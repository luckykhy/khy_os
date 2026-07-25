#!/usr/bin/env python3
"""Regenerate the editable (``pip install -e .``) install in compat mode.

Why this exists
---------------
An editable install records *where* each Python package lives. The default
setuptools strategy ("lenient") freezes each package's absolute path into a
generated ``__editable__..._finder.py``. If the forest layout later moves
``platform/khy_platform`` or ``platform/khy_os``, that frozen path goes stale
and ``khy`` dies with ``ModuleNotFoundError: No module named 'khy_platform'``.

"compat" mode instead writes a one-line ``.pth`` pointing at ``platform/`` and
lets Python scan that directory at import time. As a result you normally do
**not** need to re-run anything after a restructure: moving ``services/``,
``apps/``, ``quant/``, ``kernel/``, ``docs/`` — anything except the two Python
package roots out of ``platform/`` — keeps working untouched, and a new Python
package added directly under ``platform/`` becomes importable with no reinstall.

When to run this
----------------
- After you move the Python package roots themselves (``platform/khy_platform``
  or ``platform/khy_os``), or move ``platform/`` as a whole.
- On a fresh dev checkout, to install in the resilient compat mode.

Usage
-----
    python3 scripts/dev-install.py
    KHY_DEV_PYTHON=/path/to/python python3 scripts/dev-install.py

By default it targets the interpreter that owns the installed ``khy`` command
(read from its shebang), so it repairs the environment that actually runs
``khy``. Override with ``KHY_DEV_PYTHON`` to target a specific interpreter.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def pick_interpreter() -> str:
    """Return the Python that should own the editable install.

    Priority: explicit override -> the interpreter behind the installed ``khy``
    console script -> the interpreter running this helper.
    """
    override = os.environ.get("KHY_DEV_PYTHON")
    if override:
        return override

    khy = shutil.which("khy")
    if khy:
        try:
            first_line = Path(khy).read_text(
                encoding="utf-8", errors="ignore"
            ).splitlines()[0]
        except (OSError, IndexError):
            first_line = ""
        if first_line.startswith("#!"):
            candidate = first_line[2:].strip()
            # On Windows the console script is a .exe, not a shebang text file,
            # so this branch is simply skipped and we fall through below.
            if candidate and os.path.exists(candidate):
                return candidate

    return sys.executable


def main() -> int:
    interpreter = pick_interpreter()
    print(f"[dev-install] interpreter: {interpreter}")
    print(f"[dev-install] repo root:   {REPO_ROOT}")

    install_cmd = [
        interpreter,
        "-m",
        "pip",
        "install",
        "-e",
        str(REPO_ROOT),
        "--config-settings",
        "editable_mode=compat",
        "--no-build-isolation",
        "--force-reinstall",
        "--no-deps",
    ]
    print("[dev-install] $", " ".join(install_cmd))
    rc = subprocess.call(install_cmd)
    if rc != 0:
        print("[dev-install] pip install failed", file=sys.stderr)
        return rc

    # Prove the packages resolve before declaring success.
    verify_cmd = [
        interpreter,
        "-c",
        "import khy_platform, khy_os; "
        "print('[dev-install] khy_platform ->', khy_platform.__file__); "
        "print('[dev-install] khy_os      ->', khy_os.__file__)",
    ]
    return subprocess.call(verify_cmd)


if __name__ == "__main__":
    raise SystemExit(main())
