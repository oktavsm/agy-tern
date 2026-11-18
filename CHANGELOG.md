# Changelog

All notable changes to `agy-tern` are documented in this file.

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
