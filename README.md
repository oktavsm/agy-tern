# agy-tern

Native [Tern](https://docs.stencil.so/tern/protocol/index.md) terminal frontend for the official Antigravity CLI (`agy`) over the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/).

`agy-tern` spawns `agy acp --sandbox` as a subprocess and renders streaming conversations, agent reasoning, tool executions, diffs, centered media inspection, and explicit one-time approvals natively through the Tern Surface Protocol (TSP).

> **Third-party notice**: `agy-tern` is an independent open-source frontend, not an official Google or Stencil product. Authentication, credentials, model routing, tool execution, and Google API communication remain inside the official `agy` binary. Using the official CLI does not bypass account limits or quotas.

---

## Features

- **Native Tern Surface UI**: Renders conversations, collapsible `Thought` traces, multi-step `Plan` HUD, inline/card tool output, unified/split code diffs, and real-time context meters (`used/size` tokens) using Tern native elements and theme tokens.
- **Full Keyboard Parity**: Shell-style composer editing (`Ctrl+A`/`E`, word jumps `Ctrl+Left`/`Right` or `Alt+B`/`F`, `Up`/`Down` line movement and prompt history with `History i/N`, `Ctrl+W`/`U`/`K`, `Ctrl+Z` undo), `Esc` cancellation, and explicit one-time approvals (`Tab`, `Ctrl+Y`, `Ctrl+N`; `Enter` never approves a tool).
- **Rich Inspection & Side-by-Side Splits**: Inline clickable screenshots and images inside tool cards and agent Markdown responses (click any image or **Open modal** for centered `InspectOverlay`; optional `autoPreviewMedia` toggle in `/settings`); centered inspector for files, directories, and diffs; per-block `Copy`, `Fullscreen`, and confirmed `Run in split` (`tern split`) actions on fenced Markdown code/command blocks; `Copy output` / `Copy diff` inside tool cards; and direct `tern open --split right` launch.
- **Model Defaults & Local Memory**: New ACP sessions default to `gemini-4-hydrogen` + `high` thinking when advertised by `agy`, while remembering your last selected model and thinking level in local `prefs.json` (`rememberModel`, configurable in `/settings`).
- **Full Workspace `@` Attachments & Directory Tagging**: `@` autocomplete indexes tracked, untracked, and gitignored files plus directories (`@dir/`), clearly marking gitignored items with a `[gitignored]` flag, and includes a directory preview inspector modal (`Up`, `Copy`, `Attach`).
- **Official CLI Extension & Session Management**: Browse/toggle/add/remove MCP servers (`/mcp`), browse/toggle/validate/install/uninstall plugins & skills (`/plugins`), inspect agent profiles and `--add-dir` roots (`/agents`), manage ACP sessions (`/sessions`, `/new`, `/rename`), and read official `/usage`, `/credits`, and `/changelog` reports.
- **Workspace Prompt Templates & Multi-Format Export**: Save/search/insert reusable workspace-scoped prompts (`/templates`), export transcripts as Markdown or JSON (`/export [file.md|json]`), and emit non-intrusive terminal attention notifications (`OSC 9` + BEL) when long turns (`>= 8s`) complete or approvals await.

---

## Prerequisites

- [Bun](https://bun.sh/) `>= 1.2.22` (or Node `>= 22` compatible runtime for bundled types)
- [Tern](https://docs.stencil.so/tern/protocol/index.md) terminal with Surface Protocol support
- Official Antigravity CLI (`agy`) providing `agy acp`

Inside non-Tern terminals without TSP, `agy-tern` safely delegates all CLI arguments to `agy --sandbox`.

---

## Installation

Clone the repository and link the CLI entrypoint into `~/.local/bin`:

```sh
bun install --frozen-lockfile
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/src/cli.tsx" "$HOME/.local/bin/agy-tern"
agy-tern --doctor
```

Ensure `~/.local/bin` is on your `PATH`. Because the symlink targets `src/cli.tsx` directly, updates take effect on the next launch without a separate build step. Calling `ln -s` without `-f` avoids overwriting an existing `agy` or `agy-tern` binary.

Authenticate through the official CLI before or inside a session:

```sh
agy acp --login
```

---

## Usage

Run `agy-tern` from any project directory inside Tern:

```sh
agy-tern
```

Common launch flags:

```sh
agy-tern --cwd /path/to/repo --add-dir /path/to/shared-lib
agy-tern --agent reviewer --model gemini-3.8-flash --mode plan --thinking high
agy-tern --continue "continue the UI audit"
agy-tern --agy /abs/path/to/agy --doctor
```

### Supported CLI Flags

| Flag | Description |
| --- | --- |
| `--cwd <dir>` | Set primary workspace directory |
| `--add-dir <dir>` | Attach an additional workspace root (repeatable; forwarded to `agy` and indexed for `@file`) |
| `--agent <name>` | Select configured custom `agy` agent profile |
| `--model <id\|name>` | Apply initial ACP `model` session option once connected |
| `--mode <id\|name>` | Apply initial ACP `mode` session option once connected |
| `--thinking`, `--effort <level>` | Apply initial ACP reasoning effort option |
| `-c`, `--continue` | Resume the most recent ACP session |
| `--conversation <id>` | Load a specific saved ACP session ID |
| `-i`, `--prompt-interactive`, `[PROMPT]` | Start interactively with an initial prompt |
| `--agy <path>` | Override the `agy` executable path (absolute or PATH-resolved) |
| `--doctor [--json]` | Verify `agy`, `tern`, clipboard tools, and launcher symlink (with optional JSON output) without sending model prompts |
| `-h`, `--help`, `-V`, `--version` | Show CLI usage help or package version |

---

## Keyboard Controls

- **Send / Queue**: `Enter` sends (or queues follow-up prompts while busy); `Shift+Enter` inserts a newline; multiline pastes remain in the draft.
- **Attachments**: Type `@` to search and attach workspace files, directories (`@dir/`), or images, including gitignored items marked `[gitignored]`; pasting/dropping an existing image path attaches an image preview tile (requires server `promptCapabilities.image`).
- **Composer Navigation**: `Ctrl+A` / `Ctrl+E` (line start/end), `Ctrl+Left`/`Right` or `Alt+B`/`F` (word jump), `Up`/`Down` (crosses wrapped lines or cycles prompt history when empty), `Ctrl+W`/`U`/`K` (delete word / to start / to end), `Ctrl+Z` (undo).
- **Modals & Turns**: `Esc` steps back from nested confirmation/input overlays to their parent picker or closes modals without cancelling a running turn; in an active conversation, `Esc` cancels the turn.
- **Disconnect Recovery**: Clicking **Reconnect ACP** on a connection-failure card or the `Disconnected` status segment re-establishes the official ACP subprocess while keeping your draft.
- **Transcript**: `PgUp` / `PgDn` scroll conversation history.
- **Approvals**: `Tab` / `Shift+Tab` cycle options; `Ctrl+Y` approves once; `Ctrl+N` denies. `Enter` never approves a tool call.
- **Quit**: `Ctrl+Q` (or `Quit` status segment) cleanly shuts down pending approvals, the ACP subprocess, and the Tern surface.

---

## Slash Commands

| Command | Behavior |
| --- | --- |
| `/model [id\|name]` | Switch active ACP model using server-advertised `configOptions` |
| `/settings`, `/config` | Open 4-page `<prefs>` modal (`Appearance & UI`, `Session & Model`, `Permissions & Sandbox`, `Keybindings`) persisted under `$XDG_STATE_HOME/agy-tern/prefs.json` |
| `/templates [query]`, `/snippets [query]` | Save, browse, filter, insert, or delete workspace-scoped prompt templates |
| `/find [query]`, `/search [query]` | Search messages, thoughts, tools, diffs, plans, and notices with `Jump to chat`, `Copy`, and `Inspect` actions |
| `/changes`, `/diff` | Inspect session edits and workspace `git status` (including live `git diff` previews) with `Fullscreen` and `Tern split` (`tern open --split right`) actions |
| `/mcp` | List `agy mcp list` servers; enable, disable, add (`[--type stdio\|http] <name> <target> [args...]`), or remove servers with confirmation |
| `/plugins`, `/skills` | Browse `agy plugin list --json`; toggle state, insert `/<skill>`, validate manifests (`InspectOverlay` report), install, or uninstall |
| `/agents`, `/agent` | Inspect custom `agy agent` profiles and active `--add-dir` workspace roots |
| `/sessions`, `/resume`, `/conversation`, `/switch` | List, search, load (`session/load`), fast-resume (`session/resume`), or close (`session/close`) ACP sessions |
| `/new` | Start a fresh ACP session without discarding in-memory conversation state |
| `/rename [name]` | Set a private local display label for the current session (does not mutate server title) |
| `/export [file.md\|json]` | Export the active transcript as Markdown or structured JSON inside the workspace |
| `/expand`, `/collapse` | Expand or collapse all thought and tool cards in the active transcript |
| `/usage`, `/quota` | Display official CLI `/usage` account quotas alongside ACP `usage_update` context telemetry |
| `/credits`, `/changelog` | View official CLI account credits and release notes |
| `/account`, `/login`, `/switch-account`, `/reauth` | Official terminal login, tier inspection (`_meta`), and manual account switch confirmation |
| `/permissions` | Inspect reported session mode, requested `--sandbox` flag, and advertised ACP capabilities |
| `/help`, `/commands` | Browse tabbed command catalog (`All`, `Frontend`, `Workflows`, `Skills`) |
| `/exit`, `/quit` | Exit frontend cleanly |

Unknown slash commands are rejected locally instead of silently becoming model prompts. Dynamic ACP commands update automatically on `available_commands_update`.

---

## Trust Boundary & Local State

- **Subprocess isolation boundary**: `agy-tern` passes `--sandbox` to `agy acp --sandbox`, does not implement its own filesystem or terminal RPC servers, and never passes permission-bypass flags. Requesting `--sandbox` does not verify OS-level kernel containment unless enforced by `agy` on your host.
- **Zero credential storage**: No tokens, OAuth state, or account pools are stored by `agy-tern`. Official login/logout modifies `agy`'s shared authentication across CLI, Desktop App, and IDE extensions.
- **Explicit approvals**: Tool permission prompts allow only `allow_once` or `reject_once` choices using server-provided option IDs. Pre-existing `agy` allow rules still apply inside the backend subprocess.
- **Local XDG state (`0700` dir / `0600` file)**: Only UI preferences (`prefs.json`), private session labels (`session-names/`), and workspace prompt templates (`templates/`) are written under `$XDG_STATE_HOME/agy-tern/` (defaulting to `~/.local/state/agy-tern/`). Transcripts are not persisted to `~/.local/state`.

---

## Development & Verification

```sh
bun run typecheck
bun test
bun run src/cli.tsx --doctor
```

Core module map:
- `src/contracts.ts`, `src/agent.ts`, `src/auth.ts`, `src/reports.ts`: Official ACP stdio boundary, login lifecycle, and CLI reports.
- `src/model.ts`, `src/draft.ts`, `src/files.ts`, `src/prefs.ts`, `src/session-names.ts`, `src/templates.ts`: Transcript projection, composer input state, workspace files, and XDG local persistence.
- `src/cli-args.ts`, `src/cli.tsx`, `src/commands.ts`, `src/extensions.ts`, `src/tern-window.ts`: CLI flag parsing, extension management (`mcp`/`plugin`/`agent`), `tern open` splits, and OSC 9 notifications.
- `src/ui-format.ts`, `src/picker-nav.ts`, `src/transcript-view.tsx`, `src/ui.tsx`: Tern JSX surface rendering, pickers, centered inspector overlay, and keyboard/event orchestration.

Additional documentation:
- [Project Overview & Architecture Notes (Indonesian)](docs/project-overview.md)
- [Native UI & Visual Verification Log (Indonesian)](docs/ui-revamp.md)
- [Manager Integration Boundary Notes (Indonesian)](docs/manager-integration.md)

---

## Contributing & License

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before opening a pull request.

Licensed under the [MIT License](LICENSE).
