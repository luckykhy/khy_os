#!/usr/bin/env bash
# @pattern Command, Template Method
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

rm -rf dist build khy_os.egg-info

# Packaging law: build the distribution in an ISOLATED clean environment so no
# third-party package-management tree from this checkout can leak into the
# artifacts. Set KHY_OFFLINE_BUILD=1 to fall back to the offline path that
# reuses the already-installed build toolchain (no env resolution / network).
if [[ "${KHY_OFFLINE_BUILD:-0}" == "1" ]]; then
  python3 -m build --no-isolation --sdist --wheel
else
  python3 -m build --sdist --wheel
fi

echo "\nBuilt artifacts:"
ls -lh dist
