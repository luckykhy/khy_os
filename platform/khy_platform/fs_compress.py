# @pattern Strategy
"""Best-effort transparent filesystem compression for installed khy-os trees.

This is the pip-channel counterpart of scripts/install/enable-ntfs-compression.ps1
(Windows) and scripts/install/enable-fs-compression.sh (Linux). Python has no
post-install hook, so :func:`schedule_install_compression` is invoked from the
first-launch self-heal (``devenv.run_postinstall``) instead.

Per-platform strategies:
  - Windows NTFS: per-file LZX via ``compact.exe``. New files written into
    compressed directories inherit the compression attribute automatically.
  - Linux Btrfs: per-directory zstd via ``btrfs property set`` (new files
    inherit); existing files are rewritten by ``btrfs filesystem defragment
    -czstd``. Without btrfs-progs, ``chattr +c`` still covers new files.
  - Linux ZFS: dataset-level ``compression=zstd`` (falls back to lz4) via
    ``zfs set``. Dataset-wide by nature; needs privileges; fail-soft.
  - ext4/XFS/F2FS/APFS/other: no supported transparent per-directory
    compression exists -- detected and honestly recorded as ``unsupported``.

Safety contract (mirrors ``run_postinstall``): never raises, never blocks the
caller -- when ``detached=True`` every potentially slow step (the compact
scan, the btrfs defragment rewrite) runs as a fire-and-forget child process.
Idempotent via per-target stamp files; gated by ``KHY_FS_COMPRESS=0``.
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import subprocess
import sys
from pathlib import Path

# Windows process creation flags: run compact fully detached so the CLI's
# first launch is never blocked by the (potentially minutes-long) scan.
_DETACHED_PROCESS = 0x00000008
_CREATE_NO_WINDOW = 0x08000000


def _gate_enabled() -> bool:
    """Gate: ``KHY_FS_COMPRESS`` (default on; only {0,false,off,no} = off)."""
    raw = os.environ.get("KHY_FS_COMPRESS")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _stamp_candidates(target: Path) -> list[Path]:
    """Stamp locations, most preferred first.

    Prefers a marker inside the target tree itself; when the tree is not
    writable (system-wide site-packages), falls back to a hash-keyed marker
    under the user's khy data home so we still run at most once per target.
    The writability probe must never touch the stamp file itself -- it uses
    its own probe name so an existing stamp is never clobbered or deleted.
    """
    digest = hashlib.sha1(str(target).encode("utf-8", "surrogatepass")).hexdigest()[:12]
    home_stamp = Path.home() / ".khyquant" / f".khy-fs-compressed-{digest}"
    stamp = target / ".khy-fs-compressed"
    if stamp.exists():
        return [stamp, home_stamp]
    try:
        probe = target / ".khy-fs-compressed.probe"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
        return [stamp, home_stamp]
    except OSError:
        return [home_stamp]


def _already_compressed(target: Path) -> bool:
    for stamp in _stamp_candidates(target):
        if stamp.exists():
            return True
    return False


def _mark_done(target: Path, mode: str) -> None:
    try:
        stamp = _stamp_candidates(target)[0]
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(mode + "\n", encoding="utf-8")
    except OSError:
        pass  # fail-soft: compression is an optimization, never a requirement


def _windows_fs_name(target: Path) -> str:
    """Locale-independent filesystem name of the volume hosting ``target``."""
    try:
        root = os.path.abspath(str(target))[:3]  # e.g. "D:\\"
        name = ctypes.create_unicode_buffer(64)
        ok = ctypes.windll.kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(root), None, 0, None, None, None, name, 64
        )
        return name.value if ok else ""
    except Exception:
        return ""


def _linux_mount_for(target: Path) -> tuple[str, str] | None:
    """Return ``(fstype, device)`` of the deepest mount containing ``target``.

    ``device`` is the ZFS dataset name for zfs mounts (dataset-level control),
    ignored otherwise. Reads /proc/mounts -- no external tools, no locale.
    """
    best: tuple[int, str, str] | None = None
    try:
        text = Path("/proc/mounts").read_text(encoding="utf-8", errors="replace")
        t = str(target)
        for line in text.splitlines():
            parts = line.split()
            if len(parts) < 3:
                continue
            device = parts[0]
            mountpoint = parts[1].replace("\\040", " ")
            fstype = parts[2]
            if t == mountpoint or t.startswith(mountpoint.rstrip("/") + "/"):
                if best is None or len(mountpoint) > best[0]:
                    best = (len(mountpoint), fstype, device)
    except Exception:
        return None
    if best is None:
        return None
    return best[1], best[2]


def _run(cmd: list[str], detached: bool, timeout: float | None = None) -> bool:
    """Run a command; return True on exit code 0.

    ``detached=True`` fires the child and returns True immediately -- used for
    steps whose *result* does not change what we report (compact scan,
    defragment rewrite): they either work transparently or fail harmlessly.
    """
    try:
        if detached:
            kwargs: dict = {
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
                "close_fds": True,
            }
            if sys.platform == "win32":
                kwargs["creationflags"] = _DETACHED_PROCESS | _CREATE_NO_WINDOW
            subprocess.Popen(cmd, **kwargs)
            return True
        return subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        ).returncode == 0
    except Exception:
        return False


def compress_tree_sync(target: Path, detached: bool = False) -> str:
    """Enable compression on ``target``.

    Returns the mode actually applied: ``ntfs`` / ``btrfs`` /
    ``btrfs-attr-only`` / ``zfs`` / ``zfs-already-on`` / ``unsupported`` /
    ``failed``. With ``detached=True`` (the production path) slow rewrite
    steps are spawned fire-and-forget and the mode is returned immediately.
    """
    if sys.platform == "win32":
        if _windows_fs_name(target).lower() != "ntfs":
            return "unsupported"
        compact = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "compact.exe"
        if not compact.exists():
            return "failed"
        # compact.exe syntax note: the positional argument is a filename
        # pattern -- /s:<dir> sets the recursion root and an explicit "*"
        # pattern is required, otherwise compact matches no files.
        ok = _run([str(compact), "/c", "/s:" + str(target), "/q", "/exe:lzx", "*"], detached)
        return "ntfs" if ok else "failed"

    if sys.platform == "linux":
        mount = _linux_mount_for(target)
        if mount is None:
            return "failed"
        fstype, device = mount
        if fstype == "btrfs":
            have_btrfs = _run(["btrfs", "property", "get", str(target)], False)
            if have_btrfs and _run(
                ["btrfs", "property", "set", str(target), "compression", "zstd"], False, 30
            ):
                # Rewrite existing data so it occupies compressed blocks.
                _run(
                    ["btrfs", "filesystem", "defragment", "-r", "-f", "-czstd", str(target)],
                    detached,
                )
                return "btrfs"
            if _run(["chattr", "+c", str(target)], False, 30):
                # btrfs-progs missing: new files inherit; existing stay as-is.
                return "btrfs-attr-only"
            return "failed"
        if fstype == "zfs":
            try:
                cur = subprocess.run(
                    ["zfs", "get", "-H", "-o", "value", "compression", device],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, timeout=30,
                ).stdout.strip()
                if cur in {"on", "zstd", "lz4"} or cur.startswith("gzip"):
                    return "zfs-already-on"
            except Exception:
                pass
            for algo in ("zstd", "lz4"):
                if _run(["zfs", "set", f"compression={algo}", device], False, 30):
                    return "zfs"
            return "failed"
        return "unsupported"

    # macOS (APFS) and everything else: no public per-directory mechanism.
    return "unsupported"


def schedule_install_compression(targets: list[Path]) -> list[tuple[str, str]]:
    """Compress each target once per install; heavy work runs detached.

    Returns ``(target, mode)`` pairs for targets processed on this call
    (already-stamped targets are skipped and omitted). Never raises.
    """
    if not _gate_enabled():
        return []
    results: list[tuple[str, str]] = []
    for raw in targets:
        try:
            target = Path(raw).resolve()
            if not target.is_dir() or _already_compressed(target):
                continue
            mode = compress_tree_sync(target, detached=True)
            _mark_done(target, mode)
            results.append((str(target), mode))
        except Exception:
            continue
    return results
