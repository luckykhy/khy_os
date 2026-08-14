#!/usr/bin/env python3
# @pattern Command
"""Generate a pip-only part manifest with deterministic naming and hashes."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

STRICT_PIP_MAX_SIZE_BYTES = 1_000_000_000
DEFAULT_PART_SIZE_MB = 256
SCHEMA_VERSION = "1.0.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a pip-only artifact part manifest. "
            "The manifest defines part naming, package naming, offsets, sizes, and SHA256 hashes."
        )
    )
    parser.add_argument(
        "--artifact",
        required=True,
        help="Path to source artifact (for example: khy-os-1.8.0.iso, model.gguf, rootfs.img).",
    )
    parser.add_argument(
        "--artifact-id",
        required=True,
        help="Logical artifact id (for example: khy-os-image or qwen3.5-4b).",
    )
    parser.add_argument(
        "--version",
        required=True,
        help="Distribution version (for example: 1.8.0).",
    )
    parser.add_argument(
        "--kind",
        default="generic",
        choices=("iso", "img", "model", "generic"),
        help="Artifact kind. Used for metadata only.",
    )
    parser.add_argument(
        "--package-prefix",
        required=True,
        help=(
            "pip package prefix for parts "
            "(for example: khy-os-image-part, khy-os-model-qwen35-4b-part)."
        ),
    )
    parser.add_argument(
        "--part-size-mb",
        type=int,
        default=DEFAULT_PART_SIZE_MB,
        help=f"Part size in MB, default: {DEFAULT_PART_SIZE_MB}.",
    )
    parser.add_argument(
        "--output",
        default="dist/pip-manifests/manifest.json",
        help="Output manifest path.",
    )
    return parser.parse_args()


def fail(msg: str, code: int = 2) -> None:
    print(f"[FAIL] {msg}", file=sys.stderr)
    raise SystemExit(code)


def normalize_package_name(name: str) -> str:
    # PEP 503 normalization style for safety and consistency.
    normalized = re.sub(r"[-_.]+", "-", name.lower()).strip("-")
    return normalized


def validate_package_prefix(package_prefix: str) -> str:
    normalized = normalize_package_name(package_prefix)
    if not normalized:
        fail("Package prefix is empty after normalization.")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", normalized):
        fail(
            "Package prefix is invalid. "
            "Allowed pattern after normalization: [a-z0-9]+(?:-[a-z0-9]+)*"
        )
    return normalized


def check_part_size(part_size_mb: int) -> int:
    if part_size_mb <= 0:
        fail("--part-size-mb must be greater than 0.")
    part_size_bytes = part_size_mb * 1024 * 1024
    if part_size_bytes >= STRICT_PIP_MAX_SIZE_BYTES:
        fail(
            "--part-size-mb is too large. "
            f"Part size must stay below strict pip max {STRICT_PIP_MAX_SIZE_BYTES} bytes."
        )
    return part_size_bytes


def build_part_record(
    index: int,
    offset: int,
    chunk_size: int,
    chunk_sha256: str,
    package_prefix: str,
    package_version: str,
    artifact_filename: str,
) -> Dict[str, Any]:
    index4 = f"{index:04d}"
    package_name = f"{package_prefix}-{index4}"
    part_filename = f"{artifact_filename}.part-{index4}.bin"
    return {
        "index": index,
        "index4": index4,
        "offset_bytes": offset,
        "size_bytes": chunk_size,
        "sha256": chunk_sha256,
        "package_name": package_name,
        "package_version": package_version,
        "part_filename": part_filename,
    }


def generate_manifest(
    artifact_path: Path,
    artifact_id: str,
    version: str,
    kind: str,
    package_prefix: str,
    part_size_bytes: int,
) -> Dict[str, Any]:
    if not artifact_path.exists() or not artifact_path.is_file():
        fail(f"Artifact file does not exist: {artifact_path}")

    artifact_size_bytes = artifact_path.stat().st_size
    if artifact_size_bytes == 0:
        fail(f"Artifact file is empty: {artifact_path}")

    parts: List[Dict[str, Any]] = []
    artifact_hasher = hashlib.sha256()

    with artifact_path.open("rb") as fh:
        offset = 0
        index = 1
        while True:
            chunk = fh.read(part_size_bytes)
            if not chunk:
                break
            artifact_hasher.update(chunk)
            chunk_sha256 = hashlib.sha256(chunk).hexdigest()
            part_record = build_part_record(
                index=index,
                offset=offset,
                chunk_size=len(chunk),
                chunk_sha256=chunk_sha256,
                package_prefix=package_prefix,
                package_version=version,
                artifact_filename=artifact_path.name,
            )
            parts.append(part_record)
            offset += len(chunk)
            index += 1

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "distribution_channel": "pip-only",
        "constraints": {
            "max_package_size_bytes": STRICT_PIP_MAX_SIZE_BYTES,
            "recommended_part_size_bytes": part_size_bytes,
            "part_size_unit": "bytes",
        },
        "artifact": {
            "id": artifact_id,
            "version": version,
            "kind": kind,
            "filename": artifact_path.name,
            "size_bytes": artifact_size_bytes,
            "sha256": artifact_hasher.hexdigest(),
        },
        "naming": {
            "package_prefix": package_prefix,
            "package_name_pattern": f"{package_prefix}-{{index4}}",
            "part_filename_pattern": f"{artifact_path.name}.part-{{index4}}.bin",
            "index_format": "4-digit zero-padded",
            "index_start": 1,
        },
        "parts": parts,
    }
    return manifest


def write_manifest(manifest: Dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    artifact_path = Path(args.artifact).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()

    package_prefix = validate_package_prefix(args.package_prefix)
    part_size_bytes = check_part_size(args.part_size_mb)

    manifest = generate_manifest(
        artifact_path=artifact_path,
        artifact_id=args.artifact_id.strip(),
        version=args.version.strip(),
        kind=args.kind,
        package_prefix=package_prefix,
        part_size_bytes=part_size_bytes,
    )
    write_manifest(manifest, output_path)

    print(f"[OK] Manifest generated: {output_path}")
    print(f"[OK] Artifact: {manifest['artifact']['filename']} ({manifest['artifact']['size_bytes']} bytes)")
    print(f"[OK] Parts: {len(manifest['parts'])} | Prefix: {manifest['naming']['package_prefix']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
