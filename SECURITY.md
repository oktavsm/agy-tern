# Security Policy

## Scope & Trust Boundary

`agy-tern` is an independent terminal frontend that connects to the official Antigravity CLI subprocess (`agy acp --sandbox`) over stdio via the Agent Client Protocol (ACP) and renders native UI elements over the Tern Surface Protocol (TSP).

Key security boundaries enforced by this repository:

- **Subprocess isolation**: `agy-tern` spawns `agy acp --sandbox` and does not implement its own filesystem or shell execution RPC servers. Note that requesting `--sandbox` delegates containment to `agy` and the host OS.
- **No credential persistence**: `agy-tern` never reads, extracts, or stores Google OAuth tokens, API keys, or account pools. Account login/logout operates strictly through official `agy` commands.
- **Explicit one-time approvals**: Interactive permission prompts expose only server-provided `allow_once` and `reject_once` option IDs (`Enter` never approves a tool call; pre-existing `agy` allow rules still apply inside `agy`).
- **Restricted local state**: UI preferences (`prefs.json`), private session labels (`session-names/`), recent workspace prompt history (`prompt-history/`), templates (`templates/`), and sanitized transcript snapshots (`transcripts/`) are written under `$XDG_STATE_HOME/agy-tern/` with `0700` directory and `0600` file permissions. Inline image blobs are stripped before writing local snapshots.

## Supported Versions

Security fixes target the latest minor release on the `main` branch (`0.1.x`).

## Reporting a Vulnerability

Please do not disclose security vulnerabilities in public issues or pull requests.

To report a security issue privately:

1. Use GitHub **Private Vulnerability Reporting** (**Security -> Advisories -> Report a vulnerability**) on the repository if enabled, or contact the maintainer directly via GitHub profile email (`oktavsm`).
2. Include a clear reproduction case, affected component/file, and impact assessment.
3. Exclude personal credentials, session transcripts, and tokens from any report or attachment.

Reports are reviewed as promptly as possible, and a fix plus advisory will be coordinated prior to public disclosure.
