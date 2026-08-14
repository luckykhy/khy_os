"""khyos 生态应用接入标准（Ecosystem App Protocol）。

本模块是 khyos「生态底座」对外定义的**唯一**应用接入契约，提供三件事：

1. 路径标准（数据主权与物理隔离）：
   - 底座归属 ``~/.khyos/{data,cache,models,logs}``。
   - 应用归属 ``~/.<app>/{data,cache,models,logs}``（如 ``~/.khyquant/``）。
   - 底座与应用各自独立，禁止互相直接读写对方的数据目录。

2. 应用生命周期协议：基类 :class:`KhyApp` 定义独立/生态双模初始化入口。

3. 动态发现机制：:func:`discover_apps` 通过 ``importlib.metadata`` 的
   ``khyos.apps`` entry_points + 注册表目录扫描发现已安装应用；
   **有则加载、无则跳过、任何单个应用解析失败都不会让底座崩溃**。

设计红线：本模块只依赖 Python 标准库与 khyos 自身，**绝不 import 任何应用包**
（khyquant 或未来应用），从而保证底座对应用的零依赖。
"""

from __future__ import annotations

import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

try:  # Python 3.8+ 自带；旧环境回退到 backport
    from importlib import metadata as importlib_metadata
except ImportError:  # pragma: no cover - 极旧环境
    import importlib_metadata  # type: ignore


# ---------------------------------------------------------------------------
# 生态常量
# ---------------------------------------------------------------------------

#: 应用通过 pyproject ``[project.entry-points."khyos.apps"]`` 声明接入点的标准组名。
KHYOS_APP_ENTRYPOINT_GROUP = "khyos.apps"

#: 底座 home 目录名（``~/.khyos``）。
BASE_HOME_DIRNAME = ".khyos"

#: 每个 home 下标准子目录——数据/缓存/模型/日志，强制物理隔离。
STANDARD_SUBDIRS = ("data", "cache", "models", "logs")


# ---------------------------------------------------------------------------
# 路径标准：底座与应用各自独立的 home
# ---------------------------------------------------------------------------

def _home_root() -> Path:
    """用户主目录（尊重 $HOME，便于测试覆盖）。"""
    return Path(os.path.expanduser("~"))


def base_home() -> Path:
    """底座 home：``~/.khyos``。"""
    return _home_root() / BASE_HOME_DIRNAME


def app_home(app_name: str) -> Path:
    """应用 home：``~/.<app_name>``。

    应用名做最小净化（去掉前导点与路径分隔符），避免越权到其它目录。
    """
    safe = app_name.strip().lstrip(".").replace("/", "_").replace("\\", "_")
    if not safe:
        raise ValueError("app_name 不能为空")
    return _home_root() / f".{safe}"


def base_data_dir() -> Path:
    """底座数据目录：``~/.khyos/data``（``khyos.db`` 归属于此）。"""
    return base_home() / "data"


def ensure_home(home: Path) -> Path:
    """确保 home 及其标准子目录存在，返回 home。失败不抛（保持启动韧性）。"""
    try:
        for sub in STANDARD_SUBDIRS:
            (home / sub).mkdir(parents=True, exist_ok=True)
    except OSError:
        # 目录创建失败不应阻断启动；调用方按需降级。
        pass
    return home


# ---------------------------------------------------------------------------
# 应用清单（Manifest）：注册表与发现结果的统一数据结构
# ---------------------------------------------------------------------------

@dataclass
class AppManifest:
    """一个已发现应用的标准清单。"""

    name: str
    version: str = "0.0.0"
    description: str = ""
    #: 应用入口（entry_points 的 ``module:attr`` 或注册表中的可执行/脚本路径）。
    entry: str = ""
    #: 暴露给底座 CLI 的命令别名。
    commands: List[str] = field(default_factory=list)
    #: 发现来源：``entry_points`` | ``registry``。
    source: str = "registry"
    #: 其余非标准字段原样保留，避免信息丢失。
    extra: Dict[str, Any] = field(default_factory=dict)

    @property
    def data_home(self) -> Path:
        """该应用的独立 home（``~/.<name>``）。"""
        return app_home(self.name)

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "AppManifest":
        known = {"name", "version", "description", "entry", "commands", "source"}
        name = str(raw.get("name") or "").strip()
        if not name:
            raise ValueError("manifest 缺少 name 字段")
        commands = raw.get("commands") or []
        if not isinstance(commands, list):
            commands = [str(commands)]
        return cls(
            name=name,
            version=str(raw.get("version", "0.0.0")),
            description=str(raw.get("description", "")),
            entry=str(raw.get("entry", "")),
            commands=[str(c) for c in commands],
            source=str(raw.get("source", "registry")),
            extra={k: v for k, v in raw.items() if k not in known},
        )

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "entry": self.entry,
            "commands": list(self.commands),
            "source": self.source,
        }
        out.update(self.extra)
        return out


# ---------------------------------------------------------------------------
# 应用生命周期协议：所有生态应用应实现的基类
# ---------------------------------------------------------------------------

@dataclass
class EcoContext:
    """生态模式下，底座注入给应用的上下文。

    仅传递路径与元信息，**不**传递底座数据库句柄——跨域取数须走公共 API。
    """

    base_home: Path
    app_home: Path
    invoked_as: str = ""
    extras: Dict[str, Any] = field(default_factory=dict)


class KhyApp(ABC):
    """生态应用生命周期基类（应用接入标准）。

    应用通过 entry_point ``khyos.apps`` 暴露一个返回本类实例的工厂，即可被底座发现。
    两种运行模式由应用自身在启动时感知并切换：

    - **独立模式** ``standalone_init()``：脱离底座运行，应用自备日志/配置等环境。
    - **生态模式** ``eco_init(ctx)``：接入底座，遵循底座生命周期与上下文。
    """

    #: 应用名（须与 home 目录 ``~/.<name>`` 一致）。
    name: str = ""
    #: 应用版本。
    version: str = "0.0.0"

    def home(self) -> Path:
        """应用独立 home，默认 ``~/.<name>``。"""
        return app_home(self.name)

    @abstractmethod
    def standalone_init(self) -> None:
        """独立模式初始化：自建日志/配置/数据目录，提供降级体验。"""

    @abstractmethod
    def eco_init(self, ctx: EcoContext) -> None:
        """生态模式初始化：接入底座注入的上下文与生命周期。"""

    def shutdown(self) -> None:  # 可选钩子
        """优雅收尾（可选）。默认无操作。"""


# ---------------------------------------------------------------------------
# 动态发现机制：有则加载、无则跳过、绝不崩溃
# ---------------------------------------------------------------------------

def _registry_dirs() -> List[Path]:
    """应用注册表目录列表（优先底座归属，兼容历史 app 侧路径）。"""
    dirs = [
        base_home() / "apps",                 # 底座归属（标准）
    ]
    # Portable installs also read <root>/.khy/apps (written by _bootstrap in
    # portable mode instead of the legacy home-dir location).
    try:
        from khy_platform import portable as _portable

        portable_home = _portable.get_portable_data_home()
        if portable_home is not None:
            dirs.append(portable_home / "apps")
    except Exception:
        # Detection must never break app discovery.
        pass
    dirs.append(_home_root() / ".khyquant" / "apps")  # 历史兼容：khyquant 早期写入位置
    return dirs


def _discover_from_registry() -> List[AppManifest]:
    found: List[AppManifest] = []
    for apps_dir in _registry_dirs():
        try:
            if not apps_dir.is_dir():
                continue
            for manifest_file in sorted(apps_dir.glob("*.json")):
                try:
                    raw = json.loads(manifest_file.read_text(encoding="utf-8"))
                    m = AppManifest.from_dict(raw)
                    m.source = "registry"
                    found.append(m)
                except Exception:
                    # 单个清单损坏不影响其它应用的发现。
                    continue
        except OSError:
            continue
    return found


def _discover_from_entrypoints() -> List[AppManifest]:
    found: List[AppManifest] = []
    try:
        eps = importlib_metadata.entry_points()
        # Python 3.10+ 返回 SelectableGroups；3.8/3.9 返回 dict。
        if hasattr(eps, "select"):
            group = eps.select(group=KHYOS_APP_ENTRYPOINT_GROUP)
        else:  # pragma: no cover - 3.8/3.9 路径
            group = eps.get(KHYOS_APP_ENTRYPOINT_GROUP, [])
    except Exception:
        return found

    for ep in group:
        try:
            found.append(AppManifest(
                name=ep.name,
                entry=getattr(ep, "value", "") or "",
                commands=[ep.name],
                source="entry_points",
            ))
        except Exception:
            continue
    return found


def discover_apps() -> List[AppManifest]:
    """发现所有已安装的生态应用。

    合并 entry_points 与注册表两路来源，按 name 去重（entry_points 优先，更权威）。
    本函数对任何单点失败都做吞噬式降级——**底座在没有任何应用时也能正常启动**。
    """
    by_name: Dict[str, AppManifest] = {}
    # 注册表先入，entry_points 后入以覆盖（更权威）。
    for m in _discover_from_registry():
        by_name.setdefault(m.name, m)
    for m in _discover_from_entrypoints():
        by_name[m.name] = m
    return sorted(by_name.values(), key=lambda x: x.name)


def load_app(name: str) -> Optional["KhyApp"]:
    """**懒激活**：仅在用户明确触发某应用时，才解析其 entry_point 并实例化。

    这是 :func:`discover_apps`（只读元数据、零导入）的「重量级初始化」对应面：
    发现阶段绝不 ``import`` 应用包；只有调用本函数时，才通过 entry_point 真正
    ``load()`` 应用工厂并构造实例（应用核心依赖此刻才被加载）。

    任何失败（无此应用 / 工厂导入失败 / 调用异常）都返回 ``None`` 而非抛出，
    保证底座永不因单个应用激活失败而崩溃。
    """
    try:
        eps = importlib_metadata.entry_points()
        if hasattr(eps, "select"):
            group = eps.select(group=KHYOS_APP_ENTRYPOINT_GROUP)
        else:  # pragma: no cover - 3.8/3.9 路径
            group = eps.get(KHYOS_APP_ENTRYPOINT_GROUP, [])
    except Exception:
        return None

    for ep in group:
        if ep.name != name:
            continue
        try:
            factory = ep.load()  # 此刻才导入应用包并构造工厂（重量级）
            instance = factory() if callable(factory) else factory
            return instance
        except Exception:
            # 单个应用激活失败不影响底座；调用方按需降级。
            return None
    return None


def write_manifest(manifest: AppManifest, *, to_base: bool = True) -> Optional[Path]:
    """将应用清单写入底座注册表 ``~/.khyos/apps/<name>.json``。

    返回写入路径；失败返回 ``None``（不抛，注册失败不应阻断安装/启动）。
    """
    apps_dir = (base_home() if to_base else manifest.data_home) / "apps"
    try:
        apps_dir.mkdir(parents=True, exist_ok=True)
        target = apps_dir / f"{manifest.name}.json"
        target.write_text(
            json.dumps(manifest.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        return target
    except OSError:
        return None
