# @pattern Template Method
"""
khy OS 首次启动初始化（bootstrap）

用户第一次 `pip install khy-os` 后执行 `khy`，需要先做一些准备工作，
否则 Node 后端无法正常运行。

初始化会做这些事：
1. 安装 npm 依赖（node_modules）
2. 生成 .env（自动写入随机 JWT_SECRET）
3. 初始化数据库（执行 seed 脚本）
4. 生成入门文档（非关键，失败不影响运行）

初始化是"可重复安全"的：
- 完成后会写入标记文件 `.khy_quant_bootstrapped`
- seed 成功后会写入标记文件 `.khy_quant_seeded`
- 下次启动检测到两个标记才完全跳过
- 若初始化中断，删除标记后重试即可
"""
import os
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path

# 标记文件：存在则代表已初始化，下次可直接跳过
MARKER_FILE = ".khy_quant_bootstrapped"
# 数据库 seed 标记：与安装标记分离，避免 seed 漏跑后无法自动重试
SEED_MARKER_FILE = ".khy_quant_seeded"
# 可选依赖修复标记：避免每次启动重复检查/安装
OPTIONAL_FIX_MARKER_FILE = ".khy_quant_optional_fixed"
# Kiro CodeWhisperer SDK 修复标记：避免每次启动重复检查/安装
KIRO_CW_SDK_MARKER_FILE = ".khy_kiro_cw_sdk_fixed"
# Trae Bridge VSIX 自动安装标记
TRAE_BRIDGE_MARKER_FILE = ".khy_trae_bridge_installed"
# 版本戳记：检测版本变化以触发 token 强制刷新
VERSION_STAMP_FILE = ".khy_version_stamp"
# Token 强制刷新标记：存在时 kiroAdapter 清除所有缓存状态后删除
FORCE_TOKEN_REFRESH_FILE = ".khy_force_token_refresh"
# 自研内核 ISO 后台预构建标记：现为可对账的生命周期状态机（落 cache 目录，
# 与 lock/log/breadcrumb 同域）。历史版本把它当成一次性 write-once 闸门放在
# backend_dir，详见 _maybe_prebuild_khyos_kernel 的迁移逻辑。
KERNEL_PREBUILD_MARKER_FILE = ".khy_kernel_prebuilt"
# 自研内核构建器（Node）落下的结构化结果面包屑，供 Python 在下一条命令时感知失败。
KERNEL_BUILD_RESULT_FILE = "kernel-build-result.json"
# 自动重试策略（env 可调）：失败后最多重试几次、两次尝试间最小退避间隔（秒）。
KERNEL_AUTOBUILD_MAX_ATTEMPTS_ENV = "KHY_KERNEL_AUTOBUILD_MAX_ATTEMPTS"
KERNEL_AUTOBUILD_RETRY_INTERVAL_ENV = "KHY_KERNEL_AUTOBUILD_RETRY_INTERVAL"
_KERNEL_AUTOBUILD_MAX_ATTEMPTS_DEFAULT = 3
_KERNEL_AUTOBUILD_RETRY_INTERVAL_DEFAULT = 21600.0  # 6h

# npm install timeout: Windows native modules (node-llama-cpp) compile slower
_NPM_TIMEOUT = 600 if os.name == "nt" else 300


def _is_china_network() -> bool:
    """启发式判断是否使用国内 npm 镜像（提高下载成功率）。"""
    lang = os.environ.get("LANG", "") + os.environ.get("LC_ALL", "")
    tz = os.environ.get("TZ", "")
    if lang.startswith("zh") or "Shanghai" in tz or "Chongqing" in tz:
        return True
    if os.name == "nt":
        try:
            import locale
            loc = locale.getlocale()[0] or ""
            if loc.startswith("zh"):
                return True
        except Exception:
            pass
    return False  # default False: use official npm registry; China users get mirror via locale detection above


def _configure_npm_registry(npm_cmd: str, cwd: Path):
    """确保 backend 目录下有项目级 .npmrc（不改全局配置）。"""
    npmrc = cwd / ".npmrc"
    if npmrc.exists():
        content = npmrc.read_text(encoding="utf-8", errors="replace")
        if "npmmirror" in content or "taobao" in content or "aliyun" in content:
            return

    try:
        npmrc.write_text("registry=https://registry.npmmirror.com\n",
                         encoding="utf-8")
        print("  [OK] .npmrc created (npmmirror.com)")
    except OSError:
        try:
            subprocess.run(
                [npm_cmd, "config", "set", "registry", "https://registry.npmmirror.com"],
                capture_output=True, timeout=10, cwd=str(cwd), **_subprocess_kwargs(),
            )
            print("  [OK] npm registry set to npmmirror.com")
        except Exception:
            pass


def _subprocess_kwargs():
    """返回子进程平台参数（Windows 下隐藏弹窗）。"""
    kwargs = {}
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        kwargs["startupinfo"] = si
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kwargs


def _run_npm_streaming(args, cwd: Path, timeout: int) -> int:
    """Run an npm command while streaming its output live.

    subprocess.run() inherits the parent's stdio but stays visually silent
    while npm runs in non-TTY mode, and native postinstall steps (e.g.
    node-llama-cpp downloading/compiling binaries) can sit quiet for minutes.
    That made first-run setup look frozen. This helper pipes npm's combined
    output, echoes each line with a prefix, and emits a periodic heartbeat so
    the user can see progress. A watchdog thread enforces the timeout even
    when npm produces no output at all (the exact silent-hang case).

    Returns the process return code. Raises subprocess.TimeoutExpired on
    timeout, matching subprocess.run()'s contract so callers stay unchanged.
    """
    proc = subprocess.Popen(
        args,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        **_subprocess_kwargs(),
    )

    start = time.monotonic()
    last_output = [start]
    timed_out = [False]
    stop = threading.Event()

    def _watchdog():
        # Wakes every 5s: enforces the hard timeout and prints a heartbeat
        # when npm has been silent for a while, so a long native build never
        # looks frozen.
        while not stop.wait(5):
            elapsed = time.monotonic() - start
            if elapsed > timeout:
                timed_out[0] = True
                try:
                    proc.kill()
                except Exception:
                    pass
                return
            if time.monotonic() - last_output[0] >= 15:
                print(f"  [..] 仍在安装中（已用 {int(elapsed)}s）— npm 正在下载/编译依赖，请耐心等待...",
                      flush=True)

    watchdog = threading.Thread(target=_watchdog, daemon=True)
    watchdog.start()

    try:
        if proc.stdout is not None:
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    print(f"    npm | {line}", flush=True)
                last_output[0] = time.monotonic()
        proc.wait()
    finally:
        stop.set()
        watchdog.join(timeout=1)

    if timed_out[0]:
        raise subprocess.TimeoutExpired(args, timeout)
    return proc.returncode


def _write_marker(marker: Path, content: str):
    """Write a marker file, ignoring errors (e.g. read-only filesystem).

    Best-effort creates the parent directory first so markers that live outside
    backend_dir (e.g. the kernel-prebuild state machine under ~/.khyos/cache)
    persist reliably on a fresh machine where the cache dir does not exist yet.
    """
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    try:
        marker.write_text(f"{content}\n", encoding="utf-8")
    except OSError:
        pass


def _path_exists_safe(p: Path) -> bool:
    """
    Cross-platform Path.exists() that handles Windows junction/symlink edge
    cases where a broken junction raises PermissionError or OSError instead
    of returning False.
    """
    try:
        return p.exists()
    except (OSError, ValueError):
        return False


def _has_llama_pkg(node_modules: Path) -> bool:
    """Check if node-llama-cpp is installed (scoped or flat)."""
    return (
        _path_exists_safe(node_modules / "node-llama-cpp")
        or _path_exists_safe(node_modules / "@node-llama-cpp")
    )


def _has_cw_sdk(node_modules: Path) -> bool:
    """Check if the Kiro CodeWhisperer streaming SDK is installed."""
    return _path_exists_safe(node_modules / "@aws" / "codewhisperer-streaming-client")


def _node_env(backend_dir: Path) -> dict:
    """Return env dict with NODE_PATH set so @khy/shared can find deps."""
    env = os.environ.copy()
    node_modules = str(backend_dir / "node_modules")
    existing = env.get("NODE_PATH", "")
    env["NODE_PATH"] = (
        f"{node_modules}{os.pathsep}{existing}" if existing else node_modules
    )
    return env


def _check_version_upgrade(backend_dir: Path):
    """Compare installed version against stored stamp; on upgrade, write a
    force-refresh marker so kiroAdapter clears all cached tokens/user IDs."""
    from khy_platform import __version__

    stamp_file = backend_dir / VERSION_STAMP_FILE
    refresh_marker = backend_dir / FORCE_TOKEN_REFRESH_FILE
    stored_version = ""
    if stamp_file.exists():
        try:
            stored_version = stamp_file.read_text(encoding="utf-8").strip()
        except OSError:
            pass

    if stored_version != __version__:
        # Version changed (upgrade or downgrade) — force token refresh
        _write_marker(refresh_marker, f"upgrade:{stored_version}->{__version__}")
        _write_marker(stamp_file, __version__)
        if stored_version:
            print(f"  [INFO] Version {stored_version} → {__version__}，token 缓存将强制刷新。")


def _remove_quiet(p: Path):
    """Best-effort unlink, swallowing errors (read-only FS / already gone)."""
    try:
        p.unlink()
    except OSError:
        pass


def _khyos_cache_dir() -> Path:
    """Mirror @khy/shared `khyosCacheDir()`: the shared KHY OS cache root where a
    prebuilt/cached kernel ISO and our build log/lock live. The kernel + its build
    toolchain are khyos *base* artifacts, so the canonical home is the base home
    ``~/.khyos/cache``. Resolution (kept byte-identical to the JS resolver so the
    Python launcher and the Node builder agree on lock/log/ISO locations):
      1. ``KHY_KHYOS_CACHE_DIR`` — explicit override, highest priority.
      2. Established-wins: a populated legacy ``~/.khyquant/khyos`` keeps serving
         until the canonical dir exists, so existing machines never re-download.
      3. Canonical ``~/.khyos/cache`` — fresh-install default.
    """
    override = str(os.environ.get("KHY_KHYOS_CACHE_DIR", "")).strip()
    if override:
        return Path(override)
    home = Path.home()
    canonical = home / ".khyos" / "cache"
    legacy = home / ".khyquant" / "khyos"
    try:
        # iterdir() raises if legacy is absent → caught → canonical.
        if not canonical.exists() and any(legacy.iterdir()):
            return legacy
    except OSError:
        pass
    return canonical


def _kernel_prebuild_lock() -> Path:
    """Pid lockfile marking an in-flight first-run background kernel build, so the
    `khy os` provision path can wait for it instead of racing a second build."""
    return _khyos_cache_dir() / ".kernel-prebuild.lock"


def _kernel_iso_already_present(kernel_dir: Path, cache_dir: Path) -> bool:
    """True when a kernel ISO is already resolvable, so no build is needed.

    Mirrors the resolution order of @khy/shared `ensureKhyosIso()`:
    explicit ``KHY_KERNEL_ISO`` override → built ISO in the source tree →
    cached ISO under the shared cache dir.
    """
    if str(os.environ.get("KHY_KERNEL_ISO", "")).strip():
        return True
    if _path_exists_safe(kernel_dir / "build" / "khy-os-kernel.iso"):
        return True
    if _path_exists_safe(cache_dir / "khy-os-kernel.iso"):
        return True
    return False


def _pid_alive(pid: int) -> bool:
    """Fail-soft liveness probe for a background build pid.

    Robust against the zombie case: when the caller is the build's own parent
    (the common same-process first-run `khy os` flow), a finished child lingers
    as a zombie and a bare ``os.kill(pid, 0)`` still reports it alive. We first
    try to reap it non-blockingly with ``waitpid(WNOHANG)``; only a pid that is
    neither reapable nor our child falls back to the signal-0 probe.
    """
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True, text=True, timeout=8, **_subprocess_kwargs(),
            )
            return str(pid) in (out.stdout or "")
        except (OSError, ValueError, subprocess.SubprocessError):
            return False
    try:
        reaped, _ = os.waitpid(pid, os.WNOHANG)
        # (pid, status) → just reaped (finished); (0, 0) → still running.
        return reaped == 0
    except ChildProcessError:
        # Not our child (separate `khy os` process) → fall back to a signal probe.
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    except (OSError, ValueError):
        return False


def _env_int(name: str, default: int) -> int:
    """Read an integer env var, falling back on absent/invalid values."""
    try:
        return int(str(os.environ.get(name, "")).strip())
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    """Read a float env var, falling back on absent/invalid values."""
    try:
        return float(str(os.environ.get(name, "")).strip())
    except (TypeError, ValueError):
        return default


def _parse_marker_state(text: str):
    """Parse a kernel-prebuild marker line into ``(state, fields)``.

    Format is a single line ``state key=value key=value``. Legacy single-word
    markers (``started`` / ``present`` / ``disabled`` / ``no-source`` / ...)
    parse to ``(word, {})`` so old machines upgrade transparently. Empty / blank
    input yields ``("", {})``.
    """
    raw = (text or "").strip()
    if not raw:
        return "", {}
    line = raw.splitlines()[0].strip()
    if not line:
        return "", {}
    parts = line.split()
    state = parts[0]
    fields: dict = {}
    for token in parts[1:]:
        if "=" in token:
            key, _, value = token.partition("=")
            fields[key] = value
    return state, fields


def _format_marker_state(state: str, **fields) -> str:
    """Render ``state key=value …`` for a marker line; ``None`` values are dropped."""
    parts = [state]
    for key, value in fields.items():
        if value is None:
            continue
        parts.append(f"{key}={value}")
    return " ".join(parts)


def _marker_int(fields: dict, key: str, default: int = 0) -> int:
    try:
        return int(fields.get(key, default))
    except (TypeError, ValueError):
        return default


def _marker_float(fields: dict, key: str, default: float = 0.0) -> float:
    try:
        return float(fields.get(key, default))
    except (TypeError, ValueError):
        return default


def _decide_retry(attempt, last_ts, now, error_type, max_attempts, retry_interval):
    """Shared retry policy for a failed/dead build attempt.

    Caps total attempts and enforces a minimum backoff window between them so a
    persistently broken host neither spins forever nor gives up after one blip.
    """
    if attempt >= max_attempts:
        return "giveup", "gave-up", {"errorType": error_type, "attempt": attempt}
    if last_ts and (now - last_ts) < retry_interval:
        return "skip", None, {}  # still inside the backoff window
    return "spawn", "building", {"attempt": attempt + 1}


def _decide_kernel_prebuild_action(
    state, fields, iso_present, lock_pid_alive, now, *, max_attempts, retry_interval
):
    """Pure state-machine decision for the background kernel auto-build.

    Returns ``(action, next_state, next_fields)`` where ``action`` is one of
    ``skip`` / ``wait`` / ``spawn`` / ``giveup`` and ``next_state`` (with
    ``next_fields``) describes the marker to persist — ``next_state is None``
    means leave the marker unchanged. Kept pure (no I/O, no clock) so the whole
    lifecycle is unit-testable without spawning a build.

    Decision order:
      1. ISO already resolvable → ``skip`` and self-correct the marker to
         ``present`` (heals any stale ``failed``/``building`` left by a crash).
      2. Terminal / opt-out states (``disabled`` / ``no-source`` / ``gave-up`` /
         ``succeeded`` / ``present``) → ``skip``.
      3. A genuinely live lock → ``wait`` (never spawn a second make in the same
         tree, regardless of what the marker claims).
      4. ``building`` / legacy ``started`` with a dead lock → the detached build
         died without producing an ISO → treat as a failed attempt (retry policy).
      5. ``failed`` → retry policy.
      6. No / unknown marker → first ``spawn``.
    """
    if iso_present:
        return "skip", "present", {}
    if state in ("disabled", "no-source", "gave-up", "succeeded", "present"):
        return "skip", None, {}
    if lock_pid_alive:
        return "wait", None, {}

    attempt = _marker_int(fields, "attempt", 0)
    last_ts = _marker_float(fields, "ts", 0.0)

    if state in ("building", "started"):
        # Lock dead + a build-in-flight marker → the detached build is gone but no
        # ISO exists → it died/failed. Legacy 'started' carries no attempt count.
        if state == "started" and attempt == 0:
            attempt = 1
        error_type = fields.get("errorType", "build-died")
        return _decide_retry(attempt, last_ts, now, error_type, max_attempts, retry_interval)

    if state == "failed":
        error_type = fields.get("errorType", "unknown")
        return _decide_retry(attempt, last_ts, now, error_type, max_attempts, retry_interval)

    # No marker / unrecognized → first attempt.
    return "spawn", "building", {"attempt": 1}


def _lock_pid_alive(lock: Path) -> bool:
    """True when the prebuild lock names a still-running build pid."""
    if not _path_exists_safe(lock):
        return False
    try:
        pid = int((lock.read_text(encoding="utf-8") or "0").strip() or "0")
    except (OSError, ValueError):
        return False
    return _pid_alive(pid)


def _read_build_breadcrumb(cache_dir: Path):
    """Read the structured ``kernel-build-result.json`` the Node builder leaves.

    The detached builder is the only actor that knows the real outcome, so it
    drops this breadcrumb. Returns the parsed dict, or ``None`` when absent /
    unreadable / malformed (fail-soft).
    """
    import json as _json

    result_file = cache_dir / KERNEL_BUILD_RESULT_FILE
    if not _path_exists_safe(result_file):
        return None
    try:
        data = _json.loads(result_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _surface_kernel_build_result(cache_dir: Path):
    """Announce a failed background kernel build once, on the user's next command.

    Reads the builder's structured breadcrumb and, on a *failure* not yet
    announced, prints a single actionable ``[WARN]`` line (cause + log path +
    how to retry / disable), then stamps it ``announced`` so we never nag again
    until the next build overwrites the breadcrumb. Success is silent — a
    working install should not be interrupted.
    """
    import json as _json

    data = _read_build_breadcrumb(cache_dir)
    if not data:
        return
    if str(data.get("result")) != "failure":
        return
    if data.get("announced") is True:
        return

    error_type = str(data.get("errorType") or "unknown")
    hint = str(data.get("hint") or "").strip()
    log_path = str(data.get("logPath") or (cache_dir / "kernel-build.log"))

    print(f"  [WARN] 自研内核后台构建失败（{error_type}）。", file=sys.stderr)
    if hint:
        print(f"         {hint}", file=sys.stderr)
    print(f"         日志: {log_path}", file=sys.stderr)
    print(
        "         重试: 运行 `khy os build` 查看详情并重建；关闭自动构建: 设置 KHY_KERNEL_AUTOBUILD=0",
        file=sys.stderr,
    )

    # Announce-once: stamp the breadcrumb so the warning never repeats every boot.
    data["announced"] = True
    try:
        (cache_dir / KERNEL_BUILD_RESULT_FILE).write_text(
            _json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def _maybe_prebuild_khyos_kernel(backend_dir: Path, node_cmd: str, marker: Path):
    """Reconciling, fail-soft, background pre-build of the self-developed kernel ISO.

    The pip wheel ships kernel SOURCE but never a built ISO (MANIFEST.in prunes
    ``*.iso``). Previously the only way to materialize the ISO was the lazy
    `khy os` provision path or a manual `khy os build`. This pre-warms it the
    first time `khy` starts so the very first `khy os` boots without waiting.

    The marker is a reconciling lifecycle state machine (not a write-once gate),
    so a detached build that dies *after launch* no longer wedges the chain in a
    permanent silent ``started``: a dead lock with no ISO is treated as a failed
    attempt and re-armed (bounded by attempt cap + backoff) on a later boot.

    Contract:
      - Reconciling: ``marker`` carries lifecycle state + attempt/ts; each boot
        reads it, probes ISO/lock, and re-decides via the pure state machine.
      - Opt-out: ``KHY_KERNEL_AUTOBUILD`` ∈ {0,false,no,off} disables it.
      - No-op when there is no bundled kernel source (slim install) or an ISO is
        already resolvable (built / cached / ``KHY_KERNEL_ISO``).
      - Non-blocking: spawns the existing Node builder (`khy os build`, same
        cascade as the lazy path) detached, streaming to a log file — a multi-
        minute compile never stalls the user's first command.
      - Race-safe: a live lock short-circuits to ``wait`` BEFORE spawning, so
        provision and a concurrent launcher never start two `make iso` runs.
      - Toolchain-agnostic: if the host lacks the build toolchain the Node
        builder exits quickly with an actionable guide (captured in the log +
        the structured breadcrumb surfaced on the next command).

    The state lives in ``~/.khyos/cache`` alongside the lock/log/breadcrumb;
    ``marker`` (the legacy backend_dir path) is best-effort retired on first run.
    """
    raw = str(os.environ.get("KHY_KERNEL_AUTOBUILD", "1")).strip().lower()

    kernel_dir = backend_dir.parent.parent / "kernel"
    cli_script = backend_dir / "bin" / "khy.js"
    cache_dir = _khyos_cache_dir()
    state_marker = cache_dir / KERNEL_PREBUILD_MARKER_FILE

    # Best-effort migration: retire the legacy backend_dir marker — state now
    # lives in the cache dir next to the lock/log/breadcrumb.
    if marker is not None and marker != state_marker:
        _remove_quiet(marker)

    # Opt-out short-circuit (re-evaluated every boot; env is the source of truth).
    if raw in {"0", "false", "no", "off"}:
        _write_marker(state_marker, "disabled")
        return

    # Slim install / source not bundled → nothing to build here.
    if not _path_exists_safe(kernel_dir / "Makefile"):
        _write_marker(state_marker, "no-source")
        return

    # Incomplete install (no CLI entry yet) → leave unmarked, retry next boot.
    if not _path_exists_safe(cli_script):
        return

    # Read current lifecycle state + the builder's last structured outcome.
    state, fields = "", {}
    if _path_exists_safe(state_marker):
        try:
            state, fields = _parse_marker_state(state_marker.read_text(encoding="utf-8"))
        except OSError:
            state, fields = "", {}

    breadcrumb = _read_build_breadcrumb(cache_dir)
    if breadcrumb and not fields.get("errorType") and breadcrumb.get("errorType"):
        # Carry the builder's real errorType into the marker for the giveup record.
        fields["errorType"] = str(breadcrumb.get("errorType"))

    iso_present = _kernel_iso_already_present(kernel_dir, cache_dir)
    lock = _kernel_prebuild_lock()
    lock_pid_alive = _lock_pid_alive(lock)

    max_attempts = _env_int(KERNEL_AUTOBUILD_MAX_ATTEMPTS_ENV, _KERNEL_AUTOBUILD_MAX_ATTEMPTS_DEFAULT)
    retry_interval = _env_float(KERNEL_AUTOBUILD_RETRY_INTERVAL_ENV, _KERNEL_AUTOBUILD_RETRY_INTERVAL_DEFAULT)
    now = time.time()

    action, next_state, next_fields = _decide_kernel_prebuild_action(
        state, fields, iso_present, lock_pid_alive, now,
        max_attempts=max_attempts, retry_interval=retry_interval,
    )

    if action == "skip":
        if next_state is not None:
            _write_marker(state_marker, _format_marker_state(next_state))
        return
    if action == "wait":
        return
    if action == "giveup":
        _write_marker(state_marker, _format_marker_state(
            next_state,
            errorType=next_fields.get("errorType", "unknown"),
            attempt=next_fields.get("attempt", max_attempts),
        ))
        return

    # action == "spawn"
    attempt = int(next_fields.get("attempt", 1))

    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        # Cannot prepare the cache dir → defer to the lazy `khy os` path.
        _write_marker(state_marker, "deferred")
        return

    log_path = cache_dir / "kernel-build.log"
    try:
        log_handle = open(log_path, "w", encoding="utf-8")
    except OSError:
        log_handle = subprocess.DEVNULL

    env = _node_env(backend_dir)
    env["KHYQUANT_ROOT"] = str(backend_dir)

    popen_kwargs = dict(_subprocess_kwargs())
    if os.name == "nt":
        # Detach so the build outlives this launcher invocation.
        popen_kwargs["creationflags"] = (
            popen_kwargs.get("creationflags", 0) | subprocess.DETACHED_PROCESS
        )
    else:
        popen_kwargs["start_new_session"] = True

    try:
        proc = subprocess.Popen(
            [str(node_cmd), str(cli_script), "os", "build"],
            cwd=str(backend_dir),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
            **popen_kwargs,
        )
    except Exception:
        _write_marker(state_marker, _format_marker_state(
            "failed", errorType="launch-failed", attempt=attempt, ts=int(now),
        ))
        return
    finally:
        if hasattr(log_handle, "close"):
            try:
                log_handle.close()
            except Exception:
                pass

    # Record the in-flight build so `khy os` waits instead of racing it.
    _write_marker(lock, str(proc.pid))
    _write_marker(state_marker, _format_marker_state(
        "building", pid=proc.pid, ts=int(now), attempt=attempt,
    ))
    if attempt > 1:
        print(f"  [INFO] 正在后台重试构建自研内核 ISO（第 {attempt} 次尝试）。")
    else:
        print("  [INFO] 正在后台构建自研内核 ISO（首次安装，零摩擦）。")
    print(f"         日志: {log_path}")
    print("         完成后运行 `khy os` 即可启动；缺工具链可改用 `khy os build` 查看指引。")
    print("         如需关闭自动构建：设置环境变量 KHY_KERNEL_AUTOBUILD=0")


def wait_for_kernel_prebuild(timeout: float = None):
    """Block (bounded, fail-soft) while a first-run background kernel build is in
    flight, so the `khy os` provision path does not race a second `make iso` in
    the same source tree. Called from the cli launcher before `os provision`.

    The lock is removed once the build pid is gone (or judged stale), so a later
    `khy os` proceeds straight to provision (which finds the freshly built ISO).
    """
    lock = _kernel_prebuild_lock()
    if not _path_exists_safe(lock):
        return
    try:
        pid = int((lock.read_text(encoding="utf-8") or "0").strip() or "0")
    except (OSError, ValueError):
        pid = 0

    if not _pid_alive(pid):
        _remove_quiet(lock)
        return

    if timeout is None:
        try:
            timeout = float(os.environ.get("KHY_KERNEL_BUILD_WAIT", "900"))
        except (TypeError, ValueError):
            timeout = 900.0

    print("  [INFO] 自研内核 ISO 正在后台构建，等待其完成后再启动…")
    start = time.time()
    while time.time() - start < timeout:
        if not _pid_alive(pid):
            break
        time.sleep(2)
    _remove_quiet(lock)


def ensure_bootstrapped(backend_dir: Path, node_cmd: str):
    """主入口：如未初始化则执行初始化流程。"""
    marker = backend_dir / MARKER_FILE
    seed_marker = backend_dir / SEED_MARKER_FILE
    optional_fix_marker = backend_dir / OPTIONAL_FIX_MARKER_FILE
    kiro_cw_sdk_marker = backend_dir / KIRO_CW_SDK_MARKER_FILE
    kernel_prebuild_marker = backend_dir / KERNEL_PREBUILD_MARKER_FILE

    # Always check version upgrade (even if already bootstrapped),
    # so that `pip install --upgrade` triggers a forced token refresh.
    _check_version_upgrade(backend_dir)

    if marker.exists() and seed_marker.exists():
        _maybe_repair_optional_local_ai_deps(backend_dir, optional_fix_marker)
        _maybe_repair_kiro_cw_sdk(backend_dir, kiro_cw_sdk_marker)
        _maybe_install_trae_bridge(backend_dir)
        _maybe_configure_ide_gateway(backend_dir)
        _sync_claude_code_auth_token()
        _maybe_build_ai_frontend(backend_dir)
        _maybe_prebuild_khyos_kernel(backend_dir, node_cmd, kernel_prebuild_marker)
        _surface_kernel_build_result(_khyos_cache_dir())
        return  # 安装与 seed 都完成，直接跳过

    print()
    print("  khy OS first-run setup...")
    print()

    install_ok = True
    seed_ok = seed_marker.exists()

    # 1) 安装 npm 依赖（仅在安装标记缺失时执行）
    if not marker.exists():
        install_ok = _ensure_npm_install(backend_dir) and install_ok

    # 2) 生成 .env（可重复安全）
    _ensure_env_file(backend_dir)

    # 3) 初始化数据库（仅在 seed 标记缺失时执行，失败会在下次自动重试）
    if not seed_ok:
        seed_ok = _ensure_db_init(backend_dir, node_cmd)

    # 4) 注册到 app 清单（可重复安全）
    _register_app(backend_dir)

    # 安装标记：npm install 至少完成（即使 optional 依赖失败也算通过）
    # 避免 optional 失败导致每次启动都重跑完整 npm install
    if install_ok:
        _write_marker(marker, "bootstrapped")

    if seed_ok:
        _write_marker(seed_marker, "seeded")
    else:
        print("  [WARN] Database seed not confirmed; will retry on next startup.", file=sys.stderr)

    # 5) 生成入门文档（非关键）
    _generate_getting_started(backend_dir, node_cmd)

    # 6) 可选依赖自愈（避免旧安装缺失 node-llama-cpp）
    _maybe_repair_optional_local_ai_deps(backend_dir, optional_fix_marker)

    # 6b) Kiro 传输 SDK 自愈（避免旧安装/slim 安装缺失 CodeWhisperer SDK）
    _maybe_repair_kiro_cw_sdk(backend_dir, kiro_cw_sdk_marker)

    # 7) 自动安装 Trae Bridge 扩展到本地 Trae IDE
    _maybe_install_trae_bridge(backend_dir)

    # 8) 自动检测本地 IDE 并配置网关首选适配器
    _maybe_configure_ide_gateway(backend_dir)

    # 9) 后台预构建自研内核 ISO（首次安装后零摩擦，缺工具链则自动降级到 `khy os` 懒构建）
    _maybe_prebuild_khyos_kernel(backend_dir, node_cmd, kernel_prebuild_marker)
    _surface_kernel_build_result(_khyos_cache_dir())

    print()
    print("  Setup complete!")
    print()


def _maybe_repair_optional_local_ai_deps(backend_dir: Path, marker: Path):
    """
    One-shot repair for optional local AI dependency (node-llama-cpp).
    Writes a marker file regardless of outcome so npm never runs on every boot.
    """
    if marker.exists():
        return

    node_modules = backend_dir / "node_modules"
    include_optional_raw = str(os.environ.get("KHY_NPM_INCLUDE_OPTIONAL", "1")).strip().lower()
    include_optional = include_optional_raw not in {"0", "false", "no", "off"}

    if not include_optional:
        _write_marker(marker, "optional-disabled")
        return

    if not _path_exists_safe(node_modules):
        return

    if _has_llama_pkg(node_modules):
        _write_marker(marker, "ok")
        return

    # Attempt one-shot install — always write marker afterward
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    print("  [INFO] Repairing optional local AI dependency: node-llama-cpp ...")
    try:
        result = subprocess.run(
            [npm_cmd, "install", "node-llama-cpp", "--no-audit", "--no-fund"],
            cwd=str(backend_dir),
            timeout=_NPM_TIMEOUT,
            **_subprocess_kwargs(),
        )
        if result.returncode == 0 and _has_llama_pkg(node_modules):
            print("  [OK] Optional dependency repaired: node-llama-cpp")
            _write_marker(marker, "repaired")
        else:
            print("  [WARN] node-llama-cpp repair failed; will not retry", file=sys.stderr)
            _write_marker(marker, "failed")
    except Exception:
        print("  [WARN] node-llama-cpp repair failed; will not retry", file=sys.stderr)
        _write_marker(marker, "failed")


def _maybe_repair_kiro_cw_sdk(backend_dir: Path, marker: Path):
    """
    Ensure the Kiro CodeWhisperer streaming SDK is installed.

    @aws/codewhisperer-streaming-client is the transport the Kiro adapter uses
    to reach AWS Q / CodeWhisperer. It is now declared as a regular dependency,
    but existing installs whose node_modules predate that declaration (or that
    ran a slim `--omit=optional` install) lack it, which leaves the Kiro channel
    'unavailable: CW SDK not installed'. This self-heal installs it once.

    Unlike node-llama-cpp this package is pure JavaScript (no native build), so
    it is fast and safe to fetch even on Windows, and it is therefore NOT gated
    behind KHY_NPM_INCLUDE_OPTIONAL — Kiro should work regardless of slim mode.
    A marker is written on every outcome so npm never runs on each boot; users
    can re-trigger by deleting the marker or reinstalling the package manually.
    """
    if marker.exists():
        return

    node_modules = backend_dir / "node_modules"
    if not _path_exists_safe(node_modules):
        return

    if _has_cw_sdk(node_modules):
        _write_marker(marker, "ok")
        return

    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    print("  [INFO] Installing Kiro transport SDK: @aws/codewhisperer-streaming-client ...")
    _configure_npm_registry(npm_cmd, backend_dir)
    try:
        rc = _run_npm_streaming(
            [npm_cmd, "install", "@aws/codewhisperer-streaming-client", "--no-audit", "--no-fund"],
            backend_dir,
            _NPM_TIMEOUT,
        )
        if rc == 0 and _has_cw_sdk(node_modules):
            print("  [OK] Kiro transport SDK installed")
            _write_marker(marker, "installed")
        else:
            print("  [WARN] Kiro SDK install failed; Kiro channel stays unavailable until retried", file=sys.stderr)
            _write_marker(marker, "failed")
    except Exception:
        print("  [WARN] Kiro SDK install failed; Kiro channel stays unavailable until retried", file=sys.stderr)
        _write_marker(marker, "failed")


def _find_trae_cli() -> str | None:
    """检测本机 Trae IDE CLI 可执行文件路径。

    搜索顺序（性能优先）：
    1. Windows 常见安装目录（纯文件检测，瞬间完成）
    2. PATH 中的 trae / trae.cmd（subprocess fallback）
    """
    # Windows 常见安装目录（比 subprocess 快得多，优先）
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        if local_app:
            for name in ("Trae CN", "Trae"):
                candidate = Path(local_app) / "Programs" / name / "bin" / "trae.cmd"
                if candidate.exists():
                    return str(candidate)

    # PATH 中查找
    for cmd in ("trae", "trae.cmd"):
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True, text=True, timeout=3,
                **_subprocess_kwargs(),
            )
            if result.returncode == 0:
                return cmd
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue

    return None


def _find_bundled_vsix(backend_dir: Path) -> Path | None:
    """在 bundled 或源码目录中查找 khy-trae-bridge VSIX 文件。"""
    search_roots = []

    # pip 安装模式：bundled/extensions/（backend 镜像为 bundled/services/backend，向上两级到 bundle 根）
    # 防御性判断：如果 backend_dir.name != "backend"，说明深度可能不同，尝试向上三级
    if backend_dir.name == "backend":
        bundled_root = backend_dir.parent.parent  # bundled/services/backend → bundled
    else:
        bundled_root = backend_dir.parent.parent.parent  # 试试更深一级
    if (bundled_root / "extensions").exists():
        search_roots.append(bundled_root / "extensions" / "khy-trae-bridge")

    # 源码模式：项目根 extensions/（platform/khy_platform/ -> platform -> repo root）
    project_root = Path(__file__).parent.parent.parent
    src_ext = project_root / "extensions" / "khy-trae-bridge"
    if src_ext.exists():
        search_roots.append(src_ext)

    for root in search_roots:
        if not root.exists():
            continue
        vsix_files = sorted(root.glob("*.vsix"), reverse=True)
        if vsix_files:
            return vsix_files[0]  # 最新版本
    return None


def _maybe_install_trae_bridge(backend_dir: Path):
    """自动检测 Trae IDE 并安装 khy-trae-bridge VSIX 扩展。

    - 只在 Windows 上执行（Trae 主要面向 Windows/macOS）
    - 用标记文件避免重复安装
    - 失败静默跳过，不影响主流程
    """
    marker = backend_dir / TRAE_BRIDGE_MARKER_FILE

    vsix = _find_bundled_vsix(backend_dir)
    if not vsix:
        return  # 无 VSIX 文件，不写标记（下次升级后可能有）

    # 版本感知：标记文件记录已安装的 VSIX 文件名，版本变更时重新安装
    vsix_id = vsix.name  # e.g. "khy-trae-bridge-0.1.1.vsix"
    if marker.exists():
        try:
            installed_id = marker.read_text(encoding="utf-8").strip().split("\n")[0]
            if installed_id == vsix_id:
                return  # 同版本已安装，跳过
            # 版本不同 → 需要更新
        except OSError:
            return

    # 仅 Windows/macOS 尝试
    if os.name not in ("nt", "posix"):
        _write_marker(marker, f"{vsix_id}\nskipped-platform")
        return

    trae_cli = _find_trae_cli()
    if not trae_cli:
        # Trae 未安装也尝试 code CLI（VS Code 兼容）
        for fallback in ("code", "code.cmd"):
            try:
                result = subprocess.run(
                    [fallback, "--version"],
                    capture_output=True, text=True, timeout=10,
                    **_subprocess_kwargs(),
                )
                if result.returncode == 0:
                    trae_cli = fallback
                    break
            except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
                continue

    if not trae_cli:
        _write_marker(marker, f"{vsix_id}\nno-ide-found")
        return

    try:
        # 先卸载旧版扩展，清除 Trae 缓存的旧 VSIX 路径引用
        # 否则版本升级后 Trae 仍尝试读取已删除的旧 .vsix 文件 → ENOENT
        try:
            subprocess.run(
                [trae_cli, "--uninstall-extension", "khy.khy-trae-bridge"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=30,
                **_subprocess_kwargs(),
            )
        except Exception:
            pass  # 首次安装无旧版，忽略

        print(f"  [INFO] 正在安装 Trae Bridge 扩展: {vsix.name}")
        result = subprocess.run(
            [trae_cli, "--install-extension", str(vsix), "--force"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=60,
            **_subprocess_kwargs(),
        )
        if result.returncode == 0:
            print("  [OK] Trae Bridge 扩展已自动安装")
            _write_marker(marker, vsix_id)
        else:
            stderr = (result.stderr or "").strip()
            print(f"  [WARN] Trae Bridge 安装失败: {stderr}", file=sys.stderr)
            _write_marker(marker, f"{vsix_id}\nfailed: {stderr[:200]}")
    except subprocess.TimeoutExpired:
        print("  [WARN] Trae Bridge 安装超时", file=sys.stderr)
        _write_marker(marker, f"{vsix_id}\ntimeout")
    except Exception as e:
        print(f"  [WARN] Trae Bridge 安装异常: {e}", file=sys.stderr)
        _write_marker(marker, f"{vsix_id}\nerror: {e}")


# ── IDE 自动检测 & Claude Code 代理配置 ───────────────────────────

# 标记文件：避免每次启动重复检测
_IDE_GATEWAY_MARKER_FILE = ".khy_ide_gateway_configured"


def _detect_local_ide() -> str | None:
    """按优先级检测本地已登录的 IDE，返回适配器名或 None。

    检测顺序：Kiro > Trae > Cursor。
    Kiro 需要有效的 AWS SSO token 文件；Trae/Cursor 只需安装即可。
    """
    # ── Kiro：检查 token 文件 ──
    kiro_token_candidates: list[Path] = []
    home = Path.home()
    kiro_token_candidates.append(home / ".aws" / "sso" / "cache" / "kiro-auth-token.json")
    if os.name == "nt":
        for env_var in ("USERPROFILE", "HOMEDRIVE"):
            root = os.environ.get(env_var, "")
            if env_var == "HOMEDRIVE":
                root = root + os.environ.get("HOMEPATH", "")
            if root:
                p = Path(root) / ".aws" / "sso" / "cache" / "kiro-auth-token.json"
                if p not in kiro_token_candidates:
                    kiro_token_candidates.append(p)

    for token_path in kiro_token_candidates:
        if _path_exists_safe(token_path):
            try:
                import json as _json
                data = _json.loads(token_path.read_text(encoding="utf-8"))
                if data.get("accessToken"):
                    return "kiro"
            except Exception:
                pass

    # Kiro 安装目录检测（Windows）
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        if local_app:
            for name in ("Kiro",):
                if _path_exists_safe(Path(local_app) / "Programs" / name):
                    return "kiro"

    # ── Trae ──
    if _find_trae_cli():
        return "trae"

    # ── Cursor ──
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        if local_app and _path_exists_safe(Path(local_app) / "Programs" / "Cursor"):
            return "cursor"
    for cmd in ("cursor", "cursor.cmd"):
        try:
            r = subprocess.run(
                [cmd, "--version"],
                capture_output=True, timeout=3,
                **_subprocess_kwargs(),
            )
            if r.returncode == 0:
                return "cursor"
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue

    return None


def _proxy_data_home_candidates() -> list[Path]:
    """Return data-home candidates in the same priority order as Node."""
    candidates: list[Path] = []

    env_home = os.environ.get("KHY_DATA_HOME", "").strip()
    if env_home:
        candidates.append(Path(env_home))

    if os.name == "nt":
        d_khy = Path("D:/.khy")
        if _path_exists_safe(d_khy):
            candidates.append(d_khy)

    candidates.append(Path.home() / ".khy")
    candidates.append(Path.home() / ".khyquant")

    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve()) if candidate.exists() else str(candidate)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _primary_proxy_data_home() -> Path:
    candidates = _proxy_data_home_candidates()
    return candidates[0] if candidates else (Path.home() / ".khy")


def _parse_proxy_port(raw, fallback: int | None = None) -> int | None:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError, AttributeError):
        return fallback
    if 0 < value <= 65535:
        return value
    return fallback


def _proxy_host_for_client(raw_host: str | None = None) -> str:
    host = str(raw_host or os.environ.get("PROXY_HOST", "")).strip() or "127.0.0.1"
    if host in {"0.0.0.0", "::", "[::]", "*"}:
        return "127.0.0.1"
    return host


def _bool_from_env(raw, fallback: bool = False) -> bool:
    if raw is None:
        return fallback
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return fallback


def _read_proxy_runtime() -> dict | None:
    """Read the persisted proxy runtime file written by `khy proxy start`."""
    import json as _json

    for data_home in _proxy_data_home_candidates():
        runtime_file = data_home / "proxy_server_runtime.json"
        if not _path_exists_safe(runtime_file):
            continue
        try:
            data = _json.loads(runtime_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue

        legacy_port = _parse_proxy_port(data.get("port"))
        http_port = _parse_proxy_port(data.get("httpPort"))
        https_port = _parse_proxy_port(data.get("httpsPort"))
        https_enabled = data.get("httpsEnabled") is True or https_port is not None
        https_only = data.get("httpsOnly") is True or (http_port is None and https_port is not None)

        if http_port is None and not https_only:
            http_port = legacy_port

        if http_port is None and https_port is None:
            continue

        return {
            "host": _proxy_host_for_client(data.get("host")),
            "httpPort": http_port,
            "httpsPort": https_port,
            "httpsEnabled": https_enabled,
            "httpsOnly": https_only,
        }
    return None


def _get_proxy_base_url(prefer_https: bool = False) -> str:
    """Resolve the local KHY proxy base URL from runtime or environment."""
    runtime = _read_proxy_runtime()
    if runtime:
        host = runtime["host"]
        http_port = runtime.get("httpPort")
        https_port = runtime.get("httpsPort")
        if prefer_https and https_port is not None:
            return f"https://{host}:{https_port}"
        if http_port is not None:
            return f"http://{host}:{http_port}"
        if https_port is not None:
            return f"https://{host}:{https_port}"

    host = _proxy_host_for_client()
    http_port = _parse_proxy_port(os.environ.get("PROXY_PORT"), 9100) or 9100
    https_enabled = _bool_from_env(os.environ.get("PROXY_ENABLE_HTTPS"), False)
    https_only = _bool_from_env(os.environ.get("PROXY_HTTPS_ONLY"), False)
    https_fallback = http_port if https_only else min(http_port + 1, 65535)
    https_port = _parse_proxy_port(os.environ.get("PROXY_HTTPS_PORT"), https_fallback)

    if prefer_https and https_enabled and https_port is not None:
        return f"https://{host}:{https_port}"
    if not https_only:
        return f"http://{host}:{http_port}"
    if https_enabled and https_port is not None:
        return f"https://{host}:{https_port}"
    return f"http://{host}:{http_port}"


def _is_loopback_host(host: str) -> bool:
    import ipaddress

    text = str(host or "").strip().lower()
    if not text:
        return False
    if text == "localhost":
        return True
    try:
        return ipaddress.ip_address(text).is_loopback
    except ValueError:
        return False


def _should_disable_proxy_tls_verification(base_url: str) -> bool:
    from urllib.parse import urlparse

    try:
        parsed = urlparse(str(base_url or "").strip())
    except Exception:
        return False
    return parsed.scheme.lower() == "https" and _is_loopback_host(parsed.hostname or "")


def _is_khy_proxy_base_url(base_url: str) -> bool:
    from urllib.parse import urlparse

    try:
        parsed = urlparse(str(base_url or "").strip())
    except Exception:
        return False
    scheme = parsed.scheme.lower()
    host = parsed.hostname or ""
    port = parsed.port
    if scheme not in {"http", "https"} or not _is_loopback_host(host) or port is None:
        return False

    allowed: set[tuple[str, int]] = set()
    runtime = _read_proxy_runtime()
    if runtime:
        if runtime.get("httpPort") is not None:
            allowed.add(("http", int(runtime["httpPort"])))
        if runtime.get("httpsPort") is not None:
            allowed.add(("https", int(runtime["httpsPort"])))

    fallback_base = _get_proxy_base_url(prefer_https=False)
    try:
        fallback = urlparse(fallback_base)
        if fallback.port is not None:
            allowed.add((fallback.scheme.lower(), fallback.port))
    except Exception:
        pass

    https_base = _get_proxy_base_url(prefer_https=True)
    try:
        fallback_https = urlparse(https_base)
        if fallback_https.port is not None:
            allowed.add((fallback_https.scheme.lower(), fallback_https.port))
    except Exception:
        pass

    return (scheme, port) in allowed


def _read_proxy_auth_token() -> str | None:
    """从代理 auth 文件读取已有的 token。"""
    import json as _json

    for data_home in _proxy_data_home_candidates():
        auth_file = data_home / "proxy_server_auth.json"
        if not _path_exists_safe(auth_file):
            continue
        try:
            data = _json.loads(auth_file.read_text(encoding="utf-8"))
            token = data.get("authToken", "").strip()
            if token:
                return token
        except Exception:
            pass
    return None


def _resolve_claude_code_models() -> tuple:
    """根据检测到的本地 IDE 返回 (default, opus, sonnet, haiku, subagent) 真实模型名。

    模型名使用 adapter/model 前缀格式，KHY 代理会按前缀精确路由到对应适配器。
    Claude Code 的 /model 菜单 Default/Opus/Sonnet/Haiku + Subagent 五个槽位
    将映射到这些真实模型。
    """
    detected = _detect_local_ide()

    # 本地模型：优先 ollama，回退到 localLLM
    local_model = "ollama/qwen3.5:4b"

    if detected == "kiro":
        # Kiro IDE (AWS Q)
        return (
            "kiro/claude-sonnet-4.5",   # Default → 日常主力
            "deepseek-v4-flash",        # Opus → DeepSeek V4 Flash（SenseNova）
            "kiro/deepseek-3.2",        # Sonnet → DeepSeek
            "sensenova-6.7-flash-lite",  # Haiku → 商汤日日新（SenseNova）
            local_model,                # Subagent → 本地模型
        )
    elif detected == "trae":
        # Trae IDE
        return (
            "trae/gpt-5.4-beta",        # Default
            "trae/deepseek-v3.2",        # Opus → DeepSeek
            "trae/kimi-k2.5",            # Sonnet → Kimi
            "trae/gemini-2.5-flash",     # Haiku → 快速
            local_model,
        )
    elif detected == "cursor":
        # Cursor IDE
        return (
            "cursor/claude-3.5-sonnet",  # Default
            "cursor/gpt-4o",             # Opus
            "cursor/gpt-4o-mini",        # Sonnet
            "cursor/cursor-small",       # Haiku
            local_model,
        )
    else:
        # 未检测到 IDE — 使用 SenseNova 内置 key 开箱即用
        # 所有 slot 均可被 khy-expand 兜底（本地确定性能力，零 token）
        return (
            "sensenova-6.7-flash-lite",   # Default → SenseNova 内置
            "deepseek-v4-flash",          # Opus → DeepSeek V4 Flash（SenseNova）
            "sensenova-6.7-flash-lite",   # Sonnet → SenseNova
            "khy-expand",                 # Haiku → KHY ExpandModel（本地能力兜底）
            local_model,
        )


def _generate_proxy_auth_token() -> str:
    """生成 khy-<48 hex> 格式的代理 auth token 并持久化。"""
    import json as _json

    token = f"khy-{secrets.token_hex(24)}"
    khy_dir = _primary_proxy_data_home()
    khy_dir.mkdir(parents=True, exist_ok=True)
    auth_file = khy_dir / "proxy_server_auth.json"
    try:
        auth_file.write_text(
            _json.dumps({"authToken": token, "managedTokens": []}, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass
    return token


def _should_manage_claude_settings() -> bool:
    """Whether KHY is allowed to write ~/.claude/settings.json.

    Default is disabled to avoid conflicts with user-managed Claude Code auth.
    Enable explicitly with either:
      - KHY_ALLOW_WRITE_CLAUDE_SETTINGS=1
      - KHY_MANAGE_CLAUDE_SETTINGS=1 (legacy alias)
    """
    raw = os.environ.get("KHY_ALLOW_WRITE_CLAUDE_SETTINGS", "")
    if not raw:
        raw = os.environ.get("KHY_MANAGE_CLAUDE_SETTINGS", "")
    value = str(raw).strip().lower()
    return value in {"1", "true", "yes", "on"}


def _has_external_anthropic_auth():
    """Check if external Anthropic auth exists in shell env OR settings.json.

    Auth can live in two places:
      - Shell environment variables (os.environ)
      - ~/.claude/settings.json env block (Claude Code reads this at startup)

    Detects two forms of external auth in BOTH locations:
      1. ANTHROPIC_AUTH_TOKEN (OAuth token, e.g. from third-party proxy)
      2. ANTHROPIC_API_KEY   (official API key, e.g. sk-ant-xxx)

    KHY-managed keys (khy- prefix) are ignored since those are our own.

    Also returns True when settings.json has a non-local ANTHROPIC_BASE_URL,
    meaning Claude Code is configured to talk to an external endpoint — injecting
    a KHY local-proxy key would send the wrong credentials to that endpoint.
    """
    import json as _json

    # 1. Check shell env
    for var in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
        val = os.environ.get(var, "")
        if val and not val.startswith("khy-"):
            return True

    # 2. Check ~/.claude/settings.json env block
    settings_file = Path.home() / ".claude" / "settings.json"
    if _path_exists_safe(settings_file):
        try:
            settings = _json.loads(settings_file.read_text(encoding="utf-8"))
            env_block = settings.get("env", {})

            for var in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
                val = env_block.get(var, "")
                if val and not val.startswith("khy-"):
                    return True

            # Non-KHY BASE_URL means Claude talks to an external endpoint.
            base_url = env_block.get("ANTHROPIC_BASE_URL", "")
            if base_url and not _is_khy_proxy_base_url(base_url):
                return True
        except Exception:
            # Fail-safe: if settings exists but is unreadable/corrupted, do not
            # risk injecting KHY auth into a potentially user-managed setup.
            return True

    return False


def _cleanup_khy_auth_from_settings():
    """清除 settings.json 中 KHY 之前注入的认证配置。

    当检测到外部 ANTHROPIC_AUTH_TOKEN 时调用，移除 khy- 前缀的
    ANTHROPIC_API_KEY 和指向本地代理的 ANTHROPIC_BASE_URL，
    防止与外部认证冲突。
    """
    import json as _json

    settings_file = Path.home() / ".claude" / "settings.json"
    if not _path_exists_safe(settings_file):
        return

    try:
        settings = _json.loads(settings_file.read_text(encoding="utf-8"))
    except Exception:
        return

    env_block = settings.get("env", {})
    changed = False

    # 只清除 KHY 管理的 key（khy- 前缀），不碰用户自行配置的。
    # 同时清理 AUTH_TOKEN 与 API_KEY 两种残留：历史版本注入 API_KEY，
    # 切换到 Bearer 后注入 AUTH_TOKEN，需同时清除避免遗留旧 key 干扰凭据优先级。
    for _auth_key in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
        current_key = env_block.get(_auth_key, "")
        if current_key.startswith("khy-"):
            del env_block[_auth_key]
            changed = True
            if env_block.get("NODE_TLS_REJECT_UNAUTHORIZED") == "0":
                del env_block["NODE_TLS_REJECT_UNAUTHORIZED"]
                changed = True

    # 只清除指向 KHY 本地代理的 BASE_URL
    current_base = env_block.get("ANTHROPIC_BASE_URL", "")
    if current_base and _is_khy_proxy_base_url(current_base):
        del env_block["ANTHROPIC_BASE_URL"]
        changed = True
        if env_block.get("NODE_TLS_REJECT_UNAUTHORIZED") == "0":
            del env_block["NODE_TLS_REJECT_UNAUTHORIZED"]
            changed = True

    if changed:
        settings["env"] = env_block
        try:
            settings_file.write_text(
                _json.dumps(settings, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass


def _sync_claude_code_auth_token():
    """每次启动时同步代理 auth token 到 ~/.claude/settings.json。

    轻量级检查：读取 proxy_server_auth.json 中的 token，与
    settings.json 中的 ANTHROPIC_API_KEY 比对，不一致时更新。
    确保 Node proxy 重新生成 token 后 Claude Code 侧也自动跟进。
    """
    import json as _json

    # 默认不写 ~/.claude/settings.json，避免与用户独立 Claude Code 配置冲突。
    # 但如果检测到外部认证，仍做一次“历史残留清理”：移除旧版本注入的
    # khy-* API key 与本地代理 BASE_URL，避免 direct Claude 被错误配置拖累。
    if not _should_manage_claude_settings():
        if _has_external_anthropic_auth():
            _cleanup_khy_auth_from_settings()
        return

    # External auth (e.g. ANTHROPIC_AUTH_TOKEN from shell) takes priority;
    # also clean up any previously injected KHY keys to avoid conflict
    if _has_external_anthropic_auth():
        _cleanup_khy_auth_from_settings()
        return

    token = _read_proxy_auth_token()
    if not token:
        return  # 没有 token 文件，跳过（proxy 还没启动过）

    settings_file = Path.home() / ".claude" / "settings.json"
    if not _path_exists_safe(settings_file):
        return  # 没有 settings.json，首次配置由 _maybe_configure_claude_code_settings 处理

    try:
        settings = _json.loads(settings_file.read_text(encoding="utf-8"))
    except Exception:
        return

    env_block = settings.get("env", {})

    desired_base = _get_proxy_base_url()
    desired_tls_bypass = _should_disable_proxy_tls_verification(desired_base)

    # Guard: if BASE_URL points to a non-KHY endpoint, do NOT inject a
    # KHY local-proxy key — it would be sent to the wrong server (401).
    current_base = env_block.get("ANTHROPIC_BASE_URL", "")
    if current_base and not _is_khy_proxy_base_url(current_base):
        return

    # KHY 同时写入 Bearer（ANTHROPIC_AUTH_TOKEN）与 api-key（ANTHROPIC_API_KEY）
    # 两类凭据（同值）；以 Bearer 为准判定归属。
    current_key = env_block.get("ANTHROPIC_AUTH_TOKEN", "")

    # 仅当 key 是 khy- 前缀（我们管理的）且与 token 文件不一致时更新
    if current_key and current_key != token and not current_key.startswith("khy-"):
        return  # 用户自行设置的非 KHY key，不覆盖

    changed = False
    # 同步两类凭据：仅当已有值为空或 khy- 前缀（我们管理的）时更新，
    # 用户自配的非 khy- 值保留不动。
    for cred_key in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
        existing_val = env_block.get(cred_key, "")
        if existing_val != token and (not existing_val or existing_val.startswith("khy-")):
            env_block[cred_key] = token
            changed = True
    if env_block.get("ANTHROPIC_BASE_URL", "") != desired_base:
        env_block["ANTHROPIC_BASE_URL"] = desired_base
        changed = True
    if desired_tls_bypass:
        if env_block.get("NODE_TLS_REJECT_UNAUTHORIZED") != "0":
            env_block["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
            changed = True
    elif env_block.get("NODE_TLS_REJECT_UNAUTHORIZED") == "0":
        del env_block["NODE_TLS_REJECT_UNAUTHORIZED"]
        changed = True

    if not changed:
        return

    settings["env"] = env_block
    try:
        settings_file.write_text(
            _json.dumps(settings, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError:
        pass


def _maybe_configure_claude_code_settings():
    """自动配置 ~/.claude/settings.json，让 Claude Code 使用 KHY 代理。

    参考 DeepSeek 接入 Claude Code 教程方式，通过 ANTHROPIC_DEFAULT_*_MODEL
    环境变量将真实模型名映射到 Claude Code 的 Opus/Sonnet/Haiku 槽位，
    使 /model 菜单显示的实际是 KHY 代理中的真实模型。
    合并写入 env 字段，不覆盖用户已有配置。
    """
    import json as _json

    # 默认不写 ~/.claude/settings.json，避免与用户独立 Claude Code 配置冲突
    if not _should_manage_claude_settings():
        return

    # External auth (e.g. ANTHROPIC_AUTH_TOKEN from shell) takes priority —
    # skip injecting and clean up any previously injected KHY keys
    if _has_external_anthropic_auth():
        _cleanup_khy_auth_from_settings()
        return

    claude_dir = Path.home() / ".claude"
    settings_file = claude_dir / "settings.json"

    # 读取已有配置
    existing: dict = {}
    if _path_exists_safe(settings_file):
        try:
            existing = _json.loads(settings_file.read_text(encoding="utf-8"))
        except Exception:
            # Fail-safe: keep hands off when the file cannot be parsed.
            return

    env_block: dict = existing.get("env", {})

    # 如果已配置了非 KHY 的 ANTHROPIC_BASE_URL，不覆盖
    current_base = env_block.get("ANTHROPIC_BASE_URL", "")
    if current_base and not _is_khy_proxy_base_url(current_base):
        return

    # 获取或生成 auth token
    auth_token = _read_proxy_auth_token() or _generate_proxy_auth_token()
    proxy_base_url = _get_proxy_base_url()

    # 根据检测到的 IDE 选择真实模型名
    default_model, opus_model, sonnet_model, haiku_model, subagent_model = _resolve_claude_code_models()

    # 合并 env 字段（仅设置未配置的 key）
    # 通过 ANTHROPIC_DEFAULT_*_MODEL 将 Claude Code 的 Opus/Sonnet/Haiku
    # 槽位映射到 KHY 代理中的真实模型名（如 kiro/claude-sonnet-4.5），
    # 代理收到请求后按适配器前缀精确路由。
    defaults = {
        "ANTHROPIC_BASE_URL": proxy_base_url,
        # 同时写入 Bearer 与 api-key 两种凭据（同值）：KHY 代理两类头都接受。
        #   - ANTHROPIC_AUTH_TOKEN：主凭据（Bearer），优先级高，避免 x-api-key
        #     在自定义 BASE_URL 下触发自定义 key 审批而回退 "Please run /login"。
        #   - ANTHROPIC_API_KEY：保留，兼容读取 api-key 的消费方（对齐 cc-switch
        #     “保留原配置 token 变量”的做法），不影响工具使用。
        "ANTHROPIC_AUTH_TOKEN": auth_token,
        "ANTHROPIC_API_KEY": auth_token,
        "ANTHROPIC_MODEL": default_model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": opus_model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": sonnet_model,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": haiku_model,
        "CLAUDE_CODE_SUBAGENT_MODEL": subagent_model,
    }
    if _should_disable_proxy_tls_verification(proxy_base_url):
        defaults["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
    changed = False
    for key, value in defaults.items():
        if key not in env_block:
            env_block[key] = value
            changed = True
        elif key == "ANTHROPIC_BASE_URL":
            if env_block[key] != value and _is_khy_proxy_base_url(env_block[key]):
                env_block[key] = value
                changed = True
        elif key in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
            # 两类凭据始终同步：已有值为空或 khy- 前缀（我们管理的）时强制更新，
            # 用户自配的非 khy- 值保留不动。
            existing_val = env_block[key]
            if existing_val != value and (not existing_val or existing_val.startswith("khy-")):
                env_block[key] = value
                changed = True
        elif key == "NODE_TLS_REJECT_UNAUTHORIZED":
            if env_block[key] != value:
                env_block[key] = value
                changed = True
    if (
        env_block.get("NODE_TLS_REJECT_UNAUTHORIZED") == "0"
        and not _should_disable_proxy_tls_verification(proxy_base_url)
    ):
        del env_block["NODE_TLS_REJECT_UNAUTHORIZED"]
        changed = True

    if not changed:
        return

    existing["env"] = env_block
    claude_dir.mkdir(parents=True, exist_ok=True)
    try:
        settings_file.write_text(
            _json.dumps(existing, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print("  [OK] Claude Code settings.json 已自动配置 KHY 代理")
    except OSError as e:
        print(f"  [WARN] 无法写入 Claude Code settings: {e}", file=sys.stderr)


def _maybe_configure_ide_gateway(backend_dir: Path):
    """自动检测本地 IDE 并配置网关 + Claude Code 代理设置。

    - 首次运行时检测 Kiro/Trae/Cursor 并写入 .env
    - 首次运行时配置 ~/.claude/settings.json 让 Claude Code 使用 KHY 代理
    - 写入标记文件后，后续启动完全短路（零 I/O 开销）
    """
    marker = backend_dir / _IDE_GATEWAY_MARKER_FILE

    # ── 快速路径：标记文件已存在 → 跳过所有检测和配置 ──
    if marker.exists():
        try:
            marker_content = marker.read_text(encoding="utf-8").strip().split("\n")[0]
            if marker_content in ("none", "kiro", "trae", "cursor", "exists"):
                return
        except OSError:
            pass

    env_file = backend_dir / ".env"

    # 配置 Claude Code settings（仅在明确开启时执行）
    _maybe_configure_claude_code_settings()

    if not _path_exists_safe(env_file):
        _write_marker(marker, "none")
        return

    content = env_file.read_text(encoding="utf-8", errors="replace")

    # 已有 GATEWAY_PREFERRED_ADAPTER 配置，跳过 .env 修改
    if "GATEWAY_PREFERRED_ADAPTER" in content:
        _write_marker(marker, "exists")
        return

    detected = _detect_local_ide()
    if not detected:
        _write_marker(marker, "none")
        return

    # 追加到 .env（非严格模式，检测到的 IDE 只是首选，其余通道照常级联）
    gateway_block = (
        "\n"
        f"# Auto-detected IDE: {detected} (by khy bootstrap)\n"
        f"GATEWAY_PREFERRED_ADAPTER={detected}\n"
        "GATEWAY_PREFERRED_STRICT=false\n"
    )
    try:
        with open(env_file, "a", encoding="utf-8") as f:
            f.write(gateway_block)
        print(f"  [OK] 检测到 {detected}，已配置为首选 AI 通道（其余通道照常可用）")
    except OSError as e:
        print(f"  [WARN] 无法写入 .env: {e}", file=sys.stderr)

    _write_marker(marker, detected)


def _ensure_npm_install(backend_dir: Path) -> bool:
    """确保 Node 依赖完整；缺失时自动执行 npm install。"""
    node_modules = backend_dir / "node_modules"
    shared_link = node_modules / "@khy" / "shared"
    include_optional_raw = str(os.environ.get("KHY_NPM_INCLUDE_OPTIONAL", "1")).strip().lower()
    include_optional = include_optional_raw not in {"0", "false", "no", "off"}

    # Core packages that must be present; optional packages checked separately
    # so their absence does NOT trigger a full npm install loop.
    core_packages = [node_modules / "express"]
    # @khy/shared uses file: dep → may be a symlink/junction; use safe check
    core_ok = (
        _path_exists_safe(node_modules)
        and _path_exists_safe(core_packages[0])
        and _path_exists_safe(shared_link)
    )

    if core_ok:
        print("  [OK] Node.js dependencies already installed")
        return True

    if _path_exists_safe(node_modules):
        try:
            has_any = any(node_modules.iterdir())
        except OSError:
            has_any = False
        if has_any:
            print("  [INFO] Some packages missing, reinstalling...")

    print("  Installing Node.js dependencies...")
    print("  [INFO] This may take a few minutes on first run.")
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    npm_args = [npm_cmd, "install", "--no-audit", "--no-fund"]
    if not include_optional:
        npm_args.append("--omit=optional")
        print("  [INFO] Using slim install mode (omit optional dependencies)")
    else:
        print("  [INFO] Installing optional dependencies (includes node-llama-cpp)")

    _configure_npm_registry(npm_cmd, backend_dir)

    try:
        returncode = _run_npm_streaming(npm_args, backend_dir, _NPM_TIMEOUT)
        if returncode == 0:
            # Verify @khy/shared link (file: deps need lock entry)
            if not _path_exists_safe(shared_link):
                lock = backend_dir / "package-lock.json"
                if lock.exists():
                    lock.unlink()
                _run_npm_streaming(npm_args, backend_dir, _NPM_TIMEOUT)
            if include_optional and not _has_llama_pkg(node_modules):
                print("  [INFO] node-llama-cpp missing after npm install, trying explicit install...")
                try:
                    fix_rc = _run_npm_streaming(
                        [npm_cmd, "install", "node-llama-cpp", "--no-audit", "--no-fund"],
                        backend_dir,
                        _NPM_TIMEOUT,
                    )
                    if fix_rc == 0 and _has_llama_pkg(node_modules):
                        print("  [OK] node-llama-cpp installed")
                    else:
                        print("  [WARN] node-llama-cpp install failed; local backend will fallback", file=sys.stderr)
                except Exception:
                    print("  [WARN] node-llama-cpp install failed; local backend will fallback", file=sys.stderr)
            print("  [OK] Node.js dependencies installed")
            return True
        else:
            print(
                "  [WARN] npm install exited with errors. "
                "You may need to run it manually:",
                file=sys.stderr,
            )
            print(f"    cd {backend_dir} && npm install", file=sys.stderr)
            return False
    except FileNotFoundError:
        print(
            f"  [WARN] '{npm_cmd}' not found. Install npm and run:",
            file=sys.stderr,
        )
        print(f"    cd {backend_dir} && npm install", file=sys.stderr)
        return False
    except subprocess.TimeoutExpired:
        timeout_min = _NPM_TIMEOUT // 60
        print(f"  [WARN] npm install timed out ({timeout_min} min)", file=sys.stderr)
        return False

    finally:
        # ── ai-frontend npm install + build (管理界面前端) ──
        # forest layout: ai-frontend lives at apps/ai-frontend, two levels above services/backend
        ai_frontend_dir = backend_dir.parent.parent / "apps" / "ai-frontend"
        if ai_frontend_dir.exists() and (ai_frontend_dir / "package.json").exists():
            nm = ai_frontend_dir / "node_modules"
            lock = nm / ".package-lock.json"
            npm_ok = _path_exists_safe(nm) and _path_exists_safe(lock)
            if not npm_ok:
                print("  Installing ai-frontend dependencies...")
                try:
                    af_result = subprocess.run(
                        [npm_cmd, "install", "--no-audit", "--no-fund"],
                        cwd=str(ai_frontend_dir),
                        timeout=_NPM_TIMEOUT,
                        **_subprocess_kwargs(),
                    )
                    if af_result.returncode == 0:
                        print("  [OK] ai-frontend dependencies installed")
                        npm_ok = True
                    else:
                        print("  [WARN] ai-frontend npm install failed, management UI may be unavailable", file=sys.stderr)
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    print("  [WARN] ai-frontend npm install skipped", file=sys.stderr)

            # Auto-build dist if node_modules is ready but dist is missing
            dist_dir = ai_frontend_dir / "dist"
            dist_index = dist_dir / "index.html"
            if npm_ok and not _path_exists_safe(dist_index):
                print("  Building ai-frontend (npm run build)...")
                try:
                    build_result = subprocess.run(
                        [npm_cmd, "run", "build"],
                        cwd=str(ai_frontend_dir),
                        timeout=_NPM_TIMEOUT,
                        **_subprocess_kwargs(),
                    )
                    if build_result.returncode == 0 and _path_exists_safe(dist_index):
                        print("  [OK] ai-frontend built successfully")
                    else:
                        print("  [WARN] ai-frontend build failed, management UI may need manual build", file=sys.stderr)
                        print(f"    cd {ai_frontend_dir} && npm run build", file=sys.stderr)
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    print("  [WARN] ai-frontend build skipped (timeout or npm not found)", file=sys.stderr)


def _maybe_build_ai_frontend(backend_dir: Path):
    """If ai-frontend has node_modules but no dist/index.html, run npm build once."""
    # forest layout: ai-frontend lives at apps/ai-frontend, two levels above services/backend
    ai_frontend_dir = backend_dir.parent.parent / "apps" / "ai-frontend"
    if not ai_frontend_dir.exists():
        return
    dist_index = ai_frontend_dir / "dist" / "index.html"
    if _path_exists_safe(dist_index):
        return  # already built
    nm = ai_frontend_dir / "node_modules"
    lock = nm / ".package-lock.json"
    if not (_path_exists_safe(nm) and _path_exists_safe(lock)):
        return  # no node_modules — handled by _ensure_npm_install on next bootstrap

    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    print("  Building ai-frontend (npm run build)...")
    try:
        result = subprocess.run(
            [npm_cmd, "run", "build"],
            cwd=str(ai_frontend_dir),
            timeout=_NPM_TIMEOUT,
            **_subprocess_kwargs(),
        )
        if result.returncode == 0 and _path_exists_safe(dist_index):
            print("  [OK] ai-frontend built successfully")
        else:
            print("  [WARN] ai-frontend build failed, run manually:", file=sys.stderr)
            print(f"    cd {ai_frontend_dir} && npm run build", file=sys.stderr)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        print("  [WARN] ai-frontend build skipped", file=sys.stderr)


def _is_port_available(port: int, host: str = "127.0.0.1") -> bool:
    """True if a TCP listener can bind ``port`` on ``host`` right now.

    Uses a throwaway socket bind (no SO_REUSEADDR) so a port currently held by
    another listener reads as unavailable — exactly the EADDRINUSE the Node
    backend would hit. Fail-soft: any unexpected error is treated as "available"
    so port probing never blocks startup.
    """
    import socket

    if not (0 < port <= 65535):
        return False
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
        return True
    except OSError:
        return False
    except Exception:
        return True
    finally:
        try:
            sock.close()
        except Exception:
            pass


def _find_available_port(preferred: int = 3000, host: str = "127.0.0.1") -> int:
    """Return a bindable TCP port, preferring ``preferred``.

    Avoids the manual ".env edit on port conflict" friction: if the preferred
    port is taken, scan a small contiguous range above it, then fall back to an
    OS-assigned ephemeral port. Fail-soft — returns ``preferred`` if probing is
    impossible, preserving prior behavior.
    """
    try:
        if _is_port_available(preferred, host):
            return preferred
        for candidate in range(preferred + 1, preferred + 100):
            if candidate > 65535:
                break
            if _is_port_available(candidate, host):
                return candidate
        # Last resort: let the OS pick a free ephemeral port.
        import socket

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind((host, 0))
            return int(sock.getsockname()[1])
        finally:
            try:
                sock.close()
            except Exception:
                pass
    except Exception:
        return preferred


def _ensure_env_file(backend_dir: Path):
    """如不存在则自动生成 .env（含随机密钥）。"""
    env_file = backend_dir / ".env"
    if env_file.exists():
        print("  [OK] .env configuration exists")
        return

    print("  Generating .env configuration...")
    # 生成 64 位十六进制 JWT 密钥（安全随机）
    jwt_secret = secrets.token_hex(32)

    # 端口动态发现：避免 3000 被占用时首次启动直接 EADDRINUSE，逼用户手改 .env。
    port = _find_available_port(3000)
    if port != 3000:
        print(f"  [INFO] Port 3000 is in use; selected free port {port} instead.")

    content = (
        "# khy OS Environment Configuration\n"
        "# Generated by khy-os bootstrap\n"
        "\n"
        "# Database (sqlite = zero config, postgres = production)\n"
        "DB_TYPE=sqlite\n"
        "\n"
        "# Server\n"
        f"PORT={port}\n"
        "NODE_ENV=development\n"
        "LOG_LEVEL=info\n"
        "\n"
        "# Authentication\n"
        f"JWT_SECRET={jwt_secret}\n"
        "JWT_EXPIRES_IN=7d\n"
        "\n"
        "# Data Sources\n"
        "ENABLE_AKSHARE=true\n"
        "ENABLE_TUSHARE=false\n"
        "DEFAULT_DATA_SOURCE=reliable\n"
        "\n"
        "# AI Gateway (SenseNova built-in, works out of the box)\n"
        "GATEWAY_API_POOL_PROVIDER=sensenova\n"
        'GATEWAY_API_POOL_SERVICE_MAP={"sensenova":"openai"}\n'
        'GATEWAY_API_POOL_DEFAULT_MODEL_MAP={"sensenova":"sensenova-6.7-flash-lite"}\n'
        "\n"
        "# AI Providers (fill in the ones you have)\n"
        "# GEMINI_API_KEY=\n"
        "# GROQ_API_KEY=\n"
        "# OPENROUTER_API_KEY=\n"
        "# ZHIPU_API_KEY=\n"
    )

    env_file.write_text(content)

    # Unix 下限制权限，避免其他用户读取密钥
    if os.name != "nt":
        try:
            os.chmod(str(env_file), 0o600)
        except OSError:
            pass

    print("  [OK] .env generated (secrets auto-generated)")


def _ensure_db_init(backend_dir: Path, node_cmd: str) -> bool:
    """执行 seed 脚本，初始化数据库默认表和基础数据。"""
    seed_script = backend_dir / "scripts" / "seed.js"
    if not seed_script.exists():
        return False

    print("  Initializing database...")
    try:
        result = subprocess.run(
            [node_cmd, str(seed_script)],
            cwd=str(backend_dir),
            env=_node_env(backend_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            **_subprocess_kwargs(),
        )
        combined = f"{result.stdout or ''}\n{result.stderr or ''}"
        normalized = combined.lower()

        # seed.js 在异常时可能仍返回 0；优先基于输出关键字判断是否真正完成
        if "seed completed" in normalized and "seed warning" not in normalized:
            print("  [OK] Database initialized")
            return True

        if result.returncode == 0 and "seed warning" not in normalized:
            print("  [OK] Database initialized")
            return True

        print("  [WARN] Database seed did not confirm success", file=sys.stderr)
        return False
    except subprocess.TimeoutExpired:
        print("  [WARN] Database initialization timed out", file=sys.stderr)
        return False
    except Exception as e:
        print(f"  [WARN] Database initialization error: {e}", file=sys.stderr)
        return False


def _generate_getting_started(backend_dir: Path, node_cmd: str):
    """调用 Node 服务生成 GETTING_STARTED.md（失败可忽略）。"""
    try:
        subprocess.run(
            [node_cmd, "-e",
             "require('./src/services/gettingStartedService').generateGettingStarted()"],
            cwd=str(backend_dir),
            env=_node_env(backend_dir),
            capture_output=True, timeout=15,
            **_subprocess_kwargs(),
        )
    except Exception:
        pass  # 非关键流程，失败不影响主功能


def _register_app(backend_dir: Path):
    """把 khyquant 注册到底座应用注册表，便于主 CLI 动态发现并启动。

    遵循生态标准（app_protocol）：清单写入底座归属的 ``~/.khyos/apps/khyquant.json``，
    同时保留历史位置 ``~/.khyquant/apps/khyquant.json`` 以兼容旧版发现逻辑。
    任何写入失败都不阻断 CLI bootstrap。
    """
    import json

    # 读取版本号（用于 app 清单展示）
    version = "0.0.0"
    pkg_json = backend_dir / "package.json"
    try:
        if pkg_json.exists():
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
            version = pkg.get("version", version)
    except Exception:
        pass

    server_js = str(backend_dir / "server.js")

    manifest = {
        "name": "khyquant",
        "version": version,
        "description": "量化交易系统",
        "entry": server_js,
        "port": 3000,
        "frontendPort": 8080,
        "source": "registry",
        "commands": ["khyquant", "quant"],
        "autoStart": False,
        "installedAt": __import__("datetime").datetime.now().isoformat(),
    }

    # 首选：经生态标准写入底座注册表 ~/.khyos/apps/。
    wrote_base = False
    try:
        from khy_platform import app_protocol as _ap

        target = _ap.write_manifest(_ap.AppManifest.from_dict(manifest), to_base=True)
        if target is not None:
            wrote_base = True
            print("  [OK] khyquant registered in khyos app registry")
    except Exception:
        # 标准模块缺失或异常时退回历史路径，绝不因注册失败中断 bootstrap。
        pass

    # 兼容：保留历史 ~/.khyquant/apps/ 写入，供旧版发现读取。
    # Portable installs redirect this write to <root>/.khy/apps so no khy data
    # lands on the system drive (app_protocol._registry_dirs reads it back).
    try:
        from khy_platform import portable as _portable

        portable_home = _portable.get_portable_data_home()
        if portable_home is not None:
            legacy_dir = portable_home / "apps"
        else:
            legacy_dir = Path(os.path.expanduser("~")) / ".khyquant" / "apps"
        legacy_dir.mkdir(parents=True, exist_ok=True)
        (legacy_dir / "khyquant.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False)
        )
        if not wrote_base:
            print("  [OK] khyquant registered in app registry")
    except OSError as e:
        # Non-fatal: registry write issues should not block CLI bootstrap.
        print(f"  [WARN] Failed to register app manifest: {e}", file=sys.stderr)
