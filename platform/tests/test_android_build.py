#!/usr/bin/env python3
# @pattern Template Method

"""``khy build android`` 编排器的单元测试。

跑法（零依赖，不需要 pytest）::

    python -m unittest discover -s platform/tests -t platform/tests

为什么放在 ``platform/tests/`` 而不是 ``platform/khy_platform/``：
后者是要打进 wheel 的包目录，测试不该随包分发给用户。

覆盖的是**纯函数**：参数解析、版本锁解析、properties 转义、工程识别、
组件缺失判定。真正会下载 SDK / 跑 gradle 的函数不在这里跑——那是构建验证
的事，单测只保证「编排的判断逻辑」不出错。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

# 让测试能脱离安装状态直接跑：把 platform/ 加进导入路径。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from khy_platform import android_build as ab  # noqa: E402


class ParseArgsTest(unittest.TestCase):
    """flags 解析：默认值、别名、非法输入。"""

    def test_defaults_are_debug_build(self):
        opts = ab._parse_args([])
        self.assertFalse(opts["release"])
        self.assertFalse(opts["skip_web"])
        self.assertFalse(opts["skip_sdk"])
        self.assertFalse(opts["verbose"])
        self.assertIsNone(opts["output"])

    def test_short_and_long_aliases_agree(self):
        self.assertTrue(ab._parse_args(["-r"])["release"])
        self.assertTrue(ab._parse_args(["--release"])["release"])
        self.assertTrue(ab._parse_args(["-v"])["verbose"])

    def test_debug_flag_overrides_release(self):
        # 后出现的选项赢，用户可以用 --debug 抵消脚本里预设的 --release。
        self.assertFalse(ab._parse_args(["--release", "--debug"])["release"])

    def test_output_accepts_both_forms(self):
        self.assertEqual(ab._parse_args(["-o", "out/apk"])["output"], "out/apk")
        self.assertEqual(ab._parse_args(["--output=out/apk"])["output"], "out/apk")

    def test_unknown_flag_is_rejected(self):
        # 返回 None 而不是忽略：静默吞掉拼错的选项会让用户以为它生效了。
        self.assertIsNone(ab._parse_args(["--relase"]))

    def test_output_without_value_is_rejected(self):
        self.assertIsNone(ab._parse_args(["--output"]))


class VersionLockTest(unittest.TestCase):
    """版本锁：pyproject 真源、内置兜底、环境变量覆盖。"""

    def test_pyproject_table_is_parsed(self):
        text = (
            '[project]\nname = "khy-os"\n\n'
            '[tool.khyos.android]\n'
            'compile_sdk = "36"\n'
            'build_tools = "35.0.0"\n'
            'ndk = ""\n\n'
            '[tool.setuptools]\n'
            'packages = ["khy_platform"]\n'
        )
        table = ab._parse_android_table(text)
        self.assertEqual(table["compile_sdk"], "36")
        self.assertEqual(table["build_tools"], "35.0.0")
        self.assertEqual(table["ndk"], "")
        # 表在下一个 [section] 处必须停住，否则会把别人的键读进来。
        self.assertNotIn("packages", table)

    def test_missing_table_yields_empty(self):
        self.assertEqual(ab._parse_android_table('[project]\nname = "x"\n'), {})

    def test_defaults_match_pyproject(self):
        """内置兜底必须与 pyproject 真源逐字一致。

        pip 安装后 pyproject.toml 不随 wheel 分发，``_DEFAULT_LOCK`` 就是那时的
        唯一来源。两处漂移会造成「源码检出能装的 SDK，pip 用户装不上」。
        """
        pyproject = Path(__file__).resolve().parent.parent.parent / "pyproject.toml"
        if not pyproject.exists():
            self.skipTest("非源码检出，无 pyproject.toml")
        table = ab._parse_android_table(pyproject.read_text(encoding="utf-8"))
        self.assertTrue(table, "pyproject.toml 缺少 [tool.khyos.android] 表")
        for key, value in ab._DEFAULT_LOCK.items():
            self.assertEqual(table.get(key), value, "版本锁键 {0} 与 pyproject 不一致".format(key))

    def test_env_override_wins(self):
        os.environ["KHY_ANDROID_BUILD_TOOLS"] = "34.0.0"
        try:
            self.assertEqual(ab._lock()["build_tools"], "34.0.0")
        finally:
            os.environ.pop("KHY_ANDROID_BUILD_TOOLS", None)

    def test_blank_env_does_not_override(self):
        # 空字符串是「没设置」而不是「设成空」，否则 shell 里残留的空变量会把
        # compile_sdk 清成空串，拼出 platforms;android- 这种非法组件名。
        os.environ["KHY_ANDROID_COMPILE_SDK"] = "   "
        try:
            self.assertEqual(ab._lock()["compile_sdk"], ab._DEFAULT_LOCK["compile_sdk"])
        finally:
            os.environ.pop("KHY_ANDROID_COMPILE_SDK", None)


class PropertiesEscapeTest(unittest.TestCase):
    """Java .properties 转义——写错这里 gradle 会报和 SDK 无关的怪错。"""

    def test_windows_path_escapes_colon_and_backslashes(self):
        got = ab.escape_properties_path(Path(r"C:\Users\alice\.khyos\android_sdk"))
        self.assertEqual(got, r"C\:\\Users\\alice\\.khyos\\android_sdk")

    def test_posix_path_needs_no_escaping(self):
        # 不经 Path（Windows 上 Path 会把 / 归一成 \），只验证转义规则本身：
        # POSIX 路径里没有冒号也没有反斜杠，转义后必须逐字不变。
        self.assertEqual(ab.escape_properties_path("/home/alice/.khyos/android_sdk"),
                         "/home/alice/.khyos/android_sdk")

    def test_write_replaces_stale_sdk_dir_and_keeps_other_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = Path(tmp)
            target = android / "local.properties"
            target.write_text("sdk.dir=/gone/old/sdk\nndk.dir=/opt/ndk\n", encoding="utf-8")

            new_sdk = Path(tmp) / "new-sdk"
            self.assertTrue(ab.write_local_properties(android, new_sdk))
            lines = target.read_text(encoding="utf-8").splitlines()
            self.assertEqual(lines[0], "sdk.dir=" + ab.escape_properties_path(new_sdk))
            self.assertIn("ndk.dir=/opt/ndk", lines)
            self.assertEqual(len([ln for ln in lines if ln.startswith("sdk.dir")]), 1)

    def test_write_creates_file_when_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            android = Path(tmp)
            new_sdk = Path(tmp) / "new-sdk"
            self.assertTrue(ab.write_local_properties(android, new_sdk))
            self.assertEqual((android / "local.properties").read_text(encoding="utf-8"),
                             "sdk.dir=" + ab.escape_properties_path(new_sdk) + "\n")


class ProjectDiscoveryTest(unittest.TestCase):
    """工程识别看配置文件而非目录名——目录可以被搬走或改名。"""

    def test_directory_with_capacitor_config_is_a_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            self.assertFalse(ab._is_capacitor_project(project))
            (project / "capacitor.config.ts").write_text("export default {};", encoding="utf-8")
            self.assertTrue(ab._is_capacitor_project(project))

    def test_nonexistent_path_is_not_a_project(self):
        self.assertFalse(ab._is_capacitor_project(Path(tempfile.gettempdir()) / "khy-no-such-dir"))

    def test_env_override_is_first_candidate(self):
        os.environ["KHY_ANDROID_PROJECT"] = "/custom/mobile"
        try:
            self.assertEqual(ab._project_candidates()[0], Path("/custom/mobile"))
        finally:
            os.environ.pop("KHY_ANDROID_PROJECT", None)

    def test_source_checkout_is_preferred_by_default(self):
        os.environ.pop("KHY_ANDROID_PROJECT", None)
        self.assertEqual(ab._project_candidates()[0].name, "khy-mobile")


class SdkPackagesTest(unittest.TestCase):
    """只装缺的组件：已装齐时必须一个都不报，否则每次构建都白跑 sdkmanager。"""

    LOCK = {"compile_sdk": "36", "build_tools": "35.0.0", "cmdline_tools": "13114758", "ndk": ""}

    def test_empty_sdk_reports_all_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = ab._missing_packages(Path(tmp), self.LOCK)
            self.assertEqual(missing,
                             ["platform-tools", "platforms;android-36", "build-tools;35.0.0"])

    def test_complete_sdk_reports_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "platform-tools").mkdir()
            (root / "platforms" / "android-36").mkdir(parents=True)
            (root / "build-tools" / "35.0.0").mkdir(parents=True)
            self.assertEqual(ab._missing_packages(root, self.LOCK), [])

    def test_blank_ndk_is_never_requested(self):
        # ndk = "" 表示「不需要」，不能被拼成 "ndk;" 这种非法组件名。
        with tempfile.TemporaryDirectory() as tmp:
            self.assertNotIn("ndk;", " ".join(ab._missing_packages(Path(tmp), self.LOCK)))

    def test_pinned_ndk_is_requested_when_absent(self):
        lock = dict(self.LOCK, ndk="27.0.12077973")
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIn("ndk;27.0.12077973", ab._missing_packages(Path(tmp), lock))

    def test_sdk_root_respects_android_sdk_root(self):
        os.environ["ANDROID_SDK_ROOT"] = "/opt/android"
        try:
            self.assertEqual(ab.sdk_root(), Path("/opt/android"))
        finally:
            os.environ.pop("ANDROID_SDK_ROOT", None)

    def test_sdk_root_defaults_under_base_home(self):
        for key in ("ANDROID_SDK_ROOT", "ANDROID_HOME"):
            os.environ.pop(key, None)
        root = ab.sdk_root()
        # 生态路径红线：底座只写 ~/.khyos，绝不落在应用目录里。
        self.assertEqual(root.name, "android_sdk")
        self.assertEqual(root.parent.name, ".khyos")


class SafeExtractTest(unittest.TestCase):
    """解压必须拒绝逃逸出目标目录的成员（CVE-2007-4559 类路径穿越）。"""

    def test_traversal_member_is_rejected(self):
        import zipfile

        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "evil.zip"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("../escaped.txt", "pwned")
            dest = Path(tmp) / "dest"
            self.assertFalse(ab._safe_extract_zip(archive, dest))
            self.assertFalse((Path(tmp) / "escaped.txt").exists())

    def test_normal_member_extracts(self):
        import zipfile

        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "ok.zip"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("cmdline-tools/bin/sdkmanager", "#!/bin/sh\n")
            dest = Path(tmp) / "dest"
            self.assertTrue(ab._safe_extract_zip(archive, dest))
            self.assertTrue((dest / "cmdline-tools" / "bin" / "sdkmanager").exists())


class EntryPointTest(unittest.TestCase):
    """入口的退出码契约：cli.py 直接把它 sys.exit 出去。"""

    def test_help_exits_zero(self):
        self.assertEqual(ab.run_android_build(["--help"]), 0)

    def test_bad_flag_exits_two(self):
        # 2 = 用法/前置依赖问题，1 = 构建真的失败。区分开才好做脚本判断。
        self.assertEqual(ab.run_android_build(["--nope"]), 2)


if __name__ == "__main__":
    unittest.main()
