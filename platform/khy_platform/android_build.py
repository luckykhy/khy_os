# @pattern Template Method, Facade
"""``khy build android`` - zero-config Capacitor APK build orchestrator.

真源规范：docs/06_DEPLOY_部署/[DEPLOY-MAN-018] khyos-Android构建避坑指南.md

Why this exists
---------------
Building an Android APK normally means: install a JDK, download a 2-3 GB SDK,
click through licence dialogs, hand-edit ``local.properties``, then remember the
exact gradle task. Every one of those steps is a place where a new user gives
up. This module collapses all of it into ``khy build android``.

The eight steps are deliberately **serial and deterministic** (Template Method):

  1. locate the Capacitor project (source checkout or bundled payload)
  2. JDK precheck             - 没有 JDK 就绝不启动 gradle，直接给可执行指引
  3. Windows long-path probe  - 只读探测，无管理员权限时降级为提示
  4. SDK self-management      - 缺什么装什么，装到 ``~/.khyos/android_sdk``
  5. rewrite local.properties - 把 ``sdk.dir`` 指向托管 SDK（零手动配置的关键）
  6. web build                - npm install / vite build / cap sync android
  7. gradle assemble          - ``gradlew assembleDebug|assembleRelease``
  8. collect the APK          - 复制到 ``./dist/android``

Hard contracts
--------------
* **Only stdlib.** ``urllib`` / ``zipfile`` / ``shutil`` / ``subprocess`` - the
  launcher must work before any dependency is installed.
* **Python 3.8 floor** (``pyproject.toml`` ``requires-python``), hence
  ``from __future__ import annotations`` for builtin generics.
* **Fail-soft.** Every public function returns a status; failures print a
  human-readable ``[Action Required]`` block instead of a gradle/npm stack.
* **Never ship the SDK.** Multi-GB payloads are downloaded on demand into the
  user's own home ([DEPLOY-MAN-018] 第五节).
* **Never shadow the kernel.** This module is reached only from the narrow
  ``android`` branch in ``cli.py``; ``os build`` / ``iso build`` are untouched.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Optional, Sequence

# -- 版本锁 -------------------------------------------------------------------
# 真源是 pyproject.toml 的 [tool.khyos.android]（[DEPLOY-MAN-018] 第 2.1 节）。
# 这里的字典只是**装进 wheel 后的兜底**：pip 安装后仓库的 pyproject.toml 并不
# 随包分发，读不到时必须还能构建。两处值必须一致，改一处就改另一处。
_DEFAULT_LOCK = {
    "compile_sdk": "36",
    "build_tools": "35.0.0",
    "cmdline_tools": "13114758",
    "ndk": "",  # WebView + JS 不需要原生代码，默认不装 NDK（省 1GB+）
}

# commandlinetools 分发根。官方 + 国内镜像，按网络环境轮换。
_GOOGLE_DIST = "https://dl.google.com/android/repository/"
_TENCENT_DIST = "https://mirrors.cloud.tencent.com/AndroidSDK/"

_TOTAL_STEPS = 8
_APK_SEARCH_DIRS = ("debug", "release")


# -- 输出：动作 + 目标 + 进度（工程红线 2）-------------------------------------
def _step(index: int, action: str, target: str, progress: str) -> None:
    """打印一行阶段状态。禁止「正在工作…」这类无信息量文案。"""
    print("[{0}/{1}] {2} · {3} · {4}".format(index, _TOTAL_STEPS, action, target, progress))


def _info(text: str) -> None:
    print("      " + text)


def _fail(action: str, target: str, reason: str) -> None:
    print("[FAIL] {0} · {1} · {2}".format(action, target, reason), file=sys.stderr)


def _action_required(title: str, lines: Sequence[str]) -> None:
    """人可执行的指引块。永远不要把 gradle/npm 的原始栈直接甩给用户。"""
    print("")
    print("[Action Required] " + title)
    for line in lines:
        print("  " + line)
    print("")


# -- 子进程 -------------------------------------------------------------------
def _subprocess_kwargs() -> dict:
    """平台化的 subprocess 参数（Windows 隐藏控制台窗口）。"""
    kwargs = {}  # type: dict
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0  # SW_HIDE
        kwargs["startupinfo"] = si
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kwargs


def _run(cmd: Sequence[str], cwd: Optional[Path] = None, verbose: bool = False,
         stdin_text: Optional[str] = None) -> int:
    """执行子进程。

    刻意**不设固定超时**（工程红线 3）：gradle 首次下载依赖可能十几分钟，硬超时
    会在最不该失败的时候失败。verbose 时直接透传输出，否则只在失败时回放尾部，
    避免刷屏又不丢线索。
    """
    kwargs = _subprocess_kwargs()
    payload = stdin_text.encode("utf-8") if stdin_text else None
    try:
        if verbose:
            proc = subprocess.run(
                list(cmd), cwd=str(cwd) if cwd else None, input=payload, **kwargs
            )
            return int(proc.returncode)
        proc = subprocess.run(
            list(cmd), cwd=str(cwd) if cwd else None, input=payload,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs
        )
        if proc.returncode != 0:
            text = (proc.stdout or b"").decode("utf-8", "replace")
            for line in [ln for ln in text.splitlines() if ln.strip()][-30:]:
                print("      | " + line, file=sys.stderr)
        return int(proc.returncode)
    except FileNotFoundError:
        _fail("执行", cmd[0] if cmd else "命令", "可执行文件不存在")
        return 127
    except Exception as exc:  # noqa: BLE001 - 编排层必须 fail-soft
        _fail("执行", cmd[0] if cmd else "命令", str(exc))
        return 1


# -- 版本锁读取 ---------------------------------------------------------------
def _repo_root() -> Path:
    """源码仓库根目录（``platform/khy_platform/`` 往上两级）。"""
    return Path(__file__).resolve().parent.parent.parent


def _parse_android_table(text: str) -> dict:
    """从 pyproject 文本里抠出 ``[tool.khyos.android]`` 表。

    为什么不直接用 ``tomllib``：它是 Python 3.11 才有的，而本仓 ``requires-python``
    是 >=3.8。这张表只有「键 = 字符串」一种形态，正则足够且不引入依赖；
    3.11+ 上仍优先走 ``tomllib``，正则只是低版本兜底。
    """
    out = {}
    section = re.search(r"^\[tool\.khyos\.android\]\s*$", text, re.M)
    if not section:
        return out
    tail = text[section.end():]
    nxt = re.search(r"^\[", tail, re.M)
    body = tail[: nxt.start()] if nxt else tail
    # 行尾允许 # 注释——真源表里每个键后面都跟着说明，漏掉这段会静默解析失败、
    # 悄悄退回内置兜底，而版本锁漂移正是这类静默回退最难查的后果。
    pattern = r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*(?:#.*)?$'
    for key, value in re.findall(pattern, body, re.M):
        out[key] = value
    return out


def _lock() -> dict:
    """有效版本锁：内置兜底 -> pyproject 覆盖 -> ``KHY_ANDROID_<KEY>`` 覆盖。

    环境变量优先级最高，便于临时试别的 build-tools 而不动仓库文件，例如
    ``KHY_ANDROID_BUILD_TOOLS=34.0.0 khy build android``。
    """
    lock = dict(_DEFAULT_LOCK)
    pyproject = _repo_root() / "pyproject.toml"
    if pyproject.exists():
        try:
            text = pyproject.read_text(encoding="utf-8")
            table = {}
            try:
                import tomllib  # type: ignore[import-not-found]  # Python 3.11+

                table = tomllib.loads(text).get("tool", {}).get("khyos", {}).get("android", {})
            except Exception:
                table = _parse_android_table(text)
            for key, value in (table or {}).items():
                if isinstance(value, str):
                    lock[key] = value
        except Exception:
            pass  # 版本锁读不到不该阻断构建，退回内置兜底
    for key in list(lock.keys()):
        env = os.environ.get("KHY_ANDROID_" + key.upper())
        if env is not None and env.strip():
            lock[key] = env.strip()
    return lock


# -- 参数解析 -----------------------------------------------------------------
_USAGE = """用法: khy build android [选项]

选项:
  -r, --release      构建 release 变体（默认 debug）
      --debug        显式指定 debug 变体（默认值）
  -o, --output DIR   APK 输出目录（默认 ./dist/android）
      --skip-web     跳过 npm install / vite build / cap sync（复用已有 dist/）
      --skip-sdk     跳过 SDK 自管理（已自行配置好 SDK 时使用）
  -v, --verbose      透传 npm / gradle 的完整输出，便于排查
  -h, --help         显示本帮助
"""


def _parse_args(argv: Sequence[str]) -> Optional[dict]:
    """解析 flags。返回 None 表示参数非法（调用方应退出 2）。"""
    opts = {
        "release": False,
        "output": None,
        "skip_web": False,
        "skip_sdk": False,
        "verbose": False,
        "help": False,
    }
    items = list(argv or [])
    i = 0
    while i < len(items):
        arg = str(items[i]).strip()
        if arg in ("-h", "--help"):
            opts["help"] = True
        elif arg in ("-r", "--release"):
            opts["release"] = True
        elif arg == "--debug":
            opts["release"] = False
        elif arg in ("-v", "--verbose"):
            opts["verbose"] = True
        elif arg == "--skip-web":
            opts["skip_web"] = True
        elif arg == "--skip-sdk":
            opts["skip_sdk"] = True
        elif arg.startswith("--output="):
            opts["output"] = arg[len("--output="):].strip()
        elif arg in ("-o", "--output"):
            if i + 1 >= len(items):
                _fail("解析", "命令行参数", "{0} 缺少目录参数".format(arg))
                return None
            i += 1
            opts["output"] = str(items[i]).strip()
        else:
            _fail("解析", "命令行参数", "无法识别的选项 {0}".format(arg))
            return None
        i += 1
    return opts


# -- 步骤 1：定位 Capacitor 工程 ----------------------------------------------
def _project_candidates() -> list:
    """Capacitor 工程候选路径，按可信度排序。"""
    package_dir = Path(__file__).resolve().parent
    cwd = Path.cwd()
    candidates = []
    override = os.environ.get("KHY_ANDROID_PROJECT", "").strip()
    if override:
        candidates.append(Path(override).expanduser())
    candidates.extend([
        _repo_root() / "apps" / "khy-mobile",                       # 源码检出
        package_dir / "bundled" / "khy-mobile",                     # 标准 wheel 载荷
        package_dir.parent / "khy_os" / "bundled" / "khy-mobile",   # 旧版 wheel 布局
        cwd / "apps" / "khy-mobile",                                # 在别处的仓库根执行
        cwd,                                                        # 直接在工程目录里执行
    ])
    return candidates


def _is_capacitor_project(path: Path) -> bool:
    """判定依据是 capacitor 配置文件，而不是目录名 - 目录可以被搬走或改名。"""
    try:
        if not path.is_dir():
            return False
    except Exception:
        return False
    for name in ("capacitor.config.ts", "capacitor.config.js", "capacitor.config.json"):
        if (path / name).exists():
            return True
    return False


def _find_project() -> Optional[Path]:
    for candidate in _project_candidates():
        try:
            if _is_capacitor_project(candidate):
                return candidate.resolve()
        except Exception:
            continue
    return None


# -- 步骤 2：JDK 预检 ----------------------------------------------------------
_JDK_HINTS = (
    "Windows：winget install Microsoft.OpenJDK.17（或到 https://adoptium.net 下载 Temurin 17+）",
    "macOS  ：brew install --cask temurin",
    "Linux  ：sudo apt install openjdk-17-jdk",
    "装好后重开终端，确认 `java -version` 可用，再重跑 `khy build android`。",
)


def _java_major(java: str) -> Optional[int]:
    """从 ``java -version`` 解析主版本号。解析不出来返回 None（不阻断构建）。"""
    try:
        proc = subprocess.run(
            [java, "-version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            **_subprocess_kwargs()
        )
        text = (proc.stdout or b"").decode("utf-8", "replace")
    except Exception:
        return None
    match = re.search(r'version\s+"(\d+)(?:\.(\d+))?', text)
    if not match:
        return None
    major = int(match.group(1))
    # 1.8.x 这种老式版本号，真正的主版本在第二段。
    if major == 1 and match.group(2):
        major = int(match.group(2))
    return major


def _check_jdk() -> Optional[str]:
    """返回 java 可执行文件路径；缺失或版本过低则打印指引并返回 None。"""
    java = shutil.which("java")
    if not java:
        _action_required("未检测到 Java JDK - Android 构建的硬性前置依赖", _JDK_HINTS)
        return None
    major = _java_major(java)
    if major is not None and major < 17:
        _action_required(
            "Java 版本过低（检测到 {0}，Android Gradle Plugin 需要 17 及以上）".format(major),
            _JDK_HINTS,
        )
        return None
    # JAVA_HOME 不是必需的：gradlew 会用 PATH 上的 java。只有当能可靠反推出 JDK
    # 根目录（含 bin/javac）时才补，避免被 Windows 的 javapath 垫片误导。
    if not os.environ.get("JAVA_HOME", "").strip():
        home = Path(java).resolve().parent.parent
        javac = home / "bin" / ("javac.exe" if os.name == "nt" else "javac")
        if javac.exists():
            os.environ["JAVA_HOME"] = str(home)
    return java


# -- 步骤 3：Windows 长路径探测（只读，不改注册表）-----------------------------
def _probe_long_path() -> None:
    """只读探测 LongPathsEnabled。

    刻意**不**去写 HKLM：那需要管理员且是全局系统改动，对一次 APK 构建来说代价
    过大。托管 SDK 落在 ``~/.khyos/android_sdk``（路径很短），正常不会撞 260 字符
    上限；真撞上了，提示比偷偷改注册表更负责。
    """
    if os.name != "nt":
        return
    try:
        proc = subprocess.run(
            ["reg", "query", r"HKLM\SYSTEM\CurrentControlSet\Control\FileSystem",
             "/v", "LongPathsEnabled"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **_subprocess_kwargs()
        )
        text = (proc.stdout or b"").decode("utf-8", "replace")
    except Exception:
        return
    if re.search(r"0x1\b", text):
        return
    _info("提示：系统未启用长路径支持。托管 SDK 路径很短，通常不受影响；")
    _info("      若 gradle 报「文件名过长」，以管理员身份启用 LongPathsEnabled 后重试。")


# -- 步骤 4：SDK 自管理 --------------------------------------------------------
def sdk_root() -> Path:
    """托管 SDK 根目录。

    归属遵守生态路径红线：底座（khyos）只写 ``~/.khyos``，不碰应用目录。用户
    显式设置了 ``ANDROID_SDK_ROOT`` / ``ANDROID_HOME`` 时尊重其选择。
    """
    for key in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
        value = os.environ.get(key, "").strip()
        if value:
            return Path(value).expanduser()
    from khy_platform import app_protocol

    return app_protocol.base_home() / "android_sdk"


def _sdkmanager(root: Path) -> Optional[Path]:
    """定位 sdkmanager。``cmdline-tools/latest`` 是官方要求的规范布局。"""
    name = "sdkmanager.bat" if os.name == "nt" else "sdkmanager"
    for sub in ("latest", "cmdline-tools"):
        candidate = root / "cmdline-tools" / sub / "bin" / name
        if candidate.exists():
            return candidate
    return None


def _cmdline_tools_asset(revision: str) -> str:
    if sys.platform.startswith("win"):
        tag = "win"
    elif sys.platform == "darwin":
        tag = "mac"
    else:
        tag = "linux"
    return "commandlinetools-{0}-{1}_latest.zip".format(tag, revision)


def _mirror_bases() -> list:
    """分发根偏好顺序。国内网络优先镜像，避免长时间卡住。"""
    try:
        from khy_platform._bootstrap import _is_china_network

        china = _is_china_network()
    except Exception:
        china = True  # 镜像优先在全球都可用，卡住的代价更大
    return [_TENCENT_DIST, _GOOGLE_DIST] if china else [_GOOGLE_DIST, _TENCENT_DIST]


def _download(url: str, dest: Path) -> bool:
    """带断点续传的下载。服务端支持 Range 时从已下载字节继续，失败不抛。"""
    headers = {"User-Agent": "khy-os-android-build"}
    offset = dest.stat().st_size if dest.exists() else 0
    if offset:
        headers["Range"] = "bytes={0}-".format(offset)
    total = 0
    try:
        req = urllib.request.Request(url, headers=headers)
        # timeout 是**读空闲**超时而非总时长上限：有数据就一直下（工程红线 3）。
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - 构造上只有 https
            status = getattr(resp, "status", None) or resp.getcode()
            resuming = offset > 0 and status == 206
            done = offset if resuming else 0
            total = int(resp.headers.get("Content-Length", 0) or 0) + done
            with open(dest, "ab" if resuming else "wb") as fh:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        sys.stdout.write("\r      下载 · commandline-tools · {0}%".format(
                            min(100, int(done * 100 / total))))
                        sys.stdout.flush()
        if total:
            sys.stdout.write("\r      下载 · commandline-tools · 100%\n")
            sys.stdout.flush()
        return True
    except Exception:
        if total:
            sys.stdout.write("\n")
        return False


def _is_within(base: Path, target: Path) -> bool:
    """target 是否落在 base 内（路径穿越防护）。"""
    try:
        base_r = base.resolve()
        target_r = target.resolve()
        return base_r == target_r or base_r in target_r.parents
    except Exception:
        return False


def _safe_extract_zip(archive: Path, dest: Path) -> bool:
    """解压 zip，拒绝任何逃逸出 dest 的成员（CVE-2007-4559 类路径穿越）。"""
    try:
        with zipfile.ZipFile(archive) as zf:
            for name in zf.namelist():
                if not _is_within(dest, dest / name):
                    return False
            zf.extractall(dest)
        return True
    except Exception:
        return False


def _install_cmdline_tools(root: Path, revision: str) -> bool:
    """下载并铺开 commandline-tools 到 ``<sdk>/cmdline-tools/latest``。"""
    asset = _cmdline_tools_asset(revision)
    tmp = Path(tempfile.mkdtemp(prefix="khy-android-"))
    archive = tmp / asset
    try:
        downloaded = False
        for base in _mirror_bases():
            _info("源 · " + base)
            if _download(base + asset, archive):
                downloaded = True
                break
            _info("该源不可用，切换下一个镜像")
        if not downloaded:
            return False

        extract_dir = tmp / "unpacked"
        if not _safe_extract_zip(archive, extract_dir):
            return False
        src = extract_dir / "cmdline-tools"
        if not src.is_dir():
            return False

        target = root / "cmdline-tools" / "latest"
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(str(target), ignore_errors=True)
        shutil.move(str(src), str(target))
        if os.name != "nt":
            # zip 里丢执行位是常态，补回来，否则 sdkmanager 直接 Permission denied。
            for item in (target / "bin").glob("*"):
                try:
                    item.chmod(0o755)
                except Exception:
                    pass
        return True
    except Exception:
        return False
    finally:
        shutil.rmtree(str(tmp), ignore_errors=True)


def _missing_packages(root: Path, lock: dict) -> list:
    """列出托管 SDK 里缺的组件，只装缺的（避免每次构建都跑一遍 sdkmanager）。"""
    missing = []
    if not (root / "platform-tools").is_dir():
        missing.append("platform-tools")
    if not (root / "platforms" / ("android-" + lock["compile_sdk"])).is_dir():
        missing.append("platforms;android-" + lock["compile_sdk"])
    if not (root / "build-tools" / lock["build_tools"]).is_dir():
        missing.append("build-tools;" + lock["build_tools"])
    ndk = str(lock.get("ndk", "")).strip()
    if ndk and not (root / "ndk" / ndk).is_dir():
        missing.append("ndk;" + ndk)
    return missing


def _ensure_sdk(lock: dict, verbose: bool) -> Optional[Path]:
    """保证托管 SDK 可用，返回 SDK 根目录；失败返回 None。"""
    root = sdk_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        _fail("准备", "Android SDK", "无法创建 {0}：{1}".format(root, exc))
        return None

    manager = _sdkmanager(root)
    if manager is None:
        _info("首次构建：下载 Android commandline-tools（约 150 MB，支持断点续传）")
        if not _install_cmdline_tools(root, lock["cmdline_tools"]):
            _action_required("Android commandline-tools 下载失败", [
                "所有镜像均不可达，通常是网络受限。可尝试：",
                "1) 配置代理后重试：HTTPS_PROXY=http://<代理地址> khy build android",
                "2) 手动下载 {0}".format(_cmdline_tools_asset(lock["cmdline_tools"])),
                "   解压后把内层 cmdline-tools 目录放到 {0}".format(root / "cmdline-tools" / "latest"),
                "3) 已有本机 SDK 时：ANDROID_SDK_ROOT=<你的SDK路径> khy build android --skip-sdk",
            ])
            return None
        manager = _sdkmanager(root)
    if manager is None:
        _fail("准备", "Android SDK", "commandline-tools 解压后仍找不到 sdkmanager")
        return None

    missing = _missing_packages(root, lock)
    if not missing:
        return root

    _info("缺少组件：" + ", ".join(missing))
    sdk_arg = "--sdk_root=" + str(root)
    # 许可必须先接受，否则组件安装会静默失败。sdkmanager 只认交互式的 y。
    _run([str(manager), sdk_arg, "--licenses"], verbose=False, stdin_text="y\n" * 30)
    if _run([str(manager), sdk_arg] + missing, verbose=verbose) != 0:
        _action_required("Android SDK 组件安装失败", [
            "已接受许可但组件安装未完成，常见原因是网络中断。",
            "可直接重跑 `khy build android`（已下载部分会复用），",
            "或加 --verbose 查看 sdkmanager 的完整输出。",
        ])
        return None
    still = _missing_packages(root, lock)
    if still:
        _fail("准备", "Android SDK", "安装后仍缺少 " + ", ".join(still))
        return None
    return root


# -- 步骤 5：改写 local.properties ---------------------------------------------
def escape_properties_path(path: Path) -> str:
    """按 Java ``.properties`` 规则转义路径。

    先转义反斜杠、再转义冒号，顺序不能反（反了会把刚生成的反斜杠再转一次）。
    ``C:\\Users\\x`` -> ``C\\:\\\\Users\\\\x``。
    """
    return str(path).replace("\\", "\\\\").replace(":", "\\:")


def write_local_properties(android_dir: Path, root: Path) -> bool:
    """把 ``sdk.dir`` 指向托管 SDK，覆盖任何过期路径。

    这是「零手动配置」的关键一步：换机器、换用户名后旧的 ``local.properties`` 会
    指向不存在的目录，而 gradle 报的错和 SDK 毫无关系。每次构建都重写这一行，
    其它键（例如 ``ndk.dir``）原样保留。
    """
    target = android_dir / "local.properties"
    lines = []
    try:
        if target.exists():
            for line in target.read_text(encoding="utf-8").splitlines():
                if not line.strip().startswith("sdk.dir"):
                    lines.append(line)
    except Exception:
        lines = []
    lines.insert(0, "sdk.dir=" + escape_properties_path(root))
    try:
        target.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")
        return True
    except Exception as exc:  # noqa: BLE001
        _fail("写入", str(target), str(exc))
        return False


# -- 步骤 6：Web 产物 ----------------------------------------------------------
def _npm() -> Optional[str]:
    return shutil.which("npm.cmd") if os.name == "nt" else shutil.which("npm")


def _npx() -> Optional[str]:
    return shutil.which("npx.cmd") if os.name == "nt" else shutil.which("npx")


def _build_web(project: Path, verbose: bool) -> bool:
    npm = _npm()
    npx = _npx()
    if not npm or not npx:
        _action_required("未检测到 Node.js / npm - 前端产物无法构建", [
            "安装 Node.js 20+（https://nodejs.org），或运行 `khy dev-setup` 让底座自动装。",
            "若 dist/ 已是最新，也可以跳过这一步：khy build android --skip-web",
        ])
        return False
    if not (project / "node_modules").is_dir():
        _info("安装前端依赖（首次执行较慢）")
        if _run([npm, "install"], cwd=project, verbose=verbose) != 0:
            _fail("安装", "前端依赖", "npm install 失败，加 --verbose 查看详情")
            return False
    if _run([npm, "run", "build"], cwd=project, verbose=verbose) != 0:
        _fail("构建", "前端产物", "vite build 失败，加 --verbose 查看详情")
        return False
    if _run([npx, "cap", "sync", "android"], cwd=project, verbose=verbose) != 0:
        _fail("同步", "Capacitor android 工程", "cap sync 失败，加 --verbose 查看详情")
        return False
    return True


# -- 步骤 7：gradle ------------------------------------------------------------
def _gradlew(android_dir: Path) -> Optional[Path]:
    name = "gradlew.bat" if os.name == "nt" else "gradlew"
    path = android_dir / name
    if not path.exists():
        return None
    if os.name != "nt":
        try:
            path.chmod(path.stat().st_mode | 0o111)  # 从 zip/git 检出常丢执行位
        except Exception:
            pass
    return path


def _assemble(android_dir: Path, root: Path, release: bool, verbose: bool) -> bool:
    gradlew = _gradlew(android_dir)
    if gradlew is None:
        _fail("构建", "APK", "找不到 gradlew，Capacitor android 工程可能不完整")
        return False
    task = "assembleRelease" if release else "assembleDebug"
    backup = os.environ.get("ANDROID_SDK_ROOT")
    # gradle 优先认 ANDROID_SDK_ROOT，其次才是 local.properties。两处都指到托管
    # SDK，避免机器上另有一份半残的 SDK 抢先被用上。构建后复原，不污染进程环境。
    os.environ["ANDROID_SDK_ROOT"] = str(root)
    try:
        cmd = [str(gradlew), task, "--no-daemon"]
        if verbose:
            cmd.append("--stacktrace")
        code = _run(cmd, cwd=android_dir, verbose=verbose)
    finally:
        if backup is None:
            os.environ.pop("ANDROID_SDK_ROOT", None)
        else:
            os.environ["ANDROID_SDK_ROOT"] = backup
    if code != 0:
        _action_required("Gradle 构建失败", [
            "重跑并查看完整日志：khy build android --verbose",
            "常见原因：JDK 版本不匹配（需 17+）、SDK 组件缺失、磁盘空间不足。",
        ])
        return False
    return True


# -- 步骤 8：收集 APK ----------------------------------------------------------
def _collect_apk(android_dir: Path, output: Path, release: bool) -> Optional[Path]:
    outputs = android_dir / "app" / "build" / "outputs" / "apk"
    variant = "release" if release else "debug"
    candidates = sorted((outputs / variant).glob("*.apk")) if (outputs / variant).is_dir() else []
    if not candidates:
        for sub in _APK_SEARCH_DIRS:
            if (outputs / sub).is_dir():
                candidates = sorted((outputs / sub).glob("*.apk"))
                if candidates:
                    break
    if not candidates:
        _fail("收集", "APK", "gradle 成功但产物目录里没有 apk")
        return None
    apk = candidates[0]
    try:
        output.mkdir(parents=True, exist_ok=True)
        dest = output / apk.name
        shutil.copy2(str(apk), str(dest))
        return dest
    except Exception as exc:  # noqa: BLE001
        _fail("复制", "APK", str(exc))
        return None


# -- 编排入口 -----------------------------------------------------------------
def run_android_build(argv: Sequence[str]) -> int:
    """``khy build android`` 的编排入口。

    :param argv: 动词之后的残余参数（由 cli.py 的 android 分支切好）
    :returns: 0 成功；1 构建失败；2 缺少前置依赖或参数非法。
    """
    opts = _parse_args(argv)
    if opts is None:
        print(_USAGE)
        return 2
    if opts["help"]:
        print(_USAGE)
        return 0

    lock = _lock()
    variant = "release" if opts["release"] else "debug"
    output = Path(opts["output"]).expanduser() if opts["output"] else Path.cwd() / "dist" / "android"

    # 1) 定位工程
    project = _find_project()
    if project is None:
        _step(1, "定位", "Capacitor 工程", "失败")
        _action_required("找不到随身 App 的 Capacitor 工程", [
            "预期位置：<仓库根>/apps/khy-mobile（源码检出）",
            "或用环境变量显式指定：KHY_ANDROID_PROJECT=<工程目录> khy build android",
        ])
        return 2
    _step(1, "定位", "Capacitor 工程", str(project))

    android_dir = project / "android"
    if not android_dir.is_dir():
        npx = _npx()
        if not npx:
            _step(1, "补全", "android 原生工程", "失败（缺少 npx）")
            return 2
        _info("android/ 尚未生成，执行 cap add android")
        if _run([npx, "cap", "add", "android"], cwd=project, verbose=opts["verbose"]) != 0:
            _fail("生成", "android 原生工程", "cap add android 失败")
            return 1

    # 2) JDK 预检 - 没有 JDK 绝不进 gradle
    java = _check_jdk()
    if java is None:
        _step(2, "预检", "Java JDK", "缺失")
        return 2
    _step(2, "预检", "Java JDK", "通过（{0}）".format(java))

    # 3) Windows 长路径（只读探测）
    _step(3, "探测", "长路径支持", "完成" if os.name == "nt" else "跳过（非 Windows）")
    _probe_long_path()

    # 4) SDK 自管理
    if opts["skip_sdk"]:
        root = sdk_root()
        _step(4, "准备", "Android SDK", "跳过（--skip-sdk，使用 {0}）".format(root))
    else:
        _step(4, "准备", "Android SDK", "检查组件")
        found = _ensure_sdk(lock, opts["verbose"])
        if found is None:
            return 2
        root = found
        _step(4, "准备", "Android SDK", "就绪（{0}）".format(root))

    # 5) 改写 local.properties
    if not write_local_properties(android_dir, root):
        _step(5, "写入", "local.properties", "失败")
        return 1
    _step(5, "写入", "local.properties", "sdk.dir 已指向托管 SDK")

    # 6) Web 产物
    if opts["skip_web"]:
        _step(6, "构建", "前端产物", "跳过（--skip-web）")
    else:
        _step(6, "构建", "前端产物", "npm install / vite build / cap sync")
        if not _build_web(project, opts["verbose"]):
            return 1
        _step(6, "构建", "前端产物", "完成")

    # 7) gradle
    _step(7, "构建", "APK（{0}）".format(variant), "进行中，首次可能需要数分钟")
    if not _assemble(android_dir, root, opts["release"], opts["verbose"]):
        return 1
    _step(7, "构建", "APK（{0}）".format(variant), "完成")

    # 8) 收集产物
    apk = _collect_apk(android_dir, output, opts["release"])
    if apk is None:
        return 1
    _step(8, "输出", "APK", "{0}（{1:.1f} MB）".format(apk, apk.stat().st_size / (1024 * 1024)))
    print("")
    print('安装到手机：adb install -r "{0}"'.format(apk))
    print("或把该文件传到手机后直接点击安装（需允许「未知来源」）。")
    return 0
