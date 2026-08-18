# @pattern Command
"""
khy OS 的 Python 入口（新手版说明）

你在终端输入 `khy` 时，先执行的是这个文件。
它的职责是把控制权安全地交给 Node.js 后端。

执行流程：
1. 检查 Node.js 版本（必须 >= 20）
2. 找到 backend 目录（pip 安装模式或源码模式）
3. 首次运行时自动完成初始化（npm/.env/数据库）
4. 启动 Node CLI（bin/khy.js）
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import sysconfig
import json
import time
from pathlib import Path
from datetime import datetime, timezone

try:
    # Python 3.8+ 自带 importlib.metadata
    from importlib import metadata as importlib_metadata
except ImportError:  # Python < 3.8 的兼容兑底
    import importlib_metadata  # type: ignore

# Single source of portable detection (Node dataHome.js parity).
from khy_platform import portable as _portable


# ── Broken-upgrade guidance (shown once when the self-heal reaps orphans) ─────
# A leading-``~`` orphan dir only ever appears when a pip upgrade was
# interrupted by a file lock — on Windows this is WinError 32: khy (or the Node
# backend / tray it launched) was still running, so pip could not delete the
# old files, renamed them to ``~``-siblings, and aborted mid-uninstall ("must
# install twice"). When the launch-time self-heal reaps such orphans we know the
# user just hit exactly that, so we point them at the lock-free upgrade path
# (``khy update``, which stops the daemon/tray first) — once per process.
_ORPHAN_HINT_SHOWN = False


def _orphan_sweep_hint_enabled() -> bool:
    """Gate: ``KHY_ORPHAN_SWEEP_HINT`` (default on; only {0,false,off,no} = off)."""
    raw = os.environ.get("KHY_ORPHAN_SWEEP_HINT")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _broken_install_guidance() -> str:
    """Deterministic guidance shown after orphans from an interrupted/locked
    upgrade are reaped. Points at the lock-free upgrade path so the user stops
    hitting WinError 32 / the "must install twice" loop. Pure; never raises."""
    return (
        "khy: 以上残留来自上次被中断的升级(Windows 常见:升级时 khy 或其 Node 后台仍在运行,\n"
        "khy:   文件被占用 → WinError 32,pip 删到一半失败,往往要装两次才成功)。\n"
        "khy: 下次请用  khy update  升级——它会先自动停掉后台守护进程/托盘再装,避免文件占用。"
    )


def _sweep_corrupt_orphans(
    *roots: Path,
    recursive: bool = False,
    prune: frozenset[str] = frozenset({"node_modules", ".git"}),
) -> int:
    """Remove corrupt '~'-prefixed orphan entries left by failed installs.

    Two distinct sources strand leading-tilde siblings:

    * Interrupted/locked Windows extractions leave mangled siblings of real
      payload dirs (e.g. ``~ernel`` for ``kernel``, ``~-pycache__`` for
      ``__pycache__``) inside the bundled payload.
    * pip renames a package to a leading-tilde backup before deleting it during
      an upgrade; a crash mid-upgrade strands that backup at the site-packages
      root (``~hy-os`` for ``khy_os``, ``~ip`` for ``pip``). pip itself only
      warns ("Ignoring invalid distribution …") and ignores them.

    No legitimate *directory* begins with ``~``, so a leading-tilde dir name is
    an unambiguous corruption marker and safe to delete — whether it is a
    payload directory or a ``.dist-info`` metadata dir. Leading-tilde *files*
    are left untouched (e.g. Office ``~$…`` lock files are not ours to remove).
    Fail-soft: never raise — a cleanup error must not block startup.

    ``recursive=False`` (default) preserves the historical **shallow** behavior:
    only the direct children of each root are examined (site-packages roots
    strand their orphans at the top level). ``recursive=True`` walks the whole
    tree with ``os.walk(topdown=True, followlinks=False)`` — deleting any
    leading-tilde directory and *not descending into it*, and pruning
    ``prune`` dirs (``node_modules``/``.git``) from the walk: they are not pip
    managed, never get stashed, and are the bulk of the traversal cost.
    Symlinks are never followed, so ``rmtree`` can never punch out of the tree.

    Returns the number of orphan directories removed.
    """
    removed = 0
    for root in roots:
        try:
            if not root.is_dir():
                continue
            if not recursive:
                for entry in root.iterdir():
                    if entry.name.startswith("~") and entry.is_dir():
                        shutil.rmtree(entry, ignore_errors=True)
                        if not entry.exists():
                            removed += 1
                continue
            # Recursive walk: followlinks=False so we never cross a symlink out
            # of the tree; topdown=True so we can prune dirnames in place.
            for dirpath, dirnames, _filenames in os.walk(
                str(root), topdown=True, followlinks=False
            ):
                kept = []
                for name in dirnames:
                    if name.startswith("~"):
                        target = Path(dirpath) / name
                        shutil.rmtree(target, ignore_errors=True)
                        if not target.exists():
                            removed += 1
                        # Do not descend into a removed orphan.
                        continue
                    if name in prune:
                        # Prune from traversal (not pip managed, never stashed).
                        continue
                    kept.append(name)
                # In-place slice assignment is required for os.walk pruning.
                dirnames[:] = kept
        except OSError:
            continue  # fail-soft: corruption cleanup must never crash launch
    if removed:
        print(
            f"khy: cleaned {removed} corrupt orphan director"
            f"{'y' if removed == 1 else 'ies'} from a previous broken install.",
            file=sys.stderr,
        )
        # One-time actionable follow-up: teach the lock-free upgrade path so the
        # user stops re-triggering WinError 32 / the "install twice" loop.
        global _ORPHAN_HINT_SHOWN
        if not _ORPHAN_HINT_SHOWN and _orphan_sweep_hint_enabled():
            _ORPHAN_HINT_SHOWN = True
            try:
                print(_broken_install_guidance(), file=sys.stderr)
            except Exception:
                pass  # fail-soft: a hint must never break launch
    return removed


def _orphan_sweep_enabled() -> bool:
    """Gate: ``KHY_ORPHAN_SWEEP`` (default on; only {0,false,off,no} = off)."""
    raw = os.environ.get("KHY_ORPHAN_SWEEP")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _orphan_sweep_marker_current(bundled_root: Path, version: str) -> bool:
    """Return True when the per-version ``.khy_orphan_sweep`` marker beside the
    payload already records ``version``.

    Reuses the existing marker written after a successful recursive sweep. A
    matching marker means the corruption self-heal already ran for this exact
    installed version, so a fresh launch-time scan is provably redundant.
    Fail-soft: an empty version, or a missing/unreadable/mismatched marker,
    returns False so the caller falls back to the full authoritative cleanup
    (portable-safe: an absent marker after a copy/migration re-runs the sweep).
    """
    if not version:
        return False
    marker = bundled_root / ".khy_orphan_sweep"
    try:
        return marker.is_file() and marker.read_text(encoding="utf-8").strip() == str(version)
    except OSError:
        return False  # unreadable marker → treat as stale, re-sweep


def _sweep_bundled_orphans_deep(bundled_root: Path, version: str) -> int:
    """Recursively purge ``~``-prefixed orphan dirs inside the bundled payload,
    throttled by a per-version marker so it runs at most once per installed
    version (a fresh upgrade changes the marker → sweeps once → then short-
    circuits on every subsequent launch of that version).

    Windows ``pip install --upgrade`` renames each entry it is about to replace
    to a leading-tilde sibling to dodge file locks; an interrupted upgrade
    (AV lock / crash / Ctrl-C) strands these deep in the tree
    (``bundled/services/backend/src`` → ``~rc``). The shallow sweep never reaps
    them; this is the missing recursive reap.

    Gated by ``KHY_ORPHAN_SWEEP`` (default on). Fully fail-soft: a read-only
    install (marker write fails) is fine — a read-only tree cannot accumulate
    fresh orphans anyway. Returns the number of orphan directories removed.
    """
    if not _orphan_sweep_enabled():
        return 0
    try:
        if not bundled_root.is_dir():
            return 0
    except OSError:
        return 0
    marker = bundled_root / ".khy_orphan_sweep"
    if _orphan_sweep_marker_current(bundled_root, version):
        return 0  # already swept for this version → short-circuit
    removed = _sweep_corrupt_orphans(bundled_root, recursive=True)
    try:
        marker.write_text(str(version), encoding="utf-8")
    except OSError:
        pass  # read-only install → fine, cannot accumulate orphans anyway
    return removed


# Distribution names this installer owns, in normalized (lowercased, '-'→'_')
# form. Used to scope stale-version metadata cleanup to our own package only —
# we never touch another project's dist-info.
_OWN_DIST_NAMES = frozenset({"khy_os", "khy_quant", "khy"})


def _normalize_dist_name(name: str) -> str:
    """Normalize a distribution/dist-info base name for comparison (PEP 503-ish:
    lowercase, runs of '-'/'_'/'.' collapse to a single '_')."""
    out = []
    prev_sep = False
    for ch in name.lower():
        if ch in "-_.":
            if not prev_sep:
                out.append("_")
            prev_sep = True
        else:
            out.append(ch)
            prev_sep = False
    return "".join(out).strip("_")


def _sweep_stale_self_distinfo(roots, current_version: str) -> int:
    """Remove leftover ``<own-pkg>-<oldver>.dist-info`` / ``.egg-info`` metadata
    from previous versions of *our* package, so ``pip check`` stays clean after
    an in-place upgrade that did not fully retire the old metadata.

    Conservative by construction — only ever deletes when ALL hold:
      * the metadata's normalized base name is one we own (``_OWN_DIST_NAMES``);
      * its embedded version differs from ``current_version``;
      * a current-version ``.dist-info`` for that same name exists in the SAME
        root (so we never strand the live install if version detection is off).

    Fail-soft: never raises. Returns the number of stale metadata dirs removed.
    """
    if not current_version:
        return 0
    removed = 0
    for root in roots:
        try:
            if not root.is_dir():
                continue
            # First pass: which owned names have a *current* metadata dir here?
            live_names = set()
            entries = list(root.iterdir())
            for entry in entries:
                stem = entry.name
                for suffix in (".dist-info", ".egg-info"):
                    if stem.endswith(suffix) and "-" in stem[: -len(suffix)]:
                        base, _, ver = stem[: -len(suffix)].rpartition("-")
                        norm = _normalize_dist_name(base)
                        if norm in _OWN_DIST_NAMES and ver == current_version:
                            live_names.add(norm)
            if not live_names:
                continue  # no anchor → refuse to delete anything in this root
            # Second pass: drop owned metadata whose version != current.
            for entry in entries:
                stem = entry.name
                for suffix in (".dist-info", ".egg-info"):
                    if not (stem.endswith(suffix) and "-" in stem[: -len(suffix)]):
                        continue
                    base, _, ver = stem[: -len(suffix)].rpartition("-")
                    norm = _normalize_dist_name(base)
                    if norm in live_names and ver and ver != current_version:
                        try:
                            shutil.rmtree(entry, ignore_errors=True)
                        except OSError:
                            continue
                        if not entry.exists():
                            removed += 1
        except OSError:
            continue
    if removed:
        print(
            f"khy: removed {removed} stale metadata "
            f"{'dir' if removed == 1 else 'dirs'} from an older version.",
            file=sys.stderr,
        )
    return removed


def _site_packages_roots() -> list[Path]:
    """Return install roots where pip strands corrupt '~' orphans and stale
    version metadata: this package's parent (site-packages) plus the
    interpreter's purelib/platlib, so virtualenv and system installs are covered.
    """
    roots: list[Path] = []
    seen: set[str] = set()

    def _add(candidate: Path | None) -> None:
        if candidate is None:
            return
        try:
            resolved = candidate.resolve()
        except OSError:
            return
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            roots.append(resolved)

    _add(Path(__file__).resolve().parent.parent)  # dir containing khy_platform/
    try:
        paths = sysconfig.get_paths()
        for key in ("purelib", "platlib"):
            val = paths.get(key)
            if val:
                _add(Path(val))
    except (OSError, KeyError):
        pass
    return roots


_INSTALL_CLEANUP_DONE = False


def _self_install_cleanup() -> None:
    """Self-heal the install roots on launch: purge corrupt '~' orphans and
    retire our own stale-version metadata. Best-effort and fully fail-soft —
    any failure here must never block startup. Runs at most once per process
    (``_find_bundled_root`` is called several times during a launch).
    """
    global _INSTALL_CLEANUP_DONE
    if _INSTALL_CLEANUP_DONE:
        return
    _INSTALL_CLEANUP_DONE = True
    roots = _site_packages_roots()
    if not roots:
        return
    _sweep_corrupt_orphans(*roots)
    try:
        from khy_platform import __version__
    except Exception:  # pragma: no cover — version import must never block
        __version__ = ""
    if __version__:
        _sweep_stale_self_distinfo(roots, __version__)


def _bundled_payload_candidates() -> list[Path]:
    """Candidate payload roots: current standalone layout, then legacy layout."""
    package_dir = Path(__file__).resolve().parent
    return [
        package_dir / "bundled",
        package_dir.parent / "khy_os" / "bundled",
    ]


def _find_bundled_root() -> Path | None:
    """Locate the standalone payload root, with legacy wheel compatibility.

    Warm-path fast return: when the per-version ``.khy_orphan_sweep`` marker
    beside the payload already records the current installed version, every
    corruption self-heal (site-packages orphan/metadata scan + payload shallow
    and recursive sweep) provably already ran for this version, so all of it is
    skipped. Any missing/invalid/mismatched marker — a fresh install, an
    upgrade, or a portable copy that lacks the marker — falls through to the
    full authoritative cleanup below, preserving the original behavior.
    """
    candidates = _bundled_payload_candidates()
    for candidate in candidates:
        if candidate.exists():
            try:
                from khy_platform import __version__ as _ver
            except Exception:  # pragma: no cover — version import must never block
                _ver = ""
            # Warm path: marker matches this version → cleanup already ran; skip
            # the redundant site-packages + payload scans entirely.
            if _orphan_sweep_marker_current(candidate, _ver):
                return candidate
            # Cold / version-changed path: authoritative self-heal. Site-packages
            # is where pip strands ``~hy-os``/``~ip`` and stale-version metadata
            # after an interrupted upgrade.
            _self_install_cleanup()
            # Shallow purge of top-level '~' orphans beside the payload, then a
            # throttled *recursive* deep sweep of the payload itself — this is
            # where Windows pip-upgrade stashes strand deep (``.../src`` → ``~rc``)
            # and the shallow pass never reaches them. The deep sweep writes the
            # marker consumed by the warm path above.
            _sweep_corrupt_orphans(candidate.parent)
            _sweep_bundled_orphans_deep(candidate, _ver)
            return candidate
    # No bundled payload located (e.g. a source checkout) — still self-heal the
    # site-packages install roots once, preserving prior behavior.
    _self_install_cleanup()
    return None


def run_install_cleanup() -> int:
    """Run the full Python-side corruption cleanup from the pip post-install hook,
    so '~'-prefixed orphan dirs and stale-version metadata stranded by a previous
    (possibly interrupted) upgrade are reaped NOW instead of at the next launch.

    Reuses the same single-source sweep functions used at launch — site-packages
    '~' orphans + our own stale dist-info, then the bundled-payload neighbor
    shallow sweep and the throttled recursive deep sweep. No duplicated cleanup
    logic. Fully fail-soft: never raises (post-install must not break pip install).
    Returns the total number of orphan/metadata directories removed.
    """
    total = 0
    try:
        # (1) site-packages: '~hy-os'/'~ip' orphans + our own stale dist-info.
        roots = _site_packages_roots()
        if roots:
            total += _sweep_corrupt_orphans(*roots)  # ungated (matches launch)
            try:
                from khy_platform import __version__
            except Exception:  # pragma: no cover — version import must never block
                __version__ = ""
            if __version__:
                total += _sweep_stale_self_distinfo(roots, __version__)
        # (2) bundled payload: neighbor shallow sweep + throttled recursive deep sweep.
        for candidate in _bundled_payload_candidates():
            if candidate.exists():
                total += _sweep_corrupt_orphans(candidate.parent)
                try:
                    from khy_platform import __version__ as _ver
                except Exception:  # pragma: no cover
                    _ver = ""
                total += _sweep_bundled_orphans_deep(candidate, _ver)  # gated + throttled
                break
    except Exception:  # pragma: no cover — cleanup must never break post-install
        pass  # fail-soft
    return total


def _source_checkout_backend() -> Path | None:
    """Return the editable backend when this module lives inside a Git checkout."""
    project_root = Path(__file__).resolve().parent.parent.parent
    backend = project_root / "services" / "backend"
    if (project_root / ".git").exists() and (backend / "bin" / "khy.js").is_file():
        return backend
    return None


def get_bundle_dir() -> Path:
    """返回 backend 目录路径（这是 Node 端核心代码所在位置）。

    查找顺序：
    1. 独立后端包（khy-quant-backend）
    2. pip 安装后的 khy_os/bundled/backend（兼容旧版安装结构）
    3. 源码开发目录 ../backend

    backend 中包含：
    - bin/khy.js（Node CLI 入口）
    - server.js（后端服务）
    - src/（业务代码）
    - package.json（依赖定义）
    """
    # 方案1：尝试独立后端包
    try:
        from khy_quant_backend.cli import get_bundle_dir as _backend_get
        return _backend_get()
    except ImportError:
        pass

    # 方案2：源码开发模式优先（避免仓库内 bundled 与 backend 内容漂移）
    # forest layout: platform/khy_platform/ -> platform -> repo root
    project_root = Path(__file__).parent.parent.parent
    dev = project_root / "services" / "backend"
    if (project_root / ".git").exists() and dev.exists():
        return dev

    # 方案3：pip 安装模式（backend 在 wheel 内，bundle 镜像新树 services/backend）
    bundled_root = _find_bundled_root()
    if bundled_root:
        bundled_backend = bundled_root / "services" / "backend"
        if bundled_backend.exists():
            return bundled_backend

    # 方案4：源码模式兜底（pip install -e .）
    if dev.exists():
        return dev

    # 都找不到时，给出可操作提示
    print("Error: Cannot locate khy OS backend directory.", file=sys.stderr)
    print("  If you installed via pip, the package may be corrupted.", file=sys.stderr)
    if sys.platform == "win32":
        print("  This often happens when upgrading while khy was still running (WinError 32).", file=sys.stderr)
        print("  Fix: Close all khy windows and node.exe processes, then:", file=sys.stderr)
        print("  Try: pip install --force-reinstall khy-os", file=sys.stderr)
    else:
        print("  Try: pip install --force-reinstall khy-os", file=sys.stderr)
    print("  Fallback: pip install --force-reinstall khy-quant", file=sys.stderr)
    sys.exit(1)


def _subprocess_kwargs():
    """返回 subprocess 的平台参数（主要用于 Windows 隐藏黑窗）。

    在 Windows 上，子进程默认会弹出控制台窗口。
    这里把窗口隐藏，避免初始化过程频繁闪烁。
    """
    kwargs = {}
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE：不显示窗口
        kwargs["startupinfo"] = si
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kwargs


def _background_subprocess_kwargs():
    """Return detached subprocess kwargs for long-lived background helpers."""
    kwargs = _subprocess_kwargs()
    if os.name == "nt":
        detached = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        new_group = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | detached | new_group
    else:
        kwargs["start_new_session"] = True
    return kwargs


def _build_backend_process_env(backend_dir: Path) -> dict[str, str]:
    """Build the minimal Node backend env shared by launcher-side helpers."""
    env = os.environ.copy()
    env["KHYQUANT_ROOT"] = str(backend_dir)
    node_modules_dir = str(backend_dir / "node_modules")
    existing_node_path = env.get("NODE_PATH", "")
    env["NODE_PATH"] = (
        f"{node_modules_dir}{os.pathsep}{existing_node_path}"
        if existing_node_path
        else node_modules_dir
    )
    return env


def _node_check_cache_file() -> Path:
    # Portable installs keep launcher caches under <root>/.khy so nothing
    # lands on the system drive; regular installs keep the historical path.
    portable_home = _portable.get_portable_data_home()
    if portable_home is not None:
        return portable_home / "node_check.json"
    return Path.home() / ".khyquant" / "node_check.json"


def _node_check_cache_enabled() -> bool:
    """Python-only gate. Default on; disabled only when explicitly falsy.

    Not registered in the JS flagRegistry (that scanner only reads JS), mirroring
    the KHY_TRAY_AUTOSTART / KHY_QEMU_INSTALL_PROMPT Python-side precedent.
    """
    val = str(os.environ.get("KHY_NODE_CHECK_CACHE", "")).strip().lower()
    return val not in {"0", "false", "off", "no"}


def _node_binary_signature(cmd: str):
    """Resolve ``cmd`` on PATH and return ``(resolved_path, mtime_ns, size)``.

    Returns ``None`` when the command is unresolved or unstatable. ``st_mtime_ns``
    is an exact integer, so it survives the JSON round-trip without the float
    precision loss a bare ``st_mtime`` would risk.
    """
    try:
        resolved = shutil.which(cmd)
        if not resolved:
            return None
        st = os.stat(resolved)
        return (resolved, st.st_mtime_ns, st.st_size)
    except Exception:
        return None


def _load_cached_node_check() -> dict:
    try:
        file_path = _node_check_cache_file()
        if not file_path.exists():
            return {}
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cached_node_check(cmd: str, sig, major: int) -> None:
    try:
        file_path = _node_check_cache_file()
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(
            json.dumps(
                {"cmd": cmd, "path": sig[0], "mtime_ns": sig[1], "size": sig[2], "major": major},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except Exception:
        # best effort only — a missing cache simply re-spawns next launch
        pass


def _cached_node_command() -> str | None:
    """Return a previously validated node command whose binary is unchanged.

    Fast path for the startup-critical version check: if the resolved binary's
    (path, mtime_ns, size) match a prior successful validation of major >= 20,
    the ``node --version`` spawn can be skipped. On Windows that spawn is a full
    extra process (CreateProcess + Defender scan) on every launch. Fail-open:
    any mismatch / stat error / disabled gate returns ``None`` so the caller
    falls through to the authoritative spawn-and-validate path.
    """
    if not _node_check_cache_enabled():
        return None
    cached = _load_cached_node_check()
    cmd = cached.get("cmd") if cached else None
    if cmd not in ("node", "node.exe"):
        return None
    try:
        if int(cached.get("major", 0)) < 20:
            return None
    except (TypeError, ValueError):
        return None
    sig = _node_binary_signature(cmd)
    if (
        sig is not None
        and sig[0] == cached.get("path")
        and sig[1] == cached.get("mtime_ns")
        and sig[2] == cached.get("size")
    ):
        return cmd
    return None


def check_node() -> str:
    """检查 Node.js 是否存在且版本>=20，返回可执行命令名。

    这里尝试 node / node.exe 两种命令，兼容不同 PATH 配置。
    Node.js >= 20 is required by the Ink-based TUI (official `ink@6`).
    """
    # Fast path: skip the `node --version` spawn when the resolved binary is
    # byte-for-byte unchanged since a prior successful validation (see
    # _cached_node_command). Fail-open — None falls through to the real check.
    cached_cmd = _cached_node_command()
    if cached_cmd:
        return cached_cmd

    for cmd in ("node", "node.exe"):
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                **_subprocess_kwargs(),
            )
            if result.returncode == 0:
                # 版本示例：v22.12.0 -> 22
                version = result.stdout.strip().lstrip("v")
                major = int(version.split(".")[0])
                if major >= 20:
                    # Cache the validated binary so the next launch can skip
                    # this spawn while the binary is unchanged. Fail-soft.
                    sig = _node_binary_signature(cmd)
                    if sig is not None:
                        _save_cached_node_check(cmd, sig, major)
                    return cmd
                print(
                    f"Error: Node.js v{version} found but >= 20 required.",
                    file=sys.stderr,
                )
                _print_node_install_hint()
                sys.exit(1)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    # ── Auto-provision: no system Node found ──────────────────────────────
    # Chicken-and-egg — the Node-side self-healers cannot run without Node, so
    # the bootstrap must be Python-driven. Try a user-local portable build
    # (already provisioned, or freshly downloaded). On any failure we fall
    # through to the manual hint + exit(1), preserving today's behavior.
    provisioned = _ensure_node_via_provisioner()
    if provisioned:
        return provisioned

    print("Error: Node.js not found.", file=sys.stderr)
    print("  khy OS requires Node.js >= 20.", file=sys.stderr)
    _print_node_install_hint()
    sys.exit(1)


def _ensure_node_via_provisioner() -> str | None:
    """Resolve Node via the portable provisioner; prepend its bin dir to PATH.

    Returns the ``node`` command name (now resolvable on PATH) when a usable
    build is available or was just downloaded, else ``None``. Fail-soft: any
    error degrades to ``None`` so the caller prints the manual hint.
    """
    try:
        from khy_platform import node_provisioner
    except Exception:
        return None

    try:
        # Fast path: an already-provisioned build (no network).
        bin_dir = node_provisioner.find_provisioned_node()
        if not bin_dir:
            if not node_provisioner._auto_install_enabled():
                return None
            version = node_provisioner._resolved_version()
            print(
                f"[khy] 未检测到 Node.js，正在自动下载便携版 Node v{version}"
                f"（用户目录安装，无需管理员权限）...",
                file=sys.stderr,
            )
            progress = _DownloadProgress("Node.js")
            bin_dir = node_provisioner.provision_node(on_progress=progress)
            progress.finish()
        if not bin_dir:
            return None

        # Prepend so both `node`/`node.exe` AND `npm`/`npm.cmd` resolve for all
        # downstream spawns and `shutil.which("npm")` in the bootstrapper.
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
        for cmd in ("node", "node.exe"):
            if shutil.which(cmd):
                print(f"[khy] [OK] Node.js 就绪: {bin_dir}", file=sys.stderr)
                return cmd
        return None
    except Exception:
        return None


class _DownloadProgress:
    """下载进度显示器——实时速度 + ETA + 进度条（TTY 下更新当前行，非 TTY 每 5 秒一行）。

    被 urllib.request.urlretrieve 的 reporthook 调用，兼容各种下载场景。
    """

    def __init__(self, label: str):
        self.label = label
        self._tty = bool(getattr(sys.stderr, "isatty", lambda: False)())
        self._last_pct = -1
        self._last_log_ts = 0.0  # 非 TTY 模式下日志节流
        self._start_ts = time.time()
        self._any = False
        self._last_done = 0

    def __call__(self, done: int, total: int):
        self._any = True
        now = time.time()
        elapsed = now - self._start_ts

        if not self._tty:
            # 非 TTY：每 5 秒打印一行纯文本，避免日志爆炸
            if now - self._last_log_ts < 5:
                return
            self._last_log_ts = now
            if total > 0:
                pct = int(done * 100 / total)
                sys.stderr.write(f"[khy] 下载 {self.label}: {pct}% ({_fmt_size(done)}/{_fmt_size(total)})\n")
            else:
                sys.stderr.write(f"[khy] 下载 {self.label}: {_fmt_size(done)}\n")
            sys.stderr.flush()
            return

        # TTY：绘制进度条 + 速度 + ETA
        speed = done / (now - self._start_ts) if elapsed > 3 else 0
        self._last_done = done

        if total > 0:
            pct = int(done * 100 / total)
            if pct == self._last_pct and elapsed < 2:
                # 前 2 秒不频繁刷新
                return
            self._last_pct = pct
            bar_width = 20
            filled = int(bar_width * pct / 100)
            bar = "█" * filled + "░" * (bar_width - filled)
            eta = ""
            if speed > 0 and done < total:
                eta_sec = (total - done) / speed
                if eta_sec < 3600:
                    eta = f" ETA {eta_sec:.0f}s"
            sys.stderr.write(
                f"\r  {bar} {pct:3d}% {_fmt_size(done)}/{_fmt_size(total)}"
                f" {_fmt_speed(speed)}{eta}"
            )
        else:
            sys.stderr.write(f"\r  {_fmt_size(done)} {_fmt_speed(speed)}")
        sys.stderr.flush()

    def finish(self):
        if self._tty and self._any:
            sys.stderr.write("\n")
            sys.stderr.flush()


def _fmt_size(n: int) -> str:
    """字节数 → 人类可读（KB/MB/GB）。"""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def _fmt_speed(speed: float) -> str:
    """速度格式化。"""
    if speed <= 0:
        return ""
    return _fmt_size(int(speed)) + "/s"


def get_installed_version() -> str:
    """Read installed package version (empty string on failure)."""
    for package_name in ("khy-os", "khy-quant"):
        try:
            return importlib_metadata.version(package_name)
        except Exception:
            continue
    return ""


def _install_notice_state_file() -> Path:
    # Same portable-vs-regular split as _node_check_cache_file().
    portable_home = _portable.get_portable_data_home()
    if portable_home is not None:
        return portable_home / "install_notice.json"
    return Path.home() / ".khyquant" / "install_notice.json"


def _load_install_notice_state() -> dict:
    file_path = _install_notice_state_file()
    try:
        if not file_path.exists():
            return {}
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_install_notice_state(state: dict):
    file_path = _install_notice_state_file()
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        # best effort only
        pass


def _detect_install_mode(backend_dir: Path) -> str:
    # forest layout: platform/khy_platform/ -> platform -> repo root
    project_root = Path(__file__).parent.parent.parent
    if (project_root / ".git").exists() and backend_dir == (project_root / "services" / "backend"):
        return "source"
    bundled_root = _find_bundled_root()
    if bundled_root and backend_dir == (bundled_root / "services" / "backend"):
        return "pip-bundled"
    return "runtime"


def _should_show_install_location_notice(backend_dir: Path, pkg_version: str) -> bool:
    always = str(os.environ.get("KHY_SHOW_INSTALL_PATH_ALWAYS", "")).strip().lower() in {"1", "true", "yes", "on"}
    if always:
        return True
    state = _load_install_notice_state()
    shown = state.get("shown", {})
    notice_key = pkg_version or f"path::{backend_dir}"
    return notice_key not in shown


def _mark_install_location_notice(backend_dir: Path, pkg_version: str):
    state = _load_install_notice_state()
    shown = state.get("shown", {})
    notice_key = pkg_version or f"path::{backend_dir}"
    shown[notice_key] = datetime.now(timezone.utc).isoformat()
    state["shown"] = shown
    _save_install_notice_state(state)


def _print_install_location_notice(backend_dir: Path, pkg_version: str):
    if not _should_show_install_location_notice(backend_dir, pkg_version):
        return False
    # forest layout: backend dir is services/backend (2 deep) under the install root
    install_root = backend_dir.parent.parent if backend_dir.name == "backend" else backend_dir
    mode = _detect_install_mode(backend_dir)
    version_display = pkg_version or "unknown"
    print(f"[khy] Install ready (version={version_display}, mode={mode})", file=sys.stderr)
    print(f"[khy] Install root: {install_root}", file=sys.stderr)
    print(f"[khy] Backend dir: {backend_dir}", file=sys.stderr)
    _mark_install_location_notice(backend_dir, pkg_version)
    return True


def _print_node_install_hint():
    """输出 Node.js 安装提示（按系统给出不同建议）。"""
    # 检测中文环境，优先给国内镜像地址
    lang = os.environ.get("LANG", "") + os.environ.get("LC_ALL", "")
    tz = os.environ.get("TZ", "")
    is_china = lang.startswith("zh") or "Shanghai" in tz or "Chongqing" in tz

    if is_china:
        print("  Install from: https://npmmirror.com/mirrors/node/", file=sys.stderr)
    else:
        print("  Install from: https://nodejs.org/", file=sys.stderr)

    # 不同平台的安装建议
    plat = sys.platform
    if plat == "darwin":
        print("  Or: brew install node", file=sys.stderr)
    elif plat.startswith("linux"):
        print("  Or: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -", file=sys.stderr)
    elif plat == "win32":
        print("  Or: winget install OpenJS.NodeJS.LTS", file=sys.stderr)
    print(
        "  Note: khy 可自动下载便携版 Node 到用户目录（设 KHY_AUTO_INSTALL_NODE=0 关闭）。",
        file=sys.stderr,
    )
    print("  Tip: run `khy preflight` to diagnose all startup prerequisites.", file=sys.stderr)
    print("  Tip: run `khy doctor` to diagnose AND auto-repair them.", file=sys.stderr)


def _print_fallback_help():
    """当后端依赖缺失时，输出最小可用帮助信息。"""
    print("khy OS CLI")
    print("")
    print("Usage:")
    print("  khy [command] [args]")
    print("  khy-os [command] [args]")
    print("  khyquant [command] [args]")
    print("")
    print("Common:")
    print('  khy -p "your question"        # one-shot AI output')
    print("  khy doctor                    # diagnose AND auto-repair startup prerequisites")
    print("  khy preflight                 # diagnose startup prerequisites")
    print("  khy where                     # show the real install location (not just the PATH shim)")
    print("  khy postinstall               # re-run cross-language runtime self-heal")
    print("  khy dev-setup                 # check/repair dev toolchains before a rebuild")
    print("  khy-os --no-server help       # command help")
    print("  khy-os --version              # version")
    print("  khy bundle verify --manifest <manifest.json>")
    print("  khy bundle repair --manifest <manifest.json>")
    print("  khy iso build --output dist/khy-os.iso")
    print("  khy build android [--release] [--output dist/android]")
    print("")
    print("Note:")
    print("  Bundled backend dependencies are missing in this environment.")
    print("  Run a normal startup once (without --help/--version) to initialize.")


def _print_exit_diagnosis(returncode: int):
    """When the Node backend exits non-zero, never leave the user with a bare
    "exit 1" and no guidance. The launcher otherwise propagates the child's code
    transparently (Windows has no os.execvpe), so a backend crash reads as a
    silent failure. Print one actionable line pointing at the built-in doctor.

    Kept deliberately short — the backend has usually already written its own
    error to stderr; this only adds the next step the user can take."""
    print("", file=sys.stderr)
    print(
        "  khy exited with code %s. The backend stopped before finishing."
        % returncode,
        file=sys.stderr,
    )
    print("  Next steps:", file=sys.stderr)
    print("    khy doctor        # diagnose AND auto-repair (Node, deps, .env, port)", file=sys.stderr)
    print("    khy preflight     # diagnose startup prerequisites (Node, deps, paths)", file=sys.stderr)
    print("    khy where         # show the real install location", file=sys.stderr)
    print("    khy postinstall   # re-run cross-language runtime self-heal", file=sys.stderr)


def _normalize_bundle_command(raw_args):
    """Map bundle-related aliases to bundle subcommand argv.

    Supported forms:
      - khy bundle verify ...
      - khy bundle repair ...
      - khy os verify-bundle ...
      - khy os repair-bundle ...
      - khy verify-bundle ...
      - khy repair-bundle ...
    """
    if not raw_args:
        return None

    argv = [str(a).strip() for a in raw_args if str(a).strip()]
    if not argv:
        return None

    head = argv[0].lower()
    if head == "bundle":
        return argv[1:]

    if head == "os" and len(argv) >= 2:
        cmd = argv[1].lower()
        if cmd == "verify-bundle":
            return ["verify"] + argv[2:]
        if cmd == "repair-bundle":
            return ["repair"] + argv[2:]
        return None

    if head == "verify-bundle":
        return ["verify"] + argv[1:]
    if head == "repair-bundle":
        return ["repair"] + argv[1:]
    return None


def _normalize_iso_build_command(raw_args):
    """Map ISO build aliases to script argv.

    Supported forms:
      - khy iso build [--output ...] [--no-cache]
      - khy os iso build [--output ...] [--no-cache]
      - khy build-iso [--output ...] [--no-cache]
    """
    if not raw_args:
        return None

    argv = [str(a).strip() for a in raw_args if str(a).strip()]
    if not argv:
        return None

    lower = [a.lower() for a in argv]
    if len(lower) >= 2 and lower[0] == "iso" and lower[1] == "build":
        return argv[2:]
    if len(lower) >= 3 and lower[0] == "os" and lower[1] == "iso" and lower[2] == "build":
        return argv[3:]
    if lower[0] == "build-iso":
        return argv[1:]
    return None


def _normalize_android_build_command(raw_args):
    """Map Android APK build aliases to the orchestrator argv.

    Supported forms (all route to khy_platform.android_build.run_android_build):
      - khy build android [--release] [--output DIR] [--skip-web] [--verbose]
      - khy android build [...]
      - khy os build android [...]
      - khy build-android [...]

    Returns the residual argv (flags after the verb), or None when the command
    is not an Android build. Kept deliberately narrow so the kernel `os build`
    and `iso build` paths are never shadowed.
    """
    if not raw_args:
        return None
    argv = [str(a).strip() for a in raw_args if str(a).strip()]
    if not argv:
        return None
    lower = [a.lower() for a in argv]

    if len(lower) >= 2 and lower[0] == "build" and lower[1] == "android":
        return argv[2:]
    if len(lower) >= 2 and lower[0] == "android" and lower[1] == "build":
        return argv[2:]
    if len(lower) >= 3 and lower[0] == "os" and lower[1] == "build" and lower[2] == "android":
        return argv[3:]
    if lower[0] == "build-android":
        return argv[1:]
    return None


def _find_iso_script(is_windows: bool) -> Path | None:
    """Locate ISO build helper script in source mode or pip bundled mode."""
    # forest layout: platform/khy_platform/ -> platform -> repo root; scripts/ stays at root
    project_root = Path(__file__).parent.parent.parent
    bundled_root = _find_bundled_root()
    if is_windows:
        candidates = [project_root / "scripts" / "alpine" / "build-iso-windows.ps1"]
        if bundled_root:
            candidates.append(bundled_root / "scripts" / "alpine" / "build-iso-windows.ps1")
    else:
        candidates = [project_root / "scripts" / "alpine" / "build-iso-docker.sh"]
        if bundled_root:
            candidates.append(bundled_root / "scripts" / "alpine" / "build-iso-docker.sh")
    for p in candidates:
        if p.exists():
            return p
    return None


def _run_iso_build_cli(script_args):
    """Run cross-platform ISO build helper script."""
    is_windows = os.name == "nt"
    script = _find_iso_script(is_windows)
    if not script:
        print("Error: ISO build script not found in this installation.", file=sys.stderr)
        print("  Please reinstall khy-os or use source tree with scripts/alpine.", file=sys.stderr)
        return 1

    if is_windows:
        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            *script_args,
        ]
    else:
        cmd = ["bash", str(script), *script_args]

    result = subprocess.run(cmd)
    return int(result.returncode or 0)


# ── khy claude 启动器 ─────────────────────────────────────────────────


def _get_proxy_base() -> str:
    try:
        from khy_platform._bootstrap import _get_proxy_base_url
        return _get_proxy_base_url()
    except Exception:
        host = str(os.environ.get("PROXY_HOST", "")).strip() or "127.0.0.1"
        try:
            port = int(str(os.environ.get("PROXY_PORT", "9100")).strip())
        except (TypeError, ValueError):
            port = 9100
        if port <= 0 or port > 65535:
            port = 9100
        return f"http://{host}:{port}"


def _is_local_https_proxy(base_url: str) -> bool:
    import ipaddress
    from urllib.parse import urlparse

    try:
        parsed = urlparse(str(base_url or "").strip())
    except Exception:
        return False
    if parsed.scheme.lower() != "https":
        return False
    host = str(parsed.hostname or "").strip().lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _proxy_urlopen(request, timeout: int):
    import ssl
    import urllib.request

    kwargs = {"timeout": timeout}
    if _is_local_https_proxy(getattr(request, "full_url", "")):
        kwargs["context"] = ssl._create_unverified_context()
    return urllib.request.urlopen(request, **kwargs)


def _fetch_proxy_models() -> list[dict]:
    """从 KHY 代理获取所有可用模型列表。"""
    import urllib.request
    import urllib.error

    # 读取 auth token
    token = ""
    try:
        from khy_platform._bootstrap import _read_proxy_auth_token
        token = _read_proxy_auth_token() or ""
    except Exception:
        pass

    proxy_base = _get_proxy_base()
    url = f"{proxy_base}/v1/models"
    req = urllib.request.Request(url, headers={
        "x-api-key": token,
        "Accept": "application/json",
    })
    try:
        with _proxy_urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("data", [])
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return []


def _group_models(models: list[dict]) -> dict[str, list[dict]]:
    """按适配器（owned_by）分组模型，过滤掉重复和不常用的。"""
    # 优先显示的适配器及显示顺序
    adapter_order = ["khy", "kiro", "trae", "cursor", "codex", "relay_api", "vscode", "ollama", "localLLM"]
    # 跳过反向代理派生的重复条目（antigravity/nirvana 是 trae 的镜像）
    skip_owners = {"antigravity", "nirvana", "claude", "cursor2api", "warp"}

    groups: dict[str, list[dict]] = {}
    seen_ids: set[str] = set()
    for m in models:
        owner = m.get("owned_by", "unknown")
        if owner in skip_owners:
            continue
        mid = m.get("id", "")
        # 去重：relay_api 的无前缀副本
        if "/" not in mid and mid in seen_ids:
            continue
        if mid in seen_ids:
            continue
        seen_ids.add(mid)
        groups.setdefault(owner, []).append(m)

    # 按优先级排序
    sorted_groups: dict[str, list[dict]] = {}
    for key in adapter_order:
        if key in groups:
            sorted_groups[key] = groups.pop(key)
    for key in sorted(groups.keys()):
        sorted_groups[key] = groups[key]
    return sorted_groups


_ADAPTER_DISPLAY = {
    "khy": "KHY ExpandModel (本地+订阅)",
    "kiro": "Kiro IDE (AWS Q)",
    "trae": "Trae IDE",
    "cursor": "Cursor IDE",
    "codex": "OpenAI Codex",
    "relay_api": "Relay API",
    "vscode": "VS Code Copilot",
    "ollama": "Ollama (本地)",
    "localLLM": "本地模型",
}


def _run_claude_code_launcher(args: list[str]) -> int:
    """khy claude 命令：零配置启动 Claude Code + KHY 代理。

    自动完成：
    1. 检测并启动反向代理（如未运行）
    2. 读取/刷新 auth token（自动从本机代理配置获取）
    3. 通过子进程环境变量注入代理配置（不写 settings.json）
    4. 显示模型列表让用户选择（或直接指定模型）

    用法:
      khy claude                      # 交互选择模型并启动
      khy claude --hybrid             # 混合模式：外部 token 做主模型 + KHY 适配器做子代理
      khy claude --hybrid-sub         # 反向混合：KHY 适配器做主模型 + 外部 token 做子代理
      khy claude --model <model>      # 指定模型直接启动
      khy claude --marshal <model>    # 皇权特许：强制指定任意在线模型为元帅（主控）
      khy claude --list               # 仅列出可用模型
      khy claude <claude args>        # 透传参数给 claude
    """
    # 解析 khy claude 特有的参数
    model_override = None
    marshal_override: str | None = None  # 用户强制指定的元帅（主控模型）
    list_only = False
    hybrid_mode: str | None = None  # None / "main" / "sub"
    passthrough: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--model" and i + 1 < len(args):
            model_override = args[i + 1]
            i += 2
            continue
        elif a.startswith("--model="):
            model_override = a.split("=", 1)[1]
            i += 1
            continue
        elif a == "--marshal" and i + 1 < len(args):
            marshal_override = args[i + 1]
            i += 2
            continue
        elif a.startswith("--marshal="):
            marshal_override = a.split("=", 1)[1]
            i += 1
            continue
        elif a == "--list":
            list_only = True
            i += 1
            continue
        elif a == "--hybrid":
            hybrid_mode = "main"  # 外部 token 做主模型
            i += 1
            continue
        elif a == "--hybrid-sub":
            hybrid_mode = "sub"   # 外部 token 做子代理
            i += 1
            continue
        else:
            passthrough.append(a)
            i += 1

    node = check_node()
    backend_dir = get_bundle_dir()
    from khy_platform._bootstrap import ensure_bootstrapped
    ensure_bootstrapped(backend_dir, node)

    # ── 1. 自动启动反向代理 ──
    if not _ensure_proxy_running(node, backend_dir):
        return 1

    # ── 2. 混合模式检测与提示 ──
    ext_token = os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
    ext_key = os.environ.get("ANTHROPIC_API_KEY", "")
    has_ext_auth = (
        (bool(ext_token) and not ext_token.startswith("khy-"))
        or (bool(ext_key) and not ext_key.startswith("khy-"))
    )
    ext_endpoint = os.environ.get("ANTHROPIC_BASE_URL", "") or "https://api.anthropic.com"

    if hybrid_mode:
        if has_ext_auth:
            if hybrid_mode == "main":
                print(f"  混合模式已启用")
                print(f"    主模型 → claude/ 适配器 → 外部 ({ext_endpoint})")
                print(f"    子代理 → KHY 适配器（kiro/cursor 等）\n")
            else:  # "sub"
                print(f"  反向混合模式已启用")
                print(f"    主模型 → KHY 适配器")
                print(f"    子代理 → claude/ 适配器 → 外部 ({ext_endpoint})\n")
        else:
            print("  警告: --hybrid/--hybrid-sub 需要外部 Anthropic 认证")
            print("  请先设置: export ANTHROPIC_AUTH_TOKEN=sk-xxx")
            print("       或:  export ANTHROPIC_API_KEY=sk-ant-xxx\n")
            hybrid_mode = None  # fallback to normal mode
    elif has_ext_auth:
        print("  检测到外部 Anthropic 认证，可选混合模式:")
        print("    --hybrid      外部 token 做主模型 + KHY 适配器做子代理")
        print("    --hybrid-sub  KHY 适配器做主模型 + 外部 token 做子代理\n")

    # ── 3. 构建 KHY 代理环境变量（不写 settings.json，退出后零残留）──
    proxy_env = _build_khy_proxy_env(hybrid=hybrid_mode, marshal=marshal_override)

    # ── 3. 检查 claude 命令 ──
    claude_cmd = "claude.cmd" if os.name == "nt" else "claude"
    if not list_only:
        try:
            subprocess.run(
                [claude_cmd, "--version"],
                capture_output=True, timeout=5,
                **_subprocess_kwargs(),
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            print("  错误: 未找到 claude 命令。", file=sys.stderr)
            print("  请先安装: npm install -g @anthropic-ai/claude-code", file=sys.stderr)
            print("  提示: 运行 `khy preflight` 可一次性体检所有启动依赖。", file=sys.stderr)
            return 1

    # ── 4. 获取模型列表 ──
    print("  正在获取可用模型...")
    models = _fetch_proxy_models()
    if not models:
        print("  警告: 无法获取模型列表", file=sys.stderr)
        if not model_override:
            # 无模型列表时使用 khy-expand（本地能力兜底）
            print("  使用 khy-expand 模型启动（本地能力模式）...")
            return _launch_claude(claude_cmd, "khy-expand", passthrough, proxy_env)

    groups = _group_models(models)

    # --list: 仅显示模型列表
    if list_only:
        _print_model_list(groups)
        return 0

    # --model: 直接启动
    if model_override:
        return _launch_claude(claude_cmd, model_override, passthrough, proxy_env)

    # 交互模式：显示模型列表并让用户选择
    all_models = _print_model_list(groups, numbered=True)
    if not all_models:
        print("  没有可用模型，使用 khy-expand（本地能力模式）启动。")
        return _launch_claude(claude_cmd, "khy-expand", passthrough, proxy_env)

    print()
    try:
        choice = input(f"  输入序号选择模型 (1-{len(all_models)}, 回车=默认): ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return 130

    if not choice:
        # 回车 = 用 settings.json 中的默认模型
        return _launch_claude(claude_cmd, None, passthrough, proxy_env)

    try:
        idx = int(choice) - 1
    except ValueError:
        # 直接输入了模型名
        return _launch_claude(claude_cmd, choice, passthrough, proxy_env)

    if idx < 0 or idx >= len(all_models):
        idx = 0

    selected = all_models[idx]
    return _launch_claude(claude_cmd, selected["id"], passthrough, proxy_env)


def _is_proxy_running() -> bool:
    """检测 KHY 反向代理是否在运行。"""
    import urllib.request
    import urllib.error

    token = ""
    try:
        from khy_platform._bootstrap import _read_proxy_auth_token
        token = _read_proxy_auth_token() or ""
    except Exception:
        pass

    proxy_base = _get_proxy_base()
    req = urllib.request.Request(
        f"{proxy_base}/v1/models",
        headers={"x-api-key": token, "Accept": "application/json"},
    )
    try:
        with _proxy_urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


def _start_proxy_daemon_direct(node_cmd: str, backend_dir: Path) -> bool:
    """Start backend/scripts/proxy-daemon.js directly to avoid CLI auth coupling."""
    daemon_script = backend_dir / "scripts" / "proxy-daemon.js"
    if not daemon_script.exists():
        return False
    proc = subprocess.Popen(
        [node_cmd, str(daemon_script)],
        cwd=str(backend_dir),
        env=_build_backend_process_env(backend_dir),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **_background_subprocess_kwargs(),
    )
    # 短暂等待后探测：若守护进程启动即崩溃则返回失败
    time.sleep(0.4)
    rc = proc.poll()
    if rc is not None and rc != 0:
        return False
    return True


def _start_proxy_via_cli_fallback() -> bool:
    """Fallback for layouts that do not expose backend/scripts/proxy-daemon.js."""
    khy_cmd = "khy.exe" if os.name == "nt" else "khy"
    try:
        result = subprocess.run(
            [khy_cmd, "proxy", "start"],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=30,
            **_subprocess_kwargs(),
        )
        if result.returncode == 0:
            for _ in range(10):
                time.sleep(1)
                if _is_proxy_running():
                    print("  ✓ KHY 代理已启动")
                    return True
            print("  ✓ KHY 代理启动命令已执行")
            return True

        stderr = (result.stderr or "").strip()
        if "已在运行" in stderr or "already" in stderr.lower():
            for _ in range(5):
                time.sleep(1)
                if _is_proxy_running():
                    print("  ✓ KHY 代理已就绪")
                    return True
            print("  ✓ KHY 代理已在运行")
            return True

        print(f"  错误: 代理启动失败: {stderr}", file=sys.stderr)
        print("  请手动运行: khy proxy start", file=sys.stderr)
        return False
    except FileNotFoundError:
        print("  错误: khy 命令未找到", file=sys.stderr)
        return False
    except subprocess.TimeoutExpired:
        if _is_proxy_running():
            print("  ✓ KHY 代理已启动")
            return True
        print("  警告: 代理启动超时，请手动运行: khy proxy start", file=sys.stderr)
        return False


def _ensure_proxy_running(node_cmd: str | None = None, backend_dir: Path | None = None) -> bool:
    """Ensure the local reverse proxy is ready without requiring any CLI login."""
    if _is_proxy_running():
        print("  ✓ KHY 代理已就绪")
        return True

    print("  正在启动 KHY 反向代理...")
    try:
        resolved_node = node_cmd or check_node()
        resolved_backend_dir = backend_dir or get_bundle_dir()
        if _start_proxy_daemon_direct(resolved_node, resolved_backend_dir):
            for _ in range(10):
                time.sleep(1)
                if _is_proxy_running():
                    print("  ✓ KHY 代理已启动")
                    return True
            print("  警告: 直接启动代理未在预期时间内就绪，回退到 khy proxy start ...", file=sys.stderr)
        return _start_proxy_via_cli_fallback()
    except Exception:
        if _is_proxy_running():
            print("  ✓ KHY 代理已启动")
            return True
        return _start_proxy_via_cli_fallback()


def _build_khy_proxy_env(hybrid: str | None = None, marshal: str | None = None) -> dict[str, str]:
    """构建 KHY 代理所需的环境变量（不写 settings.json）。

    返回一个 dict，由 _launch_claude 注入到子进程环境中。
    khy claude 退出后不留任何残留，不影响直接 `claude` 的使用。

    hybrid 模式:
      None   — 默认，全部走 KHY 适配器
      "main" — 主模型走 claude/ 适配器（外部 token），子代理走 KHY 适配器
      "sub"  — 主模型走 KHY 适配器，子代理走 claude/ 适配器（外部 token）

    claude/ 前缀让 KHY 代理路由到 claudeAdapter → direct 模式 →
    代理进程继承了 shell 的 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY，
    直接调用外部 Anthropic API。
    """
    from khy_platform._bootstrap import (
        _read_proxy_auth_token,
        _generate_proxy_auth_token,
        _resolve_claude_code_models,
    )

    auth_token = _read_proxy_auth_token() or _generate_proxy_auth_token()
    default_model, opus_model, sonnet_model, haiku_model, subagent_model = _resolve_claude_code_models()
    proxy_base = _get_proxy_base()

    env = {
        "ANTHROPIC_BASE_URL": proxy_base,
        # 同时注入 Bearer 与 api-key 两种凭据，二者同值（KHY 代理 proxyServer
        # 对 Authorization: Bearer 与 x-api-key 两类头都接受）：
        #   - ANTHROPIC_AUTH_TOKEN 作为主凭据（Bearer）：优先级高于 API_KEY，可
        #     避免在自定义 BASE_URL 下因 x-api-key 触发“自定义 key 审批”而回退
        #     到 "Please run /login"。
        #   - ANTHROPIC_API_KEY 保留：兼容读取 api-key 的消费方/工具链（对齐
        #     cc-switch“保留原配置 token 变量”的做法），不影响工具使用。
        "ANTHROPIC_AUTH_TOKEN": auth_token,
        "ANTHROPIC_API_KEY": auth_token,
        "ANTHROPIC_MODEL": default_model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": opus_model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": sonnet_model,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": haiku_model,
        "CLAUDE_CODE_SUBAGENT_MODEL": subagent_model,
    }
    if _is_local_https_proxy(proxy_base):
        # Local self-signed TLS is acceptable for the child Claude process.
        env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"

    if hybrid == "main":
        # 主模型走 claude/ 适配器（外部 token），子代理保持 KHY 适配器
        env["ANTHROPIC_MODEL"] = "claude/claude-opus-4-6"
        env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = "claude/claude-opus-4-6"
        env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = "claude/claude-sonnet-4-6"
    elif hybrid == "sub":
        # 主模型保持 KHY 适配器，子代理走 claude/ 适配器（外部 token）
        env["CLAUDE_CODE_SUBAGENT_MODEL"] = "claude/claude-sonnet-4-6"

    # 皇权特许：仅透传用户强制指定的元帅，由后端任命模块（src/services/marshal）
    # 校验在线 + 选协议。此处不做能力阻拦（用户意志至上）。
    if marshal and str(marshal).strip():
        env["KHY_MARSHAL"] = str(marshal).strip()

    return env


def _print_model_list(groups: dict[str, list[dict]], numbered: bool = False) -> list[dict]:
    """打印分组模型列表，返回扁平化的模型列表（用于交互选择）。"""
    all_models: list[dict] = []
    for adapter, models in groups.items():
        display_name = _ADAPTER_DISPLAY.get(adapter, adapter)
        print(f"\n  ── {display_name} ──")
        for m in models:
            idx = len(all_models) + 1
            mid = m.get("id", "?")
            name = m.get("name", mid)
            prefix = f"  {idx:3d}. " if numbered else "    "
            # 标记默认模型
            default_mark = " ★" if m.get("is_default") else ""
            print(f"{prefix}{mid:<40s}  {name}{default_mark}")
            all_models.append(m)
    return all_models


def _launch_claude(
    claude_cmd: str,
    model: str | None,
    extra_args: list[str],
    proxy_env: dict[str, str] | None = None,
) -> int:
    """启动 Claude Code，可选指定模型。

    proxy_env: KHY 代理环境变量，仅注入到子进程中。
    通过子进程 env 传递而非写 settings.json，退出后零残留，
    不影响之后直接 `claude` 使用原有认证。
    """
    proxy_base = _get_proxy_base()
    if model:
        print(f"\n  启动 Claude Code → {model}")
        print(f"  (通过 KHY 代理 {proxy_base})\n")
        cmd = [claude_cmd, "--model", model] + extra_args
    else:
        print(f"\n  启动 Claude Code（默认模型）")
        print(f"  (通过 KHY 代理 {proxy_base})\n")
        cmd = [claude_cmd] + extra_args
    # 工具调用排障提示：设 PROXY_TOOL_DEBUG=true 让 KHY 代理打印工具透传诊断。
    if os.environ.get("PROXY_TOOL_DEBUG", "").lower() != "true":
        print("  提示：工具排障可设 PROXY_TOOL_DEBUG=true 查看代理工具透传日志\n")

    child_env = os.environ.copy()
    if proxy_env:
        # 注入 KHY 代理配置：proxy_env 同时设置 ANTHROPIC_AUTH_TOKEN 与
        # ANTHROPIC_API_KEY（同为 khy token），update 会覆盖从用户 shell 继承的
        # 任何同名旧值/外部 token，因此无需也不应再单独 pop——既消除了陈旧凭据
        # 冲突，又按需保留了 api-key 变量。AUTH_TOKEN 优先级更高，避免 /login 回退。
        child_env.update(proxy_env)

    result = subprocess.run(cmd, env=child_env)
    return result.returncode


# ──────────────────────────────────────────────────────────────────────────
# 启动预检（preflight）
#
# pip 只装好了「Python 启动器」这一层。`khy chat` 真正能跑起来，在 Windows 上
# 还需要满足另外三层依赖，缺一不可：
#   1. khy 可执行文件在 PATH 上            （否则 shell 报 'khy' 不是命令）
#   2. Node.js >= 20                        （后端是 Node 写的）
#   3. backend/node_modules 已安装          （首次启动的 npm install 成功）
#   4. 全局 claude CLI                       （khy chat 会拉起 claude-code）
#
# 这些失败点原先分散在启动流程各处、且多数直接 sys.exit。这里把四项集中成一次
# 体检（`khy preflight`），给出 Windows 专属、可直接粘贴执行的修复指引。
# ──────────────────────────────────────────────────────────────────────────

_PF_OK = "ok"
_PF_WARN = "warn"
_PF_FAIL = "fail"

# 纯文本版本（向后兼容）；渲染时会自动尝试使用彩色版本
_PF_MARK = {_PF_OK: "[ OK ]", _PF_WARN: "[WARN]", _PF_FAIL: "[FAIL]"}


def _render_mark(status: str) -> str:
    """渲染状态标记（TTY 下返回彩色，日志/管道下返回纯文本）。"""
    import sys as _sys
    if not bool(getattr(_sys.stderr, "isatty", lambda: False)()):
        return _PF_MARK.get(status, f"[{status.upper()}]")
    try:
        from khy_platform._ui import ok, warn, fail
        return {_PF_OK: ok(), _PF_WARN: warn(), _PF_FAIL: fail()}.get(status, f"[{status.upper()}]")
    except Exception:
        return _PF_MARK.get(status, f"[{status.upper()}]")


def _run_with_spinner(text, func, *args, **kwargs):
    """在 spinner 动画下运行函数。

    如果函数抛出异常，spinner 显示 [FAIL]；成功则显示 [ OK ]。
    非 TTY 环境（管道/日志）跳过 spinner，直接运行函数。
    """
    tty = bool(getattr(sys.stderr, "isatty", lambda: False)())
    if not tty:
        # 非交互：静默执行
        return func(*args, **kwargs)
    try:
        from khy_platform._ui import Spinner
        with Spinner(text):
            return func(*args, **kwargs)
    except ImportError:
        # _ui 不可用：回退到静默执行
        return func(*args, **kwargs)


# 已知的命令列表（用于建议）
_KNOWN_COMMANDS = {
    # Python 层命令
    "preflight", "precheck", "doctor", "heal", "selfheal",
    "where", "which", "location", "whereami",
    "apps", "app-list", "applist",
    "tray", "stop", "claude", "deploy", "postinstall",
    "dev-setup", "devsetup", "dev",
    # 常用的 Node 层命令
    "chat", "gateway", "os", "khyos", "upgrade", "update",
    "help", "version", "docs", "analytics", "config",
    "status", "info", "init", "start", "restart",
}


def _suggest_command(unknown: str) -> str | None:
    """对未知命令做模糊匹配，返回最相似的命令名（或 None）。"""
    if not unknown:
        return None
    unknown_lower = unknown.lower()
    # 完全匹配（大小写不敏感）→ 不需要建议
    if unknown_lower in _KNOWN_COMMANDS:
        return None
    try:
        import difflib
        matches = difflib.get_close_matches(unknown_lower, _KNOWN_COMMANDS, n=1, cutoff=0.4)
        return matches[0] if matches else None
    except Exception:
        return None


def _render_warning(msg: str):
    """向 stderr 输出黄色警告。"""
    try:
        from khy_platform._ui import warn, dim
        sys.stderr.write(f"{warn()} {msg}\n")
        sys.stderr.flush()
    except Exception:
        sys.stderr.write(f"[WARN] {msg}\n")


def _dim_print(msg: str):
    """向 stderr 输出灰色辅助文字。"""
    try:
        from khy_platform._ui import dim
        sys.stderr.write(f"{dim(msg)}\n")
        sys.stderr.flush()
    except Exception:
        sys.stderr.write(f"{msg}\n")


def _is_china_env() -> bool:
    """复用 Node 提示逻辑：中文环境优先给国内镜像。"""
    lang = os.environ.get("LANG", "") + os.environ.get("LC_ALL", "")
    tz = os.environ.get("TZ", "")
    return lang.startswith("zh") or "Shanghai" in tz or "Chongqing" in tz


def _scripts_dirs() -> list[Path]:
    """pip 放置 console_scripts 可执行文件的候选目录（按可靠度排序）。

    覆盖三种情况：
    - 全局安装：sysconfig 默认 scheme 的 scripts 目录
    - `pip install --user`：用户 scheme（nt_user / posix_user）
    - 当前进程入口所在目录（经 console_script 启动时最可靠）
    """
    dirs: list[Path] = []

    def _add(value):
        if not value:
            return
        try:
            dirs.append(Path(value))
        except Exception:
            pass

    try:
        _add(sysconfig.get_path("scripts"))
        user_scheme = "nt_user" if os.name == "nt" else "posix_user"
        try:
            _add(sysconfig.get_path("scripts", scheme=user_scheme))
        except Exception:
            pass
    except Exception:
        pass

    # 当前正在运行的入口：经 khy.exe / khy 启动时，argv[0] 就在 Scripts 目录里。
    try:
        argv0 = Path(sys.argv[0]).resolve()
        if argv0.exists():
            dirs.append(argv0.parent)
    except Exception:
        pass

    seen: set[str] = set()
    out: list[Path] = []
    for d in dirs:
        key = str(d).lower()
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def _find_entrypoint_dir() -> Path | None:
    """在已知 Scripts 目录里定位实际存在的 khy 可执行文件所在目录。"""
    names = ["khy.exe", "khy-os.exe", "khyquant.exe", "khy"] if os.name == "nt" else [
        "khy", "khy-os", "khyquant"
    ]
    for d in _scripts_dirs():
        try:
            for n in names:
                if (d / n).exists():
                    return d
        except Exception:
            continue
    return None


def _dual_install_check_enabled() -> bool:
    """Gate: ``KHY_DUAL_INSTALL_CHECK`` (default on; only {0,false,off,no} = off)."""
    raw = os.environ.get("KHY_DUAL_INSTALL_CHECK")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "off", "no"}


def _find_all_khy_on_path() -> list:
    """Return every distinct ``khy`` / ``khy-os`` executable resolvable on PATH,
    in PATH precedence order (first = the one that actually runs).

    Deterministic, fail-soft: any lookup error yields an empty list rather than
    raising. Used to detect the pip-vs-npm dual-install shadow (both channels
    ship a ``khy`` bin; whichever sorts first on PATH wins, so upgrading the
    other channel silently has no effect)."""
    found: list = []
    seen = set()
    try:
        path_dirs = os.environ.get("PATH", "").split(os.pathsep)
        exe_names = ("khy", "khy-os")
        if os.name == "nt":
            exe_names = ("khy.exe", "khy.cmd", "khy-os.exe", "khy-os.cmd", "khy", "khy-os")
        for d in path_dirs:
            d = d.strip()
            if not d:
                continue
            for name in exe_names:
                cand = os.path.join(d, name)
                try:
                    if not (os.path.isfile(cand) and os.access(cand, os.X_OK)):
                        continue
                    real = os.path.realpath(cand)
                except OSError:
                    continue
                if real in seen:
                    continue
                seen.add(real)
                found.append(cand)
    except Exception:  # noqa: BLE001 — never let diagnostics crash the caller
        return []
    return found


def _classify_khy_channel(path: str) -> str:
    """Best-effort label for which install channel a ``khy`` launcher belongs to.
    Pure string heuristic on the resolved path; never raises."""
    try:
        p = os.path.realpath(path).replace("\\", "/").lower()
    except Exception:  # noqa: BLE001
        p = str(path).replace("\\", "/").lower()
    if "node_modules" in p or "/npm/" in p or p.endswith(".cmd"):
        return "npm"
    if "site-packages" in p or "/scripts/" in p or "/.local/bin/" in p or "/bin/" in p:
        return "pip"
    return "unknown"


def _pf_check_dual_install() -> dict:
    """Detect the pip + npm dual-install shadow and advise how to keep the two
    channels in sync — NOT to uninstall one.

    pip and npm are parallel channels; each bundles its own backend and they
    coexist fine. The real hazard is drift: only the launcher that sorts first on
    PATH runs, so upgrading one channel while the other shadows it looks like
    "the upgrade had no effect". The fix is to update BOTH, which
    ``khy update`` does automatically (channel-aware self-update).

    Gate ``KHY_DUAL_INSTALL_CHECK`` (default on). Fail-soft: any error → OK/skip,
    never blocks the preflight."""
    if not _dual_install_check_enabled():
        return {"name": "khy channels", "status": _PF_OK,
                "detail": "dual-install check disabled (KHY_DUAL_INSTALL_CHECK)", "fixes": []}
    launchers = _find_all_khy_on_path()
    if len(launchers) < 2:
        return {"name": "khy channels", "status": _PF_OK,
                "detail": "one khy launcher on PATH" if launchers else "no khy launcher resolved",
                "fixes": []}

    active = launchers[0]
    active_channel = _classify_khy_channel(active)
    lines = []
    for i, p in enumerate(launchers):
        ch = _classify_khy_channel(p)
        role = "active" if i == 0 else "shadowed"
        lines.append(f"{i + 1}. {p} ({ch} · {role})")
    detail = ("multiple khy launchers on PATH — pip and npm can coexist, but only "
              "the first runs:\n       " + "\n       ".join(lines))

    fixes = [
        "两个渠道可以共存,无需卸载。为避免一个渠道升级、另一个变陈旧,请让两者同步:",
        "  khy update    # 渠道感知:自动把 pip 与 npm 两个渠道一起升到最新",
        "手动同步(等效):",
        "  pip install --upgrade khy-os",
        "  npm install -g @khy-os/khy-os@latest",
        f"(当前 PATH 生效的是 {active_channel} 渠道:{active})",
    ]
    return {"name": "khy channels", "status": _PF_WARN, "detail": detail, "fixes": fixes}


def _pf_check_path_entrypoint() -> dict:
    """第 1 层：khy 可执行文件是否在 PATH 上。"""
    on_path = shutil.which("khy") or shutil.which("khy-os") or shutil.which("khyquant")
    if on_path:
        return {"name": "khy on PATH", "status": _PF_OK, "detail": on_path, "fixes": []}

    fixes: list[str] = []
    entry_dir = _find_entrypoint_dir()
    if entry_dir:
        detail = f"installed in {entry_dir}, but that directory is not on PATH"
        if os.name == "nt":
            fixes.append(
                "PowerShell — add to user PATH (reopen the terminal afterwards):\n"
                f'    $p=[Environment]::GetEnvironmentVariable("Path","User"); '
                f'[Environment]::SetEnvironmentVariable("Path","$p;{entry_dir}","User")'
            )
            fixes.append(f'Run without PATH change: "{entry_dir}\\khy.exe" chat')
        else:
            fixes.append(f'Add to PATH: export PATH="{entry_dir}:$PATH"   (append to ~/.zshrc or ~/.bashrc)')
    else:
        detail = "khy executable not found on PATH or in known Scripts directories"
        fixes.append("Reinstall: pip install --force-reinstall khy-os")
    fixes.append("Fallback that always works: python -m khy_platform chat")
    return {"name": "khy on PATH", "status": _PF_FAIL, "detail": detail, "fixes": fixes}


def _pf_check_node() -> dict:
    """第 2 层：Node.js 是否存在且版本 >= 20。"""
    for cmd in ("node", "node.exe"):
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                **_subprocess_kwargs(),
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if result.returncode != 0:
            continue
        version = result.stdout.strip().lstrip("v")
        try:
            major = int(version.split(".")[0])
        except (ValueError, IndexError):
            continue
        if major >= 20:
            return {"name": "Node.js >= 20", "status": _PF_OK, "detail": f"v{version}", "fixes": []}
        fixes = ["Upgrade Node.js to >= 20."]
        if os.name == "nt":
            fixes.append("winget install OpenJS.NodeJS.LTS")
        return {
            "name": "Node.js >= 20",
            "status": _PF_FAIL,
            "detail": f"v{version} found but >= 20 required",
            "fixes": fixes,
        }

    fixes = []
    if _is_china_env():
        fixes.append("Install from https://npmmirror.com/mirrors/node/ (mirror)")
    else:
        fixes.append("Install from https://nodejs.org/")
    if os.name == "nt":
        fixes.append("Or: winget install OpenJS.NodeJS.LTS")
    elif sys.platform == "darwin":
        fixes.append("Or: brew install node")
    elif sys.platform.startswith("linux"):
        fixes.append("Or: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -")
    return {"name": "Node.js >= 20", "status": _PF_FAIL, "detail": "not found", "fixes": fixes}


def _pf_check_npm() -> dict:
    """npm 是否可用（首次初始化要靠它装依赖）。"""
    for cmd in ("npm", "npm.cmd"):
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                **_subprocess_kwargs(),
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            return {"name": "npm available", "status": _PF_OK, "detail": f"v{result.stdout.strip()}", "fixes": []}
    return {
        "name": "npm available",
        "status": _PF_FAIL,
        "detail": "npm not found (usually shipped with Node.js)",
        "fixes": ["Reinstall Node.js (npm is bundled with it)."],
    }


def _pf_check_backend_deps(backend_dir: Path) -> dict:
    """第 3 层：backend/node_modules 是否已安装（首次 npm install 是否成功）。"""
    node_modules = backend_dir / "node_modules"
    if node_modules.is_dir() and any(node_modules.iterdir()):
        return {
            "name": "Backend dependencies",
            "status": _PF_OK,
            "detail": str(node_modules),
            "fixes": [],
        }
    detail = f"missing: {node_modules}"
    fixes = [
        "Run any normal startup once to auto-install (e.g. khy chat), or install manually:",
        f'    cd "{backend_dir}" && npm install',
    ]
    if os.name == "nt":
        fixes.append(
            "If npm install fails on long paths: "
            "git config --system core.longpaths true  (admin), "
            "or enable Win32 long paths via Group Policy."
        )
        fixes.append(
            "If the install dir is read-only (system site-packages), reinstall with: "
            "pip install --user khy-os"
        )
    return {"name": "Backend dependencies", "status": _PF_FAIL, "detail": detail, "fixes": fixes}


def _pf_check_claude_cli() -> dict:
    """第 4 层：全局 claude CLI 是否存在（khy chat / khy claude 依赖它）。"""
    candidates = ("claude.cmd", "claude.exe", "claude") if os.name == "nt" else ("claude",)
    for cmd in candidates:
        if shutil.which(cmd):
            return {"name": "claude CLI", "status": _PF_OK, "detail": shutil.which(cmd), "fixes": []}
    return {
        "name": "claude CLI",
        "status": _PF_WARN,
        "detail": "not found (required for `khy chat` / `khy claude`)",
        "fixes": ["npm install -g @anthropic-ai/claude-code"],
    }


def _run_preflight_cli(args) -> int:
    """`khy preflight` / `khy precheck`：集中体检四层启动依赖并给出修复指引。

    退出码：0 = 全部通过（warning 不算失败）；1 = 存在 fail 项。
    """
    backend_dir = None
    try:
        backend_dir = get_bundle_dir()
    except SystemExit:
        # get_bundle_dir 在彻底找不到时会 sys.exit；这里降级为可报告的失败项。
        backend_dir = None
    except Exception:
        backend_dir = None

    checks = [
        _pf_check_path_entrypoint(),
        _pf_check_dual_install(),
        _pf_check_node(),
        _pf_check_npm(),
    ]
    if backend_dir is not None:
        checks.append(_pf_check_backend_deps(backend_dir))
    else:
        checks.append({
            "name": "Backend dependencies",
            "status": _PF_FAIL,
            "detail": "bundled backend directory not found",
            "fixes": ["Reinstall: pip install --force-reinstall khy-os"],
        })
    checks.append(_pf_check_claude_cli())

    print("khy startup preflight")
    print("=" * 60)
    failures = 0
    warnings = 0
    for c in checks:
        mark = _render_mark(c["status"])
        print(f"{mark} {c['name']}: {c['detail']}")
        if c["status"] == _PF_FAIL:
            failures += 1
        elif c["status"] == _PF_WARN:
            warnings += 1
        if c["status"] != _PF_OK and c.get("fixes"):
            for fix in c["fixes"]:
                # 缩进多行修复块，保持可读
                lines = str(fix).splitlines() or [""]
                print(f"       → {lines[0]}")
                for extra in lines[1:]:
                    print(f"         {extra}")
    print("=" * 60)

    pkg_version = get_installed_version()
    if pkg_version:
        print(f"khy-os version: {pkg_version}")
    if failures:
        print(f"Result: {failures} blocking issue(s), {warnings} warning(s). "
              f"`khy chat` will not start until the blocking issues are fixed.")
        print("Tip: run `khy doctor` to auto-repair the fixable issues above.")
        return 1
    if warnings:
        print(f"Result: ready, with {warnings} warning(s) (optional features).")
        return 0
    print("Result: all checks passed. `khy chat` is ready.")
    return 0


def _doctor_repair_port(backend_dir: Path) -> dict:
    """Ensure the backend PORT in .env is actually bindable; repick if not.

    First-launch friction this removes: a generated `.env` may pin a PORT that
    another process now holds, so the Node backend dies with EADDRINUSE and the
    user must hand-edit `.env`. Doctor instead probes the port and rewrites it to
    a free one. Fail-soft: any error degrades to a reportable status, never
    raises.
    """
    from khy_platform._bootstrap import _is_port_available, _find_available_port

    env_file = backend_dir / ".env"
    if not env_file.exists():
        return {"name": "Backend port", "status": _PF_WARN,
                "detail": ".env not present yet (will be generated on first run)",
                "fixes": []}
    try:
        lines = env_file.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        return {"name": "Backend port", "status": _PF_WARN,
                "detail": f"could not read .env: {exc}", "fixes": []}

    port = None
    port_idx = -1
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("PORT=") and not stripped.startswith("#"):
            try:
                port = int(stripped.split("=", 1)[1].strip())
            except (ValueError, IndexError):
                port = None
            port_idx = idx
            break

    if port is None:
        return {"name": "Backend port", "status": _PF_OK,
                "detail": "no fixed PORT in .env (backend chooses default)",
                "fixes": []}

    if _is_port_available(port):
        return {"name": "Backend port", "status": _PF_OK,
                "detail": f"{port} is free", "fixes": []}

    new_port = _find_available_port(port)
    if new_port == port:
        return {"name": "Backend port", "status": _PF_WARN,
                "detail": f"{port} appears busy but no free alternative was found",
                "fixes": [f"Free port {port} or set PORT manually in {env_file}"]}

    lines[port_idx] = f"PORT={new_port}"
    try:
        env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError as exc:
        return {"name": "Backend port", "status": _PF_WARN,
                "detail": f"{port} busy; could not rewrite .env: {exc}",
                "fixes": [f"Manually set PORT={new_port} in {env_file}"]}
    return {"name": "Backend port", "status": _PF_OK,
            "detail": f"{port} was busy → switched to {new_port}", "fixes": []}


def _run_doctor_cli(args) -> int:
    """`khy doctor` —— 体检并**主动修复**首次启动依赖（缺什么修什么）。

    与 `khy preflight` 的区别：preflight 只体检并给出可粘贴的修复指令；doctor
    在此基础上真正动手修：自动下载便携版 Node、补齐 backend 依赖、生成 .env、
    端口被占用时改写为空闲端口。修不了的（如全局 claude CLI）退回提示。

    选项：
      --check / --dry-run   只体检不修复（等价于 khy preflight）

    退出码：0 = 修复后无阻塞项；1 = 仍有阻塞项。
    """
    lowered = {str(a).strip().lower() for a in (args or [])}
    if lowered & {"--check", "--dry-run", "-n"}:
        return _run_preflight_cli([])

    from khy_platform._bootstrap import _ensure_npm_install, _ensure_env_file

    print("khy doctor — diagnose & self-heal startup prerequisites")
    print("=" * 60)

    # ── 1. Node.js（缺则自动下载便携版）──
    node_check = _pf_check_node()
    if node_check["status"] != _PF_OK:
        print("[FIX ] Node.js missing/outdated → provisioning portable Node...")
        provisioned = _ensure_node_via_provisioner()
        node_check = _pf_check_node()
        if node_check["status"] == _PF_OK:
            print(f"       [OK] Node.js ready: {node_check['detail']}")
        else:
            print("       [WARN] automatic Node provisioning did not succeed.")

    # ── 2. backend 目录 ──
    backend_dir = None
    try:
        backend_dir = get_bundle_dir()
    except SystemExit:
        backend_dir = None
    except Exception:
        backend_dir = None

    if backend_dir is None:
        print("[FAIL] Backend directory not found — cannot self-heal dependencies.")
        print("       → Reinstall: pip install --force-reinstall khy-os")
        print("=" * 60)
        print("Result: backend missing; resolve the reinstall step above, then re-run `khy doctor`.")
        return 1

    # ── 3. backend 依赖（缺则 npm install）──
    if node_check["status"] == _PF_OK:
        deps_check = _pf_check_backend_deps(backend_dir)
        if deps_check["status"] != _PF_OK:
            print("[FIX ] Backend dependencies missing → running npm install...")
            try:
                _ensure_npm_install(backend_dir)
            except Exception as exc:  # noqa: BLE001
                print(f"       [WARN] npm install raised: {exc}")
    else:
        print("[SKIP] Backend dependency repair needs Node.js first.")

    # ── 4. .env（缺则生成，含动态端口）──
    if not (backend_dir / ".env").exists():
        print("[FIX ] .env missing → generating with a free port...")
        try:
            _ensure_env_file(backend_dir)
        except Exception as exc:  # noqa: BLE001
            print(f"       [WARN] .env generation raised: {exc}")

    # ── 5. 端口占用（占用则改写为空闲端口）──
    port_result = _doctor_repair_port(backend_dir)
    if "switched" in port_result.get("detail", ""):
        print(f"[FIX ] Backend port: {port_result['detail']}")

    # ── 6. 复检并汇总 ──
    print("-" * 60)
    checks = [
        _pf_check_dual_install(),
        _pf_check_node(),
        _pf_check_npm(),
        _pf_check_backend_deps(backend_dir),
        port_result,
        _pf_check_claude_cli(),
    ]
    failures = 0
    warnings = 0
    for c in checks:
        mark = _render_mark(c["status"])
        print(f"{mark} {c['name']}: {c['detail']}")
        if c["status"] == _PF_FAIL:
            failures += 1
        elif c["status"] == _PF_WARN:
            warnings += 1
        if c["status"] != _PF_OK and c.get("fixes"):
            for fix in c["fixes"]:
                lines = str(fix).splitlines() or [""]
                print(f"       → {lines[0]}")
                for extra in lines[1:]:
                    print(f"         {extra}")
    print("=" * 60)
    if failures:
        print(f"Result: {failures} issue(s) still blocking after self-heal, {warnings} warning(s).")
        print("        Apply the suggested fixes above, then re-run `khy doctor`.")
        return 1
    if warnings:
        print(f"Result: healed; {warnings} optional warning(s) remain. `khy chat` is ready.")
        return 0
    print("Result: all checks healthy. `khy chat` is ready.")
    return 0


def _run_where_cli(args) -> int:
    """`khy where` / `khy which` / `khy location`：打印真实安装位置。

    Windows 的 `where khy` 内建命令只会报出 console-script 垫片
    （Python Scripts 目录下的 khy.exe），并不是后端核心代码真正所在的
    bundled 目录。本子命令把真实路径全部摊开：Python 启动器、bundled 后端、
    安装根目录、PATH 上的可执行文件，以及依赖是否就绪——方便排障与定位。

    退出码恒为 0（纯信息查询，不阻断）。
    """
    pkg_version = get_installed_version() or "unknown"
    launcher = Path(__file__).resolve()

    # 解析 backend 目录，但不在缺失时退出（get_bundle_dir 找不到会 sys.exit）。
    backend_dir = None
    try:
        backend_dir = get_bundle_dir()
    except SystemExit:
        backend_dir = None
    except Exception:
        backend_dir = None

    mode = _detect_install_mode(backend_dir) if backend_dir else "unknown"
    bundled_root = _find_bundled_root()
    on_path = (
        shutil.which("khy")
        or shutil.which("khy-os")
        or shutil.which("khyquant")
        or ""
    )

    print("khy install location")
    print("=" * 60)
    print(f"  version        : {pkg_version}")
    print(f"  mode           : {mode}")
    print(f"  executable     : {on_path or '(not on PATH — run `khy preflight`)'}")
    print(f"  python launcher: {launcher}")
    if bundled_root:
        print(f"  bundle root    : {bundled_root}")
    if backend_dir:
        # forest layout: backend dir is services/backend (2 deep) under install root
        install_root = backend_dir.parent.parent if backend_dir.name == "backend" else backend_dir
        print(f"  install root   : {install_root}")
        print(f"  backend dir    : {backend_dir}")
        node_modules = backend_dir / "node_modules"
        ready = node_modules.is_dir() and any(node_modules.iterdir())
        print(f"  dependencies   : {'installed' if ready else 'MISSING (run `khy preflight`)'}")
    else:
        print("  backend dir    : (not found — reinstall: pip install --force-reinstall khy-os)")
    print("=" * 60)
    return 0


def _run_apps_cli(args) -> int:
    """`khy apps` —— 列出动态发现的生态应用。

    通过生态标准 app_protocol.discover_apps() 扫描 entry_points 与注册表，
    有则展示、无则提示，**永不因缺少应用或单个清单损坏而崩溃**。
    支持 `--json` 输出，便于脚本消费。

    子命令 `khy apps activate <name>` —— **懒激活**：仅此显式触发时才通过
    entry_point 加载并实例化应用（重量级初始化），列出/发现阶段绝不导入应用代码。
    """
    try:
        from khy_platform import app_protocol as ap
    except Exception as e:  # 标准模块异常时给出人话提示而非堆栈
        print(f"应用发现不可用：{e}", file=sys.stderr)
        return 1

    # 显式触发：懒激活某个应用（重量级初始化只在此刻发生）。
    if args and args[0].lower() in {"activate", "run", "init"}:
        name = args[1] if len(args) > 1 else ""
        if not name:
            print("用法: khy apps activate <应用名>", file=sys.stderr)
            return 1
        app = ap.load_app(name)
        if app is None:
            print(f"无法激活应用 '{name}'：未发现该应用或其入口点加载失败。", file=sys.stderr)
            print("  提示: 先用 `khy apps` 确认应用已安装并被发现。", file=sys.stderr)
            return 1
        try:
            app.standalone_init()
        except Exception as e:
            print(f"应用 '{name}' 已加载，但初始化时降级（{e}）。", file=sys.stderr)
        print(f"✓ 已激活应用 '{name}'（数据归属: {app.home()}）")
        return 0

    try:
        apps = ap.discover_apps()
    except Exception:
        apps = []

    if args and args[0].lower() in {"--json", "-j"}:
        import json as _json
        print(_json.dumps([a.to_dict() for a in apps], ensure_ascii=False, indent=2))
        return 0

    if not apps:
        print("未发现已安装的生态应用。")
        print("（底座 khyos 不依赖任何应用，可独立运行；安装应用后会自动被发现。）")
        return 0

    print(f"已发现 {len(apps)} 个生态应用：")
    for a in apps:
        cmds = " / ".join(a.commands) if a.commands else "-"
        print(f"  • {a.name:<12} v{a.version:<10} [{a.source}]  命令: {cmds}")
        print(f"      数据归属: {a.data_home}")
    return 0


def main():
    """控制台入口函数（pyproject.toml 的 console_scripts 指向这里）。

    三个命令名都会进到这里：
    - khy
    - khy-os
    - khy-quant
    - khyquant
    """
    raw_args = sys.argv[1:]

    # khy postinstall — install-phase cross-language runtime self-heal.
    # Re-triggerable on demand; also runs implicitly on first launch.
    if raw_args and raw_args[0].lower() in {"postinstall", "post-install"}:
        from khy_platform.devenv import run_postinstall
        sys.exit(run_postinstall())

    # khy dev-setup / khy dev — compile-phase dev-toolchain self-heal.
    if raw_args and raw_args[0].lower() in {"dev-setup", "devsetup", "dev"}:
        from khy_platform.devenv import ensure_dev_environment
        sys.exit(ensure_dev_environment(trigger="dev-setup"))

    bundle_argv = _normalize_bundle_command(raw_args)
    if bundle_argv is not None:
        # Build-related command entry: auto-trigger compile-phase self-heal so a
        # rebuild from the bundled source has every dev toolchain in place.
        from khy_platform.devenv import ensure_dev_environment
        ensure_dev_environment(trigger="bundle")
        from khy_platform.bundle_tools import run_bundle_cli
        sys.exit(run_bundle_cli(bundle_argv))

    iso_argv = _normalize_iso_build_command(raw_args)
    if iso_argv is not None:
        # Build-related command entry: ISO rebuild needs the kernel/MoonBit
        # toolchains — surface what is missing before the long build runs.
        from khy_platform.devenv import ensure_dev_environment
        ensure_dev_environment(trigger="iso-build")
        sys.exit(_run_iso_build_cli(iso_argv))

    # khy build android — 零配置 Capacitor APK 构建（不触发 Node 后端，纯 Python
    # 编排：JDK 预检 + SDK 按需下载 + vite/cap sync + gradlew 无界面出包）。
    # 必须在 Node 后端启动前拦截，且只匹配明确的 android 子命令，绝不遮蔽内核
    # `os build` 与 `iso build`。
    android_argv = _normalize_android_build_command(raw_args)
    if android_argv is not None:
        from khy_platform.android_build import run_android_build
        sys.exit(run_android_build(android_argv))

    # khy preflight / khy precheck — 集中体检启动依赖（不触发 Node 后端）
    if raw_args and raw_args[0].lower() in {"preflight", "precheck"}:
        sys.exit(_run_preflight_cli(raw_args[1:]))

    # khy doctor / heal — 体检并主动自愈启动依赖（缺什么修什么，不触发 Node 后端）。
    # 与内核 `khy os doctor` 区分：此处是顶层 `doctor`（raw_args[0]），后者走 os 子命令。
    if raw_args and raw_args[0].lower() in {"doctor", "heal", "selfheal", "self-heal"}:
        sys.exit(_run_doctor_cli(raw_args[1:]))

    # khy where / which / location — 打印真实安装位置（不触发 Node 后端）。
    # 解决 Windows `where khy` 只显示 Scripts 垫片、看不到 bundled 后端的问题。
    if raw_args and raw_args[0].lower() in {"where", "which", "location", "whereami"}:
        sys.exit(_run_where_cli(raw_args[1:]))

    # khy apps / app-list — 动态发现已安装的生态应用（不触发 Node 后端）。
    # 体现「底座→应用」单向依赖：底座只按标准发现应用，无应用时正常返回。
    if raw_args and raw_args[0].lower() in {"apps", "app-list", "applist"}:
        sys.exit(_run_apps_cli(raw_args[1:]))

    # khy tray — 常驻系统托盘外壳（不触发 Node 后端；纯 Python 编排，托盘动作
    # 复用 `khy gateway manage` 单一真源）。缺 pystray/Pillow 时 fail-soft 提示。
    if raw_args and raw_args[0].lower() == "tray":
        from khy_platform.tray import run_tray_cli
        sys.exit(run_tray_cli(raw_args[1:]))

    # khy stop — 停掉所有常驻 khy 进程（守护进程 + 托盘），升级前先跑它释放文件占用。
    # 纯 Python、不启 Node：bundle 已损坏时仍可用。守护进程是分离拉起的，`khy tray stop`
    # 单独停不了它 → 这里统一停。
    if raw_args and raw_args[0].lower() == "stop":
        from khy_platform import tray
        res = tray.stop_all_resident()
        print("[khy stop] 管理守护进程: " + ("已停止" if res.get("daemon") else "未在运行"))
        print("[khy stop] 系统托盘:     " + ("已停止" if res.get("tray") else "未在运行"))
        print("[khy stop] Markdown 桥接: " + ("已停止" if res.get("md_bridge") else "未在运行"))
        if sys.platform == "win32":
            print("现在可以安全升级：pip install --upgrade khy-os")
        sys.exit(0)

    # khy claude [--model <model>] — 以 KHY 代理模型启动 Claude Code
    if raw_args and raw_args[0].lower() == "claude":
        sys.exit(_run_claude_code_launcher(raw_args[1:]))

    # khy deploy — 服务器一键部署
    if raw_args and raw_args[0].lower() == "deploy":
        from khy_platform.deploy import run_deploy_cli
        sys.exit(run_deploy_cli(raw_args[1:]))

    # khy docs build|site|rebuild|regenerate|generate — 在安装目录内重新生成离线文档站。
    # 只拦这几个重建别名（不触发 Node 后端），其余 docs 子命令（quickstart/ai-fastlane/
    # maintainer/claude/gateway/strategy/faq/subscribe/check）仍原样落到 Node CLI，绝不遮蔽。
    from khy_platform.docs_site import maybe_run_docs_build
    docs_build_argv = maybe_run_docs_build(raw_args)
    if docs_build_argv is not None:
        from khy_platform.docs_site import run_docs_build_cli
        sys.exit(run_docs_build_cli(docs_build_argv, bundled_root=_find_bundled_root()))

    # 未知命令建议（输错时给出模糊匹配提示，相当于「你是不是想输入 xxx？」）
    if raw_args and not raw_args[0].startswith("-"):
        suggestion = _suggest_command(raw_args[0])
        if suggestion:
            _render_warning(f"未知命令 '{raw_args[0]}'")
            _dim_print(f"  └─ 你是不是想输入: khy {suggestion}")

    node = check_node()
    source_backend = _source_checkout_backend()
    bundled_root = _find_bundled_root()
    bundled_cli = (
        bundled_root / "runtime" / "khy" / "bundle.mjs"
        if bundled_root else None
    )
    # In an editable Git checkout the source tree is authoritative. The bundled
    # artifact is reserved for installed wheels, where the source tree is absent.
    is_standalone_bundle = source_backend is None and bool(
        bundled_cli and bundled_cli.is_file()
    )
    backend_dir = source_backend if source_backend is not None else (
        None if is_standalone_bundle else get_bundle_dir()
    )

    # Installed wheels execute the standalone bundle. Source checkouts retain
    # the backend entrypoint for development and self-edit workflows.
    cli_script = bundled_cli if is_standalone_bundle else backend_dir / "bin" / "khy.js"
    if not cli_script.exists():
        # 红线：不止报"找不到"，要说清真实原因 + 怎么解决。
        print(f"错误：找不到 CLI 入口脚本 {cli_script}", file=sys.stderr)
        if sys.platform == "win32":
            print("真实原因：多半是上次升级时 khy 还开着,Windows 锁住了文件,pip 删到一半 → 目录残缺。", file=sys.stderr)
        else:
            print("真实原因：安装包内 backend/bin/khy.js 缺失或安装目录损坏。", file=sys.stderr)
        print("解决方法：", file=sys.stderr)
        if sys.platform == "win32":
            print("  1. 先关掉所有 khy 窗口与残留 node.exe 进程,再重装：", file=sys.stderr)
            print("     khy stop                 # 一键停掉守护进程 + 托盘（释放文件占用）", file=sys.stderr)
            print("     pip install --force-reinstall --no-cache-dir khy-os", file=sys.stderr)
            print(f"  2. 确认安装目录完整：ls {backend_dir / 'bin'}", file=sys.stderr)
            print("  3. 若仍失败：注销/重启 Windows 后再执行第 1 步。", file=sys.stderr)
            print("  4. 若从源码运行，请先在 services/backend 下执行 npm install。", file=sys.stderr)
            print("  提示：以后升级前先跑 `khy stop`（或用 `khy update`，它会自动停机）即可避免此损坏。", file=sys.stderr)
        else:
            print("  1. 重新安装：pip install --force-reinstall --no-cache-dir khy-os", file=sys.stderr)
            print(f"  2. 确认安装目录完整：ls {backend_dir / 'bin'}", file=sys.stderr)
            print("  3. 若从源码运行，请先在 services/backend 下执行 npm install。", file=sys.stderr)
        sys.exit(1)

    # 判断用户是用 khy/khy-os 还是 khyquant 调用（用于后续模式差异）
    invoked = Path(sys.argv[0]).stem.lower().replace("-", "")
    if invoked in {"__main__", "cli"}:
        # Launched via `python -m khy_platform` (portable khy.bat / khy.sh):
        # argv[0] no longer carries the console-script alias, so honor the
        # launcher-provided KHY_INVOKED_AS instead. Missing / empty / blank
        # values must NOT degrade to khyquant mode — fall back to "khy".
        raw = os.environ.get("KHY_INVOKED_AS")
        if raw and raw.strip():
            invoked = raw.strip().lower().replace("-", "")
        else:
            invoked = "khy"
    is_khy_mode = invoked in {"khy", "khyos"}

    control_flags = {"--no-server", "--cli"}
    effective_args = [a for a in raw_args if a not in control_flags]
    first_effective = (effective_args[0] if effective_args else "").lower()
    is_help = ("--help" in raw_args) or ("-h" in raw_args) or (first_effective == "help")
    is_version = (
        ("--version" in raw_args)
        or ("-v" in raw_args)
        or ("-V" in raw_args)
        or (first_effective == "version")
    )

    # 快速路径：help/version 不触发首次初始化
    if not (is_help or is_version or is_standalone_bundle):
        from khy_platform._bootstrap import ensure_bootstrapped
        _run_with_spinner(
            "正在初始化运行环境",
            ensure_bootstrapped,
            backend_dir,
            node,
        )

    # 拼接最终要执行的 Node 命令
    args = [node, str(cli_script)] + raw_args

    # 传递环境变量给 Node 进程
    env = os.environ.copy()
    env["KHYQUANT_ROOT"] = str(backend_dir or bundled_root)  # 告诉后端自己的目录
    # Ensure wrapper behavior matches direct Node CLI:
    # prefer the selected adapter and avoid relay bind fallback loops by default.
    env.setdefault("GATEWAY_PREFERRED_STRICT", "true")
    env.setdefault("GATEWAY_RELAY_ENABLED", "false")

    # Source mode still needs workspace module resolution. Standalone bundles
    # carry ordinary JavaScript dependencies internally.
    if backend_dir is not None:
        node_modules_dir = str(backend_dir / "node_modules")
        existing_node_path = env.get("NODE_PATH", "")
        env["NODE_PATH"] = (
            f"{node_modules_dir}{os.pathsep}{existing_node_path}"
            if existing_node_path
            else node_modules_dir
        )
    pkg_version = get_installed_version()
    printed_install_notice = _print_install_location_notice(backend_dir, pkg_version) if backend_dir else False
    if pkg_version:
        env["KHYQUANT_PKG_VERSION"] = pkg_version  # 用于版本显示
    if printed_install_notice:
        env["KHY_INSTALL_NOTICE_PRINTED"] = "1"
    # 告诉 Node 当前入口别名（khy / khyquant）
    env["KHYQUANT_INVOKED_AS"] = "khy" if is_khy_mode else "khyquant"

    # khy os / khy khyos（非 doctor/provision/iso 子命令）：在把终端交给交互式
    # TUI 之前，先于控制台预置内核 ISO（下载 + SHA256 校验或本地定位），避免
    # TUI 挂载期间数秒下载造成的“假死”。doctor 仅体检不应触发下载，provision
    # 自身即下载入口，iso build 已在更上游被 _normalize_iso_build_command 消费。
    if first_effective in {"os", "khyos"}:
        os_sub = (effective_args[1].lower() if len(effective_args) > 1 else "")
        # `build`/`rebuild` compile the self-kernel ISO from source; they must NOT
        # pre-provision (there is no ISO yet — that is the whole point of building).
        if os_sub not in {"doctor", "provision", "iso", "build", "build-kernel", "rebuild"}:
            # QEMU 是启动虚机的宿主前置依赖,缺失时先交互询问是否安装(门控
            # KHY_QEMU_INSTALL_PROMPT 默认开;关则什么都不做)。fail-soft:绝不因
            # 这个前置助手阻断 khy os —— 用户若拒绝/安装失败,仍由下游 KhyOsRunner
            # 在 spawn 处如实报错。
            try:
                from khy_platform import qemu_check
                qemu_check.maybe_prompt_install_qemu(env)
            except Exception:
                pass
            # If a first-run background kernel build is still running, wait for it
            # (bounded, fail-soft) so provision doesn't race a second `make iso`.
            try:
                from khy_platform._bootstrap import wait_for_kernel_prebuild
                wait_for_kernel_prebuild()
            except Exception:
                pass
            from khy_platform import _khyos
            rc = _khyos.ensure_khyos_iso(node, cli_script, env)
            if rc != 0:
                sys.exit(rc)

    # help/version 走子进程，便于优雅处理“依赖缺失”场景
    if is_help or is_version:
        result = subprocess.run(
            args,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            **_subprocess_kwargs(),
        )
        # bundled 里没 node_modules 时，仍返回可读帮助。原条件只认逐字
        # "Cannot find module"，但 Node 的模块缺失会以多种面孔出现
        # (MODULE_NOT_FOUND code、ERR_MODULE_NOT_FOUND、ESM 的
        # "Cannot find package")，且子进程可能直接非零退出却没写出可读 stderr。
        # 任一情况下对 --help 都退回内置帮助，绝不让用户面对空白或裸 exit code。
        _stderr_l = (result.stderr or "")
        _module_missing = any(
            tok in _stderr_l
            for tok in ("Cannot find module", "MODULE_NOT_FOUND",
                        "ERR_MODULE_NOT_FOUND", "Cannot find package")
        )
        _silent_failure = (
            result.returncode != 0
            and not (result.stdout or "").strip()
            and not _stderr_l.strip()
        )
        if is_help and (_module_missing or _silent_failure):
            _print_fallback_help()
            sys.exit(0)
        if result.stdout:
            # Windows legacy consoles may use GBK and reject Unicode glyphs
            # emitted by the standalone bundle. Preserve the output stream and
            # replace only characters the active console cannot represent.
            try:
                sys.stdout.reconfigure(errors="replace")
            except (AttributeError, OSError):
                pass
            print(result.stdout, end="")
        if result.stderr:
            try:
                sys.stderr.reconfigure(errors="replace")
            except (AttributeError, OSError):
                pass
            print(result.stderr, end="", file=sys.stderr)
        if result.returncode == 0:
            sys.exit(0)
        # Non-zero from --help/--version with output already shown above: still
        # surface the next step instead of a bare exit code.
        _print_exit_diagnosis(result.returncode)
        sys.exit(result.returncode)

    # ── 桥接过渡提示 ────────────────────────────────────────────────
    # `_run_with_spinner` 刚已完成并清除了 spinner 行,在 Node 引擎开始输出
    # 自身的 boot indicator（"⌛ khy 正在启动..."）之前有一个 ~100-500ms 的
    # 视觉空白期（CreateProcess + Node 冷启）。先输出一行过渡信息填住这个缺口,
    # Node 的 boot indicator 会通过 \r 覆盖此行使过渡无缝衔接。
    if sys.stderr.isatty():
        sys.stderr.write("  正在启动引擎...\r")
        sys.stderr.flush()

    if os.name == "nt":
        # Windows 无 os.execvpe，改用 subprocess
        # 注意：保持用户当前目录，不强制切到 backend_dir
        # Ctrl-C 在 Windows 会同时送达父子进程：Node 子进程已有 SIGINT 钩子自行
        # 优雅退出（"Server closed gracefully"）。父进程这里只需安静收口为标准
        # SIGINT 退出码 130，绝不向用户抛 KeyboardInterrupt traceback。
        try:
            result = subprocess.run(args, env=env)
            # Unlike Unix's os.execvpe (which replaces this process so Node's own
            # error IS the user-visible failure), Windows runs Node as a child and
            # propagates only its exit code. A non-zero crash therefore reads as a
            # silent "exit 1" with no guidance. Always append one actionable line.
            if result.returncode != 0:
                _print_exit_diagnosis(result.returncode)
            sys.exit(result.returncode)
        except KeyboardInterrupt:
            sys.exit(130)
    else:
        # Unix 直接替换当前进程为 Node，REPL 交互更自然
        # 过渡提示已在上方打印,execvpe 后 Node 的 boot indicator 会自然覆盖
        os.execvpe(node, args, env)
