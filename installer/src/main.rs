//! One-shot release installer. Never linked into the resident MCP bridge.
use fs2::FileExt;
use reqwest::blocking::Client;
use semver::Version;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

type Result<T> = std::result::Result<T, &'static str>;
const REPO: &str = "eziwork/naver-mail";
const LIMIT: u64 = 256 * 1024 * 1024;
const EXPANDED_LIMIT: u64 = 1024 * 1024 * 1024;
fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path).map_err(|_| "FILE_READ")?).map_err(|_| "INVALID_JSON")
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    safe_ancestors(path)?;
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .ok_or("FILE_WRITE")?,
        std::process::id()
    ));
    let mut options = File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|_| "FILE_WRITE")?;
    let result = (|| -> Result<()> {
        file.write_all(
            serde_json::to_string_pretty(value)
                .map_err(|_| "INVALID_JSON")?
                .as_bytes(),
        )
        .map_err(|_| "FILE_WRITE")?;
        file.sync_all().map_err(|_| "FILE_WRITE")?;
        drop(file);
        fs::rename(&temp, path).map_err(|_| "FILE_WRITE")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn safe_ancestors(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("UNSAFE_PATH");
    }
    for parent in path.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(parent) {
            if meta.file_type().is_symlink() {
                return Err("UNSAFE_PATH");
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("UNSAFE_PATH");
                }
            }
        }
    }
    Ok(())
}
fn remove_owned(path: &Path, root: &Path) -> Result<()> {
    if path == root || !path.starts_with(root) {
        return Err("UNSAFE_PATH");
    }
    safe_ancestors(path)?;
    if path.exists() {
        fs::remove_dir_all(path).map_err(|_| "FILE_WRITE")?;
    }
    Ok(())
}
fn home() -> Result<PathBuf> {
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let path = PathBuf::from(std::env::var_os(name).ok_or("HOME_MISSING")?);
    if !path.is_absolute() {
        return Err("UNSAFE_PATH");
    }
    safe_ancestors(&path)?;
    Ok(path)
}
fn target() -> Result<String> {
    if cfg!(windows) && cfg!(target_arch = "x86_64") {
        return Ok("win32-x64".into());
    }
    if cfg!(target_os = "macos") {
        let arm = Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.optional.arm64"])
            .output()
            .ok()
            .is_some_and(|r| {
                r.status.success() && String::from_utf8_lossy(&r.stdout).trim() == "1"
            });
        return Ok(if arm { "darwin-arm64" } else { "darwin-x64" }.into());
    }
    Err("UNSUPPORTED_PLATFORM")
}
fn selected_release(releases: &[Value]) -> Result<&Value> {
    let mut choices: Vec<_> = releases
        .iter()
        .filter(|r| r["draft"] == false)
        .filter_map(|r| {
            Version::parse(r["tag_name"].as_str()?.trim_start_matches('v'))
                .ok()
                .map(|v| (r, v))
        })
        .collect();
    let stable = choices
        .iter()
        .any(|(r, v)| r["prerelease"] == false && v.pre.is_empty());
    choices.retain(|(r, v)| !stable || (r["prerelease"] == false && v.pre.is_empty()));
    choices.sort_by(|a, b| a.1.cmp(&b.1));
    choices.last().map(|(r, _)| *r).ok_or("NO_RELEASE")
}
fn download(client: &Client, url: &str, limit: u64) -> Result<Vec<u8>> {
    if !url.starts_with("https://api.github.com/repos/eziwork/naver-mail/releases")
        && !url.starts_with("https://github.com/eziwork/naver-mail/releases/download/")
    {
        return Err("UNSAFE_URL");
    }
    let response = client.get(url).send().map_err(|_| "NETWORK")?;
    response_bytes(response, limit)
}
fn response_bytes(response: reqwest::blocking::Response, limit: u64) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            403 | 429 => "RATE_LIMIT",
            404 => "ASSET_MISSING",
            _ => "NETWORK",
        });
    }
    if response.content_length().is_some_and(|n| n > limit) {
        return Err("SIZE_LIMIT");
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "NETWORK")?;
    if bytes.len() as u64 > limit {
        return Err("SIZE_LIMIT");
    }
    Ok(bytes)
}
fn asset<'a>(release: &'a Value, name: &str) -> Result<&'a Value> {
    let found: Vec<_> = release["assets"]
        .as_array()
        .ok_or("ASSET_MISSING")?
        .iter()
        .filter(|a| a["name"].as_str() == Some(name))
        .collect();
    if found.len() != 1 {
        return Err("ASSET_MISSING");
    }
    Ok(found[0])
}
fn checksum(text: &[u8], name: &str) -> Result<String> {
    let text = std::str::from_utf8(text).map_err(|_| "CHECKSUM")?;
    let matches: Vec<_> = text
        .lines()
        .filter_map(|line| {
            let (hash, file) = line.split_once("  ")?;
            (file == name && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| hash.to_lowercase())
        })
        .collect();
    if matches.len() != 1 {
        return Err("CHECKSUM");
    }
    Ok(matches[0].clone())
}
fn relative_entry(name: &str) -> Result<PathBuf> {
    if name.len() > 1024
        || name.contains(['\\', ':', '\0'])
        || name.split('/').any(|p| {
            let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
            p == ".."
                || p == "."
                || p.ends_with(['.', ' '])
                || [
                    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
                    "LPT8", "LPT9",
                ]
                .contains(&stem.as_str())
        })
    {
        return Err("UNSAFE_ARCHIVE");
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("UNSAFE_ARCHIVE");
    }
    if path
        .components()
        .next()
        .and_then(|p| p.as_os_str().to_str())
        != Some("naver-mail")
    {
        return Err("UNSAFE_ARCHIVE");
    }
    Ok(path.to_path_buf())
}
fn extract(bytes: &[u8], zip: bool, directory: &Path) -> Result<()> {
    let mut seen = HashSet::new();
    let mut total = 0u64;
    if zip {
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "UNSAFE_ARCHIVE")?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|_| "UNSAFE_ARCHIVE")?;
            let path = relative_entry(entry.name().trim_end_matches('/'))?;
            let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
            if mode != 0 && mode != 0o100000 && mode != 0o040000 {
                return Err("UNSAFE_ARCHIVE");
            }
            if !seen.insert(path.to_string_lossy().to_lowercase()) || seen.len() > 100_000 {
                return Err("UNSAFE_ARCHIVE");
            }
            total = total.checked_add(entry.size()).ok_or("SIZE_LIMIT")?;
            if total > EXPANDED_LIMIT {
                return Err("SIZE_LIMIT");
            }
            let dest = directory.join(path);
            if entry.is_dir() {
                fs::create_dir_all(dest).map_err(|_| "FILE_WRITE")?;
            } else {
                fs::create_dir_all(dest.parent().ok_or("UNSAFE_PATH")?)
                    .map_err(|_| "FILE_WRITE")?;
                let mut out = File::create(dest).map_err(|_| "FILE_WRITE")?;
                std::io::copy(&mut entry, &mut out).map_err(|_| "UNSAFE_ARCHIVE")?;
            }
        }
    } else {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        for item in archive.entries().map_err(|_| "UNSAFE_ARCHIVE")? {
            let mut entry = item.map_err(|_| "UNSAFE_ARCHIVE")?;
            let path = relative_entry(
                entry
                    .path()
                    .map_err(|_| "UNSAFE_ARCHIVE")?
                    .to_str()
                    .ok_or("UNSAFE_ARCHIVE")?
                    .trim_end_matches('/'),
            )?;
            let kind = entry.header().entry_type();
            if !kind.is_file() && !kind.is_dir() {
                return Err("UNSAFE_ARCHIVE");
            }
            if !seen.insert(path.to_string_lossy().to_lowercase()) || seen.len() > 100_000 {
                return Err("UNSAFE_ARCHIVE");
            }
            total = total.checked_add(entry.size()).ok_or("SIZE_LIMIT")?;
            if total > EXPANDED_LIMIT {
                return Err("SIZE_LIMIT");
            }
            entry
                .unpack(directory.join(path))
                .map_err(|_| "UNSAFE_ARCHIVE")?;
        }
    }
    Ok(())
}
fn validate_package(root: &Path, version: &str, target: &str) -> Result<()> {
    let manifest = read_json(&root.join(".codex-plugin/plugin.json"))?;
    let build = read_json(&root.join("BUILD.json"))?;
    if manifest["name"] != "naver-mail"
        || manifest["version"] != version
        || build["version"] != version
        || build["target"] != target
    {
        return Err("PACKAGE_MISMATCH");
    }
    let bridge = if target.starts_with("win32") {
        "bin/naver-mail-bridge.exe"
    } else {
        "bin/naver-mail-bridge"
    };
    let node = if target.starts_with("win32") {
        format!("runtime/{target}/node.exe")
    } else {
        format!("runtime/{target}/bin/node")
    };
    let keyring = if target.starts_with("win32") {
        "win32-x64-msvc"
    } else {
        target
    };
    for file in [
        ".mcp.json",
        "dist/daemon.js",
        "dist/worker.js",
        bridge,
        &node,
    ] {
        if !root.join(file).is_file() {
            return Err("PACKAGE_MISSING");
        }
    }
    if !root
        .join(format!("node_modules/@napi-rs/keyring-{keyring}"))
        .is_dir()
    {
        return Err("PACKAGE_MISSING");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in [bridge, &node] {
            if fs::metadata(root.join(file))
                .map_err(|_| "PACKAGE_MISSING")?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err("NOT_EXECUTABLE");
            }
        }
    }
    let sums = fs::read_to_string(root.join("SHA256SUMS")).map_err(|_| "CHECKSUM")?;
    for line in sums.lines() {
        let (_, file) = line.split_once("  ").ok_or("CHECKSUM")?;
        let rel = relative_entry(&format!("naver-mail/{file}"))?;
        let file_path = root.parent().ok_or("UNSAFE_PATH")?.join(rel);
        if hex(&Sha256::digest(
            fs::read(file_path).map_err(|_| "CHECKSUM")?,
        )) != checksum(line.as_bytes(), file)?
        {
            return Err("CHECKSUM");
        }
    }
    Ok(())
}
fn cli() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CODEX_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Some(path);
        }
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .flat_map(|p| {
            if cfg!(windows) {
                vec![p.join("codex.exe"), p.join("codex.cmd")]
            } else {
                vec![p.join("codex")]
            }
        })
        .find(|p| p.is_file())
}
fn smoke(root: &Path, target: &str) -> Result<()> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    let binary = root.join(if target.starts_with("win32") {
        "bin/naver-mail-bridge.exe"
    } else {
        "bin/naver-mail-bridge"
    });
    let mut command = Command::new(binary);
    command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "NOT_EXECUTABLE")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let stdout = child.stdout.take().ok_or("SMOKE_FAILED")?;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().take(10) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let result = (|| -> Result<()> {
        let input = child.stdin.as_mut().ok_or("SMOKE_FAILED")?;
        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"installer-check","version":"0.2.1"}}})).map_err(|_|"SMOKE_FAILED")?;
        let response = rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "SMOKE_FAILED")?
            .map_err(|_| "SMOKE_FAILED")?;
        let value: Value = serde_json::from_str(&response).map_err(|_| "SMOKE_FAILED")?;
        if value["result"]["serverInfo"]["name"] != "naver-mail" {
            return Err("SMOKE_FAILED");
        }
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .map_err(|_| "SMOKE_FAILED")?;
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
        )
        .map_err(|_| "SMOKE_FAILED")?;
        let response = rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "SMOKE_FAILED")?
            .map_err(|_| "SMOKE_FAILED")?;
        let value: Value = serde_json::from_str(&response).map_err(|_| "SMOKE_FAILED")?;
        if value["result"]["tools"].as_array().map(Vec::len) != Some(12) {
            return Err("SMOKE_FAILED");
        }
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}
fn cli_output(cli: &Path, args: &[&str], timeout: Duration) -> Result<Vec<u8>> {
    let mut command = Command::new(cli);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "CLI_FAILED")?;
    let output = child.stdout.take().ok_or("CLI_FAILED")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = output.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send((result, bytes));
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err("CLI_FAILED");
                }
                let (read, bytes) = rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| "CLI_FAILED")?;
                if read.is_err() || bytes.len() > 8 * 1024 * 1024 {
                    return Err("CLI_FAILED");
                }
                return Ok(bytes);
            }
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("CLI_FAILED");
            }
        }
    }
}
fn cli_json(cli: &Path, args: &[&str]) -> Result<Value> {
    serde_json::from_slice(&cli_output(cli, args, Duration::from_secs(120))?)
        .map_err(|_| "CLI_FAILED")
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn destination(home: &Path, cli_path: Option<&Path>) -> Result<(PathBuf, String, bool)> {
    if let Some(cli) = cli_path {
        let list = cli_json(cli, &["plugin", "list", "--available", "--json"])?;
        let installed = list["installed"].as_array().ok_or("CLI_FAILED")?;
        let available = list["available"].as_array().ok_or("CLI_FAILED")?;
        let matches: Vec<_> = installed
            .iter()
            .chain(available)
            .filter(|p| p["name"] == "naver-mail")
            .collect();
        let unique: HashSet<_> = matches
            .iter()
            .filter_map(|p| p["pluginId"].as_str())
            .collect();
        if unique.len() > 1 {
            return Err("SOURCE_CONFLICT");
        }
        if let Some(p) = matches.first() {
            if p["source"]["source"] != "local" {
                return Err("SOURCE_CONFLICT");
            }
            let path = PathBuf::from(p["source"]["path"].as_str().ok_or("SOURCE_CONFLICT")?);
            let market = p["marketplaceName"].as_str().ok_or("SOURCE_CONFLICT")?;
            if !identifier(market) || !path.is_absolute() || !path.starts_with(home) {
                return Err("SOURCE_CONFLICT");
            }
            safe_ancestors(&path)?;
            if path
                .ancestors()
                .take_while(|p| *p != home)
                .any(|p| p.join(".git").exists())
            {
                return Err("SOURCE_CONFLICT");
            }
            let manifest = read_json(&path.join(".codex-plugin/plugin.json"))?;
            if manifest["repository"] != "https://github.com/eziwork/naver-mail"
                || !path.join("BUILD.json").is_file()
            {
                return Err("SOURCE_CONFLICT");
            }
            return Ok((path, market.into(), p["installed"] == true));
        }
    }
    let market_path = home.join(".agents/plugins/marketplace.json");
    safe_ancestors(&market_path)?;
    let mut name = "personal".to_string();
    if market_path.exists() {
        let market = read_json(&market_path)?;
        name = market["name"].as_str().ok_or("SOURCE_CONFLICT")?.into();
        if !identifier(&name)
            || market["plugins"]
                .as_array()
                .ok_or("SOURCE_CONFLICT")?
                .iter()
                .any(|p| p["name"] == "naver-mail")
        {
            return Err("SOURCE_CONFLICT");
        }
    }
    let path = home.join(".codex/plugins/naver-mail");
    safe_ancestors(&path)?;
    if path.exists() {
        return Err("SOURCE_CONFLICT");
    }
    Ok((path, name, false))
}
fn recover(root: &Path, user: &Path) -> Result<()> {
    let journal = root.join("transaction.json");
    if !journal.exists() {
        return Ok(());
    }
    let record = read_json(&journal)?;
    if record["committed"] == true {
        fs::remove_file(journal).map_err(|_| "RECOVERY_REQUIRED")?;
        return Ok(());
    }
    let dest = PathBuf::from(record["destination"].as_str().ok_or("RECOVERY_REQUIRED")?);
    let backup = PathBuf::from(record["backup"].as_str().ok_or("RECOVERY_REQUIRED")?);
    if !dest.starts_with(user)
        || backup.parent() != dest.parent()
        || !backup
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| {
                s.starts_with("naver-mail.previous-") && s[20..].bytes().all(|b| b.is_ascii_digit())
            })
    {
        return Err("RECOVERY_REQUIRED");
    }
    safe_ancestors(&dest)?;
    safe_ancestors(&backup)?;
    if backup.exists() {
        if dest.exists() {
            if read_json(&dest.join(".eziwork-install.json"))?["repository"] != REPO {
                return Err("RECOVERY_REQUIRED");
            }
            remove_owned(&dest, user)?;
        }
        fs::rename(&backup, &dest).map_err(|_| "RECOVERY_REQUIRED")?;
    } else if record["hadDestination"] == false && dest.exists() {
        if read_json(&dest.join(".eziwork-install.json"))?["repository"] != REPO {
            return Err("RECOVERY_REQUIRED");
        }
        remove_owned(&dest, user)?;
    }
    let marketplace = user.join(".agents/plugins/marketplace.json");
    if record["newEntry"] == true {
        safe_ancestors(&marketplace)?;
        let original = record["marketplaceBefore"]
            .as_str()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|_| "RECOVERY_REQUIRED")?;
        let mut current = if marketplace.exists() {
            read_json(&marketplace)?
        } else {
            original.clone().unwrap_or(json!({"plugins":[]}))
        };
        let plugins = current["plugins"]
            .as_array_mut()
            .ok_or("RECOVERY_REQUIRED")?;
        if plugins.iter().any(|p| {
            p["name"] == "naver-mail" && p["source"]["path"] != "./.codex/plugins/naver-mail"
        }) {
            return Err("RECOVERY_REQUIRED");
        }
        plugins.retain(|p| p["name"] != "naver-mail");
        if original.is_none() && plugins.is_empty() {
            if marketplace.exists() {
                fs::remove_file(&marketplace).map_err(|_| "RECOVERY_REQUIRED")?;
            }
        } else {
            write_json(&marketplace, &current).map_err(|_| "RECOVERY_REQUIRED")?;
        }
    }
    if record["cliAttempted"] == true {
        let cli_path = cli().ok_or("RECOVERY_REQUIRED")?;
        let selector = record["selector"].as_str().ok_or("RECOVERY_REQUIRED")?;
        if !selector.strip_prefix("naver-mail@").is_some_and(identifier) {
            return Err("RECOVERY_REQUIRED");
        }
        if record["wasInstalled"] == true {
            cli_json(&cli_path, &["plugin", "add", selector, "--json"])
                .map_err(|_| "RECOVERY_REQUIRED")?;
        } else {
            let list = cli_json(&cli_path, &["plugin", "list", "--json"])
                .map_err(|_| "RECOVERY_REQUIRED")?;
            let installed = list["installed"].as_array().ok_or("RECOVERY_REQUIRED")?;
            if installed.iter().any(|p| p["pluginId"] == selector) {
                cli_output(
                    &cli_path,
                    &["plugin", "remove", selector],
                    Duration::from_secs(120),
                )
                .map_err(|_| "RECOVERY_REQUIRED")?;
            }
        }
    }
    fs::remove_file(journal).map_err(|_| "RECOVERY_REQUIRED")?;
    Ok(())
}
fn run(dry: bool) -> Result<Value> {
    let user = home()?;
    let target = target()?;
    let root = user.join(".codex/naver-mail-installer");
    safe_ancestors(&root)?;
    let _lock = if !dry {
        fs::create_dir_all(&root).map_err(|_| "FILE_WRITE")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "FILE_WRITE")?;
        }
        safe_ancestors(&root.join("install.lock"))?;
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("install.lock"))
            .map_err(|_| "FILE_WRITE")?;
        file.try_lock_exclusive().map_err(|_| "INSTALL_BUSY")?;
        recover(&root, &user)?;
        Some(file)
    } else {
        None
    };
    let client = Client::builder()
        .user_agent("eziwork-naver-mail-installer/0.2.1")
        .timeout(Duration::from_secs(180))
        .https_only(true)
        .build()
        .map_err(|_| "NETWORK")?;
    let mut releases = Vec::new();
    for page in 1..=10 {
        let bytes = download(
            &client,
            &format!("https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}"),
            8 * 1024 * 1024,
        )?;
        let list: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| "INVALID_JSON")?;
        let last = list.len() < 100;
        releases.extend(list);
        if last {
            break;
        }
    }
    let release = selected_release(&releases)?;
    let version = release["tag_name"]
        .as_str()
        .ok_or("NO_RELEASE")?
        .trim_start_matches('v');
    let name = format!(
        "naver-mail-{version}-{target}.{}",
        if target.starts_with("win32") {
            "zip"
        } else {
            "tar.gz"
        }
    );
    let package = asset(release, &name)?;
    let sum = asset(release, &format!("{name}.sha256"))?;
    let cli_path = cli();
    let (dest, market, was_installed) = destination(&user, cli_path.as_deref())?;
    let mut report = json!({"state":"package_prepared","version":version,"target":target,"prerelease":release["prerelease"],"asset":name,"size":package["size"],"destination":dest,"marketplace":market,"dryRun":dry,"checksumVerified":false});
    if dry {
        report["state"] = json!("planned");
        return Ok(report);
    }
    let expected = checksum(
        &download(
            &client,
            sum["browser_download_url"]
                .as_str()
                .ok_or("ASSET_MISSING")?,
            16384,
        )?,
        &name,
    )?;
    let bytes = download(
        &client,
        package["browser_download_url"]
            .as_str()
            .ok_or("ASSET_MISSING")?,
        LIMIT,
    )?;
    if hex(&Sha256::digest(&bytes)) != expected
        || package["size"].as_u64() != Some(bytes.len() as u64)
    {
        return Err("CHECKSUM");
    }
    report["checksumVerified"] = json!(true);
    report["sha256"] = json!(expected);
    let stage = root.join("staging");
    remove_owned(&stage, &root)?;
    fs::create_dir_all(&stage).map_err(|_| "FILE_WRITE")?;
    extract(&bytes, target.starts_with("win32"), &stage)?;
    let prepared = stage.join("naver-mail");
    validate_package(&prepared, version, &target)?;
    smoke(&prepared, &target)?;
    write_json(
        &prepared.join(".eziwork-install.json"),
        &json!({"repository":REPO,"version":version,"sha256":expected}),
    )?;
    if cli_path.is_none() {
        report["destination"] = json!(prepared);
        report["nextAction"] = json!(
            "패키지는 준비됐지만 CLI를 찾지 못했습니다. 데스크톱 앱에서 로컬 플러그인으로 등록하세요."
        );
        return Ok(report);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "FILE_WRITE")?
        .as_millis();
    let backup = dest.with_file_name(format!("naver-mail.previous-{stamp}"));
    safe_ancestors(&backup)?;
    if backup.exists() {
        return Err("BACKUP_EXISTS");
    }
    let marketplace = user.join(".agents/plugins/marketplace.json");
    let new_entry = !dest.exists();
    let original = if marketplace.exists() {
        Some(fs::read_to_string(&marketplace).map_err(|_| "FILE_READ")?)
    } else {
        None
    };
    let selector = format!("naver-mail@{market}");
    let mut journal = json!({"destination":dest,"backup":backup,"hadDestination":dest.exists(),"newEntry":new_entry,"marketplaceBefore":original,"selector":selector,"wasInstalled":was_installed,"cliAttempted":false});
    write_json(&root.join("transaction.json"), &journal)?;
    let install = (|| -> Result<()> {
        fs::create_dir_all(dest.parent().ok_or("UNSAFE_PATH")?).map_err(|_| "FILE_WRITE")?;
        if dest.exists() {
            fs::rename(&dest, &backup).map_err(|_| "FILE_WRITE")?;
        }
        fs::rename(&prepared, &dest).map_err(|_| "FILE_WRITE")?;
        if new_entry {
            let mut data = if let Some(ref s) = original {
                serde_json::from_str(s).map_err(|_| "INVALID_JSON")?
            } else {
                json!({"name":market,"interface":{"displayName":"Personal"},"plugins":[]})
            };
            data["plugins"].as_array_mut().ok_or("INVALID_JSON")?.push(json!({"name":"naver-mail","source":{"source":"local","path":"./.codex/plugins/naver-mail"},"policy":{"installation":"AVAILABLE","authentication":"ON_USE"},"category":"Productivity"}));
            fs::create_dir_all(marketplace.parent().ok_or("UNSAFE_PATH")?)
                .map_err(|_| "FILE_WRITE")?;
            write_json(&marketplace, &data)?;
        }
        journal["cliAttempted"] = json!(true);
        write_json(&root.join("transaction.json"), &journal)?;
        cli_json(
            cli_path.as_ref().unwrap(),
            &["plugin", "add", &selector, "--json"],
        )?;
        Ok(())
    })();
    if let Err(error) = install {
        recover(&root, &user)?;
        return Err(error);
    }
    journal["committed"] = json!(true);
    write_json(&root.join("transaction.json"), &journal)?;
    let _ = fs::remove_file(root.join("transaction.json"));
    report["state"] = json!("app_reload_required");
    report["registered"] = json!(true);
    report["backup"] = json!(backup);
    report["nextAction"] = json!(
        "앱에 등록했습니다. 새 작업에서 네이버 메일 연결을 요청하세요. 도구가 나타나지 않을 때만 앱을 다시 시작하세요."
    );
    Ok(report)
}
fn message(code: &str) -> &'static str {
    match code {
        "NO_RELEASE" => "공개된 정식판과 사전 배포판을 모두 확인했지만 배포판을 찾지 못했습니다.",
        "ASSET_MISSING" => {
            "선택한 배포판의 운영체제용 파일 또는 체크섬이 없습니다. Release의 Assets를 확인하세요."
        }
        "CHECKSUM" => {
            "파일 검사값이 일치하지 않습니다. 실행하지 않았습니다. 공식 Release에서 다시 받아 주세요."
        }
        "SOURCE_CONFLICT" => {
            "다른 출처의 동명 플러그인 또는 개발 저장소가 있습니다. 자동으로 덮어쓰지 않았습니다. 기존 등록 출처를 확인하세요."
        }
        "BACKUP_EXISTS" => {
            "이전 설치 백업이 남아 있습니다. 백업을 보관 위치로 옮긴 뒤 다시 시도하세요."
        }
        "RECOVERY_REQUIRED" => {
            "이전 설치 복구를 완료하지 못했습니다. 설치 백업과 등록 상태를 확인하세요."
        }
        "CLI_FAILED" => {
            "Codex 등록 명령을 완료하지 못했습니다. 앱의 로그인·정책과 CLI 상태를 확인하세요."
        }
        "NETWORK" | "RATE_LIMIT" => {
            "GitHub 다운로드에 실패했습니다. 네트워크 상태나 요청 제한을 확인하고 다시 시도하세요."
        }
        "FILE_WRITE" | "FILE_READ" => {
            "설치 폴더에 접근하지 못했습니다. 실행 중인 설치를 종료하고 폴더 접근 권한을 확인하세요."
        }
        "INSTALL_BUSY" => "다른 설치가 진행 중입니다. 완료된 뒤 다시 시도하세요.",
        "NOT_EXECUTABLE" => {
            "실행 권한이 없는 패키지입니다. 공식 운영체제용 패키지를 다시 받아 주세요."
        }
        _ => "설치 조건 또는 패키지 검사를 통과하지 못했습니다. 오류 코드와 운영체제를 확인하세요.",
    }
}
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|s| s == "--help") {
        println!(
            "네이버 메일 설치 도우미\n  --dry-run   변경 없이 배포판·설치 대상 확인\n  --json      결과를 JSON으로 표시\nNode·Rust 설치가 필요하지 않습니다. 비밀번호를 입력하지 마세요."
        );
        return;
    }
    let result = if args.iter().any(|s| s != "--dry-run" && s != "--json") {
        Err("INVALID_ARGUMENT")
    } else {
        run(args.iter().any(|s| s == "--dry-run"))
    };
    match result {
        Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap()),
        Err(code) => {
            println!(
                "{}",
                json!({"state":"failed","error":{"code":code,"message":message(code)}})
            );
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an actual built release archive; invoked by package-check.mjs"]
    fn packaged_archive_round_trip() {
        let archive = PathBuf::from(
            std::env::var_os("NAVER_MAIL_TEST_PACKAGE").expect("release archive required"),
        );
        let target = target().unwrap();
        let temp = Temp::new();
        extract(
            &fs::read(&archive).unwrap(),
            target.starts_with("win32"),
            temp.path(),
        )
        .unwrap();
        let root = temp.path().join("naver-mail");
        validate_package(&root, env!("CARGO_PKG_VERSION"), &target).unwrap();
        smoke(&root, &target).unwrap();
        fs::write(root.join("dist/worker.js"), "corrupted").unwrap();
        assert_eq!(
            validate_package(&root, env!("CARGO_PKG_VERSION"), &target),
            Err("CHECKSUM")
        );
    }
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "naver-installer-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn prerelease_only_and_stable_precedence() {
        let mut releases = vec![
            json!({"tag_name":"v0.2.1","draft":false,"prerelease":true}),
            json!({"tag_name":"v9.0.0","draft":true,"prerelease":false}),
        ];
        assert_eq!(selected_release(&releases).unwrap()["tag_name"], "v0.2.1");
        releases.push(json!({"tag_name":"v0.2.0","draft":false,"prerelease":false}));
        assert_eq!(selected_release(&releases).unwrap()["tag_name"], "v0.2.0");
        assert!(selected_release(&[]).is_err());
    }
    #[test]
    fn checksums_bind_exact_asset_names() {
        let text = format!("{}  example.zip\n", "a".repeat(64));
        assert!(checksum(text.as_bytes(), "example.zip").is_ok());
        assert!(checksum(text.as_bytes(), "source.zip").is_err());
        assert!(checksum(format!("{text}{text}").as_bytes(), "example.zip").is_err());
    }
    #[test]
    fn archive_paths_are_confined() {
        for path in [
            "/naver-mail/a",
            "naver-mail/../b",
            "naver-mail/C:/a",
            "naver-mail\\a",
            "source/a",
        ] {
            assert!(relative_entry(path).is_err(), "{path}");
        }
        assert!(relative_entry("naver-mail/.codex-plugin/plugin.json").is_ok());
    }
    #[test]
    fn tar_links_rejected() {
        let mut bytes = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_mode(0o777);
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_link_name("/tmp").unwrap();
            header.set_cksum();
            builder
                .append_data(&mut header, "naver-mail/out", &[][..])
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let dir = Temp::new();
        assert_eq!(extract(&bytes, false, dir.path()), Err("UNSAFE_ARCHIVE"));
    }
    #[test]
    fn package_target_mismatch_rejected() {
        let dir = Temp::new();
        fs::create_dir(dir.path().join(".codex-plugin")).unwrap();
        write_json(
            &dir.path().join(".codex-plugin/plugin.json"),
            &json!({"name":"naver-mail","version":"0.2.1"}),
        )
        .unwrap();
        write_json(
            &dir.path().join("BUILD.json"),
            &json!({"version":"0.2.1","target":"darwin-x64"}),
        )
        .unwrap();
        assert_eq!(
            validate_package(dir.path(), "0.2.1", "darwin-arm64"),
            Err("PACKAGE_MISMATCH")
        );
    }
    #[test]
    fn interrupted_upgrade_restores_old_files_and_preserves_backup_content() {
        let temp = Temp::new();
        let root = temp.path().join("installer");
        let dest = temp.path().join("naver-mail");
        let backup = temp.path().join("naver-mail.previous-123");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&dest).unwrap();
        fs::create_dir(&backup).unwrap();
        fs::write(backup.join("old.txt"), "old-version").unwrap();
        write_json(
            &dest.join(".eziwork-install.json"),
            &json!({"repository":REPO}),
        )
        .unwrap();
        write_json(&root.join("transaction.json"),&json!({"destination":dest,"backup":backup,"hadDestination":true,"newEntry":false,"cliAttempted":false})).unwrap();
        recover(&root, temp.path()).unwrap();
        assert_eq!(
            fs::read_to_string(dest.join("old.txt")).unwrap(),
            "old-version"
        );
        assert!(!root.join("transaction.json").exists());
        recover(&root, temp.path()).unwrap(); // Recovery is idempotent.
    }
    #[test]
    fn interrupted_new_install_restores_marketplace_without_other_plugin_loss() {
        let temp = Temp::new();
        let root = temp.path().join("installer");
        let dest = temp.path().join("naver-mail");
        let backup = temp.path().join("naver-mail.previous-123");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&dest).unwrap();
        fs::create_dir_all(temp.path().join(".agents/plugins")).unwrap();
        let original = "{\"name\":\"personal\",\"plugins\":[{\"name\":\"keep-me\"}]}";
        write_json(
            &dest.join(".eziwork-install.json"),
            &json!({"repository":REPO}),
        )
        .unwrap();
        write_json(&root.join("transaction.json"),&json!({"destination":dest,"backup":backup,"hadDestination":false,"newEntry":true,"marketplaceBefore":original,"cliAttempted":false})).unwrap();
        recover(&root, temp.path()).unwrap();
        assert!(!dest.exists());
        assert_eq!(
            read_json(&temp.path().join(".agents/plugins/marketplace.json")).unwrap(),
            serde_json::from_str::<Value>(original).unwrap()
        );
    }
    #[test]
    fn invalid_recovery_path_does_not_touch_destination() {
        let temp = Temp::new();
        let root = temp.path().join("installer");
        fs::create_dir(&root).unwrap();
        write_json(&root.join("transaction.json"),&json!({"destination":temp.path().join("naver-mail"),"backup":temp.path().join("unrelated")})).unwrap();
        assert_eq!(recover(&root, temp.path()), Err("RECOVERY_REQUIRED"));
    }
    #[test]
    fn status_and_size_errors_are_classified() {
        fn response(status: u16, body: &'static str) -> reqwest::blocking::Response {
            use std::net::TcpListener;
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                let _ = stream.read(&mut buffer);
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            Client::new().get(format!("http://{addr}")).send().unwrap()
        }
        assert_eq!(response_bytes(response(403, ""), 20), Err("RATE_LIMIT"));
        assert_eq!(response_bytes(response(404, ""), 20), Err("ASSET_MISSING"));
        assert_eq!(response_bytes(response(200, "12345"), 3), Err("SIZE_LIMIT"));
        assert_eq!(response_bytes(response(200, "ok"), 3), Ok(b"ok".to_vec()));
    }
    #[test]
    fn filesystem_permission_failure_is_reported() {
        let temp = Temp::new();
        assert_eq!(write_json(temp.path(), &json!({})), Err("FILE_WRITE"));
    }
    #[test]
    fn committed_install_is_not_rolled_back_after_cleanup_interruption() {
        let temp = Temp::new();
        write_json(
            &temp.path().join("transaction.json"),
            &json!({"committed":true}),
        )
        .unwrap();
        recover(temp.path(), temp.path()).unwrap();
        assert!(!temp.path().join("transaction.json").exists());
    }
    #[test]
    fn recovery_preserves_concurrently_added_marketplace_entries() {
        let temp = Temp::new();
        let root = temp.path().join("installer");
        fs::create_dir(&root).unwrap();
        let market = temp.path().join(".agents/plugins/marketplace.json");
        fs::create_dir_all(market.parent().unwrap()).unwrap();
        write_json(&market, &json!({"name":"personal","plugins":[{"name":"new-other"},{"name":"naver-mail","source":{"path":"./.codex/plugins/naver-mail"}}]})).unwrap();
        write_json(&root.join("transaction.json"), &json!({"destination":temp.path().join("naver-mail"),"backup":temp.path().join("naver-mail.previous-123"),"hadDestination":false,"newEntry":true,"marketplaceBefore":null,"cliAttempted":false})).unwrap();
        recover(&root, temp.path()).unwrap();
        assert_eq!(
            read_json(&market).unwrap()["plugins"],
            json!([{"name":"new-other"}])
        );
    }
}
