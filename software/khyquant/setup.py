# @pattern Template Method
"""
KHY-Quant pip packaging script.

Bundles backend + khyquant source + @khy/shared into khy_quant/bundled/
so that `pip install khy-quant` produces a self-contained package.

See PACKAGING.md for included/excluded file lists.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py

ROOT = Path(__file__).parent
PROJECT_ROOT = ROOT.parent.parent  # Khy-OS repo root

EXCLUDE_PATTERNS = (
    "node_modules", "__pycache__", ".env", ".env.local",
    "logs", "temp", ".DS_Store", "Thumbs.db",
    "*.pyc", "*.db", "*.sqlite", "*.sqlite3",
    "*.joblib", "*.log", "*.iso", "*.img",
    "*.gguf", "*.safetensors",
    "models", "android", "android-sdk",
    "INTERNAL_CREDENTIALS*", "NUL",
    "*.so", "*.so.*", "*.dylib",
)

PRUNE_DIRS = {
    "node_modules", "__pycache__", "logs", "temp",
    ".git", "android", "android-sdk", "models",
    ".tmp", ".pytest_cache",
    "llama-cpp", "ollama-runner",
}


class BuildWithBundle(build_py):
    """Bundle backend + khyquant + shared into khy_quant/bundled/."""

    def run(self):
        bundled = ROOT / "khy_quant" / "bundled"
        if bundled.exists():
            shutil.rmtree(bundled, ignore_errors=True)
        bundled.mkdir(parents=True, exist_ok=True)

        # 1. Copy backend
        backend_src = PROJECT_ROOT / "services" / "backend"
        backend_dst = bundled / "backend"
        if backend_src.exists():
            shutil.copytree(
                backend_src, backend_dst,
                ignore=shutil.ignore_patterns(*EXCLUDE_PATTERNS),
                dirs_exist_ok=False,
            )
            self._prune(backend_dst)
            # Remove runtime data directory
            toplevel_data = backend_dst / "data"
            if toplevel_data.is_dir():
                shutil.rmtree(toplevel_data, ignore_errors=True)
            # Remove ML artifacts
            for subdir in ("ml/models", "ml/data"):
                d = backend_dst / subdir
                if d.is_dir():
                    shutil.rmtree(d, ignore_errors=True)

        # 2. Copy this khyquant package into its own internal bundle layout
        #    (preserve relative path for proxy re-exports). The bundled/software/khyquant
        #    name is khyquant's self-contained internal layout, independent of the repo tree.
        khyquant_src = ROOT  # software/khyquant/ is the current directory
        khyquant_dst = bundled / "software" / "khyquant"
        if khyquant_src.exists():
            shutil.copytree(
                khyquant_src, khyquant_dst,
                ignore=shutil.ignore_patterns(
                    *EXCLUDE_PATTERNS,
                    "khy_quant",  # Don't copy the Python package into itself
                    "setup.py", "pyproject.toml", "MANIFEST.in", "PACKAGING.md",
                    "*.egg-info",
                ),
                dirs_exist_ok=False,
            )
            self._prune(khyquant_dst)
            for subdir in ("frontend/android", "frontend/android-sdk", "ml/models", "ml/data"):
                d = khyquant_dst / subdir
                if d.is_dir():
                    shutil.rmtree(d, ignore_errors=True)

        # 3. Copy @khy/shared
        shared_src = PROJECT_ROOT / "platform" / "packages" / "shared"
        if shared_src.exists():
            # Into packages/shared for npm workspace resolution
            shared_dst = bundled / "packages" / "shared"
            shutil.copytree(
                shared_src, shared_dst,
                ignore=shutil.ignore_patterns(*EXCLUDE_PATTERNS),
                dirs_exist_ok=False,
            )
            self._prune(shared_dst)

            # Also vendor into backend for file: dependency
            vendor_dst = backend_dst / "vendor" / "shared"
            vendor_dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(
                shared_src, vendor_dst,
                ignore=shutil.ignore_patterns(*EXCLUDE_PATTERNS),
                dirs_exist_ok=False,
            )
            self._prune(vendor_dst)

        # 4. Patch backend/package.json: @khy/shared -> file:./vendor/shared
        backend_pkg = backend_dst / "package.json"
        if backend_pkg.exists():
            try:
                import json
                pkg = json.loads(backend_pkg.read_text(encoding="utf-8"))
                deps = pkg.get("dependencies", {})
                if "@khy/shared" in deps:
                    deps["@khy/shared"] = "file:./vendor/shared"
                    pkg["dependencies"] = deps
                    backend_pkg.write_text(
                        json.dumps(pkg, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8",
                    )
            except Exception:
                pass

        # 5. Delete stale lock file
        lock_file = backend_dst / "package-lock.json"
        if lock_file.exists():
            lock_file.unlink()

        # 6. Copy frontend dist if available
        frontend_dist = ROOT / "frontend" / "dist"
        frontend_dist_dst = bundled / "software" / "khyquant" / "frontend" / "dist"
        if frontend_dist.exists() and not frontend_dist_dst.exists():
            shutil.copytree(frontend_dist, frontend_dist_dst)

        self.package_data = self.package_data or {}
        self.package_data.setdefault("khy_quant", []).append("bundled/**/*")

        print("\n  [khy-quant] Bundle built (source readable, no obfuscation)")

        super().run()

    def _prune(self, dst: Path):
        for prune_dir in PRUNE_DIRS:
            for match in dst.rglob(prune_dir):
                if match.is_dir():
                    shutil.rmtree(match, ignore_errors=True)


setup(
    cmdclass={"build_py": BuildWithBundle},
    package_data={"khy_quant": ["bundled/**/*"]},
)
