#!/usr/bin/env bash
# @pattern Command
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

BIN_DIR="${HOME}/.local/bin"
FORCE='0'
PORTABLE_DIR=''

usage() {
  cat <<'EOF'
Usage:
  bash scripts/portable/install-portable-cli.sh [options]

Options:
  --portable-dir <path>   Portable root directory (default: auto-detect)
  --bin-dir <path>        Install command wrappers to this directory (default: ~/.local/bin)
  --force                 Overwrite existing wrappers
  -h, --help              Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --portable-dir)
      PORTABLE_DIR="${2:-}"; shift 2 ;;
    --bin-dir)
      BIN_DIR="${2:-}"; shift 2 ;;
    --force)
      FORCE='1'; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail "Unknown argument: $1" ;;
  esac
done

if [[ -z "$PORTABLE_DIR" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  # Support both:
  # 1) repo mode: scripts/portable/install-portable-cli.sh
  # 2) portable mode: <portable>/scripts/portable/install-portable-cli.sh
  if [[ -f "$SCRIPT_DIR/../../run-khy.sh" ]]; then
    PORTABLE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  else
    PORTABLE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
  fi
fi

RUNNER="$PORTABLE_DIR/run-khy.sh"
if [[ ! -f "$RUNNER" ]]; then
  fail "run-khy.sh not found under: $PORTABLE_DIR"
fi

mkdir -p "$BIN_DIR"

install_wrapper() {
  local name="$1"
  local file="$BIN_DIR/$name"
  if [[ -e "$file" && "$FORCE" != '1' ]]; then
    warn "Skip existing: $file (use --force to overwrite)"
    return
  fi
  cat > "$file" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$RUNNER" "\$@"
EOF
  chmod +x "$file"
  ok "Installed command: $name -> $RUNNER"
}

install_wrapper "khy"
install_wrapper "khy-os"
install_wrapper "khyquant"

echo
info "If command not found, add bin dir to PATH:"
echo "  export PATH=\"$BIN_DIR:\$PATH\""
echo
echo "Try:"
echo "  khy --help"
echo "  khy doctor"

