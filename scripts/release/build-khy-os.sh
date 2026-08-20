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

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

DO_BUILD='1'
STRICT='0'
PORTABLE_MAX_MB='2048'
VM_IMAGE_SIZE_GIB='32'
VM_ROOT_SIZE_GIB='24'
WITH_NODE_MODULES='0'

declare -a COMPONENTS=()
declare -a DEFAULT_COMPONENTS=('core' 'pip' 'portable' 'vmware-plan')

usage() {
  cat <<'EOF'
Usage:
  bash scripts/build-khy-os.sh [options]

Options:
  --component <name>      Select component (repeatable):
                          core | pip | portable | vmware-plan | moonbit | alpine-iso
  --deps-only             Check required commands and exit
  --strict                Fail on optional component skip/error
  --portable-max-mb <n>   Max portable archive size in MB (default: 2048)
  --vm-image-size-gib <n> VMware raw image total size for plan mode (default: 32)
  --vm-root-size-gib <n>  VMware root partition size for plan mode (default: 24)
  --with-node-modules     Include backend/node_modules in portable package
  -h, --help              Show help

Examples:
  bash scripts/build-khy-os.sh
  bash scripts/build-khy-os.sh --component core --component vmware-plan
  bash scripts/build-khy-os.sh --component moonbit --strict
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --component)
      COMPONENTS+=("${2:-}")
      shift 2
      ;;
    --deps-only)
      DO_BUILD='0'
      shift
      ;;
    --strict)
      STRICT='1'
      shift
      ;;
    --portable-max-mb)
      PORTABLE_MAX_MB="${2:-}"
      shift 2
      ;;
    --vm-image-size-gib)
      VM_IMAGE_SIZE_GIB="${2:-}"
      shift 2
      ;;
    --vm-root-size-gib)
      VM_ROOT_SIZE_GIB="${2:-}"
      shift 2
      ;;
    --with-node-modules)
      WITH_NODE_MODULES='1'
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [[ "${#COMPONENTS[@]}" -eq 0 ]]; then
  COMPONENTS=("${DEFAULT_COMPONENTS[@]}")
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

maybe_fail_or_warn() {
  local msg="$1"
  if [[ "$STRICT" == '1' ]]; then
    fail "$msg"
  else
    warn "$msg"
  fi
}

check_base_deps() {
  require_cmd bash
  require_cmd python3
  require_cmd node
  require_cmd npm
}

run_core() {
  info "[core] Running CLI smoke checks..."
  (
    cd "$ROOT_DIR"
    node services/backend/bin/khy.js help >/dev/null
    python3 -m khy_platform bundle verify --help >/dev/null
  )
  ok "[core] CLI smoke checks passed"
}

run_pip() {
  info "[pip] Building and validating pip artifacts..."
  (
    cd "$ROOT_DIR"
    mkdir -p dist
    python3 -m build --wheel --sdist >/dev/null 2>&1 || python3 setup.py sdist bdist_wheel >/dev/null
    bash scripts/release/check-pip-dist-size.sh >/dev/null
    ls -lh dist
  )
  ok "[pip] pip artifacts are valid"
}

run_portable() {
  info "[portable] Building portable package..."
  local args=(--max-size-mb "$PORTABLE_MAX_MB")
  if [[ "$WITH_NODE_MODULES" == '1' ]]; then
    args+=(--with-node-modules)
  fi
  (
    cd "$ROOT_DIR"
    bash extensions/scripts/khy-portable/build-usb-portable.sh "${args[@]}" >/dev/null
    ls -lh dist/khy-os-portable.tar.gz
  )
  ok "[portable] portable package built"
}

run_vmware_plan() {
  info "[vmware-plan] Verifying VMware image build plan..."
  (
    cd "$ROOT_DIR"
    bash extensions/scripts/khy-portable/khytogo/make-khytogo.sh \
      --mode vmware-plan \
      --image-path dist/khy-os-vmware.raw \
      --image-size-gib "$VM_IMAGE_SIZE_GIB" \
      --image-root-size-gib "$VM_ROOT_SIZE_GIB" \
      --convert-vmdk
  )
  ok "[vmware-plan] VMware image plan ready"
}

run_alpine_iso() {
  info "[alpine-iso] Building Alpine-based KHY OS ISO..."
  if [[ "$(id -u)" -ne 0 ]]; then
    maybe_fail_or_warn "[alpine-iso] Requires root (chroot + mount). Run with sudo."
    return 0
  fi
  (
    cd "$ROOT_DIR"
    bash extensions/scripts/khy-alpine-iso/build-khy-os-iso.sh --output dist/khy-os.iso
    ls -lh dist/khy-os.iso
  )
  ok "[alpine-iso] ISO built successfully"
}

run_moonbit() {
  info "[moonbit] Running MoonBit WASM indicator tests..."
  local moon_linux="${MOONBIT_LINUX_TAR:-}"
  local moon_wasm="${MOONBIT_WASM_TAR:-}"
  if [[ ! -f "$moon_linux" || ! -f "$moon_wasm" ]]; then
    maybe_fail_or_warn "[moonbit] Missing toolchain tar(s). Set MOONBIT_LINUX_TAR and MOONBIT_WASM_TAR."
    return 0
  fi
  (
    cd "$ROOT_DIR"
    bash scripts/moonbit/run-wasm-indicators-tests-offline.sh >/dev/null
  )
  ok "[moonbit] MoonBit WASM tests passed"
}

check_component_deps() {
  local c="$1"
  case "$c" in
    core)
      check_base_deps
      ;;
    pip)
      check_base_deps
      require_cmd ls
      ;;
    portable)
      check_base_deps
      require_cmd tar
      require_cmd du
      ;;
    vmware-plan)
      check_base_deps
      require_cmd parted
      ;;
    moonbit)
      check_base_deps
      require_cmd tar
      ;;
    alpine-iso)
      require_cmd chroot
      require_cmd grub-mkrescue
      ;;
    *)
      fail "Unknown component: $c"
      ;;
  esac
}

run_component() {
  local c="$1"
  case "$c" in
    core) run_core ;;
    pip) run_pip ;;
    portable) run_portable ;;
    vmware-plan) run_vmware_plan ;;
    moonbit) run_moonbit ;;
    alpine-iso) run_alpine_iso ;;
    *) fail "Unknown component: $c" ;;
  esac
}

info "khy OS component build entry"
info "Selected components: ${COMPONENTS[*]}"

for c in "${COMPONENTS[@]}"; do
  check_component_deps "$c"
done
ok "Dependency check passed"

if [[ "$DO_BUILD" != '1' ]]; then
  info "--deps-only enabled; exiting after dependency checks."
  exit 0
fi

for c in "${COMPONENTS[@]}"; do
  run_component "$c"
done

ok "khy OS component build completed"
