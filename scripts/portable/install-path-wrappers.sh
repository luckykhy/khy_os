#!/usr/bin/env bash
# @pattern Command
# Install PATH wrappers for khy commands (Unix)
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

usage() {
  cat <<'EOF'
Usage:
  bash scripts/portable/install-path-wrappers.sh [options]

Options:
  --bin-dir <path>  Install wrappers to this directory (default: ~/.local/bin)
  --force           Overwrite existing wrappers
  -h, --help        Show this help
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
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

# Calculate project root (two levels up from scripts/portable/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Verify khy.sh exists in project root
RUNNER="$PROJECT_ROOT/khy.sh"
if [[ ! -f "$RUNNER" ]]; then
  fail "khy.sh not found under: $PROJECT_ROOT"
fi

# Create bin directory
mkdir -p "$BIN_DIR"

# Install wrapper function
install_wrapper() {
  local name="$1"
  local file="$BIN_DIR/$name"
  if [[ -e "$file" && "$FORCE" != '1' ]]; then
    warn "已跳过: $file (使用 --force 覆盖)"
    return
  fi
  cat > "$file" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$RUNNER" "\$@"
EOF
  chmod +x "$file"
  ok "已安装: $name -> $RUNNER"
}

# Install all three wrappers
install_wrapper "khy"
install_wrapper "khy-os"
install_wrapper "khyquant"

echo

# Check if PATH contains BIN_DIR
if echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  ok "PATH 已包含 $BIN_DIR"
else
  warn "PATH 中未找到目标目录。"
  info "请将以下内容添加到 shell 配置文件 (~/.bashrc 或 ~/.zshrc):"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi

echo
info "试试: khy --help"
