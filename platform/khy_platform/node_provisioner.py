# @pattern Strategy, Facade
"""khy OS — portable Node.js runtime provisioner (Python-driven).

The chicken-and-egg problem this module solves: khy OS ships through a single
pip distribution whose CLI launcher is Python, but whose backend, gateways and
web frontends run on Node.js. On a freshly installed machine the user may have
Python (they just ``pip install``-ed us) but **no Node.js at all**. The existing
Node-side self-healers (``packaging/self-heal/self_healer.js``,
``services/backend/src/services/runtimeProvisioner.js``) cannot fix that — they
are themselves Node programs and will not start without Node. So the one piece
that must bootstrap Node has to be driven from Python.

Strategy (per user decision): download an **official portable Node build** and
unpack it into a *user-local* directory — no administrator rights, no UAC, no
system PATH mutation, fully isolated. If the download or checksum verification
fails, we do NOT hard-fail: the caller falls back to printing a manual hint
(``winget install OpenJS.NodeJS.LTS`` / nodejs.org). We never auto-elevate and
never call winget/msiexec ourselves.

Hard contract: **every public function is fail-soft** — any exception is caught
and turned into ``None`` / ``False``. Provisioning Node must never crash the
launcher; the worst case degrades to today's "please install Node" message.

Integrity: the downloaded archive is verified against the ``SHASUMS256.txt``
published in the same official ``dist`` directory (fetched over TLS). This
guards against corruption, truncation and basic tampering. It is **not** GPG
signature verification — that would require shipping/maintaining Node's signing
keys, which is out of scope here.

Only ``stdlib`` is used (``urllib``/``ssl``/``hashlib``/``zipfile``/``tarfile``
/``shutil``) so the module works before any third-party Python or Node dep
exists.
"""
from __future__ import annotations

import hashlib
import os
import platform as _platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Optional

# Single source of portable detection (Node dataHome.js parity).
from khy_platform import portable as _portable

# Default LTS line. A concrete patch release is pinned for determinism; the
# matching checksum is fetched per-version from SHASUMS256.txt (never hardcoded
# here), so bumping this constant is all that is needed to move versions.
# Overridable via ``KHY_NODE_VERSION`` (value like "22.12.0").
DEFAULT_NODE_VERSION = "22.12.0"

# Minimum major version the backend (Ink-based TUI on ink@6) requires.
_MIN_MAJOR = 20

# Official + mirror dist roots. ``{v}`` is substituted with the full version.
_OFFICIAL_DIST = "https://nodejs.org/dist/v{v}/"
_NPMMIRROR_DIST = "https://npmmirror.com/mirrors/node/v{v}/"

# A progress callback receives (downloaded_bytes, total_bytes); total may be 0
# when the server does not advertise a content length.
ProgressCb = Optional[Callable[[int, int], None]]


# ── Install location (user-local, no elevation) ──────────────────────────────


def node_home() -> Path:
    """Return the user-local root that holds provisioned Node builds.

    Portable installs: ``<portable root>/.khy/node`` so the runtime travels
    with the install directory. Otherwise — Windows:
    ``%LOCALAPPDATA%\\khy\\node`` (falls back to ``~/.khyquant/node`` when
    LOCALAPPDATA is absent). Other platforms: ``~/.khyquant/node``.
    """
    portable_home = _portable.get_portable_data_home()
    if portable_home is not None:
        return portable_home / "node"
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "").strip()
        if local:
            return Path(local) / "khy" / "node"
    return Path.home() / ".khyquant" / "node"


def _resolved_version() -> str:
    """Effective Node version: ``KHY_NODE_VERSION`` override or the default."""
    env = os.environ.get("KHY_NODE_VERSION", "").strip().lstrip("v")
    return env or DEFAULT_NODE_VERSION


def _auto_install_enabled() -> bool:
    """Whether automatic provisioning is allowed (``KHY_AUTO_INSTALL_NODE!=0``)."""
    val = os.environ.get("KHY_AUTO_INSTALL_NODE", "").strip().lower()
    return val not in {"0", "false", "no", "off"}


# ── Asset resolution (pure) ───────────────────────────────────────────────────


def _arch(machine: str) -> Optional[str]:
    """Map a ``platform.machine()`` string to Node's arch token, or None."""
    m = (machine or "").lower()
    if m in {"amd64", "x86_64", "x64"}:
        return "x64"
    if m in {"arm64", "aarch64"}:
        return "arm64"
    # 32-bit and exotic arches: Node portable builds are not reliably published;
    # do not fabricate an asset name — fall back to the manual hint.
    return None


def _asset(version: str, plat: str, machine: str) -> Optional[tuple[str, str, bool]]:
    """Derive the official asset for (version, platform, arch).

    Returns ``(dir_name, archive_name, is_zip)`` or ``None`` for an
    unsupported platform/arch combination. ``dir_name`` is the top-level
    directory inside the archive (also the Node naming stem).

    * win32  -> node-v{V}-win-{arch}.zip
    * darwin -> node-v{V}-darwin-{arch}.tar.gz
    * linux  -> node-v{V}-linux-{arch}.tar.gz   (.tar.gz avoids a liblzma dep)
    """
    arch = _arch(machine)
    if not arch:
        return None
    if plat == "win32":
        stem = f"node-v{version}-win-{arch}"
        return stem, f"{stem}.zip", True
    if plat == "darwin":
        stem = f"node-v{version}-darwin-{arch}"
        return stem, f"{stem}.tar.gz", False
    if plat.startswith("linux"):
        stem = f"node-v{version}-linux-{arch}"
        return stem, f"{stem}.tar.gz", False
    return None


def _mirror_base() -> list[str]:
    """Dist-root preference order. China network -> npmmirror first."""
    try:
        from khy_platform._bootstrap import _is_china_network
        china = _is_china_network()
    except Exception:
        china = True  # default to mirror-first: works globally, avoids stalls
    return [_NPMMIRROR_DIST, _OFFICIAL_DIST] if china else [_OFFICIAL_DIST, _NPMMIRROR_DIST]


# ── Provisioned-node discovery (fast, no network) ─────────────────────────────


def _node_exe_name() -> str:
    return "node.exe" if os.name == "nt" else "node"


def _bin_dir_for(extracted_root: Path) -> Path:
    """Locate the directory holding the node executable inside an extract.

    Windows portable builds place ``node.exe`` at the archive root; unix builds
    place ``node`` under ``bin/``.
    """
    return extracted_root if os.name == "nt" else extracted_root / "bin"


def _npm_shim_names() -> tuple[str, ...]:
    """Launcher shims a portable build ships next to the node executable."""
    return ("npm.cmd", "npm") if os.name == "nt" else ("npm",)


def _npm_cli_js(bin_dir: Path) -> Path:
    """Path of the bundled npm entry script inside an extracted build.

    Windows zips keep ``node_modules/npm`` at the archive root (next to
    ``node.exe``); unix tarballs keep it under ``lib/`` one level above ``bin/``.
    """
    root = bin_dir if os.name == "nt" else bin_dir.parent
    lib = root if os.name == "nt" else root / "lib"
    return lib / "node_modules" / "npm" / "bin" / "npm-cli.js"


def _probe_bundled_npm(node_exe: Path) -> bool:
    """Return True if the build next to ``node_exe`` carries a usable npm.

    An interrupted download / partial unzip can leave ``node.exe`` on disk while
    ``node_modules/npm`` (and the ``npm`` shims) never landed. Such a tree passes
    a node-only probe, gets accepted as "already provisioned", and then surfaces
    much later as ``khy doctor`` reporting *npm not found* — with no path back to
    a re-provision, because discovery keeps saying the build is fine. Validating
    npm here makes the incomplete extract fail discovery instead, so
    ``ensure_node`` falls through to ``provision_node`` and re-extracts over it.

    Structural check only (no subprocess): both the launcher shim and the npm
    entry script must exist. Fail-soft — any error means "not usable".
    """
    try:
        bin_dir = node_exe.parent
        if not any((bin_dir / name).exists() for name in _npm_shim_names()):
            return False
        return _npm_cli_js(bin_dir).is_file()
    except Exception:
        return False


def _probe_node(node_exe: Path) -> bool:
    """Return True if ``node_exe`` runs, reports major >= _MIN_MAJOR, has npm."""
    try:
        result = subprocess.run(
            [str(node_exe), "--version"],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=10, **_subprocess_kwargs(),
        )
        if result.returncode != 0:
            return False
        major = int(result.stdout.strip().lstrip("v").split(".")[0])
        if major < _MIN_MAJOR:
            return False
        # A node without its bundled npm is a half-extracted build, not a
        # runtime: reject it so it gets re-provisioned rather than cached.
        return _probe_bundled_npm(node_exe)
    except Exception:
        return False


def find_provisioned_node() -> Optional[str]:
    """Return the bin dir of a usable already-provisioned Node, or None.

    Idempotent fast path: scans ``node_home()`` for any extracted build whose
    node executable runs, satisfies the minimum version **and** carries its
    bundled npm (a half-extracted build is rejected here so ``ensure_node``
    re-provisions it). Never touches the network. Returns the **directory**
    containing the executable (so callers can prepend it to PATH), as a string.
    """
    try:
        root = node_home()
        if not root.exists():
            return None
        exe = _node_exe_name()
        # Prefer the currently-pinned version, then any other extracted build.
        version = _resolved_version()
        candidates: list[Path] = []
        stem_dir = root / f"v{version}"
        if stem_dir.exists():
            candidates.append(stem_dir)
        for child in sorted(root.iterdir(), reverse=True):
            if child.is_dir() and child not in candidates:
                candidates.append(child)
        for base in candidates:
            # base may itself be the version dir holding the node-vX-... folder.
            for extracted in [base, *(p for p in base.iterdir() if p.is_dir())] if base.is_dir() else []:
                bin_dir = _bin_dir_for(extracted)
                node_exe = bin_dir / exe
                if node_exe.exists() and _probe_node(node_exe):
                    return str(bin_dir)
        return None
    except Exception:
        return None


# ── Download + verify + extract ───────────────────────────────────────────────


def _download(url: str, dest: Path, on_progress: ProgressCb = None) -> bool:
    """Stream ``url`` to ``dest``. Returns True on success, never raises."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "khy-os-node-provisioner"})
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (https only by construction)
            total = int(resp.headers.get("Content-Length", 0) or 0)
            done = 0
            with open(dest, "wb") as fh:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    if on_progress:
                        try:
                            on_progress(done, total)
                        except Exception:
                            pass  # progress is best-effort
        return True
    except Exception:
        try:
            if dest.exists():
                dest.unlink()
        except Exception:
            pass
        return False


def _fetch_text(url: str) -> Optional[str]:
    """Fetch a small text resource (SHASUMS256.txt). None on failure."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "khy-os-node-provisioner"})
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _expected_hash(shasums: str, archive_name: str) -> Optional[str]:
    """Extract the sha256 for ``archive_name`` from SHASUMS256.txt content.

    Node's SHASUMS256.txt lines are ``<hex>  <filename>`` (two spaces). A
    leading ``*`` (binary marker) on the filename is tolerated.
    """
    for line in shasums.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        digest, name = parts[0].strip().lower(), parts[1].lstrip("*")
        if name == archive_name:
            return digest
    return None


def _is_within(base: Path, target: Path) -> bool:
    """True if ``target`` resolves inside ``base`` (path-traversal guard)."""
    try:
        base_r = base.resolve()
        target_r = target.resolve()
        return base_r == target_r or base_r in target_r.parents
    except Exception:
        return False


def _safe_extract_zip(archive: Path, dest: Path) -> bool:
    """Extract a zip, rejecting any member that escapes ``dest``."""
    try:
        with zipfile.ZipFile(archive) as zf:
            for name in zf.namelist():
                if not _is_within(dest, dest / name):
                    return False  # CVE-2007-4559-class traversal — refuse
            zf.extractall(dest)
        return True
    except Exception:
        return False


def _safe_extract_tar(archive: Path, dest: Path) -> bool:
    """Extract a tar.gz, rejecting any member that escapes ``dest``."""
    try:
        with tarfile.open(archive, "r:gz") as tf:
            for member in tf.getmembers():
                if not _is_within(dest, dest / member.name):
                    return False
                # Reject absolute paths and device/special members defensively.
                if member.name.startswith("/") or member.isdev():
                    return False
            tf.extractall(dest)
        return True
    except Exception:
        return False


def provision_node(version: Optional[str] = None, on_progress: ProgressCb = None) -> Optional[str]:
    """Download, verify and extract a portable Node build. Returns bin dir or None.

    Tries each dist mirror in turn (China-first when applicable). For each:
    download archive -> fetch SHASUMS256.txt -> verify sha256 -> safely extract
    into ``node_home()/v{V}/``. Any failure on one mirror moves to the next; if
    all fail, returns None (caller prints the manual hint). Never raises.
    """
    try:
        version = (version or _resolved_version()).lstrip("v")
        asset = _asset(version, sys.platform, _platform.machine())
        if asset is None:
            return None  # unsupported platform/arch — manual fallback
        dir_name, archive_name, is_zip = asset

        dest_root = node_home() / f"v{version}"
        try:
            dest_root.mkdir(parents=True, exist_ok=True)
        except Exception:
            return None

        with tempfile.TemporaryDirectory(prefix="khy-node-") as tmp:
            tmp_dir = Path(tmp)
            archive_path = tmp_dir / archive_name

            for base in _mirror_base():
                base_url = base.format(v=version)
                if not _download(base_url + archive_name, archive_path, on_progress):
                    continue

                shasums = _fetch_text(base_url + "SHASUMS256.txt")
                if not shasums:
                    continue
                expected = _expected_hash(shasums, archive_name)
                if not expected or _sha256(archive_path) != expected:
                    # Corruption / tamper / wrong file — try the next mirror.
                    try:
                        archive_path.unlink()
                    except Exception:
                        pass
                    continue

                ok = (_safe_extract_zip if is_zip else _safe_extract_tar)(archive_path, dest_root)
                if not ok:
                    return None

                extracted = dest_root / dir_name
                bin_dir = _bin_dir_for(extracted)
                node_exe = bin_dir / _node_exe_name()
                if node_exe.exists() and _probe_node(node_exe):
                    return str(bin_dir)
                return None
        return None
    except Exception:
        return None


# ── Facade ────────────────────────────────────────────────────────────────────


def ensure_node(auto: bool = True, on_progress: ProgressCb = None) -> Optional[str]:
    """Return a usable Node bin dir, provisioning one if needed. None on failure.

    1. Reuse an already-provisioned build (fast, no network).
    2. Else, if ``auto`` and ``KHY_AUTO_INSTALL_NODE`` is not disabled, download
       and extract a portable build.
    Never raises.
    """
    try:
        existing = find_provisioned_node()
        if existing:
            return existing
        if auto and _auto_install_enabled():
            return provision_node(on_progress=on_progress)
        return None
    except Exception:
        return None


def _subprocess_kwargs() -> dict:
    """Platform subprocess kwargs (hide the console window on Windows)."""
    kwargs: dict = {}
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        kwargs["startupinfo"] = si
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kwargs
