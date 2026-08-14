# @pattern Facade
"""Khy runtime system-tray shell — a resident tray icon that opens the Khy
management page on click, mirroring Clash Verge's tray UX.

Design (per the approved plan):
  * **Thin orchestration only.** The tray owns *no* backend capability. Every
    action shells out to the single source of truth — ``khy gateway manage
    <action>`` — which already knows how to spawn the detached management
    daemon (``services/backend/scripts/ai-manage-daemon.js``), open the browser,
    report status, and stop. No parallel reimplementation, no fake buttons.
  * **Optional dependency.** ``pystray`` + ``Pillow`` live in the ``tray`` extra.
    When absent, ``khy tray`` fails soft with a one-line ``pip install`` hint
    and returns 0 — never a traceback.
  * **Honest platform coverage.** A headless Linux session (no DISPLAY /
    WAYLAND_DISPLAY) is refused with a clear message rather than a silent hang.
  * **Single instance.** A pid lock under the data home prevents two tray
    icons; a stale lock (dead pid) is reclaimed.

Left-click default action = open the management page. Right-click menu exposes
start / stop / status / autostart toggle / quit-icon.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from khy_platform import autostart

# ── Data-home resolution (mirror of Node getDataHome priority) ───────────────

_RUNTIME_FILENAME = "ai_manage_runtime.json"
_TRAY_PID_FILENAME = "tray.pid"


def _pointer_target() -> Path | None:
    """Read ~/.khy/.location.json breadcrumb → the actual (possibly relocated)
    data home, matching the Node resolver's pinned-pointer behavior."""
    pointer = os.environ.get("KHY_LOCATION_FILE")
    pointer_path = Path(pointer) if pointer else Path.home() / ".khy" / ".location.json"
    try:
        obj = json.loads(pointer_path.read_text(encoding="utf-8"))
        target = obj.get("dataHome") or obj.get("target") or obj.get("path")
        if target:
            return Path(target)
    except Exception:
        pass
    return None


def _candidate_data_homes() -> list[Path]:
    """Candidate data homes in priority order (env → pointer → ~/.khy → legacy)."""
    candidates: list[Path] = []
    env_home = os.environ.get("KHY_DATA_HOME")
    if env_home:
        candidates.append(Path(env_home))
    pointer = _pointer_target()
    if pointer:
        candidates.append(pointer)
    candidates.append(Path.home() / ".khy")
    candidates.append(Path.home() / ".khyquant")  # legacy
    # De-dup while preserving order.
    seen: set[str] = set()
    ordered: list[Path] = []
    for c in candidates:
        key = str(c)
        if key not in seen:
            seen.add(key)
            ordered.append(c)
    return ordered


def resolve_data_home() -> Path:
    """First candidate whose runtime file exists; else the default (~/.khy)."""
    candidates = _candidate_data_homes()
    for c in candidates:
        try:
            if (c / _RUNTIME_FILENAME).exists():
                return c
        except Exception:
            continue
    # Default fallback: the resolver's canonical home.
    return Path.home() / ".khy"


def read_runtime() -> dict:
    """Read the daemon runtime descriptor; ``{}`` when absent/corrupt."""
    path = resolve_data_home() / _RUNTIME_FILENAME
    try:
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


# ── Daemon liveness ──────────────────────────────────────────────────────────


def _pid_alive(pid: int) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True, text=True, **_subprocess_kwargs(),
            )
            return str(pid) in (out.stdout or "")
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def daemon_running() -> bool:
    """Whether the management daemon appears to be alive.

    Cheap and dependency-free: the runtime file records the daemon pid; we
    confirm the process still exists. (The authoritative control-API probe is
    reserved for ``khy gateway manage status``; the tray only needs a hint to
    label its menu.)
    """
    runtime = read_runtime()
    pid = int(runtime.get("pid") or 0)
    return _pid_alive(pid)


# ── Subprocess helpers (Windows: hide console window) ────────────────────────


def _subprocess_kwargs() -> dict:
    kwargs: dict = {}
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        kwargs["startupinfo"] = si
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kwargs


def _khy_command() -> str | None:
    for name in ("khy", "khy-os"):
        found = shutil.which(name)
        if found:
            return found
    return None


# ── Robust khy invocation (fixes: tray left/right-click silently no-ops) ──────
#
# ROOT CAUSE of "托盘左键单击没用 / 右键选项无反应": every menu action ultimately
# shells out to ``khy gateway manage <action>`` via ``_khy_command()`` =
# ``shutil.which("khy")``. A tray launched by **autostart** (the ✓开机自启 case)
# — or detached via the .vbs — inherits a PATH that frequently does NOT contain
# the pip ``Scripts``/``bin`` directory where the ``khy`` console script lives.
# ``which`` then returns ``None`` and *every* click (left AND right) fell through
# the ``if not khy: return`` guard → total silence, exactly the reported symptom.
#
# Fix: resolve an argv PREFIX that is guaranteed to work, because the tray itself
# is already running under an interpreter that can import ``khy_platform``:
#   1. PATH lookup (unchanged fast path when khy IS on PATH).
#   2. Interpreter-relative script dir (…/Scripts/khy.exe, …/bin/khy).
#   3. Guaranteed fallback ``[sys.executable, "-m", "khy_platform"]`` — the same
#      ``cli:main`` entry point as ``khy``, always importable from the tray.
#
# Gated ``KHY_TRAY_INVOKE_RESOLVE`` (default-on; set 0/false/off/no to byte-revert
# to the legacy ``_khy_command`` path).

_FALSY = {"0", "false", "off", "no"}
_INVOKE_RESOLVE_ENV = "KHY_TRAY_INVOKE_RESOLVE"
_KHY_NAMES = ("khy", "khy-os", "khy-quant", "khyquant")


def _invoke_resolve_enabled() -> bool:
    """Default-on gate; only 0/false/off/no disable the robust resolver."""
    raw = os.environ.get(_INVOKE_RESOLVE_ENV)
    if raw is None:
        return True
    return str(raw).strip().lower() not in _FALSY


def _khy_invocation(which=None, executable: str | None = None, is_windows: bool | None = None) -> list:
    """Resolve an argv PREFIX that invokes the khy CLI, robust to a PATH that
    lacks the pip Scripts/bin directory (the autostart / detached-tray case).

    Pure + dependency-injectable for tests; never raises. Always returns a
    non-empty list — the module fallback works whenever the tray runs.

    @param which       ``shutil.which``-compatible lookup (injected for tests)
    @param executable  interpreter path (defaults to ``sys.executable``)
    @param is_windows  platform override (defaults to ``os.name == 'nt'``)
    """
    which = which or shutil.which
    exe = executable or sys.executable
    win = (os.name == "nt") if is_windows is None else bool(is_windows)

    # 1. PATH — fast path, byte-identical to the legacy behavior when khy is found.
    try:
        for name in _KHY_NAMES:
            found = which(name)
            if found:
                return [found]
    except Exception:
        pass

    # 2. Interpreter-relative script dir — where pip drops console scripts.
    try:
        exe_dir = Path(exe).resolve().parent
        script_dirs = [exe_dir, exe_dir / "Scripts"] if win else [exe_dir, exe_dir.parent / "bin"]
        suffixes = (".exe", "") if win else ("",)
        for d in script_dirs:
            for name in _KHY_NAMES:
                for sfx in suffixes:
                    cand = d / (name + sfx)
                    try:
                        if cand.exists():
                            return [str(cand)]
                    except Exception:
                        continue
    except Exception:
        pass

    # 3. Guaranteed fallback: same cli:main entry as `khy`, always importable here.
    return [exe, "-m", "khy_platform"]


def _run_gateway_manage(action: str) -> None:
    """Shell out to ``khy gateway manage <action>`` — the single source of truth
    for the management daemon lifecycle. Fire-and-forget, fail-soft."""
    if _invoke_resolve_enabled():
        argv = _khy_invocation() + ["gateway", "manage", action]
    else:
        khy = _khy_command()
        if not khy:
            return
        argv = [khy, "gateway", "manage", action]
    try:
        subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **_subprocess_kwargs(),
        )
    except Exception:
        pass


# ── Icon ─────────────────────────────────────────────────────────────────────

_RESOURCE_ICON = Path(__file__).resolve().parent / "_resources" / "tray-icon.png"


def load_icon(Image):  # noqa: N803 — Image is the PIL module class, injected
    """Load the packaged tray PNG; fall back to a drawn placeholder.

    ``Image`` is ``PIL.Image`` — passed in so this stays testable/importable
    without Pillow present.
    """
    try:
        if _RESOURCE_ICON.exists():
            return Image.open(str(_RESOURCE_ICON))
    except Exception:
        pass
    # Fallback: a simple solid icon so a missing PNG never crashes the tray.
    try:
        return Image.new("RGBA", (64, 64), (37, 99, 235, 255))  # khy blue
    except Exception:
        return None


# ── Single-instance pid lock ─────────────────────────────────────────────────


def _pid_lock_path() -> Path:
    return resolve_data_home() / _TRAY_PID_FILENAME


def _existing_tray_pid() -> int:
    try:
        return int(_pid_lock_path().read_text(encoding="utf-8").strip() or 0)
    except Exception:
        return 0


def _write_pid_lock() -> None:
    try:
        path = _pid_lock_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass


def _clear_pid_lock() -> None:
    try:
        _pid_lock_path().unlink()
    except Exception:
        pass


def _kill_pid(pid: int) -> bool:
    """Terminate a pid, fail-soft. Windows uses ``taskkill /F`` (hidden window);
    Unix sends SIGTERM (15). Returns True when a kill was attempted, False when
    the pid is absent/dead."""
    if not pid or pid <= 0 or not _pid_alive(pid):
        return False
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/F"],
                capture_output=True, **_subprocess_kwargs(),
            )
        else:
            os.kill(pid, 15)
        return True
    except Exception:
        return False


# Substring that uniquely identifies the khyos-markdown bridge process among all
# node.exe on the box. The bridge has NO pidfile (it listens on an ephemeral port,
# started detached via the .vbs or `khy md`), so command-line matching is the only
# reliable way to find it. This is the file that WinError 32 locks during upgrade:
# the bridge serves vendor/khyos-muya.js (6.4MB) + .css (4.6MB) out of
# site-packages/.../bundled/tools/khyos-markdown/, holding those handles open.
_MD_BRIDGE_MARKER = "khyos-md-bridge"


def _extract_bridge_pids(process_list_text: str, self_pid: int = 0) -> list:
    """Pure parser: from a WMIC/CIM listing (``ProcessId``,``CommandLine`` pairs),
    return the pids whose command line references the khyos-markdown bridge.

    Deterministic, never raises, does no IO — split out from the enumerator so it
    can be unit-tested without spawning processes. Excludes ``self_pid`` so
    ``khy stop`` never targets itself (defensive; the bridge is a node.exe and this
    is Python, but the marker could in principle appear in this process's own args).

    Accepts either the ``ProcessId=<n>`` / ``CommandLine=<...>`` ``/FORMAT:LIST``
    shape or a single line carrying both fields; matching is line-oriented and
    tolerant of blank lines and CRLF.

    @param process_list_text  raw text from wmic / Get-CimInstance
    @param self_pid           pid to exclude (this process), 0 to disable
    @returns sorted list of unique integer pids to terminate
    """
    pids: set = set()
    try:
        text = str(process_list_text or "")
        if not text.strip():
            return []
        cur_pid = 0
        cur_has_marker = False

        def _flush():
            nonlocal cur_pid, cur_has_marker
            if cur_pid and cur_has_marker and cur_pid != int(self_pid or 0):
                pids.add(cur_pid)
            cur_pid = 0
            cur_has_marker = False

        for raw in text.split("\n"):
            line = raw.strip()
            if not line:
                # Blank line separates records in WMIC /FORMAT:LIST output; it is the
                # ONLY record boundary (ProcessId and CommandLine are fields *within*
                # one record and may appear in either order).
                _flush()
                continue
            low = line.lower()
            if low.startswith("processid="):
                try:
                    cur_pid = int(line.split("=", 1)[1].strip() or 0)
                except Exception:
                    cur_pid = 0
            elif low.startswith("commandline="):
                if _MD_BRIDGE_MARKER in low:
                    cur_has_marker = True
            elif _MD_BRIDGE_MARKER in low:
                # Single-line shape carrying the marker on its own row.
                cur_has_marker = True
        _flush()
    except Exception:
        return []
    return sorted(pids)


def _list_md_bridge_pids() -> list:
    """Enumerate khyos-markdown bridge pids (IO boundary). Windows-only meaningful;
    other platforms return ``[]`` (upgrade file-lock is a Windows problem). Fail-soft:
    any error → empty list, never raises."""
    if os.name != "nt":
        return []
    try:
        out = subprocess.run(
            [
                "wmic", "process", "where",
                "name='node.exe'", "get", "ProcessId,CommandLine",
                "/FORMAT:LIST",
            ],
            capture_output=True, text=True, timeout=8,
            **_subprocess_kwargs(),
        )
        text = (out.stdout or "") + "\n" + (out.stderr or "")
        return _extract_bridge_pids(text, self_pid=os.getpid())
    except Exception:
        return []


def _stop_md_bridges() -> bool:
    """Terminate every resident khyos-markdown bridge, fail-soft. Returns True when
    at least one bridge was found and a kill attempted; False when none were running.

    This is the step that makes ``khy stop`` actually deliver on "safe to upgrade":
    the bridge — not the daemon — is what typically holds
    ``bundled/tools/khyos-markdown/`` open and triggers WinError 32."""
    stopped = False
    try:
        for pid in _list_md_bridge_pids():
            if _kill_pid(pid):
                stopped = True
    except Exception:
        pass
    return stopped


def stop_all_resident() -> dict:
    """Stop *every* resident khy process so an upgrade can overwrite the bundle.

    Single source of truth for ``khy stop`` (Python-native, so it works even when
    the Node bundle is already corrupted). Stops:
      * the management daemon (``node.exe`` that holds site-packages handles — a
        cause of Windows WinError 32 upgrade corruption); pid from the runtime
        descriptor. It is spawned *detached* by the tray, so it will NOT die when the
        tray exits — it must be killed explicitly.
      * the system tray (prevents it from re-spawning the daemon mid-upgrade).
      * the khyos-markdown bridge(s) — a SEPARATE detached node.exe with no pidfile,
        serving vendor/khyos-muya.js/.css out of bundled/tools/khyos-markdown/. This
        is the file the reported WinError 32 was actually locking; found by
        command-line marker since there is no pid descriptor to read.

    Idempotent and fail-soft: absent processes report ``False``; never raises.

    @returns {"daemon": bool, "tray": bool, "md_bridge": bool} — whether each was
        running and got a termination request.
    """
    result = {"daemon": False, "tray": False, "md_bridge": False}
    try:
        daemon_pid = int((read_runtime() or {}).get("pid") or 0)
        result["daemon"] = _kill_pid(daemon_pid)
    except Exception:
        pass
    try:
        tray_pid = _existing_tray_pid()
        result["tray"] = _kill_pid(tray_pid)
        _clear_pid_lock()
    except Exception:
        pass
    try:
        result["md_bridge"] = _stop_md_bridges()
    except Exception:
        pass
    return result


# ── Environment gates ────────────────────────────────────────────────────────


def _has_display() -> bool:
    """Whether a GUI session is available for the tray to attach to."""
    if sys.platform in ("win32", "darwin"):
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def _import_tray_deps():
    """Import pystray + PIL.Image; return (pystray, Image) or (None, None)."""
    try:
        import pystray  # type: ignore
        from PIL import Image  # type: ignore
        return pystray, Image
    except Exception:
        return None, None


# ── Foreground tray loop ─────────────────────────────────────────────────────


def run_tray() -> int:
    """Run the resident tray icon (blocking). Returns a process exit code."""
    if not _has_display():
        print(
            "[khy tray] 当前环境没有可用图形界面（缺 DISPLAY/WAYLAND_DISPLAY），"
            "无法显示系统托盘。请在有桌面的会话中运行 `khy tray`。",
            file=sys.stderr,
        )
        return 1

    pystray, Image = _import_tray_deps()
    if pystray is None:
        print(
            '[khy tray] 托盘需要额外依赖，请先安装：pip install "khy-os[tray]"',
            file=sys.stderr,
        )
        return 0  # fail-soft — not an error, just an unmet optional dependency

    existing = _existing_tray_pid()
    if existing and existing != os.getpid() and _pid_alive(existing):
        print(f"[khy tray] 托盘已在运行（pid {existing}）。", file=sys.stderr)
        return 0

    _write_pid_lock()

    icon = _build_icon(pystray, Image)
    try:
        icon.run()
    finally:
        _clear_pid_lock()
    return 0


def _build_icon(pystray, Image):  # noqa: N803
    """Construct the pystray.Icon with menu + left-click default action."""
    image = load_icon(Image)

    def do_open(icon=None, item=None):
        _run_gateway_manage("open")

    def do_start(icon=None, item=None):
        _run_gateway_manage("start")

    def do_stop(icon=None, item=None):
        _run_gateway_manage("stop")

    def do_status(icon=None, item=None):
        _run_gateway_manage("status")

    def do_toggle_autostart(icon=None, item=None):
        if autostart.is_autostart_installed():
            autostart.disable_autostart()
        else:
            autostart.enable_autostart()
        try:
            icon.update_menu()
        except Exception:
            pass

    def do_quit(icon=None, item=None):
        try:
            icon.stop()
        except Exception:
            pass

    def title_text(item=None):
        return "Khy 运行中" if daemon_running() else "Khy 已停止"

    def autostart_checked(item=None):
        return autostart.is_autostart_installed()

    Menu = pystray.Menu
    MenuItem = pystray.MenuItem
    menu = Menu(
        MenuItem(title_text, do_open, default=True),  # default = left-click
        Menu.SEPARATOR,
        MenuItem("打开管理页", do_open),
        MenuItem("启动 / 重启服务", do_start),
        MenuItem("停止服务", do_stop),
        MenuItem("查看状态", do_status),
        Menu.SEPARATOR,
        MenuItem("开机自启", do_toggle_autostart, checked=autostart_checked),
        Menu.SEPARATOR,
        MenuItem("退出托盘", do_quit),
    )
    return pystray.Icon("khy-tray", icon=image, title="Khy", menu=menu)


# ── CLI entry (invoked from cli.py `khy tray ...`) ───────────────────────────


def _detach_tray() -> int:
    """Spawn `khy tray` detached (background) and return immediately."""
    if _invoke_resolve_enabled():
        argv = _khy_invocation() + ["tray"]
    else:
        khy = _khy_command()
        if not khy:
            print('[khy tray] 找不到 khy 可执行文件。', file=sys.stderr)
            return 1
        argv = [khy, "tray"]
    kwargs: dict = _subprocess_kwargs()
    if os.name == "nt":
        detached = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        new_group = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | detached | new_group
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
        return 0
    except Exception as exc:
        print(f"[khy tray] 后台启动失败: {exc}", file=sys.stderr)
        return 1


def run_tray_cli(argv: list[str]) -> int:
    """`khy tray [subcommand]` dispatcher. Always fail-soft.

    Subcommands:
      * (none)              — run the tray in the foreground (blocking)
      * --detach            — spawn the tray in the background
      * stop                — stop a running tray
      * status              — print daemon + autostart status
      * enable-autostart    — register boot autostart
      * disable-autostart   — remove boot autostart
    """
    sub = (argv[0].lower() if argv else "").strip()

    if sub in ("--detach", "detach", "-d"):
        return _detach_tray()

    if sub in ("stop", "quit"):
        pid = _existing_tray_pid()
        if pid and _pid_alive(pid):
            try:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(pid), "/F"],
                        capture_output=True, **_subprocess_kwargs(),
                    )
                else:
                    os.kill(pid, 15)
                print("[khy tray] 已请求退出托盘。")
            except Exception as exc:
                print(f"[khy tray] 退出托盘失败: {exc}", file=sys.stderr)
        else:
            print("[khy tray] 托盘未在运行。")
        _clear_pid_lock()
        return 0

    if sub == "status":
        running = daemon_running()
        auto = autostart.is_autostart_installed()
        pid = _existing_tray_pid()
        tray_on = bool(pid and _pid_alive(pid))
        print(f"托盘进程: {'运行中 (pid ' + str(pid) + ')' if tray_on else '未运行'}")
        print(f"管理服务: {'运行中' if running else '已停止'}")
        print(f"开机自启: {'已启用' if auto else '未启用'}")
        return 0

    if sub in ("enable-autostart", "autostart-enable", "enable"):
        res = autostart.enable_autostart()
        if res["ok"]:
            print(f"[khy tray] 开机自启已启用 → {res.get('path') or ''}")
        else:
            print(f"[khy tray] 开机自启未启用: {res['status']}", file=sys.stderr)
        return 0

    if sub in ("disable-autostart", "autostart-disable", "disable"):
        res = autostart.disable_autostart()
        print(f"[khy tray] 开机自启: {res['status']}")
        return 0

    if sub in ("--help", "-h", "help"):
        _print_tray_help()
        return 0

    # No subcommand → run foreground tray.
    return run_tray()


def _print_tray_help() -> None:
    print(
        "用法: khy tray [子命令]\n"
        "\n"
        "  (无)                前台运行系统托盘\n"
        "  --detach            后台运行托盘\n"
        "  stop                停止正在运行的托盘\n"
        "  status              查看托盘 / 管理服务 / 自启状态\n"
        "  enable-autostart    注册开机自启\n"
        "  disable-autostart   取消开机自启\n"
        "\n"
        '托盘依赖 pystray + Pillow，安装: pip install "khy-os[tray]"'
    )
