"""khyquant 作为 khyos 生态应用的接入适配（示范实现）。

本模块把 khyquant 暴露为符合 ``khy_platform.app_protocol.KhyApp`` 协议的应用：
- 通过 ``pyproject.toml`` 的 ``[project.entry-points."khyos.apps"]`` 被底座发现；
- 实现独立/生态双模初始化。

设计：对底座标准模块的导入做守卫——khyquant 独立安装（无 khyos）时，import 本模块
不应崩溃；只有当底座真正调用工厂时才需要底座在场（届时 app_protocol 必然可用）。
"""

from __future__ import annotations

import os
from pathlib import Path

try:  # 底座在场时复用其标准；独立安装无底座时降级。
    from khy_platform.app_protocol import KhyApp, EcoContext, app_home, ensure_home
    _BASE_AVAILABLE = True
except Exception:  # pragma: no cover - 独立模式无底座
    _BASE_AVAILABLE = False
    KhyApp = object  # type: ignore
    EcoContext = object  # type: ignore

    def app_home(name: str) -> Path:  # type: ignore
        return Path(os.path.expanduser("~")) / f".{name}"

    def ensure_home(home: Path) -> Path:  # type: ignore
        for sub in ("data", "cache", "models", "logs"):
            try:
                (home / sub).mkdir(parents=True, exist_ok=True)
            except OSError:
                pass
        return home


class KhyQuant(KhyApp):
    """khyquant 生态应用入口（量化交易终端）。"""

    name = "khyquant"

    @property
    def version(self) -> str:  # 动态读取包版本，避免与 pyproject 漂移
        try:
            import khy_quant
            return getattr(khy_quant, "__version__", "0.0.0")
        except Exception:
            return "0.0.0"

    def standalone_init(self) -> None:
        """独立模式：保证应用数据主权目录就位，提供降级体验。"""
        ensure_home(app_home(self.name))

    def eco_init(self, ctx) -> None:
        """生态模式：接入底座上下文，仍只在自身 home 落数据（数据主权红线）。"""
        ensure_home(app_home(self.name))


def create_app() -> "KhyQuant":
    """entry_point 工厂：底座发现并加载 khyquant 时调用。"""
    return KhyQuant()
