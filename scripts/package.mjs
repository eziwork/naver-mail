import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile, access, chmod, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as createTar } from 'tar';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const platform = process.env.NAVER_MAIL_PACKAGE_PLATFORM ?? process.platform;
const arch = process.env.NAVER_MAIL_PACKAGE_ARCH ?? process.arch;
const target = `${platform}-${arch}`;
if (!['win32-x64','darwin-x64','darwin-arm64'].includes(target)) throw new Error('Unsupported package target');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const staging = join(root, '.build-package', target);
if (!resolve(staging).startsWith(resolve(root, '.build-package') + sep)) throw new Error('Unsafe staging path');
const repack = process.argv.includes('--repack');
if (!repack) await rm(staging, {recursive: true, force: true});
const plugin = join(staging, 'naver-mail');
await mkdir(plugin, {recursive: true});
for (const item of ['.codex-plugin','.mcp.json','assets','skills','docs','README.md','SECURITY.md','CHANGELOG.md','RELEASE.md','CONTRIBUTING.md','package.json','package-lock.json']) {
  await cp(join(root, item), join(plugin, item), {recursive: true, dereference: true});
}
await mkdir(join(plugin, 'dist'), {recursive: true});
for (const entry of await readdir(join(root, 'dist'))) {
  if ((entry.endsWith('.js') && !['index.js','ipc.js'].includes(entry)) || entry === 'tool-catalog.json') await cp(join(root, 'dist', entry), join(plugin, 'dist', entry));
}
await mkdir(join(plugin, 'bin'), {recursive: true});
const filename = platform === 'win32' ? 'naver-mail-bridge.exe' : 'naver-mail-bridge';
const binary = process.env.NAVER_MAIL_BRIDGE_BINARY ?? join(root, 'bin', filename);
await cp(binary, join(plugin, 'bin', filename), {dereference: true});
await chmod(join(plugin, 'bin', filename), 0o755);
await cp(join(root, 'runtime', target), join(plugin, 'runtime', target), {recursive: true, dereference: true});
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script with npm run package');
if (!repack) {
  const dependencies = spawnSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`], {cwd: plugin, stdio: 'inherit', windowsHide: true});
  if (dependencies.status !== 0) throw new Error('Production dependency install failed');
}
const keyring = platform === 'win32' ? `keyring-win32-${arch}-msvc` : `keyring-darwin-${arch}`;
// npm command shims are not runtime dependencies; omit symlinks from distributable archives.
await rm(join(plugin,'node_modules','.bin'),{recursive:true,force:true});
await access(join(plugin, 'node_modules', '@napi-rs', keyring));
await writeFile(join(plugin, 'BUILD.json'), JSON.stringify({version: pkg.version, target, generatedAt: new Date().toISOString(), validation: platform === process.platform && arch === process.arch ? 'native-package; see RELEASE.md for executed checks' : 'cross-compiled; execution not validated', signed: false}, null, 2) + '\n');
const sums = [];
async function inventory(dir) {
  for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name);
    if (file === join(plugin, 'SHA256SUMS')) continue;
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) await inventory(file);
    else sums.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${relative(plugin, file).split(sep).join('/')}`);
  }
}
await inventory(plugin); await writeFile(join(plugin, 'SHA256SUMS'), sums.join('\n') + '\n');
const releases = process.env.NAVER_MAIL_RELEASE_DIR ? resolve(process.env.NAVER_MAIL_RELEASE_DIR) : join(root, 'releases');
await mkdir(releases, {recursive: true});
const archive = join(releases, `naver-mail-${pkg.version}-${target}.${platform === 'win32' ? 'zip' : 'tar.gz'}`);
if (platform === 'win32') {
  const packed = spawnSync('tar', ['-a', '-cf', archive, '-C', staging, 'naver-mail'], {stdio: 'inherit', windowsHide: true});
  if (packed.status !== 0) throw new Error('Archive creation failed');
} else {
  await createTar({file: archive, cwd: staging, gzip: true, portable: true, filter(path, stat) {
    // Windows chmod cannot retain Unix execute bits, so normalize archive metadata.
    const normalized = path.replaceAll('\\', '/');
    const mode = stat.isDirectory() || normalized.endsWith('/bin/node') || normalized.endsWith('/bin/naver-mail-bridge') ? 0o755 : 0o644;
    stat.mode = (stat.mode & ~0o777) | mode;
    return true;
  }}, ['naver-mail']);
}
await writeFile(archive + '.sha256', `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${archive.split(sep).at(-1)}\n`);
console.log(JSON.stringify({archive, stagedPlugin: plugin, target}));
