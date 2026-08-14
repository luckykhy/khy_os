#!/usr/bin/env bash
# @pattern Command, Template Method
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

MOONBIT_LINUX_TAR="${MOONBIT_LINUX_TAR:-}"
MOONBIT_WASM_TAR="${MOONBIT_WASM_TAR:-}"
MOON_DENY_WARN="${MOON_DENY_WARN:-true}"

TOOLCHAIN_DIR="${ROOT_DIR}/.tmp/moonbit-linux"
WASM_SDK_DIR="${ROOT_DIR}/.tmp/moonbit-wasm"
CORE_DIR="${ROOT_DIR}/.tmp/moonbit-core/core"

if [[ -z "${MOONBIT_LINUX_TAR}" ]] || [[ ! -f "${MOONBIT_LINUX_TAR}" ]]; then
  echo "Error: MoonBit Linux toolchain tar not found." >&2
  echo "       Set MOONBIT_LINUX_TAR to the path of moonbit-linux-x86_64.tar.gz" >&2
  exit 1
fi

if [[ -z "${MOONBIT_WASM_TAR}" ]] || [[ ! -f "${MOONBIT_WASM_TAR}" ]]; then
  echo "Error: MoonBit WASM tar not found." >&2
  echo "       Set MOONBIT_WASM_TAR to the path of moonbit-wasm.tar.gz" >&2
  exit 1
fi

echo "[1/5] Extract MoonBit Linux toolchain..."
rm -rf "${TOOLCHAIN_DIR}"
mkdir -p "${TOOLCHAIN_DIR}"
tar -xzf "${MOONBIT_LINUX_TAR}" -C "${TOOLCHAIN_DIR}"
chmod +x "${TOOLCHAIN_DIR}/bin/"* || true

echo "[2/5] Extract MoonBit WASM SDK + core sources..."
rm -rf "${WASM_SDK_DIR}" "${ROOT_DIR}/.tmp/moonbit-core"
mkdir -p "${WASM_SDK_DIR}" "${ROOT_DIR}/.tmp/moonbit-core"
tar -xzf "${MOONBIT_WASM_TAR}" -C "${WASM_SDK_DIR}"
tar -xzf "${WASM_SDK_DIR}/core.tar.gz" -C "${ROOT_DIR}/.tmp/moonbit-core"

echo "[3/5] Build local moonbitlang/core for wasm-gc (offline)..."
PATH="${TOOLCHAIN_DIR}/bin:${PATH}" moon -C "${CORE_DIR}" build --target wasm-gc --release -q

echo "[4/5] Prepare core bundle compatibility layout..."
ln -sfn "${CORE_DIR}/_build/wasm-gc/release/build" "${CORE_DIR}/_build/wasm-gc/release/bundle"
PATH="${TOOLCHAIN_DIR}/bin:${PATH}" moonc bundle-core \
  $(find "${CORE_DIR}/_build/wasm-gc/release/build" -mindepth 2 -maxdepth 2 -name '*.core' | sort) \
  -o "${CORE_DIR}/_build/wasm-gc/release/bundle/core.core"

echo "[5/5] Run MoonBit indicator tests..."
DENY_WARN_FLAG=""
if [[ "${MOON_DENY_WARN}" == "true" ]]; then
  DENY_WARN_FLAG="--deny-warn"
fi

MOON_CORE_OVERRIDE="${CORE_DIR}" \
PATH="${TOOLCHAIN_DIR}/bin:${PATH}" \
moon -C "${ROOT_DIR}/backend/wasm-indicators" check ${DENY_WARN_FLAG} -q

MOON_CORE_OVERRIDE="${CORE_DIR}" \
PATH="${TOOLCHAIN_DIR}/bin:${PATH}" \
moon -C "${ROOT_DIR}/backend/wasm-indicators" test ${DENY_WARN_FLAG} -q

echo ""
echo "Done."
echo "Toolchain: ${TOOLCHAIN_DIR}/bin"
echo "Core override: ${CORE_DIR}"
