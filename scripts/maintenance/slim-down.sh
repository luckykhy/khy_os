#!/usr/bin/env bash
# @pattern Command
# ============================================================
#  Khy OS - Slim Down (one-shot size reduction)
#  Deletes build artifacts, logs, temp files and unused
#  platform binaries. Safe: everything removed here can be
#  regenerated (logs, build output) or is unused (llama CUDA).
# ============================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=========================================="
echo "  Khy OS Slim Down"
echo "  Root: $PROJECT_ROOT"
echo "=========================================="
echo

# Warn if a Khy-OS runtime is active (sqlite/db files may be locked).
if pgrep -f "khy\.js|khy_platform" >/dev/null 2>&1; then
    warn "Khy-OS runtime processes detected. Stop them first or locked files will be skipped."
    warn "  e.g.  pkill -f 'khy.js' ; pkill -f 'khy_platform'"
    echo
fi

FREED_MB=0
count_size() { # count_size <path> -> adds size to FREED_MB
    local path="$1"
    if [[ -e "$path" ]]; then
        local bytes
        bytes=$(du -sk "$path" 2>/dev/null | awk '{print $1}')
        FREED_MB=$((FREED_MB + (bytes / 1024)))
    fi
}

# --- 1. Application logs (regenerated at runtime) ---
if [[ -d "$PROJECT_ROOT/platform/packages/shared/logs" ]]; then
    info "[1/5] Cleaning application logs..."
    count_size "$PROJECT_ROOT/platform/packages/shared/logs"
    rm -rf "$PROJECT_ROOT/platform/packages/shared/logs"
    mkdir -p "$PROJECT_ROOT/platform/packages/shared/logs"
    ok "       Done."
fi

# --- 2. SQLite WAL / SHM temp files ---
info "[2/5] Cleaning sqlite temp files (wal/shm)..."
while IFS= read -r -d '' f; do
    local_size=0
    if [[ -e "$f" ]]; then
        local_size=$(du -k "$f" 2>/dev/null | awk '{print $1}')
    fi
    if rm -f "$f" 2>/dev/null; then
        FREED_MB=$((FREED_MB + (local_size / 1024)))
    fi
done < <(find "$PROJECT_ROOT" \
    \( -name '*.sqlite-wal' -o -name '*.sqlite-shm' \
       -o -name '*.db-wal' -o -name '*.db-shm' \) \
    -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 2>/dev/null)
ok "       Done."

# --- 3. Kernel build output (.o objects + disk images) ---
if [[ -d "$PROJECT_ROOT/kernel/build" ]]; then
    info "[3/5] Cleaning kernel build artifacts..."
    rm -f "$PROJECT_ROOT"/kernel/build/*.o \
          "$PROJECT_ROOT"/kernel/build/khy-a7b-disk.img \
          "$PROJECT_ROOT"/kernel/build/khy-a8-disk.img \
          "$PROJECT_ROOT"/kernel/build/khy-brain-disk.img
    for pattern in \
        "$PROJECT_ROOT"/kernel/build/*.o \
        "$PROJECT_ROOT"/kernel/build/khy-a7b-disk.img \
        "$PROJECT_ROOT"/kernel/build/khy-a8-disk.img \
        "$PROJECT_ROOT"/kernel/build/khy-brain-disk.img; do
        [[ -e "$pattern" ]] || continue
        local_size=$(du -k "$pattern" 2>/dev/null | awk '{print $1}')
        FREED_MB=$((FREED_MB + (local_size / 1024)))
    done
    ok "       Done."
fi

# --- 4. Old dist zip archives ---
if [[ -d "$PROJECT_ROOT/dist" ]]; then
    info "[4/5] Cleaning old dist archives..."
    for zip in "$PROJECT_ROOT"/dist/*.zip; do
        [[ -e "$zip" ]] || continue
        local_size=$(du -k "$zip" 2>/dev/null | awk '{print $1}')
        rm -f "$zip"
        FREED_MB=$((FREED_MB + (local_size / 1024)))
    done
    ok "       Done."
fi

# --- 5. Unused node-llama-cpp platform binaries (keep win-x64) ---
#     Two install layouts: root hoisted (workspaces) and legacy backend-local.
for llama in \
    "$PROJECT_ROOT/node_modules/@node-llama-cpp" \
    "$PROJECT_ROOT/services/backend/node_modules/@node-llama-cpp"; do
    if [[ -d "$llama" ]]; then
        info "[5/5] Pruning unused llama platform binaries in $(basename "$(dirname "$llama")")/$(basename "$llama") ..."
        for d in win-arm64 win-x64-cuda win-x64-cuda-ext win-x64-vulkan; do
            if [[ -d "$llama/$d" ]]; then
                count_size "$llama/$d"
                rm -rf "$llama/$d"
                ok "       Removed $d"
            fi
        done
        ok "       Done."
    fi
done

echo
echo "=========================================="
echo "  Slim Down Complete."
echo "  Approx freed: $FREED_MB MB"
echo "=========================================="
echo
