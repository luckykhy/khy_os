#!/usr/bin/env python3
"""``khy_quant._bootstrap`` 的「空壳依赖」判据单元测试。

背景（2026-09-21 实测故障）：pnpm 风格的布局把 ``node_modules/<pkg>`` 做成指向
``node_modules/.pnpm/<pkg>@<ver>/...`` 的符号链接。一次被中断的安装会留下**空实体**
——链接建好了、包内容没解包。要命的是 ``Path.exists()`` **跟随**符号链接，对这种空
目录一律返回 True，于是旧判据 ``_path_exists_safe(node_modules / "express")`` 说
「已装好」，``npm install`` 被短路，**永不自愈**。

表现还很分裂：CJS ``require()`` 找不到时会向上回退到上层 ``node_modules``，大部分
功能侥幸正常；ESM ``import()`` 不回退，命中空壳直接 ERR_MODULE_NOT_FOUND（TUI 的
``ink`` 就这样炸）。

因此判据必须是**跟随链接后能读到 package.json**，而不是路径存在。

跑法（零依赖，不需要 pytest）::

    python -m unittest discover -s software/khyquant/tests -t software/khyquant/tests
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

# 直接按文件路径加载被测模块，避免依赖 khy_quant 包的 __init__ 副作用
_MOD_PATH = Path(__file__).resolve().parents[1] / "khy_quant" / "_bootstrap.py"
_spec = importlib.util.spec_from_file_location("khy_quant_bootstrap_under_test", _MOD_PATH)
_bootstrap = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _bootstrap
_spec.loader.exec_module(_bootstrap)


class PackageIntactTests(unittest.TestCase):
    """``_package_intact``：跟随符号链接后须含 package.json。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="khy-bootstrap-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def test_missing_path_is_not_intact(self):
        self.assertFalse(_bootstrap._package_intact(self.tmp / "nope"))

    def test_hollow_dir_is_not_intact(self):
        """核心回归守卫：空目录 exists() 为真，但 intact() 必须为假。"""
        hollow = self.tmp / "express"
        hollow.mkdir()
        self.assertTrue(_bootstrap._path_exists_safe(hollow), "前提：exists() 对空目录返回真")
        self.assertFalse(_bootstrap._package_intact(hollow), "空目录不得判为完好")

    def test_dir_with_package_json_is_intact(self):
        pkg = self.tmp / "express"
        pkg.mkdir()
        (pkg / "package.json").write_text('{"name":"express"}', encoding="utf-8")
        self.assertTrue(_bootstrap._package_intact(pkg))

    def test_package_json_as_dir_does_not_count(self):
        """package.json 如果是目录（畸形），不算完好。"""
        pkg = self.tmp / "express"
        (pkg / "package.json").mkdir(parents=True)
        self.assertFalse(_bootstrap._package_intact(pkg))

    @unittest.skipUnless(hasattr(Path, "symlink_to"), "平台不支持符号链接")
    def test_symlink_to_hollow_target_is_not_intact(self):
        """复现本次故障的形态：符号链接 -> 空实体，exists() 真、intact() 假。"""
        store = self.tmp / "store"
        store.mkdir()
        link = self.tmp / "link-to-hollow"
        try:
            link.symlink_to(store, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("无权限创建符号链接（Windows 需开发者模式）")
        self.assertTrue(_bootstrap._path_exists_safe(link), "前提：exists() 跟随链接返回真")
        self.assertFalse(_bootstrap._package_intact(link), "指向空实体的链接不得判为完好")

    @unittest.skipUnless(hasattr(Path, "symlink_to"), "平台不支持符号链接")
    def test_symlink_to_intact_target_is_intact(self):
        store = self.tmp / "store-ok"
        store.mkdir()
        (store / "package.json").write_text('{"name":"x"}', encoding="utf-8")
        link = self.tmp / "link-to-ok"
        try:
            link.symlink_to(store, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("无权限创建符号链接（Windows 需开发者模式）")
        # Windows 在无开发者模式时会静默降级为「复制/联接」而非真符号链接，
        # 这时 is_symlink() 为假、内容可能为空 —— 前提不成立，跳过而不是误判。
        if not link.is_symlink():
            self.skipTest("本机 symlink_to 未被实现为真符号链接（Windows 无开发者模式时降级）")
        self.assertTrue(_bootstrap._package_intact(link))

    def test_broken_symlink_is_not_intact(self):
        """链接目标不存在时 exists() 为假、intact() 也为假，且绝不抛。"""
        link = self.tmp / "broken"
        try:
            link.symlink_to(self.tmp / "does-not-exist", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("无权限创建符号链接")
        self.assertFalse(_bootstrap._package_intact(link))


class RequiredPackagesTests(unittest.TestCase):
    """``_REQUIRED_PACKAGES`` 必须覆盖「缺了起不来」的包。"""

    def test_express_present(self):
        self.assertIn("express", _bootstrap._REQUIRED_PACKAGES)

    def test_ink_present(self):
        """ink 是 ESM-only 的 TUI 渲染器，空壳时 CJS 侥幸、ESM 必炸。"""
        self.assertIn("ink", _bootstrap._REQUIRED_PACKAGES)

    def test_no_duplicates(self):
        pkgs = list(_bootstrap._REQUIRED_PACKAGES)
        self.assertEqual(len(pkgs), len(set(pkgs)))

    def test_required_packages_are_declared_by_backend(self):
        """反漂移：每个被探测的包必须真是 backend 的运行时依赖。

        否则判据会去检查一个根本不该存在的包，永远误报「未装齐」。
        """
        import json

        # 逐级上溯找仓库根（不硬编码层数，检出布局变了也不会静默失效）
        manifest = None
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "services" / "backend" / "package.json"
            if candidate.is_file():
                manifest = candidate
                break
        if manifest is None:
            self.skipTest("未找到 services/backend/package.json（非同仓检出）")
        pkg = json.loads(manifest.read_text(encoding="utf-8"))
        deps = {**pkg.get("dependencies", {}), **pkg.get("optionalDependencies", {})}
        for name in _bootstrap._REQUIRED_PACKAGES:
            self.assertIn(
                name,
                deps,
                f'漂移：_REQUIRED_PACKAGES 的 "{name}" 不在 backend 运行时依赖里。'
                "依赖若已改名/移除，请同步更新 software/khyquant/khy_quant/_bootstrap.py。",
            )


class EnsureNpmInstallProbeTests(unittest.TestCase):
    """``_ensure_npm_install`` 的空壳探针不得被空实体短路。

    不真跑 npm：只验证判据本身对「全好 / 有空壳」给出不同结论，且绝不抛。
    """
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="khy-npm-probe-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.nm = self.tmp / "node_modules"

    def _hollow(self):
        """返回需要重装的包名列表（与 _ensure_npm_install 内的探针同式）。"""
        return [p for p in _bootstrap._REQUIRED_PACKAGES if not _bootstrap._package_intact(self.nm / p)]

    def test_all_hollow(self):
        for p in _bootstrap._REQUIRED_PACKAGES:
            (self.nm / p).mkdir(parents=True)
        self.assertEqual(sorted(self._hollow()), sorted(_bootstrap._REQUIRED_PACKAGES))

    def test_all_intact(self):
        for p in _bootstrap._REQUIRED_PACKAGES:
            (self.nm / p).mkdir(parents=True)
            (self.nm / p / "package.json").write_text("{}", encoding="utf-8")
        self.assertEqual(self._hollow(), [])

    def test_partial_hollow_reports_only_the_hollow_one(self):
        first, second = _bootstrap._REQUIRED_PACKAGES[0], _bootstrap._REQUIRED_PACKAGES[1]
        (self.nm / first).mkdir(parents=True)
        (self.nm / first / "package.json").write_text("{}", encoding="utf-8")
        (self.nm / second).mkdir(parents=True)  # 空壳
        self.assertEqual(self._hollow(), [second])

    def test_no_node_modules_at_all(self):
        self.assertEqual(sorted(self._hollow()), sorted(_bootstrap._REQUIRED_PACKAGES))

    def test_never_raises_on_weird_input(self):
        """探针在畸形路径下绝不抛（bootstrap 在首启路径上，崩了会连带拖死安装）。"""
        weird = self.tmp / "a" / "b" / "c"  # 父目录都不存在
        self.assertFalse(_bootstrap._package_intact(weird))
        self.assertFalse(_bootstrap._path_exists_safe(weird))


class RealisticJunctionLayoutTests(unittest.TestCase):
    """用 Windows junction 复现真实的 pnpm 布局，验证判据真的能挑出空壳。

    Windows 上 ``symlink_to`` 在无开发者模式时会降级（``is_symlink()`` 为假），
    但 ``mklink /J`` 创建的 junction 无视权限即可用，且 ``Path.exists()`` / ``is_file()``
    对它的行为与真符号链接一致 —— 正好用来重现「链接在、实体空」这一形态。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="khy-junction-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.nm = self.tmp / "node_modules"
        self.nm.mkdir()

    @staticmethod
    def _make_junction(link: Path, target: Path) -> bool:
        import subprocess

        try:
            # errors='replace'：mklink 在中文 Windows 上输出 GBK，用 utf-8 解码会抛
            # UnicodeDecodeError（在 reader 线程里，会把噪音打到测试输出）。
            proc = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            return proc.returncode == 0
        except (OSError, ValueError):
            return False

    def test_junction_to_empty_store_is_hollow(self):
        """本次故障的精确形态：node_modules/<pkg> -> .pnpm/<pkg>@ver/...（空实体）。"""
        store = self.tmp / ".pnpm" / "ink@6.8.0" / "node_modules" / "ink"
        store.mkdir(parents=True)  # 建了链接、没解包内容 ⇒ 空实体
        link = self.nm / "ink"
        if not self._make_junction(link, store):
            self.skipTest("无法创建 junction（非 Windows 或权限受限）")

        self.assertTrue(_bootstrap._path_exists_safe(link), "前提：exists() 跟随链接返回真")
        self.assertFalse(_bootstrap._package_intact(link), "空实体 junction 必须判为不完好")
        # 关键：正是这个组合让旧判据短路了 npm install
        self.assertNotEqual(
            _bootstrap._path_exists_safe(link), _bootstrap._package_intact(link),
            "旧判据(exists)与新判据(intact)在此形态下必须分歧，否则回归未被修复",
        )

    def test_junction_to_intact_store_is_intact(self):
        store = self.tmp / ".pnpm" / "express@4.22.2" / "node_modules" / "express"
        store.mkdir(parents=True)
        (store / "package.json").write_text('{"name":"express"}', encoding="utf-8")
        link = self.nm / "express"
        if not self._make_junction(link, store):
            self.skipTest("无法创建 junction（非 Windows 或权限受限）")
        self.assertTrue(_bootstrap._package_intact(link), "完好实体 junction 必须判为完好")


if __name__ == "__main__":
    unittest.main()
