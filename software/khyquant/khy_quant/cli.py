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
import json
import os
import subprocess
import sys
from pathlib import Path


def get_bundle_dir() -> Path:
    """Return the path to the backend/ directory."""
    # 0. Portable mode: env explicitly specifies project root
    portable_root = os.environ.get("KHYQUANT_PORTABLE_ROOT")
    if portable_root:
        portable_backend = Path(portable_root) / "services" / "backend"
        if portable_backend.exists():
            return portable_backend

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
    """Check Node.js is installed and >= 20."""
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
                if major >= 20:
                    return cmd
                print(f"Error: Node.js v{version} found but >= 20 required.", file=sys.stderr)
                sys.exit(1)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    print("Error: Node.js >= 20 not found.", file=sys.stderr)
    print("  Install from: https://nodejs.org/", file=sys.stderr)
    sys.exit(1)


def _print_sqlite_driver_diag(node: str, backend_dir: Path) -> None:
    """Print the active SQLite driver type (best-effort, never blocks startup)."""
    try:
        root = backend_dir.parent.parent
        candidates = (
            root / "platform" / "packages" / "shared" / "src" / "config" / "sqlite-adapter.js",
            backend_dir / "node_modules" / "@khy" / "shared" / "src" / "config" / "sqlite-adapter.js",
            backend_dir / "vendor" / "shared" / "src" / "config" / "sqlite-adapter.js",
            backend_dir / "src" / "config" / "sqlite-adapter.js",
        )
        adapter = next((p for p in candidates if p.exists()), None)
        if adapter is None:
            return
        adapter_path = str(adapter.resolve()).replace("\\", "/")
        script = (
            "try{const a=require(" + json.dumps(adapter_path) + ");"
            "console.log(a.__driverInfo.type)}catch(e){console.log('unavailable')}"
        )
        result = subprocess.run(
            [node, "-e", script],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=5,
        )
        driver = (result.stdout or "").strip()
        if result.returncode == 0 and driver:
            print(f"SQLite driver: {driver}")
    except Exception:
        pass  # diagnostics only -- never block startup


def _detect_mode() -> str:
    """鎰熺煡褰撳墠杩愯妯″紡锛歚`eco``锛堟帴鍏?khyos 搴曞骇锛夋垨 ``standalone``锛堢嫭绔嬭繍琛岋級銆?
    鍒ゅ畾浼樺厛绾э細
    1. 鏄惧紡鐜鍙橀噺 ``KHYOS_ECO_MODE``锛?/true/eco 鈫?鐢熸€侊紱0/false 鈫?鐙珛锛夈€?    2. 鑳藉惁 import khyos 鐢熸€佹爣鍑嗘ā鍧楋紙khy_platform.app_protocol锛夆€斺€旇兘鍒欒涓虹敓鎬佸彲鐢ㄣ€?    3. 榛樿鐙珛妯″紡锛堟彁渚涢檷绾т綋楠岋紝缁濅笉鍥犵己灏戝簳搴ц€屾棤娉曞惎鍔級銆?    """
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
    """纭繚搴旂敤鐙珛 home ``~/.khyquant/{data,cache,models,logs}`` 瀛樺湪銆?
    浼樺厛澶嶇敤搴曞骇鐢熸€佹爣鍑嗭紙app_protocol锛夌殑璺緞瀹氫箟锛屼繚璇佷笌搴曞骇鐨勯殧绂荤害瀹氫竴鑷达紱
    搴曞骇涓嶅彲鐢ㄦ椂閫€鍥炴湰鍦扮瓑浠峰疄鐜般€備换浣曞け璐ラ兘涓嶆姏锛岄伩鍏嶉樆鏂惎鍔ㄣ€?    """
    # Portable mode: use local data directory specified by env
    portable_data = os.environ.get("KHYQUANT_DATA_HOME")
    if portable_data:
        home = Path(portable_data)
        try:
            for sub in ("data", "cache", "models", "logs"):
                (home / sub).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        return home

    # (existing logic unchanged below)
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
    _print_sqlite_driver_diag(node, backend_dir)

    # 鍙屾ā鑷€傚簲锛氬厛鎰熺煡妯″紡锛屽啀鎹鍒濆鍖栧悇鑷殑杩愯鐜銆?    mode = _detect_mode()
    app_home_dir = _ensure_app_home()  # 鐙珛/鐢熸€侀兘闇€淇濊瘉搴旂敤鏁版嵁涓绘潈鐩綍灏变綅

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
    # 鎶婅繍琛屾ā寮忎笌鏁版嵁涓绘潈鐩綍涓嬩紶缁?Node 鍚庣锛屼緵鍏跺垏鎹㈠垵濮嬪寲涓庤矾寰勯殧绂婚€昏緫銆?    env["KHYQUANT_MODE"] = mode
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

if __name__ == "__main__":
    main()
