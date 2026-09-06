# Security policy

## Secret handling

- Only a Naver application password is accepted. The primary Naver password is never requested.
- The credential is stored as one OS-keyring record under service `com.eziwork.codex.naver-mail`.
- There is no plaintext fallback. If the OS keyring is unavailable, setup fails closed.
- Tool arguments and tool results never contain the credential.
- Windows Credential Manager or macOS Keychain protects secrets at rest. Other processes with the same user privileges remain a trust boundary. Revoke the application password if the account or another local plugin is compromised.

## Network

- IMAP: `imap.naver.com:993` with TLS and certificate verification.
- SMTP: `smtp.naver.com:587` with required STARTTLS and certificate verification.
- No telemetry, analytics, remote API, webhook, or developer-operated backend is used.

## User-impacting actions

- Sending requires a short-lived, single-use plan, Codex tool approval, and a separate user message after the complete preview is shown in the conversation.
- `prepare_send` returns a single-use, ten-minute in-memory plan. The skill requires a separate explicit user message before `send_mail`, and uncertain sends are never retried automatically.
- Message-body reads, send preparation, read-state changes, attachment writes, and account disconnection require tool approval.
- External URLs in mail bodies are hidden by default. Sender authentication is reported as received from the mail server and is not represented as independent cryptographic verification.
- Executable, script, shortcut, macro-enabled and macOS executable attachments are blocked. Saved attachments receive Windows Mark-of-the-Web or macOS quarantine attributes and are written with non-overwrite semantics. Failure to apply the OS marker fails the download.
- Outgoing attachments are limited to ordinary files under the current user profile; known credential and application-state directories are blocked.
- Permanent deletion and mail moves are intentionally not implemented in the first release.

## Remaining trust boundaries

- Selected headers and message bodies are supplied to Codex/OpenAI for the requested processing. The plugin developer does not receive them.
- Mail content remains untrusted external data. Heuristic prompt-injection detection can warn but cannot prove that content is safe.
- The local plugin process has the filesystem and network rights of the signed-in OS user. Only install this plugin from a source you trust and reinstall if the cached package is incomplete or modified.
- The plugin is not produced, sponsored, or endorsed by NAVER Corp. Its green secure-mail icon is an original Eziwork asset and does not use the NAVER logo.

## Local IPC and lifecycle

- A Rust MCP bridge authenticates its shared Node worker using mutual nonce/HMAC challenge-response, an OS-user-directory secret, and an exact protocol version. This IPC secret is not a Naver credential.
- Windows uses a named pipe; the runtime directory and secret receive a protected DACL for the object owner and SYSTEM instead of inheriting broader LocalAppData permissions. Reparse points are rejected. macOS uses a mode-600 Unix socket and secret in a mode-700 runtime directory. Socket leftovers are checked for type and ownership under a startup lock.
- The worker has no background mail watcher. It exits after 30 idle seconds unless a request, 30-minute setup session or 10-minute send plan is active. At most 20 send plans and 20 queued operations are retained.
- Forwarded send requests are never replayed after transport loss. Uncertain results require the user to check delivery. A consumed plan stays unusable.
- Setup accepts only loopback requests with the expected Host, unguessable token and same-origin POST. No external scripts, inline scripts or browser storage are used. Browser-launch errors return the local URL for manual opening.

## Reporting

Do not include credentials or private mail content in a bug report. Revoke the Naver application password immediately if exposure is suspected.
