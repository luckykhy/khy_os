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

if ! command -v lsblk >/dev/null 2>&1; then
  fail "lsblk is required"
fi

echo "khy OS boot capability probe"
echo "============================"

if [[ -d /sys/firmware/efi ]]; then
  ok "Boot mode: UEFI"
else
  warn "Boot mode: Legacy BIOS (CSM)"
fi

echo
info "Disks and partitions:"
lsblk -o NAME,SIZE,TYPE,FSTYPE,PARTLABEL,PARTUUID,MOUNTPOINTS

echo
if [[ -d /sys/firmware/efi ]]; then
  if command -v efibootmgr >/dev/null 2>&1; then
    info "UEFI boot entries:"
    if ! efibootmgr -v; then
      warn "Unable to read EFI entries (try sudo efibootmgr -v)"
    fi
  else
    warn "efibootmgr not found. Install it to inspect UEFI entries:"
    warn "  sudo apt-get install -y efibootmgr"
  fi
fi

echo
info "WTG-style recommendation:"
echo "  1) Use a dedicated target disk for khy OS base system."
echo "  2) Keep an independent EFI partition on that target disk."
echo "  3) Select boot disk from BIOS/UEFI boot menu (F12/Esc/F8 depending on vendor)."
echo "  4) Install khy CLI after OS install:"
echo "       bash scripts/install/install-khy-cli.sh --method script"

