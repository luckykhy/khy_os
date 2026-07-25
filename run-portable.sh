#!/usr/bin/env bash
# @pattern Command, Template Method
set -euo pipefail

# =============================================================================
# run-portable.sh - Build a portable copy of Khy-OS (Linux/macOS)
# Copies the project to a target directory, ready to run via ./khy.sh
# =============================================================================

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
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Defaults ---
TARGET_DIR=""
WITH_NODE_MODULES=0
MIRROR_MODE=0
DRY_RUN=0

usage() {
    cat <<'EOF'
Usage:
  bash run-portable.sh --target <dir> [options]

Options:
  --target, -t <dir>     Target directory (required)
  --with-node-modules    Include services/backend/node_modules (copy-and-run ready)
  --mirror               Mirror mode: delete target files not in source
  --dry-run              Show what would be copied without making changes
  --help, -h             Show this help

Examples:
  bash run-portable.sh --target /mnt/usb/khy-os
  bash run-portable.sh --target ~/khy-portable --with-node-modules
  bash run-portable.sh --target /mnt/usb/khy-os --mirror --with-node-modules
EOF
}

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target|-t)
            [[ -z "${2:-}" ]] && fail "Missing value for --target"
            TARGET_DIR="$2"; shift 2 ;;
        --with-node-modules)
            WITH_NODE_MODULES=1; shift ;;
        --mirror)
            MIRROR_MODE=1; shift ;;
        --dry-run)
            DRY_RUN=1; shift ;;
        --help|-h)
            usage; exit 0 ;;
        *)
            fail "Unknown argument: $1" ;;
    esac
done

# --- Validate target ---
[[ -z "$TARGET_DIR" ]] && { echo -e "${RED}[ERROR]${NC} Missing required argument: --target"; echo; usage; exit 1; }

# Resolve to absolute path
TARGET_DIR="$(cd "$(dirname "$TARGET_DIR")" 2>/dev/null && echo "$(pwd)/$(basename "$TARGET_DIR")" || echo "$TARGET_DIR")"
# Handle case where target doesn't exist yet
if [[ ! -d "$TARGET_DIR" ]]; then
    PARENT="$(dirname "$TARGET_DIR")"
    if [[ -d "$PARENT" ]]; then
        TARGET_DIR="$(cd "$PARENT" && pwd)/$(basename "$TARGET_DIR")"
    fi
fi

# Resolve ROOT_DIR to absolute
ROOT_DIR_ABS="$(cd "$ROOT_DIR" && pwd)"
TARGET_ABS="$(dirname "$TARGET_DIR")/$(basename "$TARGET_DIR")"
if [[ "$ROOT_DIR_ABS" == "$TARGET_ABS" ]]; then
    fail "Target directory cannot be the same as the source directory"
fi

echo
echo " ========================================"
echo "  Khy-OS Portable Build"
echo " ========================================"
echo
echo "  Source:  $ROOT_DIR"
echo "  Target:  $TARGET_DIR"
if [[ "$WITH_NODE_MODULES" == "1" ]]; then
    echo "  Node modules: Include (copy-and-run ready)"
else
    echo "  Node modules: Exclude (first boot will auto-install)"
fi
if [[ "$MIRROR_MODE" == "1" ]]; then
    echo "  Mode: Mirror (target will match source exactly)"
else
    echo "  Mode: Copy (additive, won't delete target extras)"
fi
echo

# --- Check if target exists and has content ---
if [[ -d "$TARGET_DIR" ]] && [ "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
    if [[ "$MIRROR_MODE" == "0" ]]; then
        warn "Target directory already has content. Files will be merged."
        echo "       Use --mirror to make an exact copy (deletes extra files in target)."
        read -rp "Continue? (Y/n): " CONFIRM
        [[ "${CONFIRM,,}" == "n" ]] && { echo "Aborted."; exit 0; }
    else
        warn "--mirror mode: files in target not present in source will be DELETED."
        read -rp "Continue? (Y/n): " CONFIRM
        [[ "${CONFIRM,,}" == "n" ]] && { echo "Aborted."; exit 0; }
    fi
fi

# --- Build rsync command ---
# rsync is the standard tool on Linux/macOS (equivalent to robocopy on Windows)
RSYNC_FLAGS=(-a --info=progress2)

# Base exclusions
EXCLUDES=(--exclude='.git' --exclude='__pycache__' --exclude='.tmp' --exclude='dist')

if [[ "$WITH_NODE_MODULES" == "0" ]]; then
    EXCLUDES+=(--exclude='node_modules')
fi

if [[ "$MIRROR_MODE" == "1" ]]; then
    RSYNC_FLAGS+=(--delete)
fi

if [[ "$DRY_RUN" == "1" ]]; then
    RSYNC_FLAGS+=(--dry-run)
    info "DRY-RUN: Showing what would be copied (no actual changes)"
    echo
fi

# --- Execute copy ---
info "Copying project files..."
rsync "${RSYNC_FLAGS[@]}" "${EXCLUDES[@]}" "$ROOT_DIR/" "$TARGET_DIR/"

# --- Post-copy cleanup: remove non-portable runtime payloads ---
if [[ "$DRY_RUN" == "0" ]]; then
    rm -rf "$TARGET_DIR/services/backend/models" 2>/dev/null || true
    rm -rf "$TARGET_DIR/services/backend/bin/llama-cpp" 2>/dev/null || true
    rm -rf "$TARGET_DIR/services/backend/bin/ollama-runner" 2>/dev/null || true

    # Ensure khy.sh is executable
    chmod +x "$TARGET_DIR/khy.sh" 2>/dev/null || true
fi

# --- Verify critical files ---
if [[ "$DRY_RUN" == "0" ]]; then
    echo
    info "Verifying critical files..."
    VERIFY_OK=1

    for f in \
        "khy.bat" \
        "khy.sh" \
        "software/khyquant/khy_quant/cli.py" \
        "services/backend/bin/khy.js" \
        "services/backend/package.json" \
        "portable.md"; do
        if [[ -f "$TARGET_DIR/$f" ]]; then
            echo -e "  ${GREEN}[OK]${NC}   $f"
        else
            echo -e "  ${RED}[MISS]${NC} $f"
            VERIFY_OK=0
        fi
    done

    if [[ "$VERIFY_OK" == "0" ]]; then
        echo
        warn "Some critical files are missing. The portable copy may be incomplete."
    else
        echo
        ok "All critical files verified."
    fi
fi

echo
echo " ========================================"
if [[ "$DRY_RUN" == "1" ]]; then
    echo "  Dry run complete. No files were changed."
else
    echo "  Portable build complete!"
fi
echo " ========================================"
echo
if [[ "$DRY_RUN" == "0" ]]; then
    echo "  To start:  cd $TARGET_DIR && ./khy.sh"
    echo "  Data dir:  $TARGET_DIR/.khyquant-data/"
    echo
    echo "  Prerequisites: Python 3.8+ and Node.js 20+ must be in PATH"
    if [[ "$WITH_NODE_MODULES" == "0" ]]; then
        echo "  Note: First launch will auto-run npm install (requires network)"
    fi
fi
echo
