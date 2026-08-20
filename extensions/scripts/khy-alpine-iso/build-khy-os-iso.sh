#!/usr/bin/env bash
# @pattern Command, Template Method
# ──────────────────────────────────────────────────────────────────
# build-khy-os-iso.sh — Build a bootable KHY OS ISO based on Alpine Linux
#
# Creates a self-contained ISO that boots directly into the KHY OS CLI.
# Structure: Linux kernel → initramfs → OpenRC → khy-os-backend + console
#
# Usage:
#   sudo bash extensions/scripts/khy-alpine-iso/build-khy-os-iso.sh [options]
#
# Options:
#   --arch <x86_64|aarch64>       Target architecture (default: x86_64)
#   --alpine-version <3.23>       Alpine base version (default: 3.23)
#   --output <path>               Output ISO path (default: dist/khy-os.iso)
#   --mirror <url>                Alpine mirror URL
#   --keep-rootfs                 Don't delete staging rootfs after build
#   --skip-npm-install            Skip npm install (use pre-built node_modules)
#   -h, --help                    Show help
# ──────────────────────────────────────────────────────────────────
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

# ── Defaults ────────────────────────────────────────────────────────
ARCH="x86_64"
ALPINE_VERSION="3.23"
# Use China mirror by default; override with --mirror for other regions
MIRROR="https://mirrors.tuna.tsinghua.edu.cn/alpine"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${ROOT_DIR}/dist/khy-os.iso"
KEEP_ROOTFS=0
SKIP_NPM=0
STAGING=""

# ── Parse arguments ─────────────────────────────────────────────────
usage() {
  sed -n '/^# Usage:/,/^# ────/p' "$0" | sed 's/^# //' | head -n -1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)           ARCH="$2"; shift 2 ;;
    --alpine-version) ALPINE_VERSION="$2"; shift 2 ;;
    --output)         OUTPUT="$2"; shift 2 ;;
    --mirror)         MIRROR="$2"; shift 2 ;;
    --keep-rootfs)    KEEP_ROOTFS=1; shift ;;
    --skip-npm-install) SKIP_NPM=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                fail "Unknown option: $1" ;;
  esac
done

# ── Preflight ───────────────────────────────────────────────────────
[[ "$(id -u)" -eq 0 ]] || fail "This script must be run as root (need chroot + mount)"

for cmd in wget tar chroot mount umount grub-mkrescue xorriso mksquashfs; do
  if ! command -v "$cmd" &>/dev/null; then
    # xorriso is needed by grub-mkrescue; mksquashfs optional
    if [[ "$cmd" == "mksquashfs" ]]; then
      warn "mksquashfs not found — squashfs compression will be skipped"
    else
      fail "Required command not found: $cmd (install it first)"
    fi
  fi
done

ALPINE_BRANCH="v${ALPINE_VERSION}"
# Alpine minirootfs tarballs use three-part version (e.g. 3.23.0).
# Strip any existing patch level from user-provided version and append .0.
ALPINE_PATCHED="${ALPINE_VERSION}"
if [[ "${ALPINE_PATCHED}" =~ ^[0-9]+\.[0-9]+$ ]]; then
  ALPINE_PATCHED="${ALPINE_PATCHED}.0"
fi
MINIROOTFS_URL="${MIRROR}/${ALPINE_BRANCH}/releases/${ARCH}/alpine-minirootfs-${ALPINE_PATCHED}-${ARCH}.tar.gz"

info "KHY OS ISO Builder"
info "  Alpine: ${ALPINE_BRANCH} (${ARCH})"
info "  Mirror: ${MIRROR}"
info "  Output: ${OUTPUT}"

# ── Step 1: Download Alpine minirootfs ──────────────────────────────
STAGING="$(mktemp -d /tmp/khy-os-rootfs.XXXXXX)"
ROOTFS="${STAGING}/rootfs"
ISODIR="${STAGING}/isofiles"
mkdir -p "${ROOTFS}" "${ISODIR}/boot/grub"

TARBALL="${STAGING}/alpine-minirootfs.tar.gz"
if [[ -f "${ROOT_DIR}/.cache/alpine-minirootfs-${ALPINE_VERSION}.0-${ARCH}.tar.gz" ]]; then
  info "Using cached minirootfs"
  cp "${ROOT_DIR}/.cache/alpine-minirootfs-${ALPINE_VERSION}.0-${ARCH}.tar.gz" "${TARBALL}"
else
  info "Downloading Alpine minirootfs..."
  wget -q --show-progress -O "${TARBALL}" "${MINIROOTFS_URL}" \
    || fail "Failed to download minirootfs from ${MINIROOTFS_URL}"
  mkdir -p "${ROOT_DIR}/.cache"
  cp "${TARBALL}" "${ROOT_DIR}/.cache/alpine-minirootfs-${ALPINE_VERSION}.0-${ARCH}.tar.gz"
fi

info "Extracting minirootfs..."
tar xzf "${TARBALL}" -C "${ROOTFS}"
ok "Minirootfs extracted ($(du -sh "${ROOTFS}" | cut -f1))"

# ── Step 2: Configure Alpine inside chroot ──────────────────────────
info "Configuring Alpine repositories..."
cat > "${ROOTFS}/etc/apk/repositories" <<EOF
${MIRROR}/${ALPINE_BRANCH}/main
${MIRROR}/${ALPINE_BRANCH}/community
EOF

# Bind-mount for chroot
# Use --make-rslave so unmounting inside chroot doesn't affect the host
mount --bind /dev  "${ROOTFS}/dev"
mount --make-rslave "${ROOTFS}/dev"
mount -t proc proc "${ROOTFS}/proc"
mount -t sysfs sys "${ROOTFS}/sys"
# Mount a NEW devpts instance inside chroot to avoid clobbering host /dev/pts
mount -t devpts devpts "${ROOTFS}/dev/pts" -o newinstance,gid=5,mode=620,ptmxmode=666

# Copy DNS config so chroot can resolve hostnames
cp -L /etc/resolv.conf "${ROOTFS}/etc/resolv.conf" 2>/dev/null || true

# Bootstrap CA certificates so apk can verify TLS
chroot "${ROOTFS}" apk --no-cache add ca-certificates 2>/dev/null || \
  cp -a /etc/ssl/certs "${ROOTFS}/etc/ssl/" 2>/dev/null || true

cleanup() {
  info "Cleaning up mounts..."
  # CRITICAL: Must unmount ALL bind-mounts before rm -rf, otherwise
  # rm will destroy host /dev nodes (ptmx, null, etc.) through the
  # bind-mount, breaking the host system.
  umount -lf "${ROOTFS}/proc"    2>/dev/null || true
  umount -lf "${ROOTFS}/sys"     2>/dev/null || true
  umount -lf "${ROOTFS}/dev/pts" 2>/dev/null || true
  umount -lf "${ROOTFS}/dev"     2>/dev/null || true

  # Safety check: refuse to rm if /dev is still mounted
  if mountpoint -q "${ROOTFS}/dev" 2>/dev/null; then
    warn "WARNING: ${ROOTFS}/dev is still mounted! Skipping rm to protect host."
    warn "Manual cleanup needed: sudo umount -lf ${ROOTFS}/dev && sudo rm -rf ${STAGING}"
    return 1
  fi

  if [[ "${KEEP_ROOTFS}" -eq 0 && -n "${STAGING}" ]]; then
    rm -rf "${STAGING}"
  else
    info "Rootfs preserved at: ${ROOTFS}"
  fi
}
trap cleanup EXIT

info "Installing runtime packages..."
chroot "${ROOTFS}" apk update

# Install non-GRUB packages first (these must succeed)
chroot "${ROOTFS}" apk add --no-cache \
  linux-lts \
  nodejs npm \
  python3 py3-pip \
  sqlite-dev sqlite-libs \
  openrc \
  busybox-openrc \
  e2fsprogs \
  alpine-base \
  build-base \
  || fail "apk install failed"

# GRUB triggers fail in chroot (grub-probe: cannot find a device for /).
# This is expected — we build the ISO with grub-mkrescue on the host.
chroot "${ROOTFS}" apk add --no-cache grub grub-bios grub-efi 2>&1 \
  | grep -v 'grub-probe.*error' || true

ok "Packages installed ($(chroot "${ROOTFS}" apk info 2>/dev/null | wc -l) packages)"

# ── Step 3: Install KHY OS application ──────────────────────────────
info "Installing KHY OS application..."

KHY_DEST="${ROOTFS}/opt/khy-os"
mkdir -p "${KHY_DEST}"

# Copy backend (exclude heavy optional components)
rsync -a --exclude='node_modules' \
         --exclude='bin/llama-cpp' \
         --exclude='bin/ollama-runner' \
         --exclude='models'       \
         --exclude='ml/models'    \
         --exclude='ml/data'      \
         --exclude='data'         \
         --exclude='*.log'        \
         --exclude='temp'         \
         --exclude='logs'         \
         --exclude='*.db'         \
         --exclude='*.sqlite'     \
         --exclude='.khy_quant_bootstrapped' \
  "${ROOT_DIR}/backend/" "${KHY_DEST}/backend/"

# Copy shared package
mkdir -p "${KHY_DEST}/packages/shared"
rsync -a --exclude='node_modules' \
  "${ROOT_DIR}/packages/shared/" "${KHY_DEST}/packages/shared/"

# Copy Python launcher
rsync -a "${ROOT_DIR}/khy_quant/" "${KHY_DEST}/khy_quant/" 2>/dev/null || true
cp "${ROOT_DIR}/pyproject.toml"   "${KHY_DEST}/" 2>/dev/null || true

# Copy root package.json for workspace resolution
cp "${ROOT_DIR}/package.json" "${KHY_DEST}/" 2>/dev/null || true

# npm install inside chroot (production only)
if [[ "${SKIP_NPM}" -eq 0 ]]; then
  info "Running npm install (production, this may take a while)..."
  chroot "${ROOTFS}" sh -c "
    cd /opt/khy-os/backend && \
    npm install --omit=dev --omit=optional --no-audit --no-fund 2>&1 | tail -5
  " || warn "npm install had errors (continuing)"
  # Rebuild native modules for musl
  chroot "${ROOTFS}" sh -c "
    cd /opt/khy-os/backend && \
    npm rebuild better-sqlite3 --build-from-source 2>&1 | tail -3
  " || warn "better-sqlite3 rebuild failed"
  # Also install shared package dependencies
  chroot "${ROOTFS}" sh -c "
    cd /opt/khy-os/packages/shared && \
    npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
  " || true
fi

ok "KHY OS application installed ($(du -sh "${KHY_DEST}" | cut -f1))"

# ── Step 4: Install OpenRC service files ────────────────────────────
info "Installing OpenRC services..."

cp "${ROOT_DIR}/extensions/scripts/khy-alpine-iso/rootfs/etc/init.d/khy-os-backend"  "${ROOTFS}/etc/init.d/"
cp "${ROOT_DIR}/extensions/scripts/khy-alpine-iso/rootfs/etc/init.d/khy-os-console"  "${ROOTFS}/etc/init.d/"
chmod +x "${ROOTFS}/etc/init.d/khy-os-backend" "${ROOTFS}/etc/init.d/khy-os-console"

mkdir -p "${ROOTFS}/etc/conf.d"
cp "${ROOT_DIR}/extensions/scripts/khy-alpine-iso/rootfs/etc/conf.d/khy-os-backend"  "${ROOTFS}/etc/conf.d/"

mkdir -p "${ROOTFS}/etc/logrotate.d"
cp "${ROOT_DIR}/extensions/scripts/khy-alpine-iso/rootfs/etc/logrotate.d/khy-os"     "${ROOTFS}/etc/logrotate.d/"

# Enable services in default runlevel
chroot "${ROOTFS}" rc-update add khy-os-backend default 2>/dev/null || \
  ln -sf /etc/init.d/khy-os-backend "${ROOTFS}/etc/runlevels/default/khy-os-backend"
chroot "${ROOTFS}" rc-update add khy-os-console default 2>/dev/null || \
  ln -sf /etc/init.d/khy-os-console "${ROOTFS}/etc/runlevels/default/khy-os-console"

# Create data directories
mkdir -p "${ROOTFS}/var/lib/khy-os" "${ROOTFS}/var/log/khy-os"

# Generate a random JWT_SECRET for the ISO
# /dev/urandom may not be accessible inside the build environment
JWT_SECRET="$(head -c 48 /dev/urandom 2>/dev/null | base64 | tr -d '\n')" || \
JWT_SECRET="$(openssl rand -base64 48 2>/dev/null | tr -d '\n')" || \
JWT_SECRET="$(python3 -c 'import secrets,base64;print(base64.b64encode(secrets.token_bytes(48)).decode(),end="")')"
sed -i "s|CHANGE_ME_ON_FIRST_BOOT_generate_with_urandom|${JWT_SECRET}|" \
  "${ROOTFS}/etc/conf.d/khy-os-backend"

ok "OpenRC services installed and enabled"

# ── Step 5: Configure boot ──────────────────────────────────────────
info "Configuring bootloader..."

# Copy kernel and initramfs from the chroot
KERNEL_VERSION="$(ls "${ROOTFS}/boot/" | grep -oP 'vmlinuz-\K.*' | head -1)"
if [[ -z "${KERNEL_VERSION}" ]]; then
  # Fallback: find any vmlinuz
  KERNEL_VERSION="lts"
fi

cp "${ROOTFS}/boot/vmlinuz-${KERNEL_VERSION}" "${ISODIR}/boot/vmlinuz" 2>/dev/null || \
  cp "${ROOTFS}/boot/vmlinuz-lts"             "${ISODIR}/boot/vmlinuz" 2>/dev/null || \
  fail "No kernel found in rootfs"

# Generate initramfs if not present
if [[ -f "${ROOTFS}/boot/initramfs-${KERNEL_VERSION}" ]]; then
  cp "${ROOTFS}/boot/initramfs-${KERNEL_VERSION}" "${ISODIR}/boot/initramfs"
elif [[ -f "${ROOTFS}/boot/initramfs-lts" ]]; then
  cp "${ROOTFS}/boot/initramfs-lts" "${ISODIR}/boot/initramfs"
else
  warn "No initramfs found — generating minimal one"
  chroot "${ROOTFS}" mkinitfs -o /boot/initramfs "${KERNEL_VERSION}" 2>/dev/null || true
  cp "${ROOTFS}/boot/initramfs" "${ISODIR}/boot/initramfs" 2>/dev/null || \
    fail "Failed to generate initramfs"
fi

# Create squashfs of the rootfs (excluding boot and dev/proc/sys)
if command -v mksquashfs &>/dev/null; then
  info "Creating squashfs rootfs image..."
  mksquashfs "${ROOTFS}" "${ISODIR}/boot/rootfs.squashfs" \
    -e boot dev proc sys run tmp \
    -comp zstd -Xcompression-level 3 \
    -noappend -no-exports \
    2>&1 | tail -3
  ok "Squashfs created ($(du -sh "${ISODIR}/boot/rootfs.squashfs" | cut -f1))"
  BOOT_APPEND="root=live:LABEL=KHY-OS rootfstype=squashfs"
else
  warn "mksquashfs not available — using direct rootfs copy"
  BOOT_APPEND="root=/dev/sr0"
fi

# GRUB configuration — supports BIOS, UEFI, and VMware
cat > "${ISODIR}/boot/grub/grub.cfg" <<'GRUBCFG'
set timeout=3
set default=0

# Detect UEFI vs BIOS
if [ "${grub_platform}" = "efi" ]; then
    insmod efi_gop
    insmod efi_uga
else
    insmod vbe
    insmod vga
fi

insmod gzio
insmod part_gpt
insmod part_msdos

menuentry "KHY OS" {
    linux  /boot/vmlinuz modules=loop,squashfs,overlay quiet nomodeset
    initrd /boot/initramfs
}

menuentry "KHY OS (VMware / Hyper-V)" {
    linux  /boot/vmlinuz modules=loop,squashfs,overlay,vmw_vmci,vmxnet3,vmw_pvscsi quiet nomodeset
    initrd /boot/initramfs
}

menuentry "KHY OS (verbose)" {
    linux  /boot/vmlinuz modules=loop,squashfs,overlay console=tty0 console=ttyS0,115200
    initrd /boot/initramfs
}

menuentry "KHY OS (safe graphics)" {
    linux  /boot/vmlinuz modules=loop,squashfs,overlay nomodeset xdriver=vesa
    initrd /boot/initramfs
}
GRUBCFG

ok "Boot configuration ready (BIOS + UEFI + VMware)"

# ── Step 6: Build ISO ───────────────────────────────────────────────
info "Building ISO image..."
mkdir -p "$(dirname "${OUTPUT}")"

grub-mkrescue -o "${OUTPUT}" "${ISODIR}" \
  -volid "KHY-OS" \
  -- -volid "KHY-OS" 2>&1 | tail -5

if [[ -f "${OUTPUT}" ]]; then
  ISO_SIZE="$(du -sh "${OUTPUT}" | cut -f1)"
  ok "ISO built successfully: ${OUTPUT} (${ISO_SIZE})"
  echo ""
  info "To test with QEMU:"
  info "  qemu-system-x86_64 -cdrom ${OUTPUT} -m 512M -serial stdio"
  info "  qemu-system-x86_64 -cdrom ${OUTPUT} -m 512M -nographic  # serial console"
else
  fail "ISO build failed — output file not found"
fi
