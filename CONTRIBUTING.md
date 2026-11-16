# Contributing to agy-tern

Thank you for contributing to `agy-tern`.

## Architecture & Trust Boundary

Before proposing changes, read [`AGENTS.md`](AGENTS.md) and [`README.md`](README.md):

- **Official CLI subprocess only**: Antigravity authentication, credentials, models, and tool execution stay inside `agy acp --sandbox`. Never bypass the official CLI or inspect private Antigravity Google endpoints/tokens.
- **Native Tern UI**: Build interfaces with `@stencil-hq/tern` native elements and semantic design tokens rather than custom ANSI/CSS parallel style systems. Keep full keyboard navigation parity across modals, pickers, approvals, and composer inputs.
- **No synthetic capabilities**: Advertise only ACP capabilities and session options verified in `@agentclientprotocol/sdk` and the running CLI.
- **Clean output**: Zero emoji anywhere in code, UI copy, docs, or commit messages. Keep screenshots, transcripts, credentials, and logs untracked.

## Development Setup

Prerequisites:
- Bun `>= 1.2.22`
- Official `agy` CLI with `agy acp` support
- Tern terminal (`tern`) for native surface testing

Run locally without touching global binaries:

```sh
bun install --frozen-lockfile
bun run start
```

Check environment integration:

```sh
bun run src/cli.tsx --doctor
```

## Verification

Run the typecheck and full unit/protocol suite before submitting any pull request:

```sh
bun run typecheck
bun test
```

For UI changes, verify live rendering in a real Tern surface or headless `tern serve` session and inspect every affected modal/picker in both dark and light themes.

## Commit & Pull Request Guidelines

- Follow Conventional Commits v1.0.0: `<type>(<scope>): <imperative summary>` (e.g., `feat(ui): add workspace prompt template picker`, `fix(acp): handle cancellation during session resume`).
- Keep commits focused and atomic.
- Summarize the problem, technical changes, and observed verification commands/results in your PR description.
