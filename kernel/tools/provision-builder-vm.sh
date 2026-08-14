#!/usr/bin/env bash
# Provision the QEMU Linux builder-VM appliance for `khy os build`.
#
# Why this exists: on Windows without WSL, the QEMU that khy-os already requires
# can boot a tiny Linux builder VM, share the kernel source over virtio-9p, and
# run the *unchanged* `make iso` there. The appliance image is intentionally NOT
# shipped in the pip/npm package (keeps the package small, and the goal is
# "absent until provisioned"). This script builds the appliance once on a host
# that has libguestfs `virt-builder`; afterward copy the qcow2 to the target
# machine's khyos cache dir (or point KHY_KERNEL_BUILD_VM at it) and
# `khy os build` works there with no WSL.
#
# Boot/build contract honored by the appliance (see khyos.js _buildViaQemu):
#   - boots as a normal bootable qcow2 via `-drive file=<img>,format=qcow2,if=virtio`
#   - kernel cmdline carries `console=ttyS0 [KHY_MAKE_VARS="..."]` via `-append`
#     (only effective with direct-kernel boot; for disk boot the firstboot script
#      reads KHY_MAKE_VARS from /proc/cmdline if present, else builds with defaults)
#   - on EVERY boot runs /khy-build.sh (via a systemd service) which:
#       mounts the virtio-9p share tagged `khykernel` at /kernel,
#       runs `make -C /kernel $KHY_MAKE_VARS iso`,
#       then powers off (so the host's spawnSync returns).
#     It must run every boot (not firstboot-once) because khyos.js boots the
#     appliance fresh for each `khy os build` invocation.
#   - because /kernel IS the host kernel dir, build/<ISO> lands on the host.
#
# Usage:
#   kernel/tools/provision-builder-vm.sh [OUTPUT_QCOW2] [BASE_DISTRO]
# Defaults: OUTPUT=$HOME/.khyquant/khyos/builder/khyos-builder.qcow2  BASE=debian-12
#
# Requirements (host running THIS script): virt-builder (libguestfs-tools).
#   Debian/Ubuntu: apt-get install libguestfs-tools
#   Fedora:        dnf install libguestfs-tools-c
# virt-builder produces a genuinely bootable image (kernel + bootloader inside),
# unlike a bare rootfs tarball — required for `-drive` boot to work.

set -euo pipefail

OUT="${1:-$HOME/.khyquant/khyos/builder/khyos-builder.qcow2}"
BASE="${2:-debian-12}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$(dirname "$OUT")"

if ! command -v virt-builder >/dev/null 2>&1; then
  echo "ERROR: virt-builder not found (package: libguestfs-tools)." >&2
  echo "       Install it, or build the appliance manually following" >&2
  echo "       docs/07_OPS_运维/[OPS-MAN-036] §QEMU builder-VM backend." >&2
  exit 1
fi

echo "==> Provisioning khyos builder appliance ($BASE) → $OUT"

# In-guest build agent. POSIX sh so it runs on any minimal base. Invoked on
# EVERY boot by the systemd unit below (khyos.js boots the appliance fresh per
# build, so a firstboot-once hook would only ever build once).
cat > "$WORK/khy-build.sh" <<'GUEST'
#!/bin/sh
set -e
exec > /dev/ttyS0 2>&1 || true
mkdir -p /kernel
# virtio-9p share exported by QEMU with mount_tag=khykernel (see khyos.js).
mount -t 9p -o trans=virtio,version=9p2000.L,msize=262144 khykernel /kernel || {
  echo "FATAL: cannot mount 9p share 'khykernel'"; poweroff -f; }
# Optional toolchain overrides forwarded on the kernel cmdline.
KHY_MAKE_VARS=""
for tok in $(cat /proc/cmdline 2>/dev/null); do
  case "$tok" in KHY_MAKE_VARS=*) KHY_MAKE_VARS="${tok#KHY_MAKE_VARS=}";; esac
done
echo "==> Building kernel ISO inside builder VM (make -C /kernel $KHY_MAKE_VARS iso)"
# shellcheck disable=SC2086
make -C /kernel $KHY_MAKE_VARS iso || echo "make iso FAILED (see output above)"
sync
poweroff -f
GUEST

# systemd unit that runs the build agent on every boot, after the network/fs are
# up enough to load the 9p module. The agent itself powers the VM off.
cat > "$WORK/khy-builder.service" <<'UNIT'
[Unit]
Description=KHY OS kernel builder (9p share -> make iso -> poweroff)
After=local-fs.target
DefaultDependencies=no

[Service]
Type=oneshot
ExecStartPre=/sbin/modprobe 9pnet_virtio
ExecStart=/khy-build.sh
StandardOutput=tty
StandardError=tty

[Install]
WantedBy=multi-user.target
UNIT

# Build a bootable appliance carrying exactly the kernel toolchain the Makefile
# needs (mirrors Dockerfile.kernel-build), plus the per-boot build agent.
# MoonBit is fetched during image build (--run-command); the build agent runs
# every boot via the installed systemd service.
virt-builder "$BASE" \
  --output "$OUT" \
  --format qcow2 \
  --size 6G \
  --update \
  --install build-essential,nasm,binutils,grub-pc-bin,grub-common,xorriso,mtools,curl,ca-certificates \
  --run-command 'curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash || true' \
  --append-line '/root/.bashrc:export PATH=/root/.moon/bin:$PATH' \
  --upload "$WORK/khy-build.sh:/khy-build.sh" \
  --chmod '0755:/khy-build.sh' \
  --upload "$WORK/khy-builder.service:/etc/systemd/system/khy-builder.service" \
  --run-command 'systemctl enable khy-builder.service'

echo "==> Done. Bootable appliance: $OUT"
echo "    Copy it to the target machine's <khyosCacheDir>/builder/khyos-builder.qcow2,"
echo "    or set KHY_KERNEL_BUILD_VM=<path> there. Then: khy os build"
