#!/usr/bin/env bash
# @pattern Command, Template Method
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
OUTPUT_TAR="$ROOT_DIR/dist/khy-os-portable.tar.gz"
MAX_SIZE_MB=2048
WITH_NODE_MODULES='0'

usage() {
  cat <<'EOF'
Usage:
  bash extensions/scripts/khy-portable/build-usb-portable.sh [options]

Options:
  --output <path>            Output tar.gz path
  --max-size-mb <number>     Maximum allowed archive size in MB (default: 2048)
  --with-node-modules        Include services/backend/node_modules (larger size)
  -h, --help                 Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT_TAR="${2:-}"; shift 2 ;;
    --max-size-mb)
      MAX_SIZE_MB="${2:-}"; shift 2 ;;
    --with-node-modules)
      WITH_NODE_MODULES='1'; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail "Unknown argument: $1" ;;
  esac
done

command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v du >/dev/null 2>&1 || fail "du is required"

MAX_SIZE_BYTES=$((MAX_SIZE_MB * 1024 * 1024))
TMP_DIR="$(mktemp -d /tmp/khy-portable.XXXXXX)"
STAGE_DIR="$TMP_DIR/khy-os-portable"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

info "Preparing portable stage dir: $STAGE_DIR"
mkdir -p "$STAGE_DIR"

# Root portable launchers
cp -a "$ROOT_DIR/khy.bat" "$STAGE_DIR/"
cp -a "$ROOT_DIR/khy.sh" "$STAGE_DIR/"
chmod +x "$STAGE_DIR/khy.sh"

# Python CLI entry
mkdir -p "$STAGE_DIR/software/khyquant"
cp -a "$ROOT_DIR/software/khyquant/khy_quant" "$STAGE_DIR/software/khyquant/"
cp -a "$ROOT_DIR/software/khyquant/pyproject.toml" "$STAGE_DIR/software/khyquant/" 2>/dev/null || true

# Node.js backend
mkdir -p "$STAGE_DIR/services/backend"
cp -a "$ROOT_DIR/services/backend/bin" "$STAGE_DIR/services/backend/"
cp -a "$ROOT_DIR/services/backend/src" "$STAGE_DIR/services/backend/"
cp -a "$ROOT_DIR/services/backend/scripts" "$STAGE_DIR/services/backend/"
cp -a "$ROOT_DIR/services/backend/package.json" "$STAGE_DIR/services/backend/"
cp -a "$ROOT_DIR/services/backend/package-lock.json" "$STAGE_DIR/services/backend/" 2>/dev/null || true

# Portable scripts (PATH wrappers installer + legacy portable CLI)
mkdir -p "$STAGE_DIR/scripts/portable"
cp -a "$ROOT_DIR/extensions/scripts/khy-portable/install-path-wrappers.sh" "$STAGE_DIR/extensions/scripts/khy-portable/"
cp -a "$ROOT_DIR/extensions/scripts/khy-portable/install-path-wrappers.bat" "$STAGE_DIR/extensions/scripts/khy-portable/"
cp -a "$ROOT_DIR/extensions/scripts/khy-portable/install-portable-cli.sh" "$STAGE_DIR/extensions/scripts/khy-portable/" 2>/dev/null || true

mkdir -p "$STAGE_DIR/scripts/install"
cp -a "$ROOT_DIR/extensions/scripts/khy-installer/install-khy-cli.sh" "$STAGE_DIR/extensions/scripts/khy-installer/" 2>/dev/null || true

# Documentation
cp -a "$ROOT_DIR/PORTABLE.md" "$STAGE_DIR/" 2>/dev/null || true
cp -a "$ROOT_DIR/README.md" "$STAGE_DIR/" 2>/dev/null || true

if [[ "$WITH_NODE_MODULES" == '1' ]]; then
  if [[ -d "$ROOT_DIR/services/backend/node_modules" ]]; then
    info "Including services/backend/node_modules (size may increase significantly)"
    cp -a "$ROOT_DIR/services/backend/node_modules" "$STAGE_DIR/services/backend/"
  else
    warn "services/backend/node_modules not found; skipping"
  fi
fi

# Remove non-portable or oversized runtime payloads.
rm -rf "$STAGE_DIR/services/backend/models" 2>/dev/null || true
rm -rf "$STAGE_DIR/services/backend/bin/llama-cpp" 2>/dev/null || true
rm -rf "$STAGE_DIR/services/backend/bin/ollama-runner" 2>/dev/null || true

STAGE_SIZE_BYTES="$(du -sb "$STAGE_DIR" | awk '{print $1}')"
info "Stage size: ${STAGE_SIZE_BYTES} bytes"
if (( STAGE_SIZE_BYTES > MAX_SIZE_BYTES )); then
  fail "Stage exceeds max size (${MAX_SIZE_MB} MB). Try without --with-node-modules."
fi

mkdir -p "$(dirname "$OUTPUT_TAR")"
tar -C "$TMP_DIR" -czf "$OUTPUT_TAR" "khy-os-portable"

ARCHIVE_SIZE_BYTES="$(stat -c%s "$OUTPUT_TAR" 2>/dev/null || wc -c < "$OUTPUT_TAR")"
info "Archive size: ${ARCHIVE_SIZE_BYTES} bytes"
if (( ARCHIVE_SIZE_BYTES > MAX_SIZE_BYTES )); then
  rm -f "$OUTPUT_TAR"
  fail "Archive exceeds max size (${MAX_SIZE_MB} MB). Build aborted."
fi

ok "Portable archive created: $OUTPUT_TAR"
ok "Size limit check passed (<= ${MAX_SIZE_MB} MB)"
