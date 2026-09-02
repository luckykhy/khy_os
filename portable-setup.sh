#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$PROJECT_ROOT/extensions/scripts/khy-portable/install-path-wrappers.sh"

printf 'Khy-OS portable command setup\n\n'
bash "$INSTALLER" --force --add-to-path "$@"

BIN_DIR="${HOME}/.local/bin"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done
BIN_DIR="$(cd "$BIN_DIR" && pwd)"

for name in khy khy-os khyquant; do
  [[ -x "$BIN_DIR/$name" ]] || { printf '[FAIL] Missing wrapper: %s/%s\n' "$BIN_DIR" "$name" >&2; exit 1; }
done
"$BIN_DIR/khy" --help >/dev/null

# Transparent filesystem compression (Linux btrfs/zfs, best-effort, background;
# honest no-op elsewhere). Must never fail the installer.
COMPRESSOR="$PROJECT_ROOT/scripts/install/enable-fs-compression.sh"
if [ -f "$COMPRESSOR" ]; then
  printf '\n[3/3] Enabling transparent filesystem compression (best-effort, background)...\n'
  bash "$COMPRESSOR" --project-root "$PROJECT_ROOT" || true
else
  printf '\n[3/3] Compression helper not found, skipped.\n'
fi

printf '\n[OK] khy command configured.\n'
printf 'Project: %s\n' "$PROJECT_ROOT"
printf 'Wrappers: %s\n' "$BIN_DIR"
printf 'Open a new terminal, then run: khy --help\n'
printf 'If this folder moves, run this script again.\n'
