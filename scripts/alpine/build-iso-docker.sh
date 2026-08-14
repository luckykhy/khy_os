#!/usr/bin/env bash
# @pattern Command, Template Method
# ──────────────────────────────────────────────────────────────────
# build-iso-docker.sh — Build KHY OS ISO via Docker (cross-platform)
#
# Works on Windows (Docker Desktop + Git Bash / PowerShell),
# macOS, and Linux without requiring root or chroot support.
#
# Usage:
#   bash scripts/alpine/build-iso-docker.sh [--output path] [--no-cache]
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${ROOT_DIR}/dist/khy-os.iso"
DOCKER_NOCACHE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)   OUTPUT="${2:-}"; shift 2 ;;
    --no-cache) DOCKER_NOCACHE="--no-cache"; shift ;;
    -h|--help)
      echo "Usage: bash scripts/alpine/build-iso-docker.sh [--output path] [--no-cache]"
      exit 0
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# Docker bind mount must use an absolute host path.
# Relative --output paths (e.g. dist/khy-os.iso) would otherwise be treated as
# named volumes and the ISO would not appear in the workspace.
if [[ "$OUTPUT" != /* ]]; then
  OUTPUT="${PWD}/${OUTPUT}"
fi

command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Desktop first."
docker info >/dev/null 2>&1 || fail "Docker daemon is not running."

OUT_DIR="$(dirname "$OUTPUT")"
OUT_NAME="$(basename "$OUTPUT")"
mkdir -p "$OUT_DIR"

IMAGE_TAG="khy-iso-builder:latest"

info "Building Docker image (${IMAGE_TAG})..."
docker build $DOCKER_NOCACHE \
  -t "$IMAGE_TAG" \
  -f "${ROOT_DIR}/scripts/alpine/Dockerfile.iso-builder" \
  "$ROOT_DIR" 2>&1 | tail -20

info "Running ISO build inside container (--privileged for chroot/mount)..."
docker run --rm --privileged \
  -v "${OUT_DIR}:/out" \
  "$IMAGE_TAG" \
  --output "/out/${OUT_NAME}"

if [[ -f "$OUTPUT" ]]; then
  ISO_SIZE="$(du -sh "$OUTPUT" | cut -f1)"
  ok "ISO built successfully: ${OUTPUT} (${ISO_SIZE})"
  echo ""
  info "To test:"
  info "  qemu-system-x86_64 -cdrom ${OUTPUT} -m 512M -serial stdio"
  info "  # Or import into VMware / VirtualBox"
else
  fail "ISO build failed — output file not found"
fi
