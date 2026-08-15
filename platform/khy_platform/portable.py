# @pattern Strategy
"""Portable-deployment detection for the Python launcher layer.

Mirrors the Node-side semantics in ``services/backend/src/utils/dataHome.js``
(``isPortableDeployment``): a deployment is portable when the environment
variable ``KHYQUANT_PORTABLE_ROOT`` is set (non-empty), or when the install
root carries a ``.portable`` marker file.

Install-root derivation (marker probing) checks, in order:
  1. The forest-layout root inferred from this package's location
     (``platform/khy_platform/`` -> ``platform`` -> root). A pip install puts
     the package under ``site-packages`` whose grandparent never carries the
     marker, so pip installs are never misdetected as portable.
  2. The current working directory and its parents (covers running
     ``python -m khy_platform`` from inside a portable tree whose launcher
     did not export the env var).

Portable installs keep per-install data under ``<portable root>/.khy`` (the
same project-scoped data home the Node side resolves to), so the whole
directory can move across machines/drives without leaving data on the
system drive. Non-portable deployments are entirely unaffected: every
helper here returns ``None``/``False`` and callers keep their historical
paths.

Only the Python stdlib is used so this module is importable before any
bootstrap work happens.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional

#: Marker file name that flags a portable install root (same as Node side).
PORTABLE_MARKER_FILENAME = ".portable"

#: Env var carrying an explicit portable root (same as Node side).
PORTABLE_ROOT_ENV = "KHY_PORTABLE_ROOT"
#: Legacy environment variable retained for existing launchers and installs.
LEGACY_PORTABLE_ROOT_ENV = "KHYQUANT_PORTABLE_ROOT"

#: Directory (under the portable root) that holds all portable khy data.
PORTABLE_DATA_DIRNAME = ".khy"


def _env_portable_root() -> Optional[Path]:
    """Portable root from the canonical or legacy env var, if set."""
    raw = os.environ.get(PORTABLE_ROOT_ENV, "").strip()
    if not raw:
        raw = os.environ.get(LEGACY_PORTABLE_ROOT_ENV, "").strip()
    if not raw:
        return None
    try:
        return Path(raw).resolve()
    except OSError:
        return Path(raw)


def _marker_root_candidates() -> List[Path]:
    """Directories probed (in order) for the ``.portable`` marker file."""
    candidates: List[Path] = []
    # Forest layout: platform/khy_platform/ -> platform -> install root.
    candidates.append(Path(__file__).resolve().parent.parent.parent)
    try:
        cwd = Path.cwd().resolve()
        candidates.append(cwd)
        candidates.extend(cwd.parents)
    except OSError:
        # cwd may have been deleted; env/package probing above still works.
        pass
    return candidates


def _find_marker_root(candidates: List[Path]) -> Optional[Path]:
    """First candidate directory that carries the portable marker, or None."""
    for root in candidates:
        try:
            if (root / PORTABLE_MARKER_FILENAME).is_file():
                return root
        except OSError:
            continue
    return None


def get_portable_root() -> Optional[Path]:
    """Resolve the portable install root, or None when not portable.

    The env var wins unconditionally (matching Node: a set
    ``KHYQUANT_PORTABLE_ROOT`` means portable even without a marker file);
    otherwise the first marker-carrying candidate root is used.
    """
    env_root = _env_portable_root()
    if env_root is not None:
        return env_root
    return _find_marker_root(_marker_root_candidates())


def is_portable_deployment() -> bool:
    """Whether this process runs from a portable deployment (Node parity)."""
    return get_portable_root() is not None


def get_portable_data_home() -> Optional[Path]:
    """Return the canonical data home for a portable install, else ``None``.

    ``KHY_DATA_HOME`` is the cross-language canonical override exported by the
    artifact launchers. When absent, source-tree portable installs retain the
    historical ``<portable root>/.khy`` layout.
    """
    root = get_portable_root()
    if root is None:
        return None
    configured = os.environ.get("KHY_DATA_HOME", "").strip()
    if configured:
        try:
            return Path(configured).resolve()
        except OSError:
            return Path(configured)
    return root / PORTABLE_DATA_DIRNAME
