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

AS='software'
SYSTEM_MODE='probe'
DISK=''
PORTABLE_TAR=''
EXECUTE='0'
CONFIRM_DISK=''
ALLOW_SYSTEM_DISK='0'
ALLOW_NON_USB='0'
IMAGE_PATH=''
IMAGE_SIZE_GIB=''
IMAGE_ROOT_SIZE_GIB=''
CONFIRM_IMAGE=''
CONVERT_VMDK='0'
VMDK_PATH=''
SOURCE_ROOT=''
FORCE_IMAGE='0'
CLI_METHOD='script'
CLI_PROFILE='slim'

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_INSTALLER="$ROOT_DIR/scripts/install/install-khy-cli.sh"
SYSTEM_TOOL="$ROOT_DIR/scripts/khytogo/make-khytogo.sh"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install/install-khy.sh [options]

Dual delivery:
  --as software   Install khy as regular CLI software on existing OS (default)
  --as system     Prepare/create KHYtoGo bootable system disk

Software options:
  --cli-method <auto|pypi|local-pip|npm-link|script>   (default: script)
  --cli-profile <slim|full>                            (default: slim)

System options:
  --system-mode <probe|plan|create|usb-plan|usb-create|vmware-plan|vmware-create|alpine-iso|alpine-disk> (default: probe)
  --disk <device>                                      target disk for plan/create
  --portable-tar <path>                                optional portable payload
  --execute                                            required for create
  --confirm-disk <device>                              must match --disk in create
  --allow-system-disk                                  dangerous override
  --allow-non-usb                                     allow non-USB targets in usb-* modes (dangerous)
  --image-path <path>                                  output raw path for vmware-create
  --image-size-gib <number>                            total raw size for vmware-create
  --image-root-size-gib <number>                       root partition size for vmware-create
  --confirm-image <path>                               must match --image-path in vmware-create
  --convert-vmdk                                       also produce .vmdk
  --vmdk-path <path>                                   custom VMDK output path
  --source-root <path>                                 source root to clone (default /)
  --force-image                                        overwrite existing image files

Examples:
  # Install as software
  bash scripts/install/install-khy.sh --as software --cli-method script --cli-profile slim

  # Probe disks for KHYtoGo
  sudo bash scripts/install/install-khy.sh --as system --system-mode probe

  # Plan KHYtoGo layout
  # Plan KHYtoGo layout with USB transport guard
  sudo bash scripts/install/install-khy.sh --as system --system-mode usb-plan --disk /dev/sdb
  sudo bash scripts/install/install-khy.sh --as system --system-mode plan --disk /dev/sdb

  # Create KHYtoGo (destructive)
  # Create KHYtoGo on USB/portable disk (destructive, USB transport enforced)
  sudo bash scripts/install/install-khy.sh --as system --system-mode usb-create --disk /dev/sdb \
    --execute --confirm-disk /dev/sdb
  sudo bash scripts/install/install-khy.sh --as system --system-mode create --disk /dev/sdb \
    --execute --confirm-disk /dev/sdb --portable-tar dist/khy-os-portable.tar.gz

  # Build VMware bootable image
  sudo bash scripts/install/install-khy.sh --as system --system-mode vmware-create \
    --image-path dist/khy-os-vmware.raw --image-size-gib 32 --image-root-size-gib 24 \
    --execute --confirm-image dist/khy-os-vmware.raw --convert-vmdk

  # Build Alpine-based KHY OS ISO
  sudo bash scripts/install/install-khy.sh --as system --system-mode alpine-iso

  # Write Alpine-based KHY OS to disk
  sudo bash scripts/install/install-khy.sh --as system --system-mode alpine-disk \
    --disk /dev/sdb --execute --confirm-disk /dev/sdb
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --as) AS="${2:-}"; shift 2 ;;
    --system-mode) SYSTEM_MODE="${2:-}"; shift 2 ;;
    --disk) DISK="${2:-}"; shift 2 ;;
    --portable-tar) PORTABLE_TAR="${2:-}"; shift 2 ;;
    --execute) EXECUTE='1'; shift ;;
    --confirm-disk) CONFIRM_DISK="${2:-}"; shift 2 ;;
    --allow-system-disk) ALLOW_SYSTEM_DISK='1'; shift ;;
    --allow-non-usb) ALLOW_NON_USB='1'; shift ;;
    --image-path) IMAGE_PATH="${2:-}"; shift 2 ;;
    --image-size-gib) IMAGE_SIZE_GIB="${2:-}"; shift 2 ;;
    --image-root-size-gib) IMAGE_ROOT_SIZE_GIB="${2:-}"; shift 2 ;;
    --confirm-image) CONFIRM_IMAGE="${2:-}"; shift 2 ;;
    --convert-vmdk) CONVERT_VMDK='1'; shift ;;
    --vmdk-path) VMDK_PATH="${2:-}"; shift 2 ;;
    --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
    --force-image) FORCE_IMAGE='1'; shift ;;
    --cli-method) CLI_METHOD="${2:-}"; shift 2 ;;
    --cli-profile) CLI_PROFILE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

if [[ "$AS" == 'software' ]]; then
  [[ -f "$CLI_INSTALLER" ]] || fail "Missing CLI installer: $CLI_INSTALLER"
  info "Installing as software CLI..."
  bash "$CLI_INSTALLER" --method "$CLI_METHOD" --profile "$CLI_PROFILE"
  ok "Software installation flow completed"
  exit 0
fi

if [[ "$AS" == 'system' ]]; then
  [[ -f "$SYSTEM_TOOL" ]] || fail "Missing system tool: $SYSTEM_TOOL"
  # Alpine-based modes use a different build script
  if [[ "$SYSTEM_MODE" == 'alpine-iso' ]]; then
    info "Building Alpine-based KHY OS ISO..."
    ISO_SCRIPT="$ROOT_DIR/scripts/alpine/build-khy-os-iso.sh"
    [[ -f "$ISO_SCRIPT" ]] || fail "Missing ISO builder: $ISO_SCRIPT"
    ISO_ARGS=()
    [[ -n "$IMAGE_PATH" ]] && ISO_ARGS+=(--output "$IMAGE_PATH")
    [[ -n "$ALPINE_MIRROR" ]] && ISO_ARGS+=(--mirror "$ALPINE_MIRROR")
    bash "$ISO_SCRIPT" "${ISO_ARGS[@]}"
    ok "Alpine ISO build completed"
    exit 0
  fi

  if [[ "$SYSTEM_MODE" == 'alpine-disk' ]]; then
    info "Creating Alpine-based KHY OS bootable disk..."
    # Step 1: build rootfs via ISO script with --keep-rootfs
    ISO_SCRIPT="$ROOT_DIR/scripts/alpine/build-khy-os-iso.sh"
    [[ -f "$ISO_SCRIPT" ]] || fail "Missing ISO builder: $ISO_SCRIPT"
    ALPINE_ROOTFS="/tmp/khy-os-alpine-rootfs"
    bash "$ISO_SCRIPT" --keep-rootfs --output /dev/null || fail "Alpine rootfs build failed"
    [[ -d "$ALPINE_ROOTFS" ]] || fail "Alpine rootfs not found at $ALPINE_ROOTFS"
    # Step 2: delegate to make-khytogo with --source-root pointing to Alpine rootfs
    SYSTEM_MODE='create'
    SOURCE_ROOT="${ALPINE_ROOTFS}"
    info "Delegating to KHYtoGo with Alpine rootfs..."
  fi

  info "Running KHYtoGo system tool..."
  CMD=(bash "$SYSTEM_TOOL" --mode "$SYSTEM_MODE")

  if [[ -n "$DISK" ]]; then
    CMD+=(--disk "$DISK")
  fi
  if [[ -n "$PORTABLE_TAR" ]]; then
    CMD+=(--portable-tar "$PORTABLE_TAR")
  fi
  if [[ "$EXECUTE" == '1' ]]; then
    CMD+=(--execute)
  fi
  if [[ -n "$CONFIRM_DISK" ]]; then
    CMD+=(--confirm-disk "$CONFIRM_DISK")
  fi
  if [[ "$ALLOW_SYSTEM_DISK" == '1' ]]; then
    CMD+=(--allow-system-disk)
  fi
  if [[ "$ALLOW_NON_USB" == '1' ]]; then
    CMD+=(--allow-non-usb)
  fi
  if [[ -n "$IMAGE_PATH" ]]; then
    CMD+=(--image-path "$IMAGE_PATH")
  fi
  if [[ -n "$IMAGE_SIZE_GIB" ]]; then
    CMD+=(--image-size-gib "$IMAGE_SIZE_GIB")
  fi
  if [[ -n "$IMAGE_ROOT_SIZE_GIB" ]]; then
    CMD+=(--image-root-size-gib "$IMAGE_ROOT_SIZE_GIB")
  fi
  if [[ -n "$CONFIRM_IMAGE" ]]; then
    CMD+=(--confirm-image "$CONFIRM_IMAGE")
  fi
  if [[ "$CONVERT_VMDK" == '1' ]]; then
    CMD+=(--convert-vmdk)
  fi
  if [[ -n "$VMDK_PATH" ]]; then
    CMD+=(--vmdk-path "$VMDK_PATH")
  fi
  if [[ -n "$SOURCE_ROOT" ]]; then
    CMD+=(--source-root "$SOURCE_ROOT")
  fi
  if [[ "$FORCE_IMAGE" == '1' ]]; then
    CMD+=(--force-image)
  fi

  "${CMD[@]}"
  ok "System flow completed"
  exit 0
fi

fail "Unsupported --as value: $AS (expected software|system)"
