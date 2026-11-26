# Changelog

All notable changes to `agy-tern` are documented in this file.

## [0.4.5] - 2026-11-26

### Improved
- Opened official `agy` side-by-side inside a Tern split pane (`openOfficialAgyInTernSplit` in [src/tern-window.ts](src/tern-window.ts)) from inline `<plugin-card>` widgets (`Sign in (split)`) and the `/plugin` manager (`Sign in / Add account`) so you can sign in or add multiple OAuth accounts without closing `agy-tern` (automatically falling back to full handoff when Tern split is unavailable).
- Added one-click `Reload session` buttons directly on `<plugin-card>` widgets ([src/transcript-view.tsx](src/transcript-view.tsx)) and in the `/plugin` picker ([src/panels.tsx](src/panels.tsx)) to restart `agy acp` in-place after plugin sign-in and pick up newly authorized accounts immediately, plus multi-account `AGY_ACCOUNT=<email>` hints.

## [0.4.4] - 2026-11-24

### Improved
- Rendered submitted ACP follow-up (`elicitation`) answers directly in the conversation transcript as a persisted native Tern `<card head="..." meta="Submitted">` (`recordFollowUpResponse` in [src/model.ts](src/model.ts), [src/transcript-view.tsx](src/transcript-view.tsx), [src/history.ts](src/history.ts)) with `<kv>` question/answer rows and a `Copy` button.
- Prevented duplicate post-turn follow-up popups when an `ask_question` tool call was already answered via ACP elicitation during the same turn ([src/ui.tsx](src/ui.tsx)).

## [0.4.3] - 2026-11-24

### Fixed
- Fixed untypable textboxes inside the Follow-up modal ([src/follow-up.ts](src/follow-up.ts), [src/panels.tsx](src/panels.tsx), [src/ui.tsx](src/ui.tsx)): added `stepFollowUpKey` with full `draftKey` keyboard editing fallback for answer, custom-option, and additional-note inputs (previously all raw keystrokes were dropped by the modal key loop), added deterministic keyed container IDs (`choices`, `note-wrap`) and `variant="field"` on follow-up `<input>` controls so `surface.focus()` targets every textbox accurately, enabled full `Tab`/`Shift+Tab` cycling across choices, custom inputs, and `Additional note`, and stopped `Home`/`End` from hijacking text-cursor navigation to scroll the overlay.

## [0.4.2] - 2026-11-24

### Improved
- Added responsive horizontal and vertical transcript padding inside `COMPOSER_LAYOUT_CSS` in [src/ui.tsx](src/ui.tsx) (`.sf-scroll[data-role='agy.conversation'] > .sf-scroll-view` and `[data-role='agy.tabs']`) so messages, thoughts, and tool outputs sit with balanced breathing room aligned to the centered composer column instead of flush against the left pane edge.

## [0.4.1] - 2026-11-24

### Improved
- Interactive `@` directory drill-down in [src/files.ts](src/files.ts) and [src/ui.tsx](src/ui.tsx): pressing `Tab` on a directory keeps the `@` selector open and drills into that folder (`@dir/` or auto-quoted `@"dir with spaces/"`) so you can continue browsing nested subdirectories and files, while pressing `Enter` attaches the highlighted directory or file immediately.
- Flexible, case-insensitive `@` attachment search (`filterWorkspaceEntries`, `searchWorkspacePrefix`, `atMentionQuery`): supports middle-of-name matches (`@akhir`, `@monitor`), space-separated multi-token queries via `@"..."` or `@a\ b`, compact separator-insensitive matching (`@myfolder`, `@uiformat`), ordered fuzzy subsequence matching (`@ufmt`), case-insensitive `git` pathspec lookup, and expanded result limits (16 matches / up to 8 visible popup rows on tall terminals).

## [0.4.0] - 2026-11-24

### Added
- Native inline `<plugin-card catalog-id="...">` rendering in [src/transcript-view.tsx](src/transcript-view.tsx) and [src/ui-format.ts](src/ui-format.ts): strips raw `<plugin-card>` XML from prose and renders interactive Tern `<card>` widgets enriched with local `plugin.json` / `auth.json` metadata plus `Open /plugin`, `Install`, and `Sign in (official agy)` actions, alongside direct `Open ... OAuth` and `Copy URL` buttons for OAuth sign-in URLs (via safe `openExternalUrl` in [src/tern-window.ts](src/tern-window.ts)).
- Upgraded `/plugin` (`/plugins`) and `/mcp` managers in [src/extensions.ts](src/extensions.ts), [src/panels.tsx](src/panels.tsx), and [src/ui.tsx](src/ui.tsx): added `/plugin` and `/mcps` aliases, `plugin.json` / `auth.json` OAuth metadata display (`OAuth` badges, `Sign in / Accounts` handoff, `suggestedPrompts`), `agy plugin import` (`Import` modal), `Reload MCP` live session restart in `/mcp`, and `-e`/`--env` + `-H`/`--header` flag support in `agy mcp add`.
- Added official `agy 1.5.15` slash command parity in [src/commands.ts](src/commands.ts), [src/panels.tsx](src/panels.tsx), [src/ui.tsx](src/ui.tsx), and [src/cli.tsx](src/cli.tsx): `/context` (`/ctx`, `/status`) capacity & `AGY_CLI_AUTO_COMPACT_OVERRIDE` breakdown modal, `/remote-control` (`/rc`, `/remote`) daemon status/start/stop overlay, direct `/effort` (`/thinking`) and `/mode` selectors, `/clear` (`/new`) & `/models` aliases, and `/agy` (`/official`) seamless interactive handoff to official `agy` CLI that automatically resumes your conversation back in `agy-tern` on exit.

## [0.3.6] - 2026-11-23

### Fixed
- Added `Ctrl+V` clipboard paste support in [src/ui.tsx](src/ui.tsx) alongside `Alt+V` and `/paste-image`: attaches screenshots or copied image files (`text/uri-list`) when present on the clipboard, and seamlessly falls back to pasting clipboard text (`readClipboardText`) when no image is copied.
- Intercepted pasted or dropped local image file paths inside Tern's native `<editor>` `onEdit` handler (and empty bracketed paste fallback) so `Ctrl+Shift+V` and drag-and-drop image paths attach automatically as `[Image: ...]` chips.
- Extended `readClipboardImage` in [src/files.ts](src/files.ts) and `--doctor` in [src/cli.tsx](src/cli.tsx) with parameterized MIME matching, file-manager `text/uri-list` image resolution (Nautilus/Dolphin), built-in macOS `osascript` (`NSPasteboard`) fallback, WSL `powershell.exe` fallback, and distro-aware `wl-clipboard` (`dnf`/`apt`) install hints.

## [0.3.5] - 2026-11-22

### Fixed
- Separated `agy`-spawned MCP stdio helper daemons (`mcp-server-fetch`, `playwright-mcp`, `duckduckgo-mcp-server`, `rea-agents`, `uvx`, `npm exec ... mcp`) from real session subprocesses in [src/task-monitor.ts](src/task-monitor.ts) (`category: 'session' | 'mcp'` with subtree inheritance) and [src/panels.tsx](src/panels.tsx) (`Session live`, `All session`, `Finished`, and dedicated `MCP helpers` tab in `/tasks`).
- Kept the working HUD visible whenever a session background process or active tool is waiting on output even after the ACP turn yields (`Waiting output: <command> · PID <pid> [taskId]`), with direct `Live output`, `Tasks (N)`, and `Kill PID <pid>` buttons plus continuous 1s background polling while active.
- Streamed bounded tails of official session background task logs (`~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/tasks/task-*.log` parsed via `extractBackgroundTaskRef` and `readTaskLogTail`) into `/tasks` preview and the `task-inspect` (`Enter`) overlay, and clearly labeled MCP stdio daemons when inspected.

## [0.3.4] - 2026-11-21

### Added
- Antigravity Usage Activity Heatmap inside `/usage` (`Overview` tab) via [src/usage-heatmap.ts](src/usage-heatmap.ts) and shared [src/heatmap.ts](src/heatmap.ts), aggregating daily prompt counts, active sessions, and streaks across local Antigravity session logs and active ACP sessions using `<chart kind="heatmap" token="accent">`.
- Active working directory (`~`-compacted workspace path + git branch) and active session indicator (`title · shortId`) directly inside the chatbox header (`role="agy.composer.context"`), clickable to inspect `/changes` or switch via `/sessions`.

## [0.3.3] - 2026-11-21

### Added
- GitHub-style Commit Contribution Heatmap (`/commits`, aliases `heatmap`, `contributions`) backed by [src/git-history.ts](src/git-history.ts), rendered with Tern `<chart kind="heatmap" token="success">` plus commit streak stats (`Commits`, `Current streak`, `Peak day`), clickable recent commit diffs, and a quick `Commit map` shortcut inside `/changes`.

## [0.3.2] - 2026-11-21

### Fixed
- Updated `parseQuotaReport` in [src/reports.ts](src/reports.ts) to parse official `agy --print /usage` space-padded columns and its leading `Quota:` header in addition to tab-delimited output.
- Added reset countdown indicators (`formatQuotaResetCountdown`, `formatQuotaResetDisplay`, `selectSoonestQuotaReset`) in `/usage` Overview (`Next reset` stat card and `Tightest quota` reset detail) and raised `Reset` column priority in quota tables so reset times stay visible.

## [0.3.1] - 2026-11-21

### Added
- Live child process supervision for `/tasks` via [src/task-monitor.ts](src/task-monitor.ts): monitors strict descendant processes under the active `agy` subprocess PID (`LIVE PID` badges, elapsed runtime, state, and automatic 1s polling while `/tasks` is open), correlates them with tool calls, and supports confirmed `Kill process` (`SIGTERM`) / `Force SIGKILL`.
- Dynamic live task output overlay (`task-inspect`) opened on `Enter` in `/tasks`: auto-follows streaming tool output (`stick="end"`) combining ACP `content` chunks and `rawOutput` (`extractToolLiveOutput`), with `Copy output`, `Refresh`, `k` kill shortcut, and `Esc` back to `/tasks`.

## [0.3.0] - 2026-11-18

### Added
- Multi-session open tab strip and fast tab switching (`Ctrl+Tab`, `Alt+1`..`Alt+6`) with an expanded 6-session in-memory LRU cache (`DEFAULT_MAX_IN_MEMORY_CONVERSATIONS = 6`).
- Turn Outline Navigator (`/turns`, aliases `outline`, `jump`) with turn search, `Pinned` filter tab, turn pinning from transcript messages (`Pin turn` / `Unpin turn` + `[Pinned]` badges), and direct jump/reuse actions.
- Interactive Git Workbench inside `/changes`: `Stage`, `Unstage`, and confirmation-guarded `Discard` actions for working-tree and untracked paths (`stageGitPath`, `unstageGitPath`, `discardGitPath`), plus `Staged` badges from `git status`.
- Prompt Queue Manager (`/queue`, alias `queued`) with `Move up`, `Move down`, `Send #1`, `Edit in draft`, and `Drop` controls for queued follow-up prompts.
- Pre-send context budget estimator (`src/context-budget.ts`) showing `Est. ~X tok` and remaining window percentage with hover breakdown beside attached `@file`, `@dir/`, and image chips.
- Cached tier and tightest quota summary snapshot inside `/account` alongside the existing official sign-in flow (`logout` + `agy acp --sandbox --login`).

### Changed
- Extracted `src/context-budget.ts`, `src/turn-outline.ts`, and `src/ui-session-helpers.ts` for cleaner UI modularity and unit testability, and simplified composer queue editing to reuse `SessionStateManager.pullQueuedAt`.

## [0.2.4] - 2026-11-18

### Added
- Quick command palette (`Ctrl+K`) opening the searchable `/commands` overlay and a dedicated `/keys` (`/shortcuts`, `/hotkeys`) keyboard shortcuts reference modal.
- Interactive `/update` (`/upgrade`) command that checks GitHub releases against `CURRENT_VERSION`, inspects git/install location, and presents a confirmation modal for self-update or up-to-date status.
- Multi-tab `/changes` picker (`Session edits`, `Modified`, `Untracked`) with quick `Copy path` / `Copy diff` clipboard actions and `@path` insertion.
- Live streaming output rate (`<rate unit="ch/s">`) in the active-turn HUD and circular `<meter style="ring">` gauges for context usage and tightest quota in `/usage` Overview.
- Desktop attention notification fallback (`notify-send` on Linux, `osascript` on macOS) when the Tern surface is hidden (`!visible`) on approvals, follow-up modals, or long turns (`>= 8000ms`), controlled by `notifyOnTurnComplete`.
- Keyboard navigation parity inside follow-up modals: `Up`/`Down` moves `optionCursors`, `Space` toggles `multi-select` checkboxes, and `Left`/`Right` toggles `boolean` fields.

### Fixed
- Fixed multiline `@file` / `@dir` and `/` command popup `Up`/`Down` arrow navigation on line 2+ of `<editor key="draft">` by switching the composer into `mode="insert"` while a popup list is visible (paired with `.sf-ed-mode[data-mode='insert'] { display: none; }` and `Ctrl+P`/`Ctrl+N` aliases).
- Inserted `@file`, `@dir/`, and `[Image: name]` tokens inline at the mention/caret inside the draft editor with Tern `Decor[]` highlighting (`accent` / `info`), removing inline tokens on chip dismiss and using boundary-checked token matching in `formatPromptWithAttachments` so context is neither duplicated nor missed.

## [0.2.3] - 2026-11-18

### Fixed
- Removed unsupported `@media (prefers-reduced-motion: no-preference)` and `~` sibling combinators from the `agy-motion` stylesheet so Tern parses every motion rule cleanly without startup warnings.

## [0.2.2] - 2026-11-18

### Added
- Antigravity visual branding: native square logo badge rendered via Tern PNG blob on the welcome screen and assistant message avatars (with automatic `tern` icon fallback), plus adaptive dark/light lockup header in `README.md`.
- Live expandable Gemini reasoning cards (`<trace variant="card">`) that stream active thought text while working, show live extracted step topics in both the card title and working HUD, and fold smoothly once completed unless pinned or configured open.
- Adaptive `agy-motion` CSS stylesheet choreography (`agy-brand-in`, `agy-card-in`, `agy-hud-in`, `agy-thought-rail`, `agy-composer-halo`), paired with `orbit` startup spinners and `kitt` active-turn shimmer while respecting `motion: reduced` and `prefers-reduced-motion`.
- Automatic centered follow-up modal opening at turn completion for tool follow-up payloads and markdown questions/multiple-choice lists, including clickable option extraction for trailing question choice blocks and `prompt`/`choices` tool inputs.

### Fixed
- Fixed `Tern: unknown id layer.panel.overlay-scroll.input-q1` when opening text follow-up modals by adding deterministic `key="form"` hierarchy and `followUpFocusTarget()` focus resolution across open, validation errors, and `Tab` field navigation.
- Fixed uneditable free-form `<input>` fields inside follow-up modals (`input-*`, `custom-*`, `free-note`) by dispatching `ctx.onFocus(event.id)` on click/focus and tracking native `cursor`/`anchor` state per field.
- Resolved single-select custom-answer override conflicts so preset selection and `"Or type a custom answer..."` stay mutually consistent across validation and prompt submission.
- Surfaced explicit toast lock reasons when locked ACP options (`Model` / `Thinking level` while busy, disconnected, or single-option), missing slash command targets, or unavailable session actions are triggered in `/settings`, narrow dock segments, or the composer, and added `cfg-model` / `cfg-thought_level` / `perm-mode` colon-free row IDs plus `/help [query]` filtering and `onEdit` search input handlers across picker panels.

## [0.2.1] - 2026-11-18

### Added
- Full keyboard navigation inside `/settings` (`Up`/`Down`/`Home`/`End`/`PageUp`/`PageDown` row focus, `Left`/`Right` option stepping, `Enter`/`Space` switch toggles and actions, `Tab`/`Shift+Tab` and `Alt+1..4` page switching).
- Frontend version readout and interactive `Check for updates` action in `/settings`, backed by GitHub Releases.
- `Esc` / completion return stack from `/settings` sub-panels (`permissions`, `account`, `config` pickers) back to the active settings page.

### Fixed
- Fixed `/settings` sidebar page navigation clicks (`onChange` value/item, `onSelect`, `onAction`) and per-row `Reset` actions.
- Fixed all boolean switch controls in `/settings` by reading Tern `ChangeEvent.on` and `ChangeEvent.checked` fields in addition to `value`.
- Eliminated duplicate `cfg:mode` row IDs between `Session & Model` and `Permissions & Sandbox` using distinct `perm:mode` routing.

## [0.2.0] - 2026-11-18

### Added
- Standalone `curl | bash` installer via [`scripts/install.sh`](scripts/install.sh) fetching SHA-256 verified GitHub Release archives into `~/.local/share/agy-tern` without requiring `git clone`.
- Self-update command (`agy-tern update`, `agy-tern update --check`, `--version`, `--force`) and `-V` / `--version` flag, plus a non-blocking 24h passive update check notification.
- Multi-stage startup connection indicator (`1/4` to `4/4`) with starburst spinner, shimmer status, and elapsed timer.
- `All workspaces` tab in `/sessions` (`session/list` without `cwd` filtering) showing each session's origin directory, plus non-blocking background indexing so search filters across titles, local labels, folder names, IDs, and chat message content.

### Fixed
- Enabled clickable, draggable conversation and overlay scrollbars (`flex: 1 1 0` viewport sizing inside `.sf-main`, `bar="always"`, `user-select: none` on `.sf-scroll-bar`).
- Fixed `/usage` segmented tab clicking (`onSelect` / `onActivate` + `onChange`) and enriched the `Details` tab with tier, auth boundary, sign-in method, runtime info, context breakdown, and quota table.
- Fixed `/sessions` `<picker state="loading">` spinner suppression when an active session row was present and replaced N+1 session-name stat reads with a single-`readdir` batch lookup.

## [0.1.0] - 2026-11-18

### Added
- Native [Tern](https://docs.stencil.so/tern/protocol/index.md) Surface Protocol (TSP) frontend wrapping official `agy acp --sandbox` over stdio.
- Centered rounded composer card (`92ch`) with shell-style editing, `@` workspace file/directory/image attachments (`[gitignored]` badges), prompt queue, undo (`Ctrl+Z`), and clickable `Usage` + `<meter>` bar.
- Interactive follow-up question modal (`elicitation/create` form & URL modes plus `ask_question` tool and agent follow-up extraction).
- Clickable tool tasks in the transcript: clicking file-read tasks opens contents in `InspectOverlay`; hover pill actions (`Open file`, `Inspect`, `Inspect diff`, `Split`, `Copy`) and expanded task controls across all tool kinds.
- Slash command panels (`/model`, `/settings`, `/templates`, `/find`, `/tasks`, `/changes`, `/mcp`, `/plugins`, `/agents`, `/sessions`, `/new`, `/rename`, `/export`, `/paste-image`, `/usage`, `/credits`, `/changelog`, `/account`, `/permissions`, `/help`).
- Multi-terminal store serialization (`PromptHistoryStore.append`, `PrefsStore`, `SessionNames`, `PromptTemplatesStore`) and `$TERN_PANE`-scoped split targeting.
- macOS clipboard image support (`pngpaste`) alongside Linux Wayland (`wl-paste`/`wl-copy`) and X11 (`xclip`).
- GitHub Actions CI (`ubuntu-latest` + `macos-latest`), tag-based Release workflow, `SECURITY.md`, Issue/PR templates, and Platform Support Matrix.

### Fixed
- Prevented mid-turn UI freezes caused by synchronous dual-credit `settle` bursts during streaming and stale hidden-pane gating during busy turns.
