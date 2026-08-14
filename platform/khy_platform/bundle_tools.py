# @pattern Template Method
"""Bundle verification and repair tools for pip-only split distribution."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    from importlib import metadata as importlib_metadata
except ImportError:  # pragma: no cover
    import importlib_metadata  # type: ignore


def _is_sha256(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{64}", str(value or "").lower()))


def _hash_file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _load_manifest(manifest_path: Path) -> Dict[str, Any]:
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest_path}")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    parts = data.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ValueError("Invalid manifest: parts must be a non-empty list")
    return data


def _find_payload_file(distribution: Any, part_filename: str) -> Optional[Path]:
    files = distribution.files or []
    for file_rel in files:
        rel_str = str(file_rel).replace("\\", "/")
        if rel_str.endswith(f"/{part_filename}") or rel_str == part_filename:
            abs_path = Path(distribution.locate_file(file_rel))
            if abs_path.exists() and abs_path.is_file():
                return abs_path
    return None


def _verify_part(part: Dict[str, Any], default_version: str) -> Dict[str, Any]:
    package_name = str(part.get("package_name", "")).strip()
    package_version = str(part.get("package_version", default_version)).strip()
    part_filename = str(part.get("part_filename", "")).strip()
    expected_sha = str(part.get("sha256", "")).strip().lower()
    index4 = str(part.get("index4") or f"{int(part.get('index', 0)):04d}")

    record = {
        "index4": index4,
        "package_name": package_name,
        "expected_version": package_version,
        "part_filename": part_filename,
        "expected_sha256": expected_sha,
        "installed_version": "",
        "payload_path": "",
        "actual_sha256": "",
        "status": "",
        "detail": "",
    }

    if not package_name or not part_filename or not _is_sha256(expected_sha):
        record["status"] = "invalid_manifest_part"
        record["detail"] = "Missing package_name/part_filename or invalid sha256 in manifest"
        return record

    try:
        dist = importlib_metadata.distribution(package_name)
    except importlib_metadata.PackageNotFoundError:
        record["status"] = "missing_package"
        record["detail"] = "Package not installed"
        return record

    installed_version = str(dist.version)
    record["installed_version"] = installed_version
    if package_version and installed_version != package_version:
        record["status"] = "version_mismatch"
        record["detail"] = f"Installed {installed_version}, expected {package_version}"
        return record

    payload_path = _find_payload_file(dist, part_filename)
    if not payload_path:
        record["status"] = "missing_payload_file"
        record["detail"] = f"Cannot find payload file: {part_filename}"
        return record

    record["payload_path"] = str(payload_path)
    actual_sha = _hash_file_sha256(payload_path)
    record["actual_sha256"] = actual_sha
    if actual_sha != expected_sha:
        record["status"] = "hash_mismatch"
        record["detail"] = "Payload hash does not match manifest"
        return record

    record["status"] = "ok"
    record["detail"] = "Verified"
    return record


def verify_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    artifact = manifest.get("artifact", {})
    artifact_version = str(artifact.get("version", "")).strip()
    parts = manifest.get("parts", [])

    results: List[Dict[str, Any]] = []
    for part in parts:
        results.append(_verify_part(part, artifact_version))

    failed = [r for r in results if r["status"] != "ok"]
    return {
        "artifact": artifact,
        "total": len(results),
        "ok": len(results) - len(failed),
        "failed": len(failed),
        "results": results,
    }


def _print_verify_result(summary: Dict[str, Any]) -> None:
    print("")
    artifact = summary.get("artifact", {})
    artifact_name = artifact.get("filename") or artifact.get("id") or "unknown-artifact"
    artifact_ver = artifact.get("version") or "-"
    print(f"Bundle verify: {artifact_name} @ {artifact_ver}")
    print("-" * 72)

    for item in summary.get("results", []):
        status = item.get("status", "")
        prefix = "[OK] " if status == "ok" else "[FAIL]"
        pkg = item.get("package_name", "")
        ver = item.get("installed_version") or item.get("expected_version") or "?"
        idx = item.get("index4", "----")
        detail = item.get("detail", "")
        print(f"{prefix} part={idx} pkg={pkg}=={ver} status={status} detail={detail}")

    print("-" * 72)
    print(f"Summary: total={summary['total']} ok={summary['ok']} failed={summary['failed']}")
    print("")


def _collect_repair_specs(summary: Dict[str, Any]) -> List[Tuple[str, str]]:
    specs: List[Tuple[str, str]] = []
    seen = set()
    for item in summary.get("results", []):
        if item.get("status") == "ok":
            continue
        pkg = str(item.get("package_name", "")).strip()
        ver = str(item.get("expected_version", "")).strip()
        if not pkg:
            continue
        key = (pkg, ver)
        if key in seen:
            continue
        seen.add(key)
        specs.append(key)
    return specs


def _build_pip_cmd(args: argparse.Namespace, specs: Iterable[Tuple[str, str]]) -> List[str]:
    cmd: List[str] = [sys.executable, "-m", "pip", "install", "--upgrade", "--no-deps"]
    if args.no_index:
        cmd.append("--no-index")
    if args.index_url:
        cmd.extend(["--index-url", args.index_url])
    for value in args.extra_index_url:
        cmd.extend(["--extra-index-url", value])
    for value in args.find_links:
        cmd.extend(["--find-links", value])
    for value in args.trusted_host:
        cmd.extend(["--trusted-host", value])
    if args.timeout:
        cmd.extend(["--timeout", str(args.timeout)])

    for pkg, ver in specs:
        cmd.append(f"{pkg}=={ver}" if ver else pkg)
    return cmd


def _run_repair(args: argparse.Namespace, summary: Dict[str, Any], manifest: Dict[str, Any]) -> int:
    specs = _collect_repair_specs(summary)
    if not specs:
        print("[OK] No missing or corrupted parts. Repair skipped.")
        return 0

    print("[INFO] Repair targets:")
    for pkg, ver in specs:
        print(f"  - {pkg}=={ver}" if ver else f"  - {pkg}")

    cmd = _build_pip_cmd(args, specs)
    print("[INFO] pip command:")
    print("  " + " ".join(cmd))

    if args.dry_run:
        print("[INFO] Dry-run mode enabled. No changes applied.")
        return 0

    proc = subprocess.run(cmd, text=True)
    if proc.returncode != 0:
        print(f"[FAIL] pip install failed with exit code {proc.returncode}")
        return proc.returncode

    print("[INFO] Re-running verify after repair...")
    new_summary = verify_manifest(manifest)
    _print_verify_result(new_summary)
    return 0 if new_summary["failed"] == 0 else 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="khy bundle",
        description="Verify and repair split pip bundles by manifest."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    verify = sub.add_parser("verify", help="Verify installed bundle parts")
    verify.add_argument("--manifest", required=True, help="Manifest JSON path")
    verify.add_argument("--json", action="store_true", help="Output verification result as JSON")

    repair = sub.add_parser("repair", help="Repair missing or corrupted bundle parts")
    repair.add_argument("--manifest", required=True, help="Manifest JSON path")
    repair.add_argument("--dry-run", action="store_true", help="Print actions without installing")
    repair.add_argument("--index-url", default="", help="Primary pip index URL")
    repair.add_argument("--extra-index-url", action="append", default=[], help="Additional pip index URL")
    repair.add_argument("--find-links", action="append", default=[], help="Local wheel directory or URL")
    repair.add_argument("--trusted-host", action="append", default=[], help="trusted-host entries for pip")
    repair.add_argument("--timeout", type=int, default=120, help="pip install timeout in seconds")
    repair.add_argument("--no-index", action="store_true", help="Do not use package index")
    return parser


def run_bundle_cli(argv: Optional[List[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    manifest_path = Path(args.manifest).expanduser().resolve()
    try:
        manifest = _load_manifest(manifest_path)
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] {exc}")
        return 2

    summary = verify_manifest(manifest)

    if args.command == "verify":
        if args.json:
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        else:
            _print_verify_result(summary)
        return 0 if summary["failed"] == 0 else 1

    if args.command == "repair":
        return _run_repair(args, summary, manifest)

    parser.print_help()
    return 2
