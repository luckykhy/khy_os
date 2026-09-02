#!/usr/bin/env python3
"""Verify that MANIFEST.in matches the generated packaging rules."""

from __future__ import annotations

import difflib
import sys
from pathlib import Path

#PYTHONSAFEPATH (or `python -P`) omits the script directory from sys.path,
# breaking the sibling import below. Make the import location-independent.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pip_packaging_rules import render_manifest  # noqa: E402


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    manifest_path = root / "MANIFEST.in"
    expected = render_manifest()
    actual = manifest_path.read_text(encoding="utf-8") if manifest_path.exists() else ""

    if actual == expected:
        print("MANIFEST.in is in sync with scripts/release/pip_packaging_rules.py")
        return 0

    print("MANIFEST.in is out of sync. Re-run: python3 scripts/release/render_manifest.py")
    diff = difflib.unified_diff(
        actual.splitlines(),
        expected.splitlines(),
        fromfile="MANIFEST.in",
        tofile="MANIFEST.in.expected",
        lineterm="",
    )
    for line in diff:
        print(line)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
