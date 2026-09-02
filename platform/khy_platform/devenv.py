# @pattern Template Method, Strategy
"""khy OS — cross-language dependency orchestration (install + compile phases).

khy OS is a multi-language project shipped through a single pip distribution:

    Python  — the CLI launcher / glue layer (this package)
    Node.js — the backend, gateways and web frontends (npm)
    C       — the bare-metal kernel (make + cc + nasm + ld)
    MoonBit — the WASM indicator/plugin engines (moon)

The pip package is the *delivery + orchestration hub*: it carries every
language's source and lock files but NONE of their third-party dependency
trees (no node_modules, no compiled toolchains). This module is what makes
that work — it detects what each language needs and fetches the missing
pieces through that language's own package manager, driven from Python.

Two phases, deliberately separated:

* Install phase — :func:`run_postinstall`. After ``pip install`` finishes
  pulling the Python glue dependencies, this walks each *runtime* requirement
  of the other languages (today: the backend's ``node_modules``) and, when a
  dependency directory or key library is missing, silently invokes that
  language's package manager. The only auto-fetchable cross-language runtime
  is Node's ``node_modules`` (via ``npm``), so this reuses the hardened
  installer in :mod:`khy_platform._bootstrap`.

* Compile phase — :func:`ensure_dev_environment`. When the user rebuilds (pip
  wheel/sdist, kernel ISO, MoonBit WASM), this checks every language's
  *compiler and development* dependencies. Python dev tools (``build``,
  ``twine``, ``pytest``) are auto-fetched against the bundled lock file
  :file:`_resources/dev-constraints.txt`; system toolchains that cannot be
  installed silently (``cc``, ``nasm``, ``moon`` …) are reported with an
  explicit, copy-pasteable recovery command.

Hard contract shared by both phases: **never interrupt**. Every failure is
caught, a manual-recovery hint is printed, and control returns to the caller.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ── Install-path export (requirement: expose the absolute install path) ──────

#: Absolute path of the installed ``khy_platform`` package directory. Exported
#: at the package entry so any runtime can trace *where* khy OS is installed.
INSTALL_PATH: Path = Path(__file__).resolve().parent


def get_install_path() -> Path:
    """Return the absolute path of the installed ``khy_platform`` package."""
    return INSTALL_PATH


def get_install_root() -> Path:
    """Return the install root that contains the Python package roots.

    For both the forest source checkout and a pip install this is the parent
    that holds ``khy_platform`` / ``khy_os`` (the ``platform/`` dir in source,
    or ``site-packages`` once installed).
    """
    return INSTALL_PATH.parent


# ── Bundled dev lock file ────────────────────────────────────────────────────


def constraints_file() -> Path | None:
    """Locate the bundled dev-constraints lock file, or ``None`` if absent."""
    candidate = INSTALL_PATH / "_resources" / "dev-constraints.txt"
    return candidate if candidate.exists() else None


# ── Python development components (auto-fetchable via pip) ────────────────────

# (import_name, pip_name) pairs mirroring pyproject `dev` extra.
REQUIRED_DEV_PYTHON: tuple[tuple[str, str], ...] = (
    ("build", "build"),
    ("twine", "twine"),
    ("pytest", "pytest"),
)


def _python_module_present(import_name: str) -> bool:
    """Dynamic lookup: is an importable module available in this interpreter?"""
    try:
        return importlib.util.find_spec(import_name) is not None
    except (ImportError, ValueError):
        # A broken/partial install can make find_spec raise; treat as missing.
        return False


def ensure_python_dev_deps(quiet: bool = True) -> dict:
    """Ensure the Python dev toolchain is present; auto-install what is missing.

    Iterates :data:`REQUIRED_DEV_PYTHON`, using a dynamic import lookup to skip
    components already importable. Missing components are installed in one pip
    invocation that *forces* the bundled lock file (``-c``) so version pins stay
    consistent. The install is best-effort and silent by default.

    On failure nothing is raised — the exception is caught and an explicit
    manual-recovery command is printed. Returns a small status report.
    """
    missing = [
        (imp, pip) for imp, pip in REQUIRED_DEV_PYTHON if not _python_module_present(imp)
    ]
    report = {
        "checked": [imp for imp, _ in REQUIRED_DEV_PYTHON],
        "missing": [imp for imp, _ in missing],
        "installed": False,
        "ok": not missing,
    }
    if not missing:
        return report

    pip_names = [pip for _, pip in missing]
    print(f"  [devenv] 缺失 Python 开发组件: {', '.join(pip_names)} — 正在自动获取...")

    cmd = [sys.executable, "-m", "pip", "install"]
    if quiet:
        cmd.append("-q")
    lock = constraints_file()
    if lock is not None:
        # Force the in-package lock file so repaired environments are pinned.
        cmd += ["-c", str(lock)]
    cmd += pip_names

    try:
        result = subprocess.run(cmd, **_subprocess_kwargs())
        if result.returncode == 0:
            # Re-check so the report reflects reality, not just pip's exit code.
            still_missing = [imp for imp, _ in missing if not _python_module_present(imp)]
            report["installed"] = True
            report["missing"] = still_missing
            report["ok"] = not still_missing
            if report["ok"]:
                print(f"  [devenv] [OK] Python 开发组件已就位: {', '.join(pip_names)}")
            else:
                _print_python_recovery(pip_names, lock)
        else:
            _print_python_recovery(pip_names, lock)
    except Exception as exc:  # never interrupt — report and continue
        print(f"  [devenv] [WARN] 自动获取 Python 开发组件失败: {exc}", file=sys.stderr)
        _print_python_recovery(pip_names, lock)
    return report


def _print_python_recovery(pip_names: list[str], lock: Path | None):
    """Print a copy-pasteable manual recovery command for Python dev deps."""
    lock_arg = f" -c {lock}" if lock is not None else ""
    print("  [devenv] 手动恢复命令:", file=sys.stderr)
    print(
        f"    {sys.executable} -m pip install{lock_arg} "
        + " ".join(pip_names),
        file=sys.stderr,
    )


# ── Cross-language toolchain detection ───────────────────────────────────────

# (label, [executable candidates], recovery hint). System toolchains are
# detected for reporting; they cannot be installed silently without elevation.
_TOOLCHAINS: tuple[tuple[str, tuple[str, ...], str], ...] = (
    ("Node.js (>=20)", ("node", "node.exe"),
     "安装 Node.js >= 20: https://nodejs.org/ (国内镜像 https://npmmirror.com/mirrors/node/)"),
    ("npm", ("npm", "npm.cmd"),
     "npm 随 Node.js 一起安装；请重新安装 Node.js"),
    ("C compiler", ("cc", "gcc", "clang"),
     "Linux: sudo apt-get install build-essential | macOS: xcode-select --install"),
    ("nasm (kernel asm)", ("nasm",),
     "Linux: sudo apt-get install nasm | macOS: brew install nasm"),
    ("ld (linker)", ("ld", "ld.lld", "lld"),
     "随 binutils 安装: sudo apt-get install binutils"),
    ("make", ("make", "mingw32-make"),
     "Linux: sudo apt-get install make | macOS: xcode-select --install"),
    ("MoonBit (moon)", ("moon",),
     "安装 MoonBit: curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash"),
)


def detect_toolchains() -> list[dict]:
    """Detect each language's compiler/toolchain executable on PATH.

    Returns a list of ``{label, found, path, recovery}`` dicts. Pure PATH
    lookup — fast and side-effect free.
    """
    results: list[dict] = []
    for label, candidates, recovery in _TOOLCHAINS:
        found_path = None
        for exe in candidates:
            found_path = shutil.which(exe)
            if found_path:
                break
        results.append({
            "label": label,
            "found": bool(found_path),
            "path": found_path or "",
            "recovery": recovery,
        })
    return results


# ── Node runtime self-heal (install phase) ───────────────────────────────────


def _resolve_backend_dir(backend_dir: Path | None) -> Path | None:
    """Resolve the Node backend directory, tolerating launch-failure modes."""
    if backend_dir is not None:
        return backend_dir
    try:
        from khy_platform.cli import get_bundle_dir
        return get_bundle_dir()
    except SystemExit:
        # get_bundle_dir() exits when it cannot find the backend; in the
        # orchestration context that is a recoverable, reportable condition.
        return None
    except Exception:
        return None


def _find_provisioned_node_bin() -> str | None:
    """Return the bin dir of an already-provisioned portable Node, or None.

    Read-only and fail-soft: never downloads, never raises. Used to keep the
    install-phase self-heal consistent with the launch-time auto-installer.
    """
    try:
        from khy_platform import node_provisioner
        return node_provisioner.find_provisioned_node()
    except Exception:
        return None


def ensure_node_runtime(backend_dir: Path | None = None) -> dict:
    """Ensure the backend's Node runtime dependencies (node_modules) are present.

    Reuses the hardened installer in :mod:`khy_platform._bootstrap` rather than
    re-implementing npm orchestration. Never raises.
    """
    report = {"language": "node", "backend_dir": "", "ok": False, "detail": ""}

    node = shutil.which("node") or shutil.which("node.exe")
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not node or not npm:
        # Reuse an already-provisioned portable Node (from the launch-time
        # auto-installer) so `khy postinstall` stays consistent with startup.
        # Read-only: we never trigger a download during the install phase.
        bin_dir = _find_provisioned_node_bin()
        if bin_dir:
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
            node = shutil.which("node") or shutil.which("node.exe")
            npm = shutil.which("npm") or shutil.which("npm.cmd")
        if not node or not npm:
            report["detail"] = "Node.js/npm 未安装，无法自动获取 node_modules"
            print(f"  [devenv] [WARN] {report['detail']}", file=sys.stderr)
            print("  [devenv] 手动恢复: 安装 Node.js >= 20 后重新运行 `khy postinstall`", file=sys.stderr)
            return report

    resolved = _resolve_backend_dir(backend_dir)
    if resolved is None:
        report["detail"] = "未找到 backend 目录"
        print(f"  [devenv] [WARN] {report['detail']}", file=sys.stderr)
        return report
    report["backend_dir"] = str(resolved)

    node_modules = resolved / "node_modules"
    express = node_modules / "express"
    if node_modules.exists() and express.exists():
        report["ok"] = True
        report["detail"] = "node_modules 已就位"
        return report

    try:
        from khy_platform._bootstrap import _ensure_npm_install
        ok = _ensure_npm_install(resolved)
        report["ok"] = bool(ok)
        report["detail"] = "node_modules 已自动获取" if ok else "npm install 未完成"
        if not ok:
            print(
                f"  [devenv] 手动恢复: cd {resolved} && npm install",
                file=sys.stderr,
            )
    except Exception as exc:  # never interrupt
        report["detail"] = f"npm 自动获取异常: {exc}"
        print(f"  [devenv] [WARN] {report['detail']}", file=sys.stderr)
        print(f"  [devenv] 手动恢复: cd {resolved} && npm install", file=sys.stderr)
    return report


# ── Phase orchestrators ──────────────────────────────────────────────────────


def heal_bundled_source(backend_dir: Path | None = None) -> dict:
    """Restore any missing/corrupt runtime source file from the bundled snapshot.

    Mirror twin of the npm channel's ``healBundledSource``. After ``pip install``
    unpacks the bundled backend, spawn Node to run the per-file SHA-256 self-heal
    (``runStartupHeal``) so a source file that arrived missing or corrupt (an
    interrupted download, a disk hiccup) is restored from the encrypted pristine
    snapshot — NOT a whole-tree overwrite. This is goal trigger point ③ "pip or
    npm update": a fresh install changes the snapshot fingerprint, so the throttle
    always re-checks here rather than deferring to first launch.

    Safety: ``apply`` is gated by the same double rails as every other trigger —
    version-match + too-many-changes — so drift can never trigger a mass-revert.
    Never raises; a self-heal failure must not break ``pip install``.
    """
    report = {"ok": False, "healed": 0, "reason": "skipped"}
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        bin_dir = _find_provisioned_node_bin()
        if bin_dir:
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
            node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        report["reason"] = "no-node"
        return report

    resolved = _resolve_backend_dir(backend_dir)
    if resolved is None:
        report["reason"] = "no-backend"
        return report
    svc = resolved / "src" / "services" / "sourceHealService.js"
    if not svc.exists():
        report["reason"] = "no-service"
        return report

    # deep:true bypasses the manifest cache (fresh install always re-verifies).
    # We deliberately do NOT pass force:true — force would bypass the
    # too-many-changes rail, the exact protection against a drifted bundle
    # mass-reverting to an older snapshot. A fresh install has no throttle state
    # (any real update changes the fingerprint), so the check runs anyway.
    script = (
        "try{const{runStartupHeal}=require(process.argv[1]);"
        "const r=runStartupHeal({reason:'pip-postinstall',deep:true});"
        "process.stdout.write(JSON.stringify({ok:!!(r&&r.ok),healed:(r&&r.healed)||0,"
        "reason:(r&&r.reason)||'unknown'}));}"
        "catch(e){process.stdout.write(JSON.stringify({ok:false,healed:0,reason:'error'}));}"
    )
    try:
        import json

        res = subprocess.run(
            [node, "-e", script, str(svc)],
            capture_output=True,
            text=True,
            timeout=120,
            **_subprocess_kwargs(),
        )
        out = (res.stdout or "").strip()
        if out:
            parsed = json.loads(out)
            report["ok"] = bool(parsed.get("ok"))
            report["healed"] = int(parsed.get("healed") or 0)
            report["reason"] = parsed.get("reason") or "unknown"
    except Exception as exc:  # never interrupt
        report["reason"] = f"error: {exc}"
    return report


def ensure_md_registration(backend_dir: Path | None = None) -> dict:
    """Register the khyos Markdown right-click association at pip-install time.

    Goal "pip 安装 Khy 时自动进注册表 / 可右键用 khy 打开 md": the user expects the
    system "Open with" association to exist right after ``pip install``, not only
    after the first launch.

    This does NOT reimplement registration in Python — that path was tried once
    and reverted because it competed with the Node single source of truth over
    the ``.md-registered`` sentinel. Instead we spawn Node to invoke the SAME
    authoritative ``mdEditorRegister.ensureMdRegistered`` that first launch calls:
    it is gated (``KHY_MD_EDITOR`` ∧ ``KHY_MD_AUTO_REGISTER``), platform-aware
    (linux/win32 only; others self-skip), idempotent, and bounded-retry. Running
    it here just moves the same idempotent registration earlier; first launch then
    sees the success sentinel and short-circuits. Zero duplicate state.

    Never raises — a registration hiccup must not break ``pip install``.
    """
    report = {"ok": False, "status": "skipped"}
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        bin_dir = _find_provisioned_node_bin()
        if bin_dir:
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
            node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        report["status"] = "no-node"
        return report

    resolved = _resolve_backend_dir(backend_dir)
    if resolved is None:
        report["status"] = "no-backend"
        return report
    mod = resolved / "src" / "services" / "mdEditorRegister.js"
    if not mod.exists():
        report["status"] = "no-module"
        return report

    # Delegate to the single-source Node registrar; it decides gate/platform/retry.
    script = (
        "try{const{ensureMdRegistered}=require(process.argv[1]);"
        "const s=ensureMdRegistered();"
        "process.stdout.write(JSON.stringify({status:s||'unknown'}));}"
        "catch(e){process.stdout.write(JSON.stringify({status:'error'}));}"
    )
    try:
        import json

        res = subprocess.run(
            [node, "-e", script, str(mod)],
            capture_output=True,
            text=True,
            timeout=30,
            **_subprocess_kwargs(),
        )
        out = (res.stdout or "").strip()
        if out:
            parsed = json.loads(out)
            status = parsed.get("status") or "unknown"
            report["status"] = status
            # 'already'/'spawned' = registration happened or is in flight; the
            # 'skip-*' family are honest no-ops (gated off / unsupported OS / etc.).
            report["ok"] = status in ("already", "spawned")
    except Exception as exc:  # never interrupt install
        report["status"] = f"error: {exc}"
    return report


def ensure_tray_autostart() -> dict:
    """Register the Khy system-tray boot autostart at pip-install time.

    Goal "安装即写自启": after ``pip install`` the user expects the Khy tray to
    return on its own after a reboot (like Clash Verge), not only after the
    first manual ``khy tray``. Mirrors :func:`ensure_md_registration`: gated
    (``KHY_TRAY_AUTOSTART``, default-on), idempotent (skips when the autostart
    entry already exists), platform-aware, and **never raises** — a registration
    hiccup must not break ``pip install``.

    This only *writes the autostart entry*; it deliberately does NOT launch the
    tray GUI during install (pulling up a GUI mid-install is inappropriate). The
    entry brings the tray up on the next login, or the user runs ``khy tray``.
    """
    report = {"ok": False, "status": "skipped"}
    try:
        from khy_platform import autostart

        if not autostart.autostart_enabled_by_env():
            report["status"] = "skip-disabled"
            return report
        result = autostart.enable_autostart()
        report["status"] = result.get("status", "unknown")
        report["ok"] = bool(result.get("ok"))
    except Exception as exc:  # never interrupt install
        report["status"] = f"error: {exc}"
    return report


def run_postinstall(backend_dir: Path | None = None) -> int:
    """Install-phase self-heal: ensure cross-language *runtime* deps are present.

    Walks each non-Python language's runtime requirement and auto-fetches the
    missing pieces through that language's package manager. Today the only
    silently auto-fetchable cross-language runtime is Node's ``node_modules``
    (via npm); the backend's first-run bootstrap covers the rest (`.env`, DB
    seed) on launch.

    Always returns 0 — install-phase orchestration must never break the
    surrounding ``pip install`` / first run. Diagnostics and manual-recovery
    hints are printed for anything that could not be auto-fetched.
    """
    print("  [devenv] 安装阶段跨语言依赖自愈...")
    node_report = ensure_node_runtime(backend_dir)
    if node_report["ok"]:
        print("  [devenv] [OK] 跨语言运行时依赖就绪")
    else:
        print(
            "  [devenv] [WARN] 部分运行时依赖未就位，将于首次启动重试: "
            f"{node_report['detail']}",
            file=sys.stderr,
        )

    # Restore any missing/corrupt runtime source file from the bundled snapshot.
    heal_report = heal_bundled_source(backend_dir)
    if heal_report["healed"] > 0:
        print(f"  [devenv] [OK] 源码自愈已修复 {heal_report['healed']} 个文件")
    elif heal_report["reason"] in ("too-many-changes", "version-mismatch"):
        print(
            "  [devenv] [WARN] 检测到源码漂移——若安装异常请运行 `khy restore`",
            file=sys.stderr,
        )

    # Clean up '~'-prefixed orphan dirs + stale-version metadata stranded by a
    # previous (possibly interrupted) upgrade — now, not at the next launch.
    # Reuses cli.py's single-source sweep functions; fully fail-soft.
    try:
        from khy_platform.cli import run_install_cleanup

        removed = run_install_cleanup()
        if removed:
            print(f"  [devenv] [OK] 已清理 {removed} 个历史损坏目录（`~` 孤儿/陈旧元数据）")
    except Exception:  # never interrupt install
        pass

    # Register the khyos Markdown "Open with" association now (linux/win32), so the
    # right-click entry exists right after `pip install` rather than only on first
    # launch. Delegates to the Node single source (idempotent, gated, fail-soft).
    md_report = ensure_md_registration(backend_dir)
    if md_report["ok"]:
        print("  [devenv] [OK] 已注册系统「打开方式」→ khyos Markdown 关联")

    # Register the Khy system-tray boot autostart now (win/mac/linux), so the
    # tray comes back on its own after a reboot rather than needing a manual
    # `khy tray`. Delegates to the autostart single source (idempotent, gated,
    # fail-soft). Writes the autostart entry only — never launches the GUI here.
    tray_report = ensure_tray_autostart()
    if tray_report["ok"]:
        print("  [devenv] [OK] 已注册开机自启 → Khy 托盘")

    # Enable transparent filesystem compression (NTFS LZX / btrfs zstd / ZFS)
    # on the installed trees. Python has no post-install hook, so this runs on
    # first launch via the postinstall self-heal; heavy work is detached and
    # the step is gated (KHY_FS_COMPRESS=0), idempotent and fully fail-soft.
    try:
        from khy_platform.fs_compress import schedule_install_compression

        compress_targets = [get_install_path()]
        try:
            from khy_platform.node_provisioner import node_home

            compress_targets.append(node_home())
        except Exception:
            pass
        compress_report = schedule_install_compression(compress_targets)
        for target, mode in compress_report:
            if mode in {"ntfs", "btrfs", "zfs"}:
                print(f"  [devenv] [OK] 透明压缩已启用 ({mode})：{target}（后台重写存量文件，新文件自动继承）")
            elif mode in {"btrfs-attr-only", "zfs-already-on"}:
                print(f"  [devenv] [OK] 透明压缩已就位 ({mode})：{target}")
            elif mode == "unsupported":
                print(f"  [devenv] [INFO] 文件系统不支持透明压缩，已跳过：{target}")
            else:
                print(f"  [devenv] [WARN] 透明压缩未能启用 ({mode})：{target}", file=sys.stderr)
    except Exception:  # never interrupt install
        pass

    return 0


def ensure_dev_environment(trigger: str = "manual", check_toolchains: bool = True) -> int:
    """Compile-phase self-heal: ensure every language's dev toolchain is ready.

    Invoked before a rebuild (pip wheel/sdist, kernel ISO, MoonBit WASM). It:

    1. Auto-fetches missing Python dev tools (``build``/``twine``/``pytest``)
       against the bundled lock file.
    2. Detects each language's compiler/toolchain and prints an explicit
       recovery command for anything missing that cannot be installed without
       elevation.

    Never raises and always returns 0 — a missing system toolchain must not
    abort the command the user actually asked for.
    """
    label = f" ({trigger})" if trigger and trigger != "manual" else ""
    print(f"  [devenv] 编译阶段开发环境自愈{label}...")

    ensure_python_dev_deps(quiet=True)

    if check_toolchains:
        missing = [t for t in detect_toolchains() if not t["found"]]
        if not missing:
            print("  [devenv] [OK] 各语言编译工具链均已就位")
        else:
            print(
                f"  [devenv] [WARN] 缺失 {len(missing)} 项系统工具链（需手动安装）:",
                file=sys.stderr,
            )
            for t in missing:
                print(f"    - {t['label']}: {t['recovery']}", file=sys.stderr)
    return 0


# Alias matching the goal's "环境配置函数" wording.
configure_dev_environment = ensure_dev_environment


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


def _main(argv: list[str]) -> int:
    """``python -m khy_platform.devenv [postinstall|dev-setup]`` entry."""
    cmd = (argv[0].lower() if argv else "dev-setup")
    if cmd in {"postinstall", "post-install", "install"}:
        return run_postinstall()
    return ensure_dev_environment(trigger=cmd)


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
