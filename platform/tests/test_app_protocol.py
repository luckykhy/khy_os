#!/usr/bin/env python3
"""``khy_platform.app_protocol``（生态应用接入标准）的单元测试。

覆盖四块：
- 路径标准：``base_home`` / ``app_home`` / ``ensure_home``（home 隔离与净化）；
- 清单数据：``AppManifest`` 的默认值、``from_dict`` / ``to_dict`` 往返与校验；
- 生命周期基类：``KhyApp`` / ``EcoContext``；
- 动态发现：注册表扫描、entry_points（含 3.8/3.9 dict 风格回退）、
  ``load_app`` 懒激活、``write_manifest``。

发现/加载全部用 ``unittest.mock`` 替掉 ``importlib.metadata`` 与
``khy_platform.portable``，**不导入任何真实应用包**——这正是协议红线。

跑法（零依赖，不需要 pytest）::

    python -m unittest discover -s platform/tests -t platform/tests
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
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
from khy_platform import app_protocol as ap  # noqa: E402
from khy_platform.app_protocol import AppManifest, EcoContext, KhyApp  # noqa: E402

# 测量护栏：coverage 的 --include=platform\* 会把测试期间导入的任何 platform
# 模块都算进 TOTAL。本模块的测试只针对 app_protocol（以及包 __init__），
# 不得把 portable / _bootstrap 等无关模块拖进测量范围。预先备好最小假模块：
# 源码里的懒加载（_registry_dirs -> portable）拿到的是假对象，真实 .py 文件
# 从未被 exec，也就不出现在 coverage 报告里。
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


# ---------------------------------------------------------------------------
# 路径标准
# ---------------------------------------------------------------------------
class PathStandardTest(unittest.TestCase):
    """底座与应用 home 的命名与净化规则。"""

    def test_base_home_layout(self):
        self.assertEqual(ap.base_home().name, ".khyos")
        self.assertEqual(ap.base_data_dir().name, "data")
        self.assertEqual(ap.base_data_dir().parent, ap.base_home())

    def test_home_isolated_to_tmp_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with mock.patch.object(ap, "_home_root", return_value=home):
                self.assertEqual(ap.base_home(), home / ".khyos")
                self.assertEqual(ap.base_data_dir(), home / ".khyos" / "data")

    def test_app_home_sanitizes_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with mock.patch.object(ap, "_home_root", return_value=home):
                self.assertEqual(ap.app_home("khyquant"), home / ".khyquant")
                # 前导点必须剥掉，否则 ``../../`` 式名字会越权出 home。
                self.assertEqual(ap.app_home("..khyquant"), home / ".khyquant")
                # 路径分隔符替换为下划线，防止 ``a/b`` 建出嵌套目录。
                self.assertEqual(ap.app_home("a/b\\c"), home / ".a_b_c")

    def test_blank_app_name_rejected(self):
        for raw in ("", ".", "...", "   "):
            with self.assertRaises(ValueError):
                ap.app_home(raw)

    def test_ensure_home_creates_standard_subdirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            got = ap.ensure_home(home)
            self.assertIs(got, home)
            for sub in ap.STANDARD_SUBDIRS:
                self.assertTrue((home / sub).is_dir(), "缺少子目录 {0}".format(sub))

    def test_ensure_home_swallows_mkdir_error(self):
        # 子目录位置被普通文件占住 -> mkdir 抛 OSError，启动仍继续（韧性红线）。
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            home.mkdir()
            (home / "data").write_text("file blocks mkdir", encoding="utf-8")
            self.assertIs(ap.ensure_home(home), home)


# ---------------------------------------------------------------------------
# 清单数据
# ---------------------------------------------------------------------------
class AppManifestTest(unittest.TestCase):
    """from_dict / to_dict 的校验、类型强转与信息保留。"""

    def test_defaults(self):
        m = AppManifest(name="x")
        self.assertEqual(m.version, "0.0.0")
        self.assertEqual(m.description, "")
        self.assertEqual(m.entry, "")
        self.assertEqual(m.commands, [])
        self.assertEqual(m.source, "registry")
        self.assertEqual(m.extra, {})

    def test_data_home_follows_protocol(self):
        m = AppManifest(name="khyquant")
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(ap, "_home_root", return_value=Path(tmp)):
                self.assertEqual(m.data_home, Path(tmp) / ".khyquant")

    def test_from_dict_full(self):
        raw = {
            "name": "alpha", "version": "2.0", "description": "demo",
            "entry": "pkg.mod:App", "commands": ["run", "stop"],
            "source": "registry", "owner": "me",
        }
        m = AppManifest.from_dict(raw)
        self.assertEqual(m.name, "alpha")
        self.assertEqual(m.version, "2.0")
        self.assertEqual(m.description, "demo")
        self.assertEqual(m.entry, "pkg.mod:App")
        self.assertEqual(m.commands, ["run", "stop"])
        # 未知键必须原样保留，避免注册表升级丢信息。
        self.assertEqual(m.extra, {"owner": "me"})

    def test_from_dict_missing_name_raises(self):
        for raw in ({}, {"name": None}, {"name": "   "}):
            with self.assertRaises(ValueError):
                AppManifest.from_dict(raw)

    def test_from_dict_non_list_commands_are_wrapped(self):
        self.assertEqual(AppManifest.from_dict({"name": "a", "commands": "solo"}).commands,
                         ["solo"])
        self.assertEqual(AppManifest.from_dict({"name": "a", "commands": 7}).commands,
                         ["7"])

    def test_from_dict_version_coerced_to_str(self):
        self.assertEqual(AppManifest.from_dict({"name": "a", "version": 3}).version, "3")

    def test_to_dict_round_trips_with_extra(self):
        m = AppManifest.from_dict({"name": "a", "version": "1", "owner": "me"})
        out = m.to_dict()
        self.assertEqual(out, {
            "name": "a", "version": "1", "description": "", "entry": "",
            "commands": [], "source": "registry", "owner": "me"})
        back = AppManifest.from_dict(out)
        self.assertEqual(back.to_dict(), out)

    def test_to_dict_commands_is_a_copy(self):
        m = AppManifest(name="a", commands=["run"])
        m.to_dict()["commands"].append("hacked")
        self.assertEqual(m.commands, ["run"])


# ---------------------------------------------------------------------------
# 生命周期基类
# ---------------------------------------------------------------------------
class _DemoApp(KhyApp):
    name = "demo"
    version = "1.2.3"

    def __init__(self):
        self.events = []

    def standalone_init(self):
        self.events.append("standalone")

    def eco_init(self, ctx):
        self.events.append(ctx)


class KhyAppTest(unittest.TestCase):
    """KhyApp / EcoContext：双模初始化契约。"""

    def test_lifecycle_hooks_and_home(self):
        app = _DemoApp()
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with mock.patch.object(ap, "_home_root", return_value=home):
                self.assertEqual(app.home(), home / ".demo")
        app.standalone_init()
        ctx = EcoContext(home / ".khyos", home / ".demo", invoked_as="khy demo")
        app.eco_init(ctx)
        self.assertEqual(app.events, ["standalone", ctx])
        # shutdown 是可选钩子，默认无操作且不得抛。
        self.assertIsNone(app.shutdown())

    def test_abstract_base_cannot_instantiate(self):
        with self.assertRaises(TypeError):
            KhyApp()

    def test_eco_context_defaults(self):
        ctx = EcoContext(Path("/b"), Path("/a"))
        self.assertEqual(ctx.base_home, Path("/b"))
        self.assertEqual(ctx.app_home, Path("/a"))
        self.assertEqual(ctx.invoked_as, "")
        self.assertEqual(ctx.extras, {})


# ---------------------------------------------------------------------------
# 注册表目录
# ---------------------------------------------------------------------------
class RegistryDirsTest(unittest.TestCase):
    """_registry_dirs：底座 apps + portable 目录（兼容）+ 历史 khyquant 位置。"""

    def _patched(self, portable_return):
        home = Path(tempfile.mkdtemp(prefix="khy-appdirs-"))
        self.addCleanup(shutil.rmtree, str(home), ignore_errors=True)
        fake_portable = mock.Mock(name="portable")
        if isinstance(portable_return, Exception):
            fake_portable.get_portable_data_home.side_effect = portable_return
        else:
            fake_portable.get_portable_data_home.return_value = portable_return
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(ap, "_home_root", return_value=home))
        # 双保险：sys.modules 项 + 包属性，确保 _registry_dirs 里的
        # `from khy_platform import portable` 拿到假对象而非真实模块。
        stack.enter_context(
            mock.patch.dict(sys.modules, {"khy_platform.portable": fake_portable}))
        stack.enter_context(
            mock.patch.object(khy_platform, "portable", fake_portable, create=True))
        return home, stack

    def test_portable_home_added_when_present(self):
        home, stack = self._patched(Path(r"C:\portable-data"))
        with stack:
            dirs = ap._registry_dirs()
        self.assertEqual(dirs, [
            home / ".khyos" / "apps",
            Path(r"C:\portable-data") / "apps",
            home / ".khyquant" / "apps",
        ])

    def test_portable_home_none_keeps_two_dirs(self):
        home, stack = self._patched(None)
        with stack:
            dirs = ap._registry_dirs()
        self.assertEqual(dirs, [home / ".khyos" / "apps", home / ".khyquant" / "apps"])

    def test_portable_probe_failure_is_soft(self):
        home, stack = self._patched(RuntimeError("portable config broken"))
        with stack:
            dirs = ap._registry_dirs()
        # 探测失败绝不能让应用发现崩溃。
        self.assertEqual(dirs, [home / ".khyos" / "apps", home / ".khyquant" / "apps"])


# ---------------------------------------------------------------------------
# 注册表扫描
# ---------------------------------------------------------------------------
class RegistryDiscoverTest(unittest.TestCase):
    """_discover_from_registry：坏清单只跳过自己，不影响其它应用。"""

    def _apps_dir(self, tmp: str) -> Path:
        apps = Path(tmp) / "apps"
        apps.mkdir()
        return apps

    def test_valid_manifest_is_loaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            apps = self._apps_dir(tmp)
            (apps / "a.json").write_text(json.dumps(
                {"name": "alpha", "version": "1", "commands": "run", "owner": "me"}),
                encoding="utf-8")
            with mock.patch.object(ap, "_registry_dirs", return_value=[apps]):
                found = ap._discover_from_registry()
            self.assertEqual([m.name for m in found], ["alpha"])
            m = found[0]
            self.assertEqual(m.source, "registry")
            self.assertEqual(m.commands, ["run"])
            self.assertEqual(m.extra, {"owner": "me"})

    def test_corrupt_and_invalid_manifests_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            apps = self._apps_dir(tmp)
            (apps / "bad.json").write_text("{ not json", encoding="utf-8")
            (apps / "noname.json").write_text(json.dumps({"version": "1"}), encoding="utf-8")
            (apps / "dir.json").mkdir()  # 目录混进 *.json -> 读取抛错同样要跳过
            (apps / "good.json").write_text(json.dumps({"name": "good"}), encoding="utf-8")
            with mock.patch.object(ap, "_registry_dirs", return_value=[apps]):
                found = ap._discover_from_registry()
            self.assertEqual([m.name for m in found], ["good"])

    def test_nonexistent_dir_yields_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(ap, "_registry_dirs",
                                   return_value=[Path(tmp) / "nope"]):
                self.assertEqual(ap._discover_from_registry(), [])

    def test_unreadable_apps_dir_is_skipped(self):
        # 目录本身不可读（权限错误）只跳过该目录，不影响其它注册表位置。
        def _boom(_pattern):
            raise OSError("access denied")
        fake_dir = types.SimpleNamespace(is_dir=lambda: True, glob=_boom)
        with mock.patch.object(ap, "_registry_dirs", return_value=[fake_dir]):
            self.assertEqual(ap._discover_from_registry(), [])


# ---------------------------------------------------------------------------
# entry_points 发现
# ---------------------------------------------------------------------------
class _Ep:
    """importlib.metadata EntryPoint 的最小假对象。"""

    def __init__(self, name, loaded=None, value="pkg.mod:App"):
        self.name = name
        self._loaded = loaded
        self.value = value

    def load(self):
        if isinstance(self._loaded, Exception):
            raise self._loaded
        return self._loaded


class _EpBad:
    """属性访问即抛错的坏 entry point（发现必须吞掉它）。"""

    @property
    def name(self):
        raise RuntimeError("no name")

    @property
    def value(self):
        raise RuntimeError("no value")


class EntrypointsDiscoverTest(unittest.TestCase):
    """_discover_from_entrypoints / load_app：两代 API + 失败吞噬。"""

    @staticmethod
    def _fake_im(eps, raise_exc=False):
        fake = mock.MagicMock(name="importlib_metadata")
        if raise_exc:
            fake.entry_points.side_effect = RuntimeError("metadata exploded")
        else:
            fake.entry_points.return_value = eps
        return mock.patch.object(ap, "importlib_metadata", fake)

    # -- 只读发现（零导入） --------------------------------------------------

    def test_select_style_groups(self):
        ep = _Ep("alpha")
        eps = mock.MagicMock()
        eps.select.return_value = [ep]
        with self._fake_im(eps):
            found = ap._discover_from_entrypoints()
        self.assertEqual(len(found), 1)
        m = found[0]
        self.assertEqual(m.name, "alpha")
        self.assertEqual(m.source, "entry_points")
        self.assertEqual(m.entry, "pkg.mod:App")
        self.assertEqual(m.commands, ["alpha"])

    def test_dict_style_groups(self):
        # Python 3.8/3.9 的 dict 形态回退路径。
        ep = _Ep("beta")
        with self._fake_im({ap.KHYOS_APP_ENTRYPOINT_GROUP: [ep]}):
            found = ap._discover_from_entrypoints()
        self.assertEqual([m.name for m in found], ["beta"])

    def test_metadata_failure_yields_empty(self):
        with self._fake_im(None, raise_exc=True):
            self.assertEqual(ap._discover_from_entrypoints(), [])

    def test_bad_entrypoint_is_skipped(self):
        eps = mock.MagicMock()
        eps.select.return_value = [_EpBad(), _Ep("ok")]
        with self._fake_im(eps):
            found = ap._discover_from_entrypoints()
        self.assertEqual([m.name for m in found], ["ok"])

    # -- 懒激活 ---------------------------------------------------------------

    def test_factory_is_invoked_lazily(self):
        instance = object()
        ep = _Ep("demo", loaded=lambda: instance)
        eps = mock.MagicMock()
        eps.select.return_value = [ep]
        with self._fake_im(eps):
            self.assertIs(ap.load_app("demo"), instance)

    def test_non_callable_load_result_returned_as_is(self):
        ep = _Ep("demo", loaded=42)
        eps = mock.MagicMock()
        eps.select.return_value = [ep]
        with self._fake_im(eps):
            self.assertEqual(ap.load_app("demo"), 42)

    def test_load_failure_is_none(self):
        ep = _Ep("demo", loaded=ImportError("app deps missing"))
        eps = mock.MagicMock()
        eps.select.return_value = [ep]
        with self._fake_im(eps):
            self.assertIsNone(ap.load_app("demo"))

    def test_unknown_app_is_none(self):
        eps = mock.MagicMock()
        eps.select.return_value = [_Ep("other", loaded=lambda: "x")]
        with self._fake_im(eps):
            self.assertIsNone(ap.load_app("demo"))

    def test_metadata_failure_is_none(self):
        with self._fake_im(None, raise_exc=True):
            self.assertIsNone(ap.load_app("demo"))

    def test_dict_style_groups_load(self):
        instance = object()
        ep = _Ep("demo", loaded=lambda: instance)
        with self._fake_im({ap.KHYOS_APP_ENTRYPOINT_GROUP: [ep]}):
            self.assertIs(ap.load_app("demo"), instance)


# ---------------------------------------------------------------------------
# 合并发现
# ---------------------------------------------------------------------------
class DiscoverAppsTest(unittest.TestCase):
    """discover_apps：两路来源合并、entry_points 更权威、按名排序。"""

    def test_entrypoints_override_registry(self):
        reg = [AppManifest(name="alpha", source="registry", entry="reg-a"),
               AppManifest(name="beta", source="registry")]
        eps = [AppManifest(name="alpha", source="entry_points", entry="ep-a")]
        with mock.patch.object(ap, "_discover_from_registry", return_value=reg), \
             mock.patch.object(ap, "_discover_from_entrypoints", return_value=eps):
            found = ap.discover_apps()
        by_name = {m.name: m for m in found}
        self.assertEqual(by_name["alpha"].entry, "ep-a")
        self.assertEqual(by_name["alpha"].source, "entry_points")
        self.assertIn("beta", by_name)
        self.assertEqual([m.name for m in found], ["alpha", "beta"])

    def test_no_sources_means_no_apps(self):
        with mock.patch.object(ap, "_discover_from_registry", return_value=[]), \
             mock.patch.object(ap, "_discover_from_entrypoints", return_value=[]):
            self.assertEqual(ap.discover_apps(), [])


# ---------------------------------------------------------------------------
# 清单写入
# ---------------------------------------------------------------------------
class WriteManifestTest(unittest.TestCase):
    """write_manifest：注册表落盘 + 失败不抛。"""

    def test_write_to_base_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(ap, "base_home", return_value=Path(tmp) / ".khyos"):
                m = AppManifest(name="alpha", version="1.0",
                                entry="pkg.mod:App", commands=["run"])
                target = ap.write_manifest(m, to_base=True)
            self.assertEqual(target, Path(tmp) / ".khyos" / "apps" / "alpha.json")
            saved = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(saved, m.to_dict())
            self.assertEqual(AppManifest.from_dict(saved).to_dict(), m.to_dict())

    def test_write_to_app_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with mock.patch.object(ap, "_home_root", return_value=home):
                target = ap.write_manifest(AppManifest(name="alpha"), to_base=False)
            self.assertEqual(target, home / ".alpha" / "apps" / "alpha.json")
            self.assertTrue(target.is_file())

    def test_write_failure_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "blocker"
            blocker.write_text("file blocks mkdir", encoding="utf-8")
            with mock.patch.object(ap, "base_home", return_value=blocker / ".khyos"):
                self.assertIsNone(ap.write_manifest(AppManifest(name="alpha")))


if __name__ == "__main__":
    unittest.main()
