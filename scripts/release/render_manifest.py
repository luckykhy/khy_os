#!/usr/bin/env python3
"""Render MANIFEST.in from the shared pip packaging rules."""

from __future__ import annotations

from pathlib import Path

from pip_packaging_rules import render_manifest


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    manifest_path = root / "MANIFEST.in"
    manifest_path.write_text(render_manifest(), encoding="utf-8")
    print(f"Rendered {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
