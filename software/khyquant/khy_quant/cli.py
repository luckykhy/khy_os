# @pattern Command
"""
KHY-Quant CLI entry point.

Locates the Node.js backend, runs first-time bootstrap if needed,
then hands control to the Node CLI (bin/khy.js).

Backend resolution order:
  1. khy_quant/bundled/backend/   (pip install khy-quant)
  2. khy-quant-backend package    (standalone backend package)
  3. khy_os/bundled/backend/      (pip install khy-os)
  4. ../../services/backend/      (source development mode)
"""
import os
import subprocess
import sys
from pathlib import Path


def get_bundle_dir() -> Path:
    """Return the path to the backend/ directory."""
    # 1. pip-installed khy-quant: bundled/backend/
    bundled = Path(__file__).parent / "bundled" / "backend"
    if bundled.exists():
        return bundled

    # 2. Standalone backend package
    try:
        from khy_quant_backend.cli import get_bundle_dir as _backend_get
        return _backend_get()
    except ImportError:
        pass

    # 3. khy-os full package
    try:
        from khy_platform.cli import get_bundle_dir as _platform_get
        return _platform_get()
    except ImportError:
        pass

    # 4. Source development mode
    dev = Path(__file__).resolve().parent.parent.parent.parent / "services" / "backend"
    if dev.exists():
        return dev

    print("Error: Cannot locate KHY-Quant backend directory.", file=sys.stderr)
    print("  If installed via pip, the package may be corrupted.", file=sys.stderr)
    print("  Try: pip install --force-reinstall khy-quant", file=sys.stderr)
    sys.exit(1)


def check_node() -> str:
    """Check Node.js is installed and >= 18."""
    for cmd in ("node", "node.exe"):
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=10,
            )
            if result.returncode == 0:
                version = result.stdout.strip().lstrip("v")
                major = int(version.split(".")[0])
                if major >= 18:
                    return cmd
                print(f"Error: Node.js v{version} found but >= 18 required.", file=sys.stderr)
                sys.exit(1)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    print("Error: Node.js >= 18 not found.", file=sys.stderr)
    print("  Install from: https://nodejs.org/", file=sys.stderr)
    sys.exit(1)


def _detect_mode() -> str:
    """感知当前运行模式：``eco``（接入 khyos 底座）或 ``standalone``（独立运行）。

    判定优先级：
    1. 显式环境变量 ``KHYOS_ECO_MODE``（1/true/eco → 生态；0/false → 独立）。
    2. 能否 import khyos 生态标准模块（khy_platform.app_protocol）——能则视为生态可用。
    3. 默认独立模式（提供降级体验，绝不因缺少底座而无法启动）。
    """
    flag = os.environ.get("KHYOS_ECO_MODE", "").strip().lower()
    if flag in {"1", "true", "eco", "yes"}:
        return "eco"
    if flag in {"0", "false", "standalone", "no"}:
        return "standalone"
    try:
        import importlib.util
        if importlib.util.find_spec("khy_platform.app_protocol") is not None:
            return "eco"
    except Exception:
        pass
    return "standalone"


def _ensure_app_home() -> "Path":
    """确保应用独立 home ``~/.khyquant/{data,cache,models,logs}`` 存在。

    优先复用底座生态标准（app_protocol）的路径定义，保证与底座的隔离约定一致；
    底座不可用时退回本地等价实现。任何失败都不抛，避免阻断启动。
    """
    try:
        from khy_platform.app_protocol import app_home, ensure_home
        return ensure_home(app_home("khyquant"))
    except Exception:
        home = Path(os.path.expanduser("~")) / ".khyquant"
        try:
            for sub in ("data", "cache", "models", "logs"):
                (home / sub).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        return home


def main():
    """Console entry point (pyproject.toml console_scripts)."""
    node = check_node()
    backend_dir = get_bundle_dir()

    # 双模自适应：先感知模式，再据此初始化各自的运行环境。
    mode = _detect_mode()
    app_home_dir = _ensure_app_home()  # 独立/生态都需保证应用数据主权目录就位

    # Bootstrap on first run
    from khy_quant._bootstrap import ensure_bootstrapped
    ensure_bootstrapped(backend_dir, node)

    cli_script = backend_dir / "bin" / "khy.js"
    if not cli_script.exists():
        print(f"Error: CLI script not found at {cli_script}", file=sys.stderr)
        sys.exit(1)

    args = [node, str(cli_script)] + sys.argv[1:]
    env = os.environ.copy()
    env["KHYQUANT_ROOT"] = str(backend_dir)
    env["KHYQUANT_PKG_VERSION"] = __import__("khy_quant").__version__
    env["KHYQUANT_INVOKED_AS"] = "khyquant"
    # 把运行模式与数据主权目录下传给 Node 后端，供其切换初始化与路径隔离逻辑。
    env["KHYQUANT_MODE"] = mode
    env["KHYQUANT_HOME"] = str(app_home_dir)

    # Fix @khy/shared module resolution
    node_modules_dir = str(backend_dir / "node_modules")
    existing_node_path = env.get("NODE_PATH", "")
    env["NODE_PATH"] = (
        f"{node_modules_dir}{os.pathsep}{existing_node_path}"
        if existing_node_path
        else node_modules_dir
    )

    if os.name == "nt":
        result = subprocess.run(args, env=env)
        sys.exit(result.returncode)
    else:
        os.execvpe(node, args, env)
