#!/usr/bin/env python3
"""``khy_platform._detect_version`` 的单元测试。

版本解析有三层：
1. ``importlib.metadata.version("khy-os")`` —— 已安装分布元数据（pip 渠道）；
2. 仓库根 ``pyproject.toml`` 的 ``[project] version`` —— 源码检出回退；
3. 都拿不到时返回 ``"0.0.0+unknown"``。

各分支通过 mock ``importlib.metadata.version`` 与替换模块 ``__file__``
（决定第 2 层读哪个 pyproject）注入 fake 场景，不触碰真实安装状态。

跑法（零依赖，不需要 pytest）::

    python -m unittest discover -s platform/tests -t platform/tests
"""

from __future__ import annotations

import importlib.metadata
import os
import sys
import tempfile
import unittest
from pathlib import Path

# 让测试能脱离安装状态直接跑：把 platform/ 加进导入路径。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# 某些便携/嵌入式 Python 布局把 C 扩展（.pyd）放在可执行文件目录，只有直接
# `python` 启动才会把该目录放进 sys.path；`python -m coverage run` 会丢掉这项，
# 导致 `unittest.mock`（传递导入 asyncio -> _overlapped）加载失败。防御性补回。
_exe_dir = os.path.dirname(sys.executable)
if _exe_dir not in sys.path:
    sys.path.insert(0, _exe_dir)

from unittest import mock  # noqa: E402  # 必须在上面补全 sys.path 之后导入

import khy_platform  # noqa: E402


def _fake_package_root(tmp: str, pyproject: str = None) -> str:
    """造一棵 fake 包树，让 ``_detect_version`` 第 2 层读我们写的 pyproject。

    布局与真实一致：``<root>/platform/khy_platform/__init__.py``，
    ``parents[2] == <root>``（与源码检出的相对位置相同）。
    """
    pkg = Path(tmp) / "platform" / "khy_platform"
    pkg.mkdir(parents=True)
    if pyproject is not None:
        (Path(tmp) / "pyproject.toml").write_text(pyproject, encoding="utf-8")
    return str(pkg / "__init__.py")


class MetadataHitTest(unittest.TestCase):
    """第 1 层：安装元数据命中时直接返回，不碰 pyproject。"""

    def test_installed_metadata_wins(self):
        with mock.patch.object(
                importlib.metadata, "version", return_value="9.9.9-test") as fake:
            got = khy_platform._detect_version()
        self.assertEqual(got, "9.9.9-test")
        fake.assert_called_once_with("khy-os")

    def test_version_attribute_is_resolved(self):
        # 包导入时就用同一逻辑解析了 __version__，必须是非空字符串。
        self.assertIsInstance(khy_platform.__version__, str)
        self.assertTrue(khy_platform.__version__)


class PyprojectFallbackTest(unittest.TestCase):
    """第 2 层：安装元数据缺失时，从仓库根 pyproject.toml 解析版本。"""

    def _miss(self):
        return mock.patch.object(
            importlib.metadata, "version",
            side_effect=importlib.metadata.PackageNotFoundError("khy-os"))

    def test_source_checkout_reads_repo_pyproject(self):
        with self._miss():
            got = khy_platform._detect_version()
        self.assertNotEqual(got, "0.0.0+unknown")
        # 与真源 pyproject 的 [project] version 交叉验证。
        try:
            import tomllib
            pyproject = Path(khy_platform.__file__).resolve().parents[2] / "pyproject.toml"
            expected = tomllib.loads(pyproject.read_text(encoding="utf-8"))[
                "project"]["version"]
        except Exception:
            self.skipTest("pyproject.toml 缺失或不可解析")
        self.assertEqual(got, expected)

    def test_fake_pyproject_version_is_extracted(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_file = _fake_package_root(
                tmp, '[project]\nname = "khy-os"\nversion = "4.5.6"\n')
            with self._miss(), \
                 mock.patch.object(khy_platform, "__file__", fake_file):
                self.assertEqual(khy_platform._detect_version(), "4.5.6")

    def test_version_only_from_project_section(self):
        # 别的 section（如 [tool.x]）里恰好有 version = "..." 不能误读。
        with tempfile.TemporaryDirectory() as tmp:
            text = ('[tool.khy]\nversion = "0.0.1"\n\n'
                    '[project]\nname = "khy-os"\nversion = "7.7.7"\n')
            fake_file = _fake_package_root(tmp, text)
            with self._miss(), \
                 mock.patch.object(khy_platform, "__file__", fake_file):
                self.assertEqual(khy_platform._detect_version(), "7.7.7")


class UnknownVersionTest(unittest.TestCase):
    """第 3 层兜底：一切来源都失败时返回 0.0.0+unknown，绝不抛。"""

    def _miss(self):
        return mock.patch.object(
            importlib.metadata, "version",
            side_effect=importlib.metadata.PackageNotFoundError("khy-os"))

    def test_missing_pyproject_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_file = _fake_package_root(tmp)  # 无 pyproject.toml
            with self._miss(), \
                 mock.patch.object(khy_platform, "__file__", fake_file):
                self.assertEqual(khy_platform._detect_version(), "0.0.0+unknown")

    def test_project_section_without_version_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_file = _fake_package_root(tmp, '[project]\nname = "khy-os"\n')
            with self._miss(), \
                 mock.patch.object(khy_platform, "__file__", fake_file):
                self.assertEqual(khy_platform._detect_version(), "0.0.0+unknown")

    def test_no_project_section_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_file = _fake_package_root(tmp, '[tool.other]\nkey = "v"\n')
            with self._miss(), \
                 mock.patch.object(khy_platform, "__file__", fake_file):
                self.assertEqual(khy_platform._detect_version(), "0.0.0+unknown")

    def test_unreadable_pyproject_is_unknown(self):
        # pyproject.toml 是个目录 -> read_text 抛 OSError，仍须兜底。
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "pyproject.toml").mkdir()
            fake_file = _fake_package_root(tmp)
            with self._miss(), \
                 mock.patch.object(khy_platform, "__file__", fake_file):
                self.assertEqual(khy_platform._detect_version(), "0.0.0+unknown")


if __name__ == "__main__":
    unittest.main()
