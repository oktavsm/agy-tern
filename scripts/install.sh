#!/usr/bin/env bash
set -euo pipefail

REPO="${AGY_TERN_REPO:-oktavsm/agy-tern}"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agy-tern"
TARGET_LINK="$BIN_DIR/agy-tern"

FORCE=0
UNINSTALL=0
SKIP_DOCTOR=0
SKIP_CLIPBOARD_DEPS="${AGY_TERN_SKIP_CLIPBOARD_DEPS:-0}"
TAG_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-doctor) SKIP_DOCTOR=1; shift ;;
    --no-clipboard-deps) SKIP_CLIPBOARD_DEPS=1; shift ;;
    --version)
      [[ $# -ge 2 ]] || { printf 'Error: --version requires a tag (e.g. v0.2.0)\n' >&2; exit 1; }
      TAG_OVERRIDE="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { printf 'Error: --repo requires OWNER/REPO\n' >&2; exit 1; }
      REPO="$2"
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage:
  curl -fsSL https://raw.githubusercontent.com/oktavsm/agy-tern/main/scripts/install.sh | bash
  ./scripts/install.sh [--force] [--uninstall] [--version TAG] [--no-doctor] [--no-clipboard-deps]

Installs agy-tern into ~/.local/bin/agy-tern:
  - When run remotely (via curl), downloads the latest verified release archive from GitHub Releases into ~/.local/share/agy-tern/current (no git clone required).
  - When run inside a local git clone, installs dependencies and builds dist/cli.js from source.
  - On Linux, automatically ensures wl-clipboard (Wayland) or xclip (X11) is available for clipboard image paste unless --no-clipboard-deps is passed.

Options:
  --version TAG        Install a specific release tag from GitHub Releases (e.g. v0.3.6)
  --repo REPO          Override GitHub repository (default: oktavsm/agy-tern)
  --force              Replace an existing non-symlink file at ~/.local/bin/agy-tern
  --uninstall          Remove the ~/.local/bin/agy-tern symlink and standalone data directory
  --no-doctor          Skip running \`agy-tern --doctor\` after installation
  --no-clipboard-deps  Skip installing wl-clipboard / xclip on Linux
  -h, --help           Show this help message
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ -L "$TARGET_LINK" ]]; then
    rm -f "$TARGET_LINK"
    printf 'Removed symlink: %s\n' "$TARGET_LINK"
  elif [[ -e "$TARGET_LINK" ]]; then
    printf 'Refusing to remove non-symlink file at %s (remove manually if desired)\n' "$TARGET_LINK" >&2
    exit 1
  else
    printf 'No launcher symlink found at %s.\n' "$TARGET_LINK"
  fi
  if [[ -d "$DATA_DIR" ]]; then
    rm -rf "$DATA_DIR"
    printf 'Removed release directory: %s\n' "$DATA_DIR"
  fi
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  if [[ "${AGY_TERN_INSTALL_BUN:-0}" == "1" ]]; then
    printf 'Bun not found; installing Bun...\n'
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  else
    cat >&2 <<'EOF'
Error: Bun (>= 1.2.22) is required to run agy-tern.
Install Bun first:
  curl -fsSL https://bun.sh/install | bash
Or let this installer install Bun automatically:
  AGY_TERN_INSTALL_BUN=1 curl -fsSL https://raw.githubusercontent.com/oktavsm/agy-tern/main/scripts/install.sh | bash
EOF
    exit 1
  fi
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'Error: bun is still not on PATH after installation.\n' >&2
  exit 1
fi

run_privileged() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
    return $?
  fi
  if command -v sudo >/dev/null 2>&1; then
    if sudo -n true 2>/dev/null; then
      sudo -n "$@"
      return $?
    fi
    if [[ -r /dev/tty && -w /dev/tty ]]; then
      sudo "$@" < /dev/tty
      return $?
    fi
    return 126
  fi
  if command -v doas >/dev/null 2>&1 && [[ -r /dev/tty && -w /dev/tty ]]; then
    doas "$@" < /dev/tty
    return $?
  fi
  return 126
}

ensure_linux_clipboard_deps() {
  if [[ "$SKIP_CLIPBOARD_DEPS" == "1" ]]; then
    return 0
  fi
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi
  if [[ -n "${WSL_DISTRO_NAME:-}" ]] && command -v powershell.exe >/dev/null 2>&1; then
    return 0
  fi

  local pkg=""
  if [[ -n "${WAYLAND_DISPLAY:-}" || "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
    if command -v wl-paste >/dev/null 2>&1 && command -v wl-copy >/dev/null 2>&1; then
      return 0
    fi
    pkg="wl-clipboard"
  else
    if command -v xclip >/dev/null 2>&1; then
      return 0
    fi
    pkg="xclip"
  fi

  local -a cmd=()
  local pre_apt=0
  if command -v dnf >/dev/null 2>&1; then
    cmd=(dnf install -y "$pkg")
  elif command -v apt-get >/dev/null 2>&1; then
    pre_apt=1
    cmd=(apt-get install -y "$pkg")
  elif command -v pacman >/dev/null 2>&1; then
    cmd=(pacman -Sy --noconfirm --needed "$pkg")
  elif command -v zypper >/dev/null 2>&1; then
    cmd=(zypper --non-interactive install "$pkg")
  elif command -v apk >/dev/null 2>&1; then
    cmd=(apk add --no-cache "$pkg")
  elif command -v xbps-install >/dev/null 2>&1; then
    cmd=(xbps-install -Sy "$pkg")
  else
    printf 'Note: %s is not installed and no supported package manager was detected. Install %s manually for clipboard image paste.\n' "$pkg" "$pkg"
    return 0
  fi

  printf 'Installing %s for clipboard image paste (%s)...\n' "$pkg" "${cmd[0]}"
  if [[ "$pre_apt" -eq 1 ]]; then
    if ! run_privileged apt-get update -qq; then
      printf 'Note: skipped automatic %s install (sudo unavailable or cancelled). Install manually: sudo apt-get install -y %s\n' "$pkg" "$pkg"
      return 0
    fi
  fi
  if ! run_privileged "${cmd[@]}"; then
    printf 'Note: skipped automatic %s install (sudo unavailable or cancelled). Install manually: sudo %s\n' "$pkg" "${cmd[*]}"
  fi
  return 0
}

link_launcher() {
  local entry_file="$1"
  mkdir -p "$BIN_DIR"
  chmod +x "$entry_file"
  if [[ -L "$TARGET_LINK" ]]; then
    ln -sfn "$entry_file" "$TARGET_LINK"
  elif [[ -e "$TARGET_LINK" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      rm -f "$TARGET_LINK"
      ln -s "$entry_file" "$TARGET_LINK"
    else
      printf 'Error: %s already exists and is not a symlink. Re-run with --force to replace it.\n' "$TARGET_LINK" >&2
      exit 1
    fi
  else
    ln -s "$entry_file" "$TARGET_LINK"
  fi
  printf 'Linked %s -> %s\n' "$TARGET_LINK" "$entry_file"
}

verify_sha256() {
  local sums_file="$1"
  local archive_file="$2"
  local archive_name
  archive_name="$(basename "$archive_file")"
  local expected
  expected="$(awk -v target="$archive_name" '{
    file = $2;
    sub(/^\*/, "", file);
    n = split(file, parts, "/");
    if (parts[n] == target) { print tolower($1); exit }
  }' "$sums_file")"
  if [[ -z "$expected" ]]; then
    printf 'Error: checksum entry for %s missing in SHA256SUMS.txt\n' "$archive_name" >&2
    exit 1
  fi
  local actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive_file" | awk '{print tolower($1)}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive_file" | awk '{print tolower($1)}')"
  else
    actual="$(bun -e 'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));' "$archive_file")"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'Error: checksum mismatch for %s (expected %s, got %s)\n' "$archive_name" "$expected" "$actual" >&2
    exit 1
  fi
}

SRC_PATH="${BASH_SOURCE[0]:-}"
LOCAL_ROOT=""
if [[ -z "$TAG_OVERRIDE" && -n "$SRC_PATH" && -e "$SRC_PATH" ]]; then
  CANDIDATE_ROOT="$(cd -- "$(dirname -- "$SRC_PATH")/.." && pwd -P)"
  if [[ -f "$CANDIDATE_ROOT/src/cli.tsx" && -f "$CANDIDATE_ROOT/package.json" ]]; then
    LOCAL_ROOT="$CANDIDATE_ROOT"
  fi
fi

if [[ -n "$LOCAL_ROOT" ]]; then
  printf 'Installing agy-tern from local checkout (%s)...\n' "$LOCAL_ROOT"
  printf 'Installing dependencies with Bun...\n'
  (cd "$LOCAL_ROOT" && bun install --frozen-lockfile)
  printf 'Building agy-tern bundle...\n'
  (cd "$LOCAL_ROOT" && bun run build)
  link_launcher "$LOCAL_ROOT/dist/cli.js"
else
  for tool in curl tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'Error: %s is required for standalone installation.\n' "$tool" >&2
      exit 1
    fi
  done

  TAG="$TAG_OVERRIDE"
  if [[ -z "$TAG" ]]; then
    printf 'Checking latest agy-tern release from %s...\n' "$REPO"
    RESOLVED_URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"
    if [[ "$RESOLVED_URL" == */releases/tag/* ]]; then
      TAG="${RESOLVED_URL##*/releases/tag/}"
      TAG="${TAG%%[?#]*}"
    else
      TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | bun -e 'const d = JSON.parse(await new Response(Bun.stdin.stream()).text()); console.log(d.tag_name ?? "");')"
    fi
  fi

  if [[ -z "$TAG" || ! "$TAG" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
    printf 'Error: could not determine a valid release tag (%s).\n' "${TAG:-empty}" >&2
    exit 1
  fi
  [[ "$TAG" == v* ]] || TAG="v$TAG"

  ARCHIVE_NAME="agy-tern-${TAG}.tar.gz"
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

  mkdir -p "$DATA_DIR"
  TMP_DIR="$(mktemp -d "$DATA_DIR/.install-XXXXXX")"
  trap 'rm -rf "$TMP_DIR"' EXIT

  printf 'Downloading %s...\n' "$ARCHIVE_NAME"
  curl -fsSL "${BASE_URL}/${ARCHIVE_NAME}" -o "$TMP_DIR/${ARCHIVE_NAME}"
  curl -fsSL "${BASE_URL}/SHA256SUMS.txt" -o "$TMP_DIR/SHA256SUMS.txt"

  printf 'Verifying SHA-256 checksum...\n'
  verify_sha256 "$TMP_DIR/SHA256SUMS.txt" "$TMP_DIR/${ARCHIVE_NAME}"

  mkdir -p "$TMP_DIR/extract"
  tar -xzf "$TMP_DIR/${ARCHIVE_NAME}" -C "$TMP_DIR/extract"

  EXTRACTED_DIR=""
  if [[ -f "$TMP_DIR/extract/dist/cli.js" && -f "$TMP_DIR/extract/package.json" ]]; then
    EXTRACTED_DIR="$TMP_DIR/extract"
  else
    for candidate in "$TMP_DIR/extract"/*; do
      if [[ -d "$candidate" && -f "$candidate/dist/cli.js" && -f "$candidate/package.json" ]]; then
        EXTRACTED_DIR="$candidate"
        break
      fi
    done
  fi

  if [[ -z "$EXTRACTED_DIR" ]]; then
    printf 'Error: release archive %s is missing pre-built dist/cli.js.\n' "$ARCHIVE_NAME" >&2
    exit 1
  fi

  CURRENT_DIR="$DATA_DIR/current"
  BACKUP_DIR="$TMP_DIR/backup-current"
  if [[ -e "$CURRENT_DIR" ]]; then
    mv "$CURRENT_DIR" "$BACKUP_DIR"
  fi
  mv "$EXTRACTED_DIR" "$CURRENT_DIR"
  rm -rf "$BACKUP_DIR"

  link_launcher "$CURRENT_DIR/dist/cli.js"
  printf 'Installed agy-tern %s to %s\n' "$TAG" "$CURRENT_DIR"
fi

ensure_linux_clipboard_deps

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\nAdd %s to your PATH if `agy-tern` is not found in a new shell:\n' "$BIN_DIR"
    printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
    ;;
esac

if [[ "$SKIP_DOCTOR" -eq 0 ]]; then
  printf '\nRunning environment check (agy-tern --doctor)...\n'
  if ! "$TARGET_LINK" --doctor; then
    if [[ -n "$LOCAL_ROOT" ]]; then
      printf '\nSetup linked, but agy was not detected or needs login. Fix the check above and run `agy-tern --doctor`.\n' >&2
      exit 1
    else
      printf '\nInstalled %s cleanly. Install or authenticate `agy`, then run `agy-tern --doctor`.\n' "$TARGET_LINK" >&2
    fi
  fi
fi

printf '\nReady! Run `agy-tern` inside any project directory (upgrade later with `agy-tern update`).\n'
