#!/usr/bin/env python3
"""``khy build android`` 编排器 I/O 层的单元测试（子函数与编排入口）。

``test_android_build.py`` 覆盖纯判断逻辑；本文件补齐编排器里会触达
subprocess / urllib / 文件系统的函数——一律用 ``unittest.mock`` 把
``subprocess.run`` / ``shutil.which`` / ``urllib.request.urlopen`` 等外部
调用替掉，**不触发真实下载、不跑 gradle、不装 SDK**。

跑法（零依赖，不需要 pytest）::

    python -m unittest discover -s platform/tests -t platform/tests
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

# 让测试能脱离安装状态直接跑：把 platform/ 加进导入路径。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# 某些便携/嵌入式 Python 布局把 C 扩展（.pyd）放在可执行文件目录，只有直接
# `python` 启动才会把该目录放进 sys.path；`python -m coverage run` 会丢掉这项，
# 导致 `unittest.mock`（传递导入 asyncio -> _overlapped）加载失败。防御性补回。
_exe_dir = os.path.dirname(sys.executable)
if _exe_dir not in sys.path:
    sys.path.insert(0, _exe_dir)

from unittest import mock  # noqa: E402  # 必须在上面补全 sys.path 之后导入

# 测量护栏：coverage 的 --include=platform\* 会把测试期间导入的任何
# platform 模块都算进 TOTAL。本模块的测试只针对 khy_platform 的三个目标
# 文件（android_build / app_protocol / __init__），不得把 portable / _bootstrap
# 等无关模块拖进测量范围（它们行覆盖率很低，会拉低 TOTAL）。因此预先在
# sys.modules 里备好最小假模块：源码里的懒加载
# （android_build._mirror_bases -> _bootstrap，sdk_root -> app_protocol）拿到
# 的是假对象，真实 .py 文件从未被 exec，也就不出现在 coverage 报告里。
import types  # noqa: E402


def _seed_unrelated_module_fakes() -> None:
    fake_bootstrap = types.ModuleType("khy_platform._bootstrap")

    def _china_network():
        raise RuntimeError("fake: 测试必须显式注入 _is_china_network 桩")

    fake_bootstrap._is_china_network = _china_network
    sys.modules.setdefault("khy_platform._bootstrap", fake_bootstrap)

    fake_portable = types.ModuleType("khy_platform.portable")
    fake_portable.get_portable_data_home = lambda: None
    sys.modules.setdefault("khy_platform.portable", fake_portable)


_seed_unrelated_module_fakes()

from khy_platform import android_build as ab  # noqa: E402

_SDKMANAGER_NAME = "sdkmanager.bat" if os.name == "nt" else "sdkmanager"


def _capture(func, *args, **kwargs):
    """调用 func，同时捕获 stdout/stderr，返回 (result, out, err)。"""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        result = func(*args, **kwargs)
    return result, out.getvalue(), err.getvalue()


def _proc(returncode=0, stdout=b""):
    p = mock.Mock()
    p.returncode = returncode
    p.stdout = stdout
    return p


def _fake_extract(archive: Path, dest: Path) -> bool:
    """假装解压成功：在 dest 下造出 cmdline-tools 布局。"""
    bin_dir = dest / "cmdline-tools" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / _SDKMANAGER_NAME).write_text("stub", encoding="utf-8")
    return True


# ---------------------------------------------------------------------------
# 输出辅助：阶段状态必须含「动作 + 目标 + 进度」（工程红线 2）
# ---------------------------------------------------------------------------
class OutputFormatTest(unittest.TestCase):
    """_step / _info / _fail / _action_required 的输出形态。"""

    def test_step_is_indexed_status_line(self):
        _, out, _ = _capture(ab._step, 3, "检索", "RAG 知识库", "5/8")
        self.assertIn("[3/8] 检索 · RAG 知识库 · 5/8", out)

    def test_info_is_indented(self):
        _, out, _ = _capture(ab._info, "首次构建：下载 commandline-tools")
        self.assertTrue(out.startswith("      "))

    def test_fail_goes_to_stderr(self):
        _, out, err = _capture(ab._fail, "准备", "Android SDK", "无法创建目录")
        self.assertIn("[FAIL] 准备 · Android SDK · 无法创建目录", err)
        self.assertEqual(out, "")

    def test_action_required_prints_guidance_block(self):
        _, out, _ = _capture(
            ab._action_required, "Android commandline-tools 下载失败",
            ["1) 配置代理", "2) 手动下载"])
        self.assertIn("[Action Required] Android commandline-tools 下载失败", out)
        self.assertIn("  1) 配置代理", out)
        self.assertIn("  2) 手动下载", out)


# ---------------------------------------------------------------------------
# _subprocess_kwargs / _run：子进程封装（全部 mock，不真正启动进程）
# ---------------------------------------------------------------------------
class SubprocessKwargsTest(unittest.TestCase):
    """平台化参数：Windows 隐藏控制台窗口，其它平台不注入。"""

    def test_windows_kwargs_hide_console(self):
        if os.name != "nt":
            self.skipTest("仅 Windows 分支")
        kw = ab._subprocess_kwargs()
        self.assertIn("startupinfo", kw)
        self.assertEqual(kw["creationflags"], subprocess.CREATE_NO_WINDOW)

    def test_posix_kwargs_are_empty(self):
        with mock.patch("os.name", "posix"):
            self.assertEqual(ab._subprocess_kwargs(), {})

    def test_success_is_quiet(self):
        # 非 verbose 且成功：输出被静默吞掉（PIPE 捕获但不回放）。
        run = mock.MagicMock(return_value=_proc(0, b"gradle noise"))
        with mock.patch("subprocess.run", run):
            code, out, err = _capture(ab._run, ["some", "cmd"], cwd=Path(tempfile.gettempdir()))
        self.assertEqual(code, 0)
        self.assertEqual(out, "")
        self.assertEqual(err, "")
        self.assertEqual(run.call_args.kwargs.get("stdout"), subprocess.PIPE)

    def test_failure_replays_last_lines(self):
        tail = "\n".join("line{0}".format(i) for i in range(40)).encode("utf-8")
        run = mock.MagicMock(return_value=_proc(1, tail))
        with mock.patch("subprocess.run", run):
            code, _, err = _capture(ab._run, ["some", "cmd"])
        self.assertEqual(code, 1)
        # 只回放尾部 30 行：最早的行被裁掉，最后的行保留。
        self.assertIn("| line39", err)
        self.assertNotIn("| line0", err)

    def test_none_stdout_does_not_crash(self):
        proc = mock.Mock()
        proc.returncode = 3
        proc.stdout = None
        with mock.patch("subprocess.run", return_value=proc):
            code, _, _ = _capture(ab._run, ["cmd"])
        self.assertEqual(code, 3)

    def test_verbose_passes_output_through(self):
        run = mock.MagicMock(return_value=_proc(7))
        with mock.patch("subprocess.run", run):
            code, _, _ = _capture(ab._run, ["cmd"], verbose=True)
        self.assertEqual(code, 7)
        self.assertNotIn("stdout", run.call_args.kwargs)  # 透传模式不接 PIPE

    def test_missing_executable_returns_127(self):
        run = mock.MagicMock(side_effect=FileNotFoundError("no such bin"))
        with mock.patch("subprocess.run", run):
            code, _, err = _capture(ab._run, ["definitely-missing-bin"])
        self.assertEqual(code, 127)
        self.assertIn("可执行文件不存在", err)

    def test_other_exceptions_return_1(self):
        run = mock.MagicMock(side_effect=OSError("spawn exploded"))
        with mock.patch("subprocess.run", run):
            code, _, err = _capture(ab._run, ["cmd"])
        self.assertEqual(code, 1)
        self.assertIn("spawn exploded", err)

    def test_stdin_text_is_encoded(self):
        run = mock.MagicMock(return_value=_proc(0))
        with mock.patch("subprocess.run", run):
            self.assertEqual(ab._run(["cmd"], stdin_text="y\n"), 0)
        self.assertEqual(run.call_args.kwargs["input"], b"y\n")

    def test_empty_command_reports_generically(self):
        run = mock.MagicMock(side_effect=FileNotFoundError())
        with mock.patch("subprocess.run", run):
            code, _, err = _capture(ab._run, [])
        self.assertEqual(code, 127)
        self.assertIn("命令", err)

    def test_cwd_passed_as_string(self):
        run = mock.MagicMock(return_value=_proc(0))
        cwd = Path(tempfile.gettempdir())
        with mock.patch("subprocess.run", run):
            ab._run(["cmd"], cwd=cwd)
        self.assertEqual(run.call_args.kwargs["cwd"], str(cwd))


# ---------------------------------------------------------------------------
# 版本锁：pyproject 真源 -> tomllib -> 正则兜底 -> 环境变量
# ---------------------------------------------------------------------------
class LockSourceTest(unittest.TestCase):
    """_repo_root / _lock 的兜底与覆盖链。"""

    _ENV_KEYS = (
        "KHY_ANDROID_BUILD_TOOLS", "KHY_ANDROID_COMPILE_SDK",
        "KHY_ANDROID_CMDLINE_TOOLS", "KHY_ANDROID_NDK", "KHY_ANDROID_EXTRA",
    )

    def setUp(self):
        for key in self._ENV_KEYS:
            os.environ.pop(key, None)

    def test_repo_root_is_repository_root(self):
        root = ab._repo_root()
        self.assertEqual(root.name, "khy-os")
        self.assertTrue((root / "pyproject.toml").exists())

    def test_parse_table_allows_trailing_comments(self):
        text = ('[tool.khyos.android]\n'
                'build_tools = "34.0.0"  # 固定旧版以便排查\n')
        self.assertEqual(ab._parse_android_table(text), {"build_tools": "34.0.0"})

    def test_lock_defaults_without_pyproject(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(ab, "_repo_root", return_value=Path(tmp)):
                self.assertEqual(ab._lock(), ab._DEFAULT_LOCK)

    def test_lock_survives_unreadable_pyproject(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "pyproject.toml").mkdir()  # 目录而非文件 -> read_text 抛错
            with mock.patch.object(ab, "_repo_root", return_value=Path(tmp)):
                self.assertEqual(ab._lock(), ab._DEFAULT_LOCK)

    def test_lock_regex_fallback_on_invalid_toml(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "pyproject.toml"
            bad.write_text("[tool.khyos.android\nbuild_tools = '34.0.0'\n", encoding="utf-8")
            with mock.patch.object(ab, "_repo_root", return_value=Path(tmp)):
                self.assertEqual(ab._lock(), ab._DEFAULT_LOCK)

    def test_lock_reads_valid_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "pyproject.toml").write_text(
                '[tool.khyos.android]\nbuild_tools = "34.0.0"  # pin\n', encoding="utf-8")
            with mock.patch.object(ab, "_repo_root", return_value=Path(tmp)):
                self.assertEqual(ab._lock()["build_tools"], "34.0.0")

    def test_non_string_table_values_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "pyproject.toml").write_text(
                '[tool.khyos.android]\nport = 8080\nextra = "ok"\n', encoding="utf-8")
            with mock.patch.object(ab, "_repo_root", return_value=Path(tmp)):
                lock = ab._lock()
            self.assertNotIn("port", lock)
            self.assertEqual(lock["extra"], "ok")

    def test_env_override_reaches_added_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "pyproject.toml").write_text(
                '[tool.khyos.android]\nextra = "ok"\n', encoding="utf-8")
            os.environ["KHY_ANDROID_EXTRA"] = "  v2  "
            try:
                with mock.patch.object(ab, "_repo_root", return_value=Path(tmp)):
                    self.assertEqual(ab._lock()["extra"], "v2")
            finally:
                os.environ.pop("KHY_ANDROID_EXTRA", None)


# ---------------------------------------------------------------------------
# 工程定位
# ---------------------------------------------------------------------------
class FindProjectTest(unittest.TestCase):
    """_find_project：按候选顺序找第一个含 capacitor 配置的目录。"""

    def test_returns_first_valid_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            project.mkdir()
            (project / "capacitor.config.js").write_text("x", encoding="utf-8")
            with mock.patch.object(ab, "_project_candidates",
                                   return_value=[Path(tmp) / "nope", project]):
                self.assertEqual(ab._find_project(), project.resolve())

    def test_returns_none_when_no_candidate_is_a_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "empty").mkdir()
            with mock.patch.object(ab, "_project_candidates",
                                   return_value=[Path(tmp) / "empty"]):
                self.assertIsNone(ab._find_project())

    def test_is_capacitor_project_swallows_isdir_error(self):
        # is_dir() 抛错（权限/挂载点异常）也绝不外抛，判「不是工程」。
        class _BadPath:
            def is_dir(self):
                raise OSError("stat failed")
        self.assertFalse(ab._is_capacitor_project(_BadPath()))

    def test_find_project_skips_raising_candidate(self):
        # 单个候选抛错只跳过它，不中断整体查找。
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(ab, "_project_candidates",
                                   return_value=[Path(tmp)]), \
                 mock.patch.object(ab, "_is_capacitor_project",
                                   side_effect=OSError("boom")):
                self.assertIsNone(ab._find_project())


# ---------------------------------------------------------------------------
# JDK 预检与 Windows 长路径探测（subprocess 全部 mock）
# ---------------------------------------------------------------------------
class JavaProbeTest(unittest.TestCase):
    """_java_major / _check_jdk：解析版本号、JDK 缺失/过低的指引。"""

    def test_modern_version(self):
        run = mock.MagicMock(return_value=_proc(0, b'openjdk version "17.0.9" 2024-07-16'))
        with mock.patch("subprocess.run", run):
            self.assertEqual(ab._java_major("java"), 17)

    def test_legacy_1_dot_x_version_uses_second_segment(self):
        run = mock.MagicMock(return_value=_proc(0, b'java version "1.8.0_362"'))
        with mock.patch("subprocess.run", run):
            self.assertEqual(ab._java_major("java"), 8)

    def test_1_dot_11_maps_to_11(self):
        run = mock.MagicMock(return_value=_proc(0, b'openjdk version "1.11.0.2"'))
        with mock.patch("subprocess.run", run):
            self.assertEqual(ab._java_major("java"), 11)

    def test_unparseable_output_is_none(self):
        run = mock.MagicMock(return_value=_proc(0, b"no version here"))
        with mock.patch("subprocess.run", run):
            self.assertIsNone(ab._java_major("java"))

    def test_probe_exception_is_none(self):
        run = mock.MagicMock(side_effect=RuntimeError("java not there"))
        with mock.patch("subprocess.run", run):
            self.assertIsNone(ab._java_major("java"))

    def test_missing_jdk_prints_guidance(self):
        with mock.patch("shutil.which", return_value=None):
            got, out, _ = _capture(ab._check_jdk)
        self.assertIsNone(got)
        self.assertIn("未检测到 Java JDK", out)

    def test_old_jdk_is_rejected(self):
        with mock.patch("shutil.which", return_value="java"), \
             mock.patch.object(ab, "_java_major", return_value=11):
            got, out, _ = _capture(ab._check_jdk)
        self.assertIsNone(got)
        self.assertIn("Java 版本过低", out)

    def test_javac_derives_java_home_when_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            jdk = Path(tmp) / "jdk"
            bin_dir = jdk / "bin"
            bin_dir.mkdir(parents=True)
            java = bin_dir / ("java.exe" if os.name == "nt" else "java")
            java.write_text("stub", encoding="utf-8")
            javac = bin_dir / ("javac.exe" if os.name == "nt" else "javac")
            javac.write_text("stub", encoding="utf-8")
            old = os.environ.pop("JAVA_HOME", None)
            try:
                with mock.patch("shutil.which", return_value=str(java)), \
                     mock.patch.object(ab, "_java_major", return_value=17):
                    self.assertEqual(ab._check_jdk(), str(java))
                self.assertEqual(os.environ.get("JAVA_HOME"), str(jdk))
            finally:
                os.environ.pop("JAVA_HOME", None)
                if old is not None:
                    os.environ["JAVA_HOME"] = old

    def test_missing_javac_leaves_java_home_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            jdk = Path(tmp) / "jdk"
            (jdk / "bin").mkdir(parents=True)
            java = jdk / "bin" / ("java.exe" if os.name == "nt" else "java")
            java.write_text("stub", encoding="utf-8")  # 无 javac
            old = os.environ.pop("JAVA_HOME", None)
            try:
                with mock.patch("shutil.which", return_value=str(java)), \
                     mock.patch.object(ab, "_java_major", return_value=17):
                    self.assertEqual(ab._check_jdk(), str(java))
                self.assertIsNone(os.environ.get("JAVA_HOME"))
            finally:
                if old is not None:
                    os.environ["JAVA_HOME"] = old

    def test_existing_java_home_is_respected(self):
        os.environ["JAVA_HOME"] = "/custom/jdk"
        try:
            with mock.patch("shutil.which", return_value="java"), \
                 mock.patch.object(ab, "_java_major", return_value=17):
                self.assertEqual(ab._check_jdk(), "java")
            self.assertEqual(os.environ["JAVA_HOME"], "/custom/jdk")
        finally:
            os.environ.pop("JAVA_HOME", None)


class LongPathProbeTest(unittest.TestCase):
    """_probe_long_path：只读探测，绝不写注册表。"""

    def test_enabled_registry_value_is_silent(self):
        run = mock.MagicMock(
            return_value=_proc(0, b"    LongPathsEnabled    REG_DWORD    0x1"))
        with mock.patch("subprocess.run", run):
            _, out, _ = _capture(ab._probe_long_path)
        self.assertNotIn("LongPathsEnabled", out)
        run.assert_called_once()

    def test_disabled_value_prints_hint(self):
        run = mock.MagicMock(
            return_value=_proc(0, b"    LongPathsEnabled    REG_DWORD    0x0"))
        with mock.patch("subprocess.run", run):
            _, out, _ = _capture(ab._probe_long_path)
        self.assertIn("LongPathsEnabled", out)

    def test_reg_failure_is_silent(self):
        run = mock.MagicMock(side_effect=FileNotFoundError("no reg"))
        with mock.patch("subprocess.run", run):
            _, out, _ = _capture(ab._probe_long_path)
        self.assertEqual(out, "")

    def test_non_windows_skips_probe(self):
        run = mock.MagicMock()
        with mock.patch("subprocess.run", run), mock.patch("os.name", "posix"):
            ab._probe_long_path()
        run.assert_not_called()


# ---------------------------------------------------------------------------
# SDK 自管理：sdkmanager 定位 / 资产名 / 镜像顺序 / 下载 / 安装 / 组件检查
# ---------------------------------------------------------------------------
class SdkToolsTest(unittest.TestCase):
    """_sdkmanager / _cmdline_tools_asset / _mirror_bases 的纯逻辑。"""

    def test_latest_layout_finds_sdkmanager(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "cmdline-tools" / "latest" / "bin"
            bin_dir.mkdir(parents=True)
            target = bin_dir / _SDKMANAGER_NAME
            target.write_text("stub", encoding="utf-8")
            self.assertEqual(ab._sdkmanager(root), target)

    def test_legacy_cmdline_tools_subdir_finds_sdkmanager(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "cmdline-tools" / "cmdline-tools" / "bin"
            bin_dir.mkdir(parents=True)
            target = bin_dir / _SDKMANAGER_NAME
            target.write_text("stub", encoding="utf-8")
            self.assertEqual(ab._sdkmanager(root), target)

    def test_missing_sdkmanager_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(ab._sdkmanager(Path(tmp)))

    def test_asset_name_per_platform(self):
        with mock.patch("sys.platform", "win32"):
            self.assertEqual(ab._cmdline_tools_asset("13114758"),
                             "commandlinetools-win-13114758_latest.zip")
        with mock.patch("sys.platform", "darwin"):
            self.assertEqual(ab._cmdline_tools_asset("13114758"),
                             "commandlinetools-mac-13114758_latest.zip")
        with mock.patch("sys.platform", "linux"):
            self.assertEqual(ab._cmdline_tools_asset("13114758"),
                             "commandlinetools-linux-13114758_latest.zip")

    def test_china_network_prefers_mirrors(self):
        import types
        fake = types.ModuleType("khy_platform._bootstrap")
        fake._is_china_network = lambda: True
        with mock.patch.dict(sys.modules, {"khy_platform._bootstrap": fake}):
            self.assertEqual(ab._mirror_bases()[0], ab._TENCENT_DIST)

    def test_foreign_network_prefers_google(self):
        import types
        fake = types.ModuleType("khy_platform._bootstrap")
        fake._is_china_network = lambda: False
        with mock.patch.dict(sys.modules, {"khy_platform._bootstrap": fake}):
            self.assertEqual(ab._mirror_bases()[0], ab._GOOGLE_DIST)

    def test_probe_failure_assumes_china_for_safety(self):
        # 探测失败时宁可优先国内镜像：卡住的代价比绕路的代价大。
        import types
        def _boom():
            raise RuntimeError("no network")
        fake = types.ModuleType("khy_platform._bootstrap")
        fake._is_china_network = _boom
        with mock.patch.dict(sys.modules, {"khy_platform._bootstrap": fake}):
            self.assertEqual(ab._mirror_bases()[0], ab._TENCENT_DIST)


class _Resp:
    """urlopen 上下文管理器的假响应。"""

    def __init__(self, data: bytes, status: int = 200,
                 content_length=None, fail_after_chunks: int = None):
        self._left = data
        self._status = status
        self.status = status
        self._content_length = content_length
        self.fail_after = fail_after_chunks
        self.calls = 0
        self.headers = {}
        if content_length is not None:
            self.headers["Content-Length"] = str(content_length)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def getcode(self):
        return self._status

    def read(self, n):
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise OSError("simulated mid-stream failure")
        if not self._left:
            return b""
        chunk, self._left = self._left[:n], self._left[n:]
        return chunk


class DownloadTest(unittest.TestCase):
    """_download：断点续传语义（urlopen 全部 mock）。"""

    def test_fresh_download_writes_full_body(self):
        payload = b"A" * 400_000
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "tools.zip"
            urlopen = mock.MagicMock(return_value=_Resp(payload, content_length=len(payload)))
            with mock.patch("urllib.request.urlopen", urlopen):
                self.assertTrue(ab._download("https://example.com/x.zip", dest))
            self.assertEqual(dest.read_bytes(), payload)
            req = urlopen.call_args.args[0]
            self.assertNotIn("Range", req.headers)

    def test_resumable_download_appends_when_server_says_206(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "tools.zip"
            head, rest = b"head", b"tail" * 3
            dest.write_bytes(head)
            urlopen = mock.MagicMock(
                return_value=_Resp(rest, status=206, content_length=len(rest)))
            with mock.patch("urllib.request.urlopen", urlopen):
                self.assertTrue(ab._download("https://example.com/x.zip", dest))
            self.assertEqual(dest.read_bytes(), head + rest)
            self.assertEqual(urlopen.call_args.args[0].headers["Range"],
                             "bytes={0}-".format(len(head)))

    def test_200_on_resume_rewrites_from_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "tools.zip"
            dest.write_bytes(b"stale")
            rest = b"fresh"
            urlopen = mock.MagicMock(
                return_value=_Resp(rest, status=200, content_length=len(rest)))
            with mock.patch("urllib.request.urlopen", urlopen):
                self.assertTrue(ab._download("https://example.com/x.zip", dest))
            self.assertEqual(dest.read_bytes(), rest)  # 200 表示全量重发

    def test_no_content_length_skips_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "tools.zip"
            urlopen = mock.MagicMock(return_value=_Resp(b"xyz"))
            with mock.patch("urllib.request.urlopen", urlopen):
                self.assertTrue(ab._download("https://example.com/x.zip", dest))
            self.assertEqual(dest.read_bytes(), b"xyz")

    def test_mid_stream_failure_keeps_partial_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "tools.zip"
            payload = b"B" * 400_000
            resp = _Resp(payload, content_length=len(payload), fail_after_chunks=1)
            urlopen = mock.MagicMock(return_value=resp)
            with mock.patch("urllib.request.urlopen", urlopen):
                ok, out, _ = _capture(ab._download, "https://example.com/x.zip", dest)
            self.assertFalse(ok)
            # 首个 256KB 块已落盘，第二个块读取时断流 -> 保留部分文件供续传。
            self.assertEqual(dest.stat().st_size, 256 * 1024)
            self.assertTrue(out.endswith("\n"))  # 打断点进度条

    def test_upstream_error_returns_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "tools.zip"
            urlopen = mock.MagicMock(side_effect=OSError("down"))
            with mock.patch("urllib.request.urlopen", urlopen):
                self.assertFalse(ab._download("https://example.com/x.zip", dest))


class SafeZipTest(unittest.TestCase):
    """_is_within / _safe_extract_zip 的路径穿越防护。"""

    def test_within_nested(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.assertTrue(ab._is_within(base, base / "a" / "b"))

    def test_within_equal(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertTrue(ab._is_within(Path(tmp), Path(tmp)))

    def test_traversal_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.assertFalse(ab._is_within(base, base / "a" / ".." / ".." / "esc"))

    def test_unresolvable_paths_are_false(self):
        # resolve() 抛错（符号链接断裂等）时按「不在其内」处理，绝不外抛。
        import pathlib
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            with mock.patch.object(pathlib.Path, "resolve",
                                    side_effect=OSError("cannot resolve")):
                self.assertFalse(ab._is_within(base, base / "a"))

    def test_non_zip_archive_is_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "not-a-zip.zip"
            archive.write_bytes(b"garbage")
            self.assertFalse(ab._safe_extract_zip(archive, Path(tmp) / "dest"))


class InstallCmdlineToolsTest(unittest.TestCase):
    """_install_cmdline_tools：下载/解压/落地（_download 与 _safe_extract_zip 替掉）。"""

    def test_all_mirrors_down_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            download = mock.MagicMock(return_value=False)
            extract = mock.MagicMock()
            with mock.patch.object(ab, "_download", download), \
                 mock.patch.object(ab, "_safe_extract_zip", extract):
                self.assertFalse(ab._install_cmdline_tools(root, "13114758"))
            self.assertEqual(download.call_count, 2)  # 两个镜像都试
            extract.assert_not_called()

    def test_bad_extract_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(ab, "_download", return_value=True), \
                 mock.patch.object(ab, "_safe_extract_zip", return_value=False):
                self.assertFalse(ab._install_cmdline_tools(root, "13114758"))

    def test_missing_inner_dir_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            def _no_inner(archive, dest):
                (dest / "unrelated").mkdir(parents=True)
                return True
            with mock.patch.object(ab, "_download", return_value=True), \
                 mock.patch.object(ab, "_safe_extract_zip", _no_inner):
                self.assertFalse(ab._install_cmdline_tools(root, "13114758"))

    def test_success_lands_under_latest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "cmdline-tools" / "latest").mkdir(parents=True)  # 覆盖旧布局
            with mock.patch.object(ab, "_download", return_value=True), \
                 mock.patch.object(ab, "_safe_extract_zip", _fake_extract):
                self.assertTrue(ab._install_cmdline_tools(root, "13114758"))
            self.assertTrue((root / "cmdline-tools" / "latest" / "bin" /
                             _SDKMANAGER_NAME).exists())

    def test_posix_restore_exec_bits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(ab, "os", SimpleNamespace(name="posix")), \
                 mock.patch.object(ab, "_download", return_value=True), \
                 mock.patch.object(ab, "_safe_extract_zip", _fake_extract):
                self.assertTrue(ab._install_cmdline_tools(root, "13114758"))
            bin_dir = root / "cmdline-tools" / "latest" / "bin"
            mode = (bin_dir / _SDKMANAGER_NAME).stat().st_mode
            self.assertTrue(mode & 0o111)  # 执行位已补回

    def test_mirror_probe_failure_is_soft(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(ab, "_mirror_bases",
                                   side_effect=RuntimeError("probe down")):
                self.assertFalse(ab._install_cmdline_tools(Path(tmp), "13114758"))

    def test_posix_chmod_failure_is_soft(self):
        # 执行位补不齐（只读文件系统）不阻断安装，只跳过 chmod。
        import pathlib
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch.object(ab, "os", SimpleNamespace(name="posix")), \
                 mock.patch.object(ab, "_download", return_value=True), \
                 mock.patch.object(ab, "_safe_extract_zip", _fake_extract), \
                 mock.patch.object(pathlib.Path, "chmod", side_effect=OSError("denied")):
                self.assertTrue(ab._install_cmdline_tools(root, "13114758"))
            self.assertTrue((root / "cmdline-tools" / "latest").is_dir())


# ---------------------------------------------------------------------------
# 组件缺失检查与 _ensure_sdk
# ---------------------------------------------------------------------------
class EnsureSdkTest(unittest.TestCase):
    """_ensure_sdk：装齐直连、缺啥补啥、失败给指引。"""

    LOCK = dict(ab._DEFAULT_LOCK)

    def _full_root(self, tmp: str) -> Path:
        root = Path(tmp) / "sdk"
        for sub in ("platform-tools", "platforms/android-36", "build-tools/35.0.0"):
            (root / sub).mkdir(parents=True)
        (root / "cmdline-tools" / "latest" / "bin").mkdir(parents=True)
        (root / "cmdline-tools" / "latest" / "bin" / _SDKMANAGER_NAME).write_text("stub", encoding="utf-8")
        return root

    def test_complete_sdk_needs_no_sdkmanager_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._full_root(tmp)
            run = mock.MagicMock()
            with mock.patch.object(ab, "sdk_root", return_value=root), \
                 mock.patch.object(ab, "_run", run):
                self.assertEqual(ab._ensure_sdk(self.LOCK, False), root)
            run.assert_not_called()

    def test_missing_packages_get_installed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sdk"
            (root / "cmdline-tools" / "latest" / "bin").mkdir(parents=True)
            (root / "cmdline-tools" / "latest" / "bin" / _SDKMANAGER_NAME).write_text("stub", encoding="utf-8")
            calls = []

            def fake_run(cmd, cwd=None, verbose=False, stdin_text=None):
                calls.append((list(cmd), stdin_text))
                for sub in ("platform-tools", "platforms/android-36",
                             "build-tools/35.0.0"):
                    (root / sub).mkdir(parents=True, exist_ok=True)
                return 0
            with mock.patch.object(ab, "sdk_root", return_value=root), \
                 mock.patch.object(ab, "_run", fake_run):
                self.assertEqual(ab._ensure_sdk(self.LOCK, False), root)
            self.assertEqual(len(calls), 2)  # 一次许可 + 一次安装
            self.assertIn("--licenses", calls[0][0])
            self.assertEqual(calls[0][1], "y\n" * 30)
            self.assertEqual(calls[1][0][-3:],
                             ["platform-tools", "platforms;android-36", "build-tools;35.0.0"])

    def test_install_failure_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sdk"
            (root / "cmdline-tools" / "latest" / "bin").mkdir(parents=True)
            (root / "cmdline-tools" / "latest" / "bin" / _SDKMANAGER_NAME).write_text("stub", encoding="utf-8")
            with mock.patch.object(ab, "sdk_root", return_value=root), \
                 mock.patch.object(ab, "_run", side_effect=[0, 1]):
                got, out, _ = _capture(ab._ensure_sdk, self.LOCK, False)
            self.assertIsNone(got)
            self.assertIn("Android SDK 组件安装失败", out)

    def test_still_missing_after_install_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sdk"
            (root / "cmdline-tools" / "latest" / "bin").mkdir(parents=True)
            (root / "cmdline-tools" / "latest" / "bin" / _SDKMANAGER_NAME).write_text("stub", encoding="utf-8")
            with mock.patch.object(ab, "sdk_root", return_value=root), \
                 mock.patch.object(ab, "_run", return_value=0):  # 装完仍缺组件
                got, out, err = _capture(ab._ensure_sdk, self.LOCK, False)
            self.assertIsNone(got)
            self.assertIn("安装后仍缺少", err)

    def test_cmdline_tools_download_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sdk"
            root.mkdir()
            with mock.patch.object(ab, "sdk_root", return_value=root), \
                 mock.patch.object(ab, "_install_cmdline_tools", return_value=False):
                got, out, _ = _capture(ab._ensure_sdk, self.LOCK, False)
            self.assertIsNone(got)
            self.assertIn("Android commandline-tools 下载失败", out)

    def test_manager_still_missing_after_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "sdk"
            root.mkdir()
            with mock.patch.object(ab, "sdk_root", return_value=root), \
                 mock.patch.object(ab, "_sdkmanager", side_effect=[None, None]), \
                 mock.patch.object(ab, "_install_cmdline_tools", return_value=True):
                got, out, err = _capture(ab._ensure_sdk, self.LOCK, False)
            self.assertIsNone(got)
            self.assertIn("找不到 sdkmanager", err)

    def test_root_mkdir_failure_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "blocker"
            blocker.write_text("file", encoding="utf-8")
            with mock.patch.object(ab, "sdk_root", return_value=blocker / "sdk"):
                got, out, err = _capture(ab._ensure_sdk, self.LOCK, False)
            self.assertIsNone(got)
            self.assertIn("无法创建", err)


# ---------------------------------------------------------------------------
# local.properties（补充异常分支）
# ---------------------------------------------------------------------------
class WritePropertiesExtraTest(unittest.TestCase):
    """_build_web / _gradlew / _assemble / _collect_apk / 编排入口。"""

    def test_target_as_directory_fails_softly(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = Path(tmp)
            (android / "local.properties").mkdir()  # 目标是个目录 -> 读写都会抛
            root = Path(tmp) / "sdk"
            ok, out, err = _capture(ab.write_local_properties, android, root)
        self.assertFalse(ok)
        self.assertIn("[FAIL]", err)


class NpmNpxTest(unittest.TestCase):
    """_npm / _npx 的平台化可执行名选择。"""

    def test_windows_prefers_dot_cmd(self):
        which = mock.MagicMock(return_value="C:\\node\\npm.cmd")
        with mock.patch.object(ab.shutil, "which", which):
            self.assertEqual(ab._npm(), "C:\\node\\npm.cmd")
        which.assert_called_with("npm.cmd")

    def test_posix_uses_bare_name(self):
        which = mock.MagicMock(return_value="/usr/bin/npx")
        with mock.patch("os.name", "posix"), mock.patch.object(ab.shutil, "which", which):
            self.assertEqual(ab._npx(), "/usr/bin/npx")
        which.assert_called_with("npx")


class BuildWebTest(unittest.TestCase):
    """_build_web：npm install / vite build / cap sync 三段失败语义。"""

    def _project(self, with_node_modules: bool = False) -> Path:
        tmp = Path(tempfile.mkdtemp(prefix="khy-abweb-"))
        self.addCleanup(shutil.rmtree, str(tmp), ignore_errors=True)
        proj = tmp / "proj"
        proj.mkdir()
        if with_node_modules:
            (proj / "node_modules").mkdir()
        return proj

    def test_missing_npm_short_circuits(self):
        with mock.patch.object(ab, "_npm", return_value=None):
            ok, out, _ = _capture(ab._build_web, self._project(), False)
        self.assertFalse(ok)
        self.assertIn("未检测到 Node.js", out)

    def test_missing_npx_short_circuits(self):
        proj = self._project()
        with mock.patch.object(ab, "_npm", return_value="npm.cmd"), \
             mock.patch.object(ab, "_npx", return_value=None):
            ok, out, _ = _capture(ab._build_web, proj, False)
        self.assertFalse(ok)
        self.assertIn("未检测到 Node.js", out)

    def test_first_install_failure_stops(self):
        run = mock.MagicMock(side_effect=[1, 0, 0])
        with mock.patch.object(ab, "_npm", return_value="npm.cmd"), \
             mock.patch.object(ab, "_npx", return_value="npx.cmd"), \
             mock.patch.object(ab, "_run", run):
            self.assertFalse(ab._build_web(self._project(), False))
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ["npm.cmd", "install"])

    def test_build_failure_stops_before_cap_sync(self):
        run = mock.MagicMock(side_effect=[0, 1, 0])
        with mock.patch.object(ab, "_npm", return_value="npm.cmd"), \
             mock.patch.object(ab, "_npx", return_value="npx.cmd"), \
             mock.patch.object(ab, "_run", run):
            self.assertFalse(ab._build_web(self._project(), False))
        self.assertEqual(run.call_count, 2)

    def test_cap_sync_failure_is_failure(self):
        run = mock.MagicMock(side_effect=[0, 0, 1])
        with mock.patch.object(ab, "_npm", return_value="npm.cmd"), \
             mock.patch.object(ab, "_npx", return_value="npx.cmd"), \
             mock.patch.object(ab, "_run", run):
            self.assertFalse(ab._build_web(self._project(), False))
        self.assertEqual(run.call_args.args[0], ["npx.cmd", "cap", "sync", "android"])

    def test_all_green_skips_install_when_node_modules_present(self):
        run = mock.MagicMock(side_effect=[0, 0])
        with mock.patch.object(ab, "_npm", return_value="npm.cmd"), \
             mock.patch.object(ab, "_npx", return_value="npx.cmd"), \
             mock.patch.object(ab, "_run", run):
            self.assertTrue(ab._build_web(self._project(with_node_modules=True), False))
        self.assertEqual(run.call_args_list[0].args[0], ["npm.cmd", "run", "build"])


class GradlewTest(unittest.TestCase):
    """_gradlew：存在性 + 平台可执行名 + 执行位修复。"""

    def test_windows_wants_gradlew_bat(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "gradlew.bat"
            script.write_text("@echo off\n", encoding="utf-8")
            if os.name == "nt":
                self.assertEqual(ab._gradlew(Path(tmp)), script)

    def test_posix_wants_gradlew_and_restores_exec_bit(self):
        # 只替换 android_build 模块内的 os 引用（避免全局 os.name 影响 pathlib 分派）。
        with tempfile.TemporaryDirectory() as tmp:
            android_dir = Path(tmp)
            script = android_dir / "gradlew"
            script.write_text("#!/bin/sh\n", encoding="utf-8")
            with mock.patch.object(ab, "os", SimpleNamespace(name="posix")):
                self.assertEqual(ab._gradlew(android_dir), script)
            # Windows 的 chmod 不清执行位，只有真正的 posix 上才断言执行位。
            if os.name != "nt":
                self.assertTrue(script.stat().st_mode & 0o111)

    def test_missing_script_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(ab._gradlew(Path(tmp)))

    def test_posix_chmod_failure_is_soft(self):
        # 补执行位失败（只读检出）不阻断：仍返回脚本路径。
        import pathlib
        with tempfile.TemporaryDirectory() as tmp:
            android_dir = Path(tmp)
            script = android_dir / "gradlew"
            script.write_text("#!/bin/sh\n", encoding="utf-8")
            with mock.patch.object(ab, "os", SimpleNamespace(name="posix")), \
                 mock.patch.object(pathlib.Path, "chmod", side_effect=OSError("denied")):
                self.assertEqual(ab._gradlew(android_dir), script)


class AssembleTest(unittest.TestCase):
    """_assemble：gradle 任务 + ANDROID_SDK_ROOT 的临时切换与复原。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="khy-abgradle-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), ignore_errors=True)
        self.android = self.tmp / "android"
        self.android.mkdir()
        (self.android / "gradlew.bat").write_text("@echo off\n", encoding="utf-8")
        self.sdk = self.tmp / "sdk"
        self._sdk_env = os.environ.pop("ANDROID_SDK_ROOT", None)

    def tearDown(self):
        if self._sdk_env is None:
            os.environ.pop("ANDROID_SDK_ROOT", None)
        else:
            os.environ["ANDROID_SDK_ROOT"] = self._sdk_env

    def _assemble(self, release=False, verbose=False, code=0):
        run = mock.MagicMock(return_value=code)
        gradlew = self.android / "gradlew.bat"
        with mock.patch.object(ab, "_gradlew", return_value=gradlew), \
             mock.patch.object(ab, "_run", run):
            ok = ab._assemble(self.android, self.sdk, release, verbose)
        return ok, run

    def test_debug_success_restores_environment(self):
        ok, run = self._assemble()
        self.assertTrue(ok)
        self.assertNotIn("ANDROID_SDK_ROOT", os.environ)
        self.assertEqual(run.call_args.args[0],
                         [str(self.android / "gradlew.bat"), "assembleDebug", "--no-daemon"])

    def test_release_task_selected(self):
        ok, run = self._assemble(release=True)
        self.assertTrue(ok)
        self.assertIn("assembleRelease", run.call_args.args[0])

    def test_verbose_adds_stacktrace(self):
        ok, run = self._assemble(verbose=True)
        self.assertTrue(ok)
        self.assertEqual(run.call_args.args[0][-1], "--stacktrace")

    def test_prior_sdk_env_is_restored(self):
        os.environ["ANDROID_SDK_ROOT"] = "/custom/sdk"
        ok, _ = self._assemble()
        self.assertTrue(ok)
        self.assertEqual(os.environ["ANDROID_SDK_ROOT"], "/custom/sdk")

    def test_gradle_failure_returns_false(self):
        ok, _ = self._assemble(code=1)
        self.assertFalse(ok)

    def test_missing_gradlew_fails_early(self):
        run = mock.MagicMock()
        with mock.patch.object(ab, "_gradlew", return_value=None), \
             mock.patch.object(ab, "_run", run):
            ok, _, err = _capture(ab._assemble, self.android, self.sdk, False, False)
        self.assertFalse(ok)
        self.assertIn("找不到 gradlew", err)
        run.assert_not_called()


class CollectApkTest(unittest.TestCase):
    """_collect_apk：变体目录定位 + 搜索目录回退 + 拷贝。"""

    def _android(self, tmp: str, layout) -> Path:
        android = Path(tmp) / "android"
        outputs = android / "app" / "build" / "outputs" / "apk"
        for variant, names in layout.items():
            for name in names:
                d = outputs / variant
                d.mkdir(parents=True, exist_ok=True)
                (d / name).write_bytes(b"APK-" + name.encode())
        return android

    def test_debug_variant_picked_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = self._android(tmp, {"debug": ["app-debug.apk"]})
            out = Path(tmp) / "out"
            got = ab._collect_apk(android, out, release=False)
            self.assertEqual(got, out / "app-debug.apk")
            self.assertEqual(got.read_bytes(), b"APK-app-debug.apk")

    def test_release_variant_picked_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = self._android(tmp, {"release": ["app-release.apk"]})
            got = ab._collect_apk(android, Path(tmp) / "out", release=True)
            self.assertEqual(got.name, "app-release.apk")

    def test_empty_variant_dir_falls_back_to_search_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = self._android(tmp, {"debug": [], "release": ["app-release.apk"]})
            got = ab._collect_apk(android, Path(tmp) / "out", release=False)
            self.assertIsNotNone(got)
            self.assertEqual(got.name, "app-release.apk")

    def test_no_apk_anywhere_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = self._android(tmp, {})
            got, out, err = _capture(ab._collect_apk, android, Path(tmp) / "out", False)
            self.assertIsNone(got)
            self.assertIn("[FAIL]", err)

    def test_unwritable_output_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = self._android(tmp, {"debug": ["a.apk"]})
            blocker = Path(tmp) / "blocker"
            blocker.write_text("file", encoding="utf-8")
            got, out, err = _capture(ab._collect_apk, android, blocker / "sub", False)
            self.assertIsNone(got)
            self.assertIn("[FAIL]", err)


# ---------------------------------------------------------------------------
# 编排入口：run_android_build 全链路（每个 I/O 桩都 mock 掉）
# ---------------------------------------------------------------------------
class AndroidOrchestrationTest(unittest.TestCase):
    """run_android_build：成功路径 + 每个失败分支的退出码契约。

    0 = 成功；1 = 构建失败；2 = 前置依赖/参数问题。
    所有外部 I/O（JDK、SDK、npm、gradle）在此层一律替桩，
    子函数本身的分支在上方的单测里单独验证。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="khy-aborch-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), ignore_errors=True)
        self.project = self.tmp / "proj"
        (self.project / "android").mkdir(parents=True)
        (self.project / "capacitor.config.ts").write_text("export default {};", encoding="utf-8")
        (self.project / "node_modules").mkdir()
        (self.project / "android" / "gradlew.bat").write_text("@echo off\n", encoding="utf-8")
        for variant, data in (("debug", b"APKDATA-DEBUG"), ("release", b"APKDATA-RELEASE")):
            d = self.project / "android" / "app" / "build" / "outputs" / "apk" / variant
            d.mkdir(parents=True)
            (d / ("app-{0}.apk".format(variant))).write_bytes(data)
        self.proj2 = self.tmp / "proj2"  # 只有 capacitor 配置、没有 android/ 子目录
        self.proj2.mkdir()
        (self.proj2 / "capacitor.config.js").write_text("x", encoding="utf-8")
        self.sdk = self.tmp / "sdk"
        for sub in ("platform-tools", "platforms/android-36", "build-tools/35.0.0"):
            (self.sdk / sub).mkdir(parents=True)

    def _run_orch(self, args, **patched):
        stack = contextlib.ExitStack()
        try:
            for name, value in patched.items():
                stack.enter_context(mock.patch.object(ab, name, value))
            return ab.run_android_build(args)
        finally:
            stack.close()

    def _standard(self):
        """常规成功链路里被桩掉的步骤，返回 (补丁字典, 可断言的 mock)。"""
        ensure = mock.MagicMock(return_value=self.sdk)
        build = mock.MagicMock(return_value=True)
        assemble = mock.MagicMock(return_value=True)
        patches = {
            "_lock": mock.MagicMock(return_value=dict(ab._DEFAULT_LOCK)),
            "_find_project": mock.MagicMock(return_value=self.project),
            "_check_jdk": mock.MagicMock(return_value="java"),
            "_probe_long_path": mock.MagicMock(),
            "_ensure_sdk": ensure,
            "_build_web": build,
            "_assemble": assemble,
        }
        return patches, ensure, build, assemble

    def test_full_success_debug(self):
        patches, _, _, _ = self._standard()
        out = self.tmp / "out"
        self.assertEqual(self._run_orch(["-o", str(out)], **patches), 0)
        apk = out / "app-debug.apk"
        self.assertTrue(apk.exists())
        self.assertEqual(apk.read_bytes(), b"APKDATA-DEBUG")
        # local.properties 由真实函数写入，指向托管 SDK。
        lp = (self.project / "android" / "local.properties").read_text(encoding="utf-8")
        self.assertEqual(lp.splitlines()[0],
                         "sdk.dir=" + ab.escape_properties_path(self.sdk))

    def test_release_flag_collects_release_apk(self):
        patches, _, _, _ = self._standard()
        out = self.tmp / "out-r"
        self.assertEqual(self._run_orch(["-r", "-o", str(out)], **patches), 0)
        self.assertEqual((out / "app-release.apk").read_bytes(), b"APKDATA-RELEASE")

    def test_skip_sdk_bypasses_ensure_sdk(self):
        patches, ensure, _, _ = self._standard()
        out = self.tmp / "out-skip"
        code = self._run_orch(["--skip-sdk", "-o", str(out)], **patches,
                              sdk_root=mock.MagicMock(return_value=self.sdk))
        self.assertEqual(code, 0)
        ensure.assert_not_called()
        self.assertTrue((out / "app-debug.apk").exists())

    def test_skip_web_bypasses_web_build(self):
        patches, _, build, _ = self._standard()
        out = self.tmp / "out-web"
        code = self._run_orch(["--skip-web", "-o", str(out)], **patches)
        self.assertEqual(code, 0)
        build.assert_not_called()

    def test_missing_project_exits_2(self):
        patches, *_ = self._standard()
        patches["_find_project"] = mock.MagicMock(return_value=None)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 2)

    def test_missing_android_dir_without_npx_exits_2(self):
        patches, *_ = self._standard()
        patches["_find_project"] = mock.MagicMock(return_value=self.proj2)
        patches["_npx"] = mock.MagicMock(return_value=None)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 2)

    def test_cap_add_failure_exits_1(self):
        patches, *_ = self._standard()
        run = mock.MagicMock(return_value=1)
        patches["_find_project"] = mock.MagicMock(return_value=self.proj2)
        patches["_npx"] = mock.MagicMock(return_value="npx.cmd")
        patches["_run"] = run
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 1)
        self.assertEqual(run.call_args.args[0], ["npx.cmd", "cap", "add", "android"])

    def test_missing_jdk_exits_2(self):
        patches, *_ = self._standard()
        patches["_check_jdk"] = mock.MagicMock(return_value=None)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 2)

    def test_sdk_provisioning_failure_exits_2(self):
        patches, *_ = self._standard()
        patches["_ensure_sdk"] = mock.MagicMock(return_value=None)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 2)

    def test_local_properties_failure_exits_1(self):
        patches, *_ = self._standard()
        patches["write_local_properties"] = mock.MagicMock(return_value=False)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 1)

    def test_web_build_failure_exits_1(self):
        patches, *_ = self._standard()
        patches["_build_web"] = mock.MagicMock(return_value=False)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 1)

    def test_gradle_failure_exits_1(self):
        patches, *_ = self._standard()
        patches["_assemble"] = mock.MagicMock(return_value=False)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 1)

    def test_collect_failure_exits_1(self):
        patches, *_ = self._standard()
        patches["_collect_apk"] = mock.MagicMock(return_value=None)
        self.assertEqual(self._run_orch(["-o", str(self.tmp / "o")], **patches), 1)


if __name__ == "__main__":
    unittest.main()
