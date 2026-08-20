#!/usr/bin/env bash
# @pattern Command
# Install PATH wrappers for khy commands (Unix)
set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
FORCE=0
ADD_TO_PATH=0
PROFILE_FILE=''

usage() {
  cat <<'EOF'
Usage: bash extensions/scripts/khy-portable/install-path-wrappers.sh [options]

Options:
  --bin-dir <path>  Install directory (default: ~/.local/bin)
  --profile <path>  Shell profile to update
  --force           Overwrite existing wrappers
  --add-to-path     Persist the install directory in the user PATH
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir) BIN_DIR="${2:?--bin-dir requires a path}"; shift 2 ;;
    --profile) PROFILE_FILE="${2:?--profile requires a path}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --add-to-path) ADD_TO_PATH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf '[FAIL] Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER="$PROJECT_ROOT/khy.sh"
[[ -f "$RUNNER" ]] || { printf '[FAIL] khy.sh not found under: %s\n' "$PROJECT_ROOT" >&2; exit 1; }
mkdir -p "$BIN_DIR"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"

install_wrapper() {
  local name="$1" file="$BIN_DIR/$1"
  if [[ -e "$file" && "$FORCE" != 1 ]]; then
    printf '[SKIP] %s (use --force to overwrite)\n' "$file"
    return
  fi
  printf '#!/usr/bin/env bash\nset -euo pipefail\nexec %q "$@"\n' "$RUNNER" > "$file"
  chmod +x "$file"
  printf '[OK] %s -> %s\n' "$name" "$RUNNER"
}

install_wrapper khy
install_wrapper khy-os
install_wrapper khyquant

if [[ "$ADD_TO_PATH" == 1 ]]; then
  if [[ -z "$PROFILE_FILE" ]]; then
    case "${SHELL:-}" in
      */zsh) PROFILE_FILE="$HOME/.zshrc" ;;
      *) PROFILE_FILE="$HOME/.bashrc" ;;
    esac
  fi
  mkdir -p "$(dirname "$PROFILE_FILE")"
  touch "$PROFILE_FILE"
  START_MARKER='# >>> khy-os portable command >>>'
  END_MARKER='# <<< khy-os portable command <<<'
  TEMP_FILE="${PROFILE_FILE}.khy-tmp.$$"
  awk -v start="$START_MARKER" -v end="$END_MARKER" '
    $0 == start { skip=1; next }
    $0 == end { skip=0; next }
    !skip { print }
  ' "$PROFILE_FILE" > "$TEMP_FILE"
  {
    cat "$TEMP_FILE"
    printf '\n%s\nexport PATH=%q:"$PATH"\n%s\n' "$START_MARKER" "$BIN_DIR" "$END_MARKER"
  } > "$PROFILE_FILE"
  rm -f "$TEMP_FILE"
  printf '[OK] User PATH configured in %s\n' "$PROFILE_FILE"
fi

printf '[OK] Wrappers: %s\n' "$BIN_DIR"
