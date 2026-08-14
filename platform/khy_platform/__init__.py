"""Khy OS Python launcher package.

__version__ is resolved DYNAMICALLY — never hard-code a literal here.
scripts/ci/check-version-sync.js rejects any `__version__ = "x.y.z"` literal
(it would silently reintroduce version drift), and publish-dual.sh normalizes
this line back to `__version__ = _detect_version()` on every release.
"""


def _detect_version():
    """Resolve the package version from installed metadata, falling back to
    the repo-root pyproject.toml [project] version when running from a
    source checkout (single source of truth)."""
    # 1. Installed distribution metadata (pip install khy-os).
    from importlib.metadata import PackageNotFoundError, version as _dist_version

    try:
        return _dist_version("khy-os")
    except PackageNotFoundError:
        pass

    # 2. Source checkout: parse version = "..." from the repo-root pyproject.toml
    #    (this file lives at platform/khy_platform/__init__.py, root is two up).
    try:
        import re
        from pathlib import Path

        pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8")
        # Only match the version field inside the [project] section.
        section = re.search(
            r"^\[project\]\s*$(.*?)(?=^\[|\Z)",
            text,
            re.MULTILINE | re.DOTALL,
        )
        if section:
            match = re.search(
                r'^version\s*=\s*"([^"]+)"',
                section.group(1),
                re.MULTILINE,
            )
            if match:
                return match.group(1)
    except Exception:
        pass

    return "0.0.0+unknown"


__version__ = _detect_version()
