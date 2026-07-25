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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODE='probe'
DISK=''
PORTABLE_TAR=''
TARGET_MNT='/mnt/khytogo'
EFI_SIZE_MIB=512
ROOT_SIZE_GIB=40
EXECUTE='0'
CONFIRM_DISK=''
ALLOW_SYSTEM_DISK='0'
ALLOW_NON_USB='0'

IMAGE_PATH=''
IMAGE_SIZE_GIB=40
IMAGE_ROOT_SIZE_GIB=30
CONFIRM_IMAGE=''
CONVERT_VMDK='0'
VMDK_PATH=''
SOURCE_ROOT='/'
FORCE_IMAGE='0'

LOOP_DEV=''

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/khytogo/make-khytogo.sh [options]

Modes:
  --mode probe           List candidate disks (default)
  --mode plan            Show the exact layout/steps for a target disk
  --mode create          Partition + clone current system + install bootloader
  --mode usb-plan        Show KHYtoGo plan with USB-only target guard
  --mode usb-create      Create KHYtoGo on USB/portable disk (destructive)
  --mode vmware-plan     Show VMware image layout and build plan
  --mode vmware-create   Build a bootable VMware raw image from current system

Disk mode options:
  --disk <device>           Target disk (e.g. /dev/sdb, /dev/nvme1n1)
  --portable-tar <path>     Optional khy portable tar.gz to copy into /data
  --target-mount <path>     Mount point for target root (default: /mnt/khytogo)
  --efi-size-mib <number>   EFI partition size in MiB (default: 512)
  --root-size-gib <number>  Root partition size in GiB (default: 40)
  --execute                 Actually perform destructive actions
  --confirm-disk <device>   Must exactly match --disk in create mode
  --allow-system-disk       Allow writing to current OS disk (dangerous)
  --allow-non-usb          Allow non-USB transport disks in usb-* modes (dangerous)

VMware image options:
  --image-path <path>         Output raw image path (default: dist/khy-os-vmware.raw)
  --image-size-gib <number>   Total raw image size in GiB (default: 40)
  --image-root-size-gib <n>   Root partition size in GiB (default: 30)
  --confirm-image <path>      Must match --image-path in vmware-create
  --convert-vmdk              Also produce a .vmdk from raw image
  --vmdk-path <path>          Output VMDK path (default: same dir/name as raw)
  --source-root <path>        Source root to clone (default: /)
  --force-image               Overwrite existing image files
  -h, --help                  Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --disk) DISK="${2:-}"; shift 2 ;;
    --portable-tar) PORTABLE_TAR="${2:-}"; shift 2 ;;
    --target-mount) TARGET_MNT="${2:-}"; shift 2 ;;
    --efi-size-mib) EFI_SIZE_MIB="${2:-}"; shift 2 ;;
    --root-size-gib) ROOT_SIZE_GIB="${2:-}"; shift 2 ;;
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
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

resolve_path() {
  local input="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$input"
    return 0
  fi
  if [[ "$input" == /* ]]; then
    echo "$input"
  else
    echo "$(pwd)/$input"
  fi
}

probe_disks() {
  info "Available disks:"
  lsblk -d -o NAME,MODEL,SIZE,TRAN,RM,HOTPLUG,TYPE
  echo
  info "Current root device:"
  findmnt -n -o SOURCE / || true
}

require_disk() {
  [[ -n "$DISK" ]] || fail "--disk is required for mode: $MODE"
  [[ -b "$DISK" ]] || fail "Not a block device: $DISK"
}

disk_part() {
  local dev="$1"
  local idx="$2"
  if [[ "$dev" =~ [0-9]$ ]]; then
    echo "${dev}p${idx}"
  else
    echo "${dev}${idx}"
  fi
}

current_root_disk() {
  local root_src
  root_src="$(findmnt -n -o SOURCE / || true)"
  if [[ -z "$root_src" ]]; then
    return 0
  fi
  local base
  base="$(lsblk -no PKNAME "$root_src" 2>/dev/null | head -n1 || true)"
  if [[ -n "$base" ]]; then
    echo "/dev/$base"
  fi
}

protect_system_disk() {
  local root_disk
  root_disk="$(current_root_disk)"
  if [[ -n "$root_disk" && "$ALLOW_SYSTEM_DISK" != '1' && "$DISK" == "$root_disk" ]]; then
    fail "Refusing to write current system disk ($DISK). Use --allow-system-disk to override."
  fi
}

disk_transport() {
  lsblk -dn -o TRAN "$DISK" 2>/dev/null | head -n1 | tr "[:upper:]" "[:lower:]"
}

protect_usb_transport() {
  if [[ "$ALLOW_NON_USB" == '1' ]]; then
    return 0
  fi

  local transport
  transport="$(disk_transport)"
  if [[ "$transport" != 'usb' ]]; then
    fail "Mode $MODE requires a USB transport target. Detected transport='${transport:-unknown}' for $DISK. Use --allow-non-usb to override."
  fi
}

require_portable_tar_if_set() {
  if [[ -n "$PORTABLE_TAR" && ! -f "$PORTABLE_TAR" ]]; then
    fail "Portable tar not found: $PORTABLE_TAR"
  fi
}

show_plan() {
  require_disk
  if [[ "$MODE" == 'usb-plan' ]]; then
    protect_usb_transport
  fi
  local root_end_mib=$((EFI_SIZE_MIB + ROOT_SIZE_GIB * 1024))

  echo "KHYtoGo plan"
  echo "==========="
  echo "Target disk: $DISK"
  echo "Layout:"
  echo "  1) EFI   FAT32  ${EFI_SIZE_MIB}MiB   label=KHYTOGO_EFI"
  echo "  2) ROOT  EXT4   ${ROOT_SIZE_GIB}GiB  label=KHYTOGO_ROOT"
  echo "  3) DATA  EXT4   remaining space      label=KHYTOGO_DATA"
  echo
  echo "Create commands (summary):"
  echo "  wipefs -a $DISK"
  echo "  parted -s $DISK mklabel gpt"
  echo "  parted -s $DISK mkpart ESP fat32 1MiB ${EFI_SIZE_MIB}MiB"
  echo "  parted -s $DISK set 1 esp on"
  echo "  parted -s $DISK mkpart ROOT ext4 ${EFI_SIZE_MIB}MiB ${root_end_mib}MiB"
  echo "  parted -s $DISK mkpart DATA ext4 ${root_end_mib}MiB 100%"
  echo "  mkfs.vfat -F 32 $(disk_part "$DISK" 1)"
  echo "  mkfs.ext4 -F $(disk_part "$DISK" 2)"
  echo "  mkfs.ext4 -F $(disk_part "$DISK" 3)"
  echo
  echo "Clone commands (summary):"
  echo "  rsync current / -> target ROOT"
  echo "  chroot target and run grub-install + update-grub"
  if [[ -n "$PORTABLE_TAR" ]]; then
    echo "  extract portable package into DATA: $PORTABLE_TAR"
  fi
}

default_image_path() {
  echo "$ROOT_DIR/dist/khy-os-vmware.raw"
}

validate_image_layout() {
  local total_mib=$((IMAGE_SIZE_GIB * 1024))
  local root_end_mib=$((EFI_SIZE_MIB + IMAGE_ROOT_SIZE_GIB * 1024))
  if (( root_end_mib >= total_mib )); then
    fail "Invalid image layout: EFI + ROOT exceeds total image size"
  fi
}

show_vmware_plan() {
  local raw_path
  raw_path="$(resolve_path "${IMAGE_PATH:-$(default_image_path)}")"
  validate_image_layout
  local root_end_mib=$((EFI_SIZE_MIB + IMAGE_ROOT_SIZE_GIB * 1024))
  local vmdk_path=""
  if [[ "$CONVERT_VMDK" == '1' ]]; then
    if [[ -n "$VMDK_PATH" ]]; then
      vmdk_path="$(resolve_path "$VMDK_PATH")"
    else
      vmdk_path="${raw_path%.raw}.vmdk"
    fi
  fi

  echo "KHY VMware image plan"
  echo "====================="
  echo "Source root: $SOURCE_ROOT"
  echo "Raw image:   $raw_path"
  echo "Raw size:    ${IMAGE_SIZE_GIB}GiB"
  echo "Layout:"
  echo "  1) EFI   FAT32  ${EFI_SIZE_MIB}MiB   label=KHYVM_EFI"
  echo "  2) ROOT  EXT4   ${IMAGE_ROOT_SIZE_GIB}GiB  label=KHYVM_ROOT"
  echo "  3) DATA  EXT4   remaining space      label=KHYVM_DATA"
  echo
  echo "Create commands (summary):"
  echo "  truncate -s ${IMAGE_SIZE_GIB}G $raw_path"
  echo "  losetup --find --show -P $raw_path"
  echo "  parted -s <loopdev> mklabel gpt"
  echo "  parted -s <loopdev> mkpart ESP fat32 1MiB ${EFI_SIZE_MIB}MiB"
  echo "  parted -s <loopdev> set 1 esp on"
  echo "  parted -s <loopdev> mkpart ROOT ext4 ${EFI_SIZE_MIB}MiB ${root_end_mib}MiB"
  echo "  parted -s <loopdev> mkpart DATA ext4 ${root_end_mib}MiB 100%"
  echo "  rsync source root -> mounted ROOT"
  echo "  chroot target and install grub (UEFI + BIOS)"
  if [[ "$CONVERT_VMDK" == '1' ]]; then
    echo
    echo "VMDK conversion:"
    echo "  qemu-img convert -f raw -O vmdk $raw_path $vmdk_path"
  fi
}

cleanup_mounts() {
  set +e
  if mountpoint -q "$TARGET_MNT/dev"; then umount -lf "$TARGET_MNT/dev"; fi
  if mountpoint -q "$TARGET_MNT/proc"; then umount -lf "$TARGET_MNT/proc"; fi
  if mountpoint -q "$TARGET_MNT/sys"; then umount -lf "$TARGET_MNT/sys"; fi
  if mountpoint -q "$TARGET_MNT/run"; then umount -lf "$TARGET_MNT/run"; fi
  if mountpoint -q "$TARGET_MNT/boot/efi"; then umount -lf "$TARGET_MNT/boot/efi"; fi
  if mountpoint -q "$TARGET_MNT/data"; then umount -lf "$TARGET_MNT/data"; fi
  if mountpoint -q "$TARGET_MNT"; then umount -lf "$TARGET_MNT"; fi
  set -e
}

detach_loop() {
  set +e
  if [[ -n "$LOOP_DEV" ]] && [[ -b "$LOOP_DEV" ]]; then
    losetup -d "$LOOP_DEV" >/dev/null 2>&1 || true
  fi
  LOOP_DEV=''
  set -e
}

cleanup_all() {
  cleanup_mounts
  detach_loop
}

wait_for_partition() {
  local part="$1"
  local i
  for i in $(seq 1 30); do
    if [[ -b "$part" ]]; then
      return 0
    fi
    sleep 0.2
  done
  fail "Partition device did not appear: $part"
}

generate_fstab() {
  local p1="$1"
  local p2="$2"
  local p3="$3"
  local uuid_efi uuid_root uuid_data
  uuid_efi="$(blkid -s UUID -o value "$p1")"
  uuid_root="$(blkid -s UUID -o value "$p2")"
  uuid_data="$(blkid -s UUID -o value "$p3")"
  cat > "$TARGET_MNT/etc/fstab" <<EOF
UUID=${uuid_root} / ext4 defaults 0 1
UUID=${uuid_efi} /boot/efi vfat umask=0077 0 1
UUID=${uuid_data} /data ext4 defaults 0 2
EOF
}

install_bootloader() {
  local bootloader_id="$1"
  local bios_target="$2"
  info "Installing bootloader inside target..."

  mount --bind /dev "$TARGET_MNT/dev"
  mount --bind /proc "$TARGET_MNT/proc"
  mount --bind /sys "$TARGET_MNT/sys"
  mount --bind /run "$TARGET_MNT/run"

  chroot "$TARGET_MNT" env KHY_BOOT_ID="$bootloader_id" KHY_BIOS_TARGET="$bios_target" bash -c '
set -e
if ! command -v grub-install >/dev/null 2>&1; then
  echo "grub-install not found inside target root" >&2
  exit 1
fi

uefi_ok=0
bios_ok=0

if grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id="$KHY_BOOT_ID" --removable --recheck; then
  uefi_ok=1
fi

if grub-install --target=i386-pc "$KHY_BIOS_TARGET" --recheck; then
  bios_ok=1
fi

if [[ "$uefi_ok" -eq 0 && "$bios_ok" -eq 0 ]]; then
  echo "Both UEFI and BIOS grub-install failed" >&2
  exit 1
fi

if command -v update-grub >/dev/null 2>&1; then
  update-grub
elif command -v grub-mkconfig >/dev/null 2>&1; then
  grub-mkconfig -o /boot/grub/grub.cfg
fi
'
}

clone_source_root() {
  local source_root="$1"
  shift
  local extra_excludes=("$@")

  info "Cloning source root ($source_root) to target root (this may take a while)..."
  local src="$source_root"
  if [[ "$src" != */ ]]; then
    src="${src}/"
  fi

  rsync -aAXH --numeric-ids \
    --exclude '/dev/*' \
    --exclude '/proc/*' \
    --exclude '/sys/*' \
    --exclude '/tmp/*' \
    --exclude '/run/*' \
    --exclude '/mnt/*' \
    --exclude '/media/*' \
    --exclude '/lost+found' \
    --exclude '/swapfile' \
    "${extra_excludes[@]}" \
    "$src" "$TARGET_MNT/"
}

extract_portable_if_any() {
  if [[ -n "$PORTABLE_TAR" ]]; then
    info "Extracting portable payload to /data/khy-portable..."
    mkdir -p "$TARGET_MNT/data/khy-portable"
    tar -xzf "$PORTABLE_TAR" -C "$TARGET_MNT/data/khy-portable"
  fi
}

create_khytogo() {
  require_disk
  require_portable_tar_if_set
  require_cmd lsblk
  require_cmd findmnt
  require_cmd parted
  require_cmd partprobe
  require_cmd wipefs
  require_cmd mkfs.vfat
  require_cmd mkfs.ext4
  require_cmd rsync
  require_cmd blkid
  require_cmd mount
  require_cmd umount
  require_cmd chroot

  [[ "$EXECUTE" == '1' ]] || fail "Create mode requires --execute"
  [[ "$CONFIRM_DISK" == "$DISK" ]] || fail "--confirm-disk must exactly match --disk"
  [[ "$(id -u)" -eq 0 ]] || fail "Create mode must run as root (sudo)"
  protect_system_disk
  if [[ "$MODE" == 'usb-create' ]]; then
    protect_usb_transport
  fi

  trap cleanup_all EXIT

  local root_end_mib=$((EFI_SIZE_MIB + ROOT_SIZE_GIB * 1024))
  info "Unmounting existing partitions on $DISK..."
  while read -r part _; do
    if [[ -n "$part" ]]; then
      umount -lf "/dev/$part" >/dev/null 2>&1 || true
    fi
  done < <(lsblk -ln -o NAME,MOUNTPOINT "$DISK" | tail -n +2)

  info "Wiping partition metadata..."
  wipefs -a "$DISK"
  if command -v sgdisk >/dev/null 2>&1; then
    sgdisk --zap-all "$DISK" || true
  fi

  info "Creating GPT partitions..."
  parted -s "$DISK" mklabel gpt
  parted -s "$DISK" mkpart ESP fat32 1MiB "${EFI_SIZE_MIB}MiB"
  parted -s "$DISK" set 1 esp on
  parted -s "$DISK" mkpart ROOT ext4 "${EFI_SIZE_MIB}MiB" "${root_end_mib}MiB"
  parted -s "$DISK" mkpart DATA ext4 "${root_end_mib}MiB" 100%
  partprobe "$DISK"
  sleep 2

  local p1 p2 p3
  p1="$(disk_part "$DISK" 1)"
  p2="$(disk_part "$DISK" 2)"
  p3="$(disk_part "$DISK" 3)"

  info "Formatting partitions..."
  mkfs.vfat -F 32 -n KHYTOGO_EFI "$p1"
  mkfs.ext4 -F -L KHYTOGO_ROOT "$p2"
  mkfs.ext4 -F -L KHYTOGO_DATA "$p3"

  info "Mounting target filesystem..."
  mkdir -p "$TARGET_MNT"
  mount "$p2" "$TARGET_MNT"
  mkdir -p "$TARGET_MNT/boot/efi" "$TARGET_MNT/data"
  mount "$p1" "$TARGET_MNT/boot/efi"
  mount "$p3" "$TARGET_MNT/data"

  clone_source_root "$SOURCE_ROOT"
  info "Generating target /etc/fstab..."
  generate_fstab "$p1" "$p2" "$p3"
  install_bootloader "KHYtoGo" "$DISK"
  extract_portable_if_any

  cleanup_all
  trap - EXIT

  ok "KHYtoGo disk created successfully on $DISK"
  ok "Next: reboot and choose this disk in BIOS/UEFI boot menu."
}

create_vmware_image() {
  require_portable_tar_if_set
  require_cmd truncate
  require_cmd losetup
  require_cmd parted
  require_cmd partprobe
  require_cmd mkfs.vfat
  require_cmd mkfs.ext4
  require_cmd rsync
  require_cmd blkid
  require_cmd mount
  require_cmd umount
  require_cmd chroot

  [[ "$EXECUTE" == '1' ]] || fail "vmware-create mode requires --execute"
  [[ "$(id -u)" -eq 0 ]] || fail "vmware-create mode must run as root (sudo)"

  local raw_path
  raw_path="$(resolve_path "${IMAGE_PATH:-$(default_image_path)}")"
  [[ "$CONFIRM_IMAGE" == "$raw_path" || "$CONFIRM_IMAGE" == "${IMAGE_PATH:-}" ]] || \
    fail "--confirm-image must exactly match --image-path (or its absolute path)"

  validate_image_layout

  local vmdk_path=""
  if [[ "$CONVERT_VMDK" == '1' ]]; then
    require_cmd qemu-img
    if [[ -n "$VMDK_PATH" ]]; then
      vmdk_path="$(resolve_path "$VMDK_PATH")"
    else
      vmdk_path="${raw_path%.raw}.vmdk"
    fi
  fi

  if [[ -e "$raw_path" && "$FORCE_IMAGE" != '1' ]]; then
    fail "Image already exists: $raw_path (use --force-image to overwrite)"
  fi
  if [[ -n "$vmdk_path" && -e "$vmdk_path" && "$FORCE_IMAGE" != '1' ]]; then
    fail "VMDK already exists: $vmdk_path (use --force-image to overwrite)"
  fi

  trap cleanup_all EXIT
  cleanup_all

  mkdir -p "$(dirname "$raw_path")"
  if [[ -n "$vmdk_path" ]]; then
    mkdir -p "$(dirname "$vmdk_path")"
  fi
  rm -f "$raw_path"
  if [[ -n "$vmdk_path" ]]; then
    rm -f "$vmdk_path"
  fi

  info "Creating sparse raw image: $raw_path (${IMAGE_SIZE_GIB}GiB)"
  truncate -s "${IMAGE_SIZE_GIB}G" "$raw_path"

  LOOP_DEV="$(losetup --find --show -P "$raw_path")"
  info "Loop device attached: $LOOP_DEV"

  local root_end_mib=$((EFI_SIZE_MIB + IMAGE_ROOT_SIZE_GIB * 1024))
  info "Partitioning image..."
  parted -s "$LOOP_DEV" mklabel gpt
  parted -s "$LOOP_DEV" mkpart ESP fat32 1MiB "${EFI_SIZE_MIB}MiB"
  parted -s "$LOOP_DEV" set 1 esp on
  parted -s "$LOOP_DEV" mkpart ROOT ext4 "${EFI_SIZE_MIB}MiB" "${root_end_mib}MiB"
  parted -s "$LOOP_DEV" mkpart DATA ext4 "${root_end_mib}MiB" 100%
  partprobe "$LOOP_DEV" || true
  if command -v udevadm >/dev/null 2>&1; then
    udevadm settle || true
  fi
  sleep 1

  local p1 p2 p3
  p1="$(disk_part "$LOOP_DEV" 1)"
  p2="$(disk_part "$LOOP_DEV" 2)"
  p3="$(disk_part "$LOOP_DEV" 3)"
  wait_for_partition "$p1"
  wait_for_partition "$p2"
  wait_for_partition "$p3"

  info "Formatting image partitions..."
  mkfs.vfat -F 32 -n KHYVM_EFI "$p1"
  mkfs.ext4 -F -L KHYVM_ROOT "$p2"
  mkfs.ext4 -F -L KHYVM_DATA "$p3"

  info "Mounting image filesystem..."
  mkdir -p "$TARGET_MNT"
  mount "$p2" "$TARGET_MNT"
  mkdir -p "$TARGET_MNT/boot/efi" "$TARGET_MNT/data"
  mount "$p1" "$TARGET_MNT/boot/efi"
  mount "$p3" "$TARGET_MNT/data"

  local raw_exclude="/${raw_path#/}"
  local vmdk_exclude=""
  if [[ -n "$vmdk_path" ]]; then
    vmdk_exclude="/${vmdk_path#/}"
  fi
  if [[ -n "$vmdk_exclude" ]]; then
    clone_source_root "$SOURCE_ROOT" --exclude "$raw_exclude" --exclude "$vmdk_exclude"
  else
    clone_source_root "$SOURCE_ROOT" --exclude "$raw_exclude"
  fi

  info "Generating image /etc/fstab..."
  generate_fstab "$p1" "$p2" "$p3"
  install_bootloader "KHYOS" "$LOOP_DEV"
  extract_portable_if_any

  cleanup_mounts
  detach_loop
  trap - EXIT

  if [[ "$CONVERT_VMDK" == '1' ]]; then
    info "Converting raw image to VMDK..."
    qemu-img convert -f raw -O vmdk "$raw_path" "$vmdk_path"
    ok "VMDK image created: $vmdk_path"
  fi

  ok "VMware raw image created: $raw_path"
  ok "In VMware: Create VM -> Use existing disk/image -> select raw/VMDK -> boot with EFI enabled."
}

case "$MODE" in
  probe)
    probe_disks
    ;;
  plan)
    show_plan
    ;;
  usb-plan)
    show_plan
    ;;
  create)
    create_khytogo
    ;;
  usb-create)
    create_khytogo
    ;;
  vmware-plan)
    show_vmware_plan
    ;;
  vmware-create)
    create_vmware_image
    ;;
  *)
    fail "Unsupported mode: $MODE (expected: probe|plan|create|usb-plan|usb-create|vmware-plan|vmware-create)"
    ;;
esac
