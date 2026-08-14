#!/usr/bin/env python3
"""Audit built pip artifacts against the shared packaging rules."""

from __future__ import annotations

import argparse
import fnmatch
import shutil
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

from pip_packaging_rules import (
    AUDIT_FORBIDDEN_CLASSIFIER_SUBSTRINGS,
    AUDIT_FORBIDDEN_DIRS,
    AUDIT_FORBIDDEN_FILE_EXEMPT_DIRS,
    AUDIT_FORBIDDEN_FILE_GLOBS,
    AUDIT_FORBIDDEN_REQUIRES_SUBSTRINGS,
    REQUIRED_SDIST_PATHS,
    REQUIRED_WHEEL_PATHS,
)


def _fail(message: str) -> int:
    print(f"[FAIL] {message}", file=sys.stderr)
    return 1


def _ok(message: str) -> None:
    print(f"[OK] {message}")


def _info(message: str) -> None:
    print(f"[INFO] {message}")


def _find_forbidden_dirs(root: Path):
    hits = []
    for path in root.rglob("*"):
        if path.is_dir() and path.name in AUDIT_FORBIDDEN_DIRS:
            hits.append(path)
    return hits


def _find_forbidden_files(root: Path):
    hits = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        # Exempt intentional, audited-by-construction payloads (the encrypted
        # source snapshot under _source/). Its *.enc / *.tar.gz names would
        # otherwise trip the archive globs.
        if any(part in AUDIT_FORBIDDEN_FILE_EXEMPT_DIRS for part in path.parts):
            continue
        rel = path.relative_to(root).as_posix()
        for pattern in AUDIT_FORBIDDEN_FILE_GLOBS:
            if fnmatch.fnmatch(path.name, pattern) or fnmatch.fnmatch(rel, pattern):
                hits.append(path)
                break
    return hits


def _has_required_path(root: Path, required: str) -> bool:
    return any(path.as_posix().endswith(required) for path in root.rglob("*"))


def _find_metadata_files(root: Path):
    """Locate built METADATA (wheel) / PKG-INFO (sdist) descriptor files."""
    hits = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.name == "METADATA" and path.parent.name.endswith(".dist-info"):
            hits.append(path)
        elif path.name == "PKG-INFO":
            hits.append(path)
    return hits


def _audit_metadata_purity(label: str, root: Path) -> int:
    """Fail if package metadata declares khy-quant* deps or financial classifiers.

    Root cause of the "1.8.0" version confusion: cross-package linkage between
    khy-os and the unrelated khy-quant family. A contaminated build must never
    reach a channel, so this gate refuses to pass it.
    """
    metadata_files = _find_metadata_files(root)
    if not metadata_files:
        # No descriptor to inspect — cannot assert purity, treat as a failure so
        # a malformed build never slips through unaudited.
        return _fail(f"{label} has no METADATA/PKG-INFO to audit")

    for meta in metadata_files:
        try:
            text = meta.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:  # pragma: no cover - unreadable descriptor
            return _fail(f"{label} metadata unreadable ({meta.name}): {exc}")
        for raw_line in text.splitlines():
            line = raw_line.strip()
            lowered = line.lower()
            if lowered.startswith("requires-dist:"):
                for needle in AUDIT_FORBIDDEN_REQUIRES_SUBSTRINGS:
                    if needle.lower() in lowered:
                        print(f"  {meta.name}: {line}")
                        return _fail(
                            f"{label} metadata declares forbidden cross-package "
                            f"dependency (matched '{needle}')"
                        )
            elif lowered.startswith("classifier:"):
                for needle in AUDIT_FORBIDDEN_CLASSIFIER_SUBSTRINGS:
                    if needle.lower() in lowered:
                        print(f"  {meta.name}: {line}")
                        return _fail(
                            f"{label} metadata carries forbidden classifier "
                            f"(matched '{needle}')"
                        )

    _ok(f"{label} metadata is free of cross-package/financial contamination")
    return 0


def _audit_tree(label: str, root: Path, required_paths) -> int:
    _info(f"Auditing {label}")

    bad_dirs = _find_forbidden_dirs(root)
    if bad_dirs:
        for hit in bad_dirs[:20]:
            print(f"  {hit}")
        return _fail(f"{label} contains forbidden third-party/build dirs")

    bad_files = _find_forbidden_files(root)
    if bad_files:
        for hit in bad_files[:20]:
            print(f"  {hit}")
        return _fail(f"{label} contains forbidden compiled/binary artifacts")

    missing = [required for required in required_paths if not _has_required_path(root, required)]
    if missing:
        for item in missing:
            print(f"  missing: {item}")
        return _fail(f"{label} is missing required packaging paths")

    rc = _audit_metadata_purity(label, root)
    if rc:
        return rc

    _ok(f"{label} is pure and complete")
    return 0


def _audit_sdist(artifact: Path, workspace: Path) -> int:
    target = workspace / f"{artifact.name}.x"
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(artifact, "r:gz") as tf:
        try:
            tf.extractall(target, filter="data")
        except TypeError:
            tf.extractall(target)
    return _audit_tree(f"sdist {artifact.name}", target, REQUIRED_SDIST_PATHS)


def _audit_wheel(artifact: Path, workspace: Path) -> int:
    target = workspace / f"{artifact.name}.x"
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(artifact) as zf:
        zf.extractall(target)
    return _audit_tree(f"wheel {artifact.name}", target, REQUIRED_WHEEL_PATHS)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", default="dist", help="Directory containing built distributions")
    args = parser.parse_args(argv)

    dist_dir = Path(args.dist_dir).resolve()
    if not dist_dir.is_dir():
        return _fail(f"Distribution directory not found: {dist_dir}")

    sdists = sorted(dist_dir.glob("*.tar.gz"))
    wheels = sorted(dist_dir.glob("*.whl"))
    if not sdists:
        return _fail(f"No sdist (*.tar.gz) found in {dist_dir}")
    if not wheels:
        return _fail(f"No wheel (*.whl) found in {dist_dir}")

    with tempfile.TemporaryDirectory(prefix="khy-pip-audit-") as tmp:
        workspace = Path(tmp)
        for artifact in sdists:
            rc = _audit_sdist(artifact, workspace)
            if rc:
                return rc
        for artifact in wheels:
            rc = _audit_wheel(artifact, workspace)
            if rc:
                return rc

    _ok("Purity audit passed: artifacts are isolated, complete, and dependency-free.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
