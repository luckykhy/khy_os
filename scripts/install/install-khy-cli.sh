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

METHOD='auto'
PROFILE='slim'
PYTHON_BIN='python3'
NPM_BIN='npm'
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install/install-khy-cli.sh [options]

Options:
  --method <auto|pypi|local-pip|npm-link|script>
      auto      : prefer local-pip when inside repo, otherwise pypi
      pypi      : install from PyPI (khy-os, fallback khy-quant)
      local-pip : install current repo with pip editable mode
      npm-link  : install backend deps and register khy via npm link
      script    : script mode (slim/full profile aware)
  --profile <slim|full>
      slim      : CLI-only footprint, skip frontend install (default)
      full      : run full project CLI installer path
  --python <bin>   Python executable (default: python3)
  --npm <bin>      npm executable (default: npm)
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method)
      METHOD="${2:-}"; shift 2 ;;
    --python)
      PYTHON_BIN="${2:-}"; shift 2 ;;
    --npm)
      NPM_BIN="${2:-}"; shift 2 ;;
    --profile)
      PROFILE="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail "Unknown argument: $1" ;;
  esac
done

command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail "Python not found: $PYTHON_BIN"

if [[ "$METHOD" == 'auto' ]]; then
  if [[ -f "$ROOT_DIR/pyproject.toml" ]]; then
    METHOD='local-pip'
  else
    METHOD='pypi'
  fi
fi

info "Install method: $METHOD"
info "Install profile: $PROFILE"

install_from_pypi() {
  info "Installing khy CLI from PyPI..."
  if "$PYTHON_BIN" -m pip install --user --upgrade khy-os; then
    ok "Installed khy-os from PyPI"
    return
  fi
  warn "khy-os install failed, trying compatibility package khy-quant..."
  "$PYTHON_BIN" -m pip install --user --upgrade khy-quant
  ok "Installed khy-quant from PyPI"
}

install_local_pip() {
  [[ -f "$ROOT_DIR/pyproject.toml" ]] || fail "pyproject.toml not found under: $ROOT_DIR"
  info "Installing local repository in editable mode..."
  (cd "$ROOT_DIR" && "$PYTHON_BIN" -m pip install --user -e .)
  ok "Local editable install completed"
}

install_npm_link() {
  command -v "$NPM_BIN" >/dev/null 2>&1 || fail "npm not found: $NPM_BIN"
  command -v node >/dev/null 2>&1 || fail "node not found"
  info "Installing backend dependencies and linking CLI..."
  (cd "$ROOT_DIR/backend" && "$NPM_BIN" install --no-audit --no-fund && "$NPM_BIN" link)
  ok "npm link completed"
}

install_script_slim() {
  command -v "$NPM_BIN" >/dev/null 2>&1 || fail "npm not found: $NPM_BIN"
  command -v node >/dev/null 2>&1 || fail "node not found"
  [[ -f "$ROOT_DIR/backend/package.json" ]] || fail "backend/package.json not found under: $ROOT_DIR"

  info "Running slim script mode (CLI-only, no frontend install)..."
  (cd "$ROOT_DIR/backend" && "$NPM_BIN" install --no-audit --no-fund)
  (cd "$ROOT_DIR/backend" && "$NPM_BIN" link)

  if [[ -f "$ROOT_DIR/pyproject.toml" ]]; then
    (cd "$ROOT_DIR" && "$PYTHON_BIN" -m pip install --user -e .)
  else
    "$PYTHON_BIN" -m pip install --user --upgrade khy-os || "$PYTHON_BIN" -m pip install --user --upgrade khy-quant
  fi

  if [[ -f "$ROOT_DIR/backend/scripts/seed.js" ]]; then
    info "Initializing local database..."
    (cd "$ROOT_DIR/backend" && node scripts/seed.js >/dev/null 2>&1 || true)
  fi
  ok "Slim script mode completed"
}

install_script_mode() {
  if [[ "$PROFILE" == 'full' ]]; then
    [[ -x "$ROOT_DIR/install.sh" || -f "$ROOT_DIR/install.sh" ]] || fail "install.sh not found under: $ROOT_DIR"
    info "Running full installer (install.sh --cli)..."
    (cd "$ROOT_DIR" && bash install.sh --cli)
    ok "install.sh --cli completed"
    return
  fi

  if [[ "$PROFILE" != 'slim' ]]; then
    fail "Unsupported profile: $PROFILE (expected slim|full)"
  fi

  install_script_slim
}

case "$METHOD" in
  pypi) install_from_pypi ;;
  local-pip) install_local_pip ;;
  npm-link) install_npm_link ;;
  script) install_script_mode ;;
  *) fail "Unsupported method: $METHOD" ;;
esac

if command -v khy >/dev/null 2>&1; then
  ok "khy command is available: $(command -v khy)"
else
  USER_BASE="$("$PYTHON_BIN" -m site --user-base 2>/dev/null || true)"
  if [[ -n "$USER_BASE" ]]; then
    warn "khy command not found in PATH yet."
    warn "Try: export PATH=\"$USER_BASE/bin:\$PATH\""
  else
    warn "khy command not found in PATH yet."
  fi
fi

echo
echo "Try:"
echo "  khy --help"
echo "  khy doctor"
