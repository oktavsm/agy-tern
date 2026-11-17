#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
TARGET_LINK="$BIN_DIR/agy-tern"
ENTRY_FILE="$ROOT_DIR/src/cli.tsx"

FORCE=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      cat <<EOF
Usage: ./scripts/install.sh [--force] [--uninstall]

Installs agy-tern dependencies, links ~/.local/bin/agy-tern -> src/cli.tsx,
and runs agy-tern --doctor to verify your environment.

Options:
  --force      Replace an existing non-symlink file at ~/.local/bin/agy-tern
  --uninstall  Remove the ~/.local/bin/agy-tern symlink
  -h, --help   Show this help message
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ -L "$TARGET_LINK" ]]; then
    rm -f "$TARGET_LINK"
    printf 'Removed symlink: %s\n' "$TARGET_LINK"
  elif [[ -e "$TARGET_LINK" ]]; then
    printf 'Refusing to remove non-symlink file at %s\n' "$TARGET_LINK" >&2
    exit 1
  else
    printf 'Nothing to uninstall (%s does not exist).\n' "$TARGET_LINK"
  fi
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Error: Bun (>= 1.2.22) is required to run agy-tern.
Install Bun first:
  curl -fsSL https://bun.sh/install | bash
Then re-run:
  ./scripts/install.sh
EOF
  exit 1
fi

printf 'Installing dependencies with Bun...\n'
(cd "$ROOT_DIR" && bun install --frozen-lockfile)

mkdir -p "$BIN_DIR"
chmod +x "$ENTRY_FILE"

if [[ -L "$TARGET_LINK" ]]; then
  ln -sfn "$ENTRY_FILE" "$TARGET_LINK"
elif [[ -e "$TARGET_LINK" ]]; then
  if [[ "$FORCE" -eq 1 ]]; then
    rm -f "$TARGET_LINK"
    ln -s "$ENTRY_FILE" "$TARGET_LINK"
  else
    printf 'Error: %s already exists and is not a symlink. Re-run with --force to replace it.\n' "$TARGET_LINK" >&2
    exit 1
  fi
else
  ln -s "$ENTRY_FILE" "$TARGET_LINK"
fi

printf 'Linked %s -> %s\n' "$TARGET_LINK" "$ENTRY_FILE"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\nAdd %s to your PATH if `agy-tern` is not found in a new shell:\n' "$BIN_DIR"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

printf '\nRunning environment check (agy-tern --doctor)...\n'
if ! "$TARGET_LINK" --doctor; then
  printf '\nSetup linked, but agy was not detected or needs login. Fix the check above and run `agy-tern --doctor`.\n' >&2
  exit 1
fi

printf '\nReady! Run `agy-tern` inside any project directory.\n'
