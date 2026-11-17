# Changelog

All notable changes to `agy-tern` are documented in this file.

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
