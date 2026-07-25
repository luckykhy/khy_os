#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# khy.sh - Linux/macOS launcher for Khy-OS CLI
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Detect Python 3.8+ ---
PYTHON_CMD=""

for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
        version=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
        major="${version%%.*}"
        minor="${version##*.}"
        if [ "$major" -ge 3 ] 2>/dev/null; then
            if [ "$major" -gt 3 ] || [ "$minor" -ge 8 ]; then
                PYTHON_CMD="$cmd"
                break
            fi
        fi
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "[ERROR] 检测 Python 3.8+ 失败：未在 PATH 中找到 python"
    echo "请安装 Python 3.8+: https://www.python.org/downloads/"
    exit 1
fi

# --- Detect Node.js 20+ ---
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] 检测 Node.js 20+ 失败：未在 PATH 中找到 node"
    echo "请安装 Node.js 20+: https://nodejs.org/"
    exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"

if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
    echo "[ERROR] 检测 Node.js 20+ 失败：当前版本 ${NODE_VERSION} 过低（需要 v20+）"
    echo "请升级 Node.js: https://nodejs.org/"
    exit 1
fi

# --- Set environment variables ---
export KHYQUANT_PORTABLE_ROOT="$SCRIPT_DIR"
export KHYQUANT_DATA_HOME="${KHYQUANT_DATA_HOME:-$SCRIPT_DIR/.khyquant-data}"
export PYTHONPATH="$SCRIPT_DIR/software/khyquant:${PYTHONPATH:-}"

# --- Launch CLI ---
exec "$PYTHON_CMD" -m khy_quant.cli "$@"
