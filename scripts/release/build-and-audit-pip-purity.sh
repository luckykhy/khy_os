#!/usr/bin/env bash
# @pattern Command, Template Method, Visitor
#
# Isolated clean build + distribution purity audit.
#
# Enforces two of the goal's packaging laws in one pass:
#   1. Build the distribution in an ISOLATED clean environment so no
#      third-party package-management directory from this working tree can
#      leak into the artifacts (`python -m build` with build isolation).
#   2. Audit the produced sdist + wheel: the multi-language workshop source
#      and lock files must be present, while NO third-party dependency tree
#      (node_modules, site-packages, bower_components, …) or compiled
#      build output may be bundled.
#
# Exit non-zero on the first purity violation so CI / the verification flow
# can react. First-party vendored code (services/backend/vendor/shared, the
# @khy/shared package) is explicitly allowed; only foreign dependency trees
# are rejected.
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

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

DIST_DIR="$ROOT_DIR/dist"
NO_ISOLATION='0'   # default: isolated build (the packaging law)
SKIP_BUILD='0'

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release/build-and-audit-pip-purity.sh [options]

Options:
  --no-isolation   Build with `python -m build --no-isolation` (offline env
                   that already has build/setuptools/wheel installed). The
                   default builds in an isolated environment.
  --skip-build     Audit existing artifacts in ./dist without rebuilding.
  --dist-dir PATH  Distribution directory (default: ./dist)
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-isolation) NO_ISOLATION='1'; shift ;;
    --skip-build)   SKIP_BUILD='1'; shift ;;
    --dist-dir)     DIST_DIR="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# ── 1. Isolated clean build ──────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == '0' ]]; then
  command -v python3 >/dev/null 2>&1 || fail "python3 is required"
  python3 -c 'import build' 2>/dev/null || fail \
    "python 'build' module missing — run: python3 -m pip install build"

  info "Assembling standalone zero-dependency runtime..."
  node scripts/release/assemble-pip-runtime.js

  info "Verifying MANIFEST.in sync..."
  python3 scripts/release/check_manifest_sync.py

  info "Cleaning previous build outputs..."
  rm -rf "$DIST_DIR" build khy_os.egg-info platform/khy_os.egg-info

  if [[ "$NO_ISOLATION" == '1' ]]; then
    warn "Building WITHOUT isolation (offline mode)."
    python3 -m build --no-isolation --sdist --wheel --outdir "$DIST_DIR"
  else
    info "Building in ISOLATED clean environment..."
    python3 -m build --sdist --wheel --outdir "$DIST_DIR"
  fi
fi

[[ -d "$DIST_DIR" ]] || fail "Distribution directory not found: $DIST_DIR"
info "Auditing built artifacts..."
python3 scripts/release/audit_pip_artifacts.py --dist-dir "$DIST_DIR"
