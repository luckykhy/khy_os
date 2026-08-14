#!/usr/bin/env bash
# @pattern Command, Visitor
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
DIST_DIR="$ROOT_DIR/dist"
MAX_SIZE_BYTES=1000000000 # 1 GB hard limit (decimal)
DO_BUILD='0'

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release/check-pip-dist-size.sh [options]

Options:
  --build                     Build wheel+sdist before checking
  --dist-dir <path>           Distribution directory (default: ./dist)
  --max-size-bytes <number>   Hard limit in bytes (default: 1000000000)
  -h, --help                  Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      DO_BUILD='1'; shift ;;
    --dist-dir)
      DIST_DIR="${2:-}"; shift 2 ;;
    --max-size-bytes)
      MAX_SIZE_BYTES="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail "Unknown argument: $1" ;;
  esac
done

format_bytes() {
  local bytes="$1"
  awk -v b="$bytes" 'BEGIN{
    split("B KB MB GB TB",u," ");
    i=1;
    while (b>=1024 && i<5) { b/=1024; i++ }
    printf "%.2f%s", b, u[i];
  }'
}

if [[ "$DO_BUILD" == '1' ]]; then
  command -v python3 >/dev/null 2>&1 || fail "python3 is required"
  info "Building Python distributions..."
  (
    cd "$ROOT_DIR"
    python3 -m build --wheel --sdist
  )
fi

[[ -d "$DIST_DIR" ]] || fail "Distribution directory not found: $DIST_DIR"

shopt -s nullglob
artifacts=("$DIST_DIR"/*.whl "$DIST_DIR"/*.tar.gz)
shopt -u nullglob

if [[ "${#artifacts[@]}" -eq 0 ]]; then
  fail "No wheel/sdist artifacts found in: $DIST_DIR"
fi

total_bytes=0
echo
info "Checking pip distribution size limit: $(format_bytes "$MAX_SIZE_BYTES")"
for file in "${artifacts[@]}"; do
  size="$(stat -c%s "$file" 2>/dev/null || wc -c < "$file")"
  total_bytes=$((total_bytes + size))
  if (( size > MAX_SIZE_BYTES )); then
    fail "Artifact too large: $(basename "$file") -> $(format_bytes "$size")"
  fi
  ok "$(basename "$file"): $(format_bytes "$size")"
done

if (( total_bytes > MAX_SIZE_BYTES )); then
  fail "Combined artifact size exceeds limit: $(format_bytes "$total_bytes")"
fi

ok "All artifacts satisfy strict <=1GB rule (single + combined)."
