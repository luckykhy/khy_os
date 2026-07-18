<!-- 文档分类: DESIGN-ARCH-011 | 阶段: 设计 | 原路径: docs/生态架构/应用接入标准.md -->
# khyos 生态应用接入标准（Ecosystem App Standard）

> 版本：v1（第一根桩）  ·  适用：khyos 生态下的所有应用（首款示范应用：khyquant）
>
> 本标准定义「生态底座（khyos）」与「生态应用（khyquant / 未来 khytrade / khydata …）」
> 之间的接入契约，目标是**底座与应用绝对解耦**：底座不依赖任何应用，应用可独立运行，
> 也可作为插件接入底座。

```
                  ┌───────────────────────┐
                  │      khyos 生态底座     │
                  │  核心调度 / 公共API / 发现机制 │
                  └──────────┬────────────┘
                             │ 动态发现 (entry_points / 注册表扫描)
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   ┌──────────┐       ┌──────────┐       ┌──────────┐
   │ khyquant │       │ 未来应用B │       │ 未来应用C │
   │ (首款)   │       │ khytrade │       │ khydata  │
   └────┬─────┘       └────┬─────┘       └────┬─────┘
        ▼                  ▼                  ▼
   ~/.khyquant/        ~/.khytrade/        ~/.khydata/
   ├─ data/            ├─ data/            ├─ data/
   ├─ models/          ├─ models/          ├─ models/
   ├─ cache/           ├─ cache/           ├─ cache/
   └─ logs/            └─ logs/            └─ logs/

   底座自身数据 → ~/.khyos/{data,cache,models,logs}
```

---

## 一、底座原则：khyos 绝不依赖任何应用

1. **源码零依赖**：khyos 源码（`platform/khy_platform`、`platform/khy_os`）中
   **禁止**出现对应用包的硬 `import`（如 `import khyquant`）。
   - 唯一例外：`platform/khy_platform/cli.py` 对 `khy_quant_backend`（底座**自身** Node
     后端的独立打包）的探测，且已包在 `try/except ImportError` 内——属底座定位自身后端，
     非依赖应用。
2. **无应用也能运行**：底座启动时动态发现应用，有则加载、无则跳过，绝不报错崩溃。

## 二、动态发现机制（底座提供）

单一真源：`platform/khy_platform/app_protocol.py`。

底座通过两路来源发现应用，按 `name` 去重（entry_points 优先）：

1. **entry_points**（推荐，最权威）——应用在自身 `pyproject.toml` 声明：

   ```toml
   [project.entry-points."khyos.apps"]
   khyquant = "khy_quant.app:create_app"
   ```

2. **注册表目录扫描**——清单 JSON 落在底座归属的 `~/.khyos/apps/<name>.json`
   （兼容历史位置 `~/.khyquant/apps/`）。清单 schema 见 `AppManifest`：

   ```json
   {
     "name": "khyquant",
     "version": "0.1.78",
     "description": "量化交易系统",
     "commands": ["khyquant", "quant"],
     "entry": "/abs/path/to/server.js",
     "source": "registry"
   }
   ```

查看已发现应用：`khy apps`（或 `khy apps --json`）。

## 三、应用生命周期协议（应用实现）

应用应实现 `app_protocol.KhyApp` 基类，声明双模初始化入口：

```python
from khy_platform.app_protocol import KhyApp, EcoContext

class KhyQuant(KhyApp):
    name = "khyquant"
    version = "0.1.78"

    def standalone_init(self) -> None:
        ...  # 独立模式：自建日志/配置/数据目录，提供降级体验

    def eco_init(self, ctx: EcoContext) -> None:
        ...  # 生态模式：接入底座注入的上下文与生命周期
```

## 四、双模运行标准（所有应用必须遵守）

| 模式 | 触发 | 初始化 |
|---|---|---|
| **独立** `standalone` | 默认；或 `KHYOS_ECO_MODE=0` | 应用自备日志/配置/数据目录 |
| **生态** `eco` | `KHYOS_ECO_MODE=1`；或检测到底座 `app_protocol` 可导入 | 接入底座上下文与生命周期 |

环境感知由应用入口在启动时完成（参考 `khy_quant/cli.py:_detect_mode()`），
并经环境变量 `KHYQUANT_MODE` / `KHYQUANT_HOME` 下传给运行时（Node 后端）。

## 五、数据主权与物理隔离（核心红线）

| 归属 | home | 数据库 | 模型/缓存/日志 | 解析器 |
|---|---|---|---|---|
| 底座 khyos | `~/.khyos/` | `~/.khyos/data/khyos.db` | `~/.khyos/{models,cache,logs}` | `dataHome.getBaseHome()` / `app_protocol.base_home()` |
| 应用 khyquant | `~/.khyquant/` | `~/.khyquant/data/khyq.db` | `~/.khyquant/{models,cache,logs}` | `dataHome.getDataHome()` / `app_protocol.app_home("khyquant")` |

红线：
- **DB 物理分离**：底座与应用各自的 `.db` 文件独立，**禁止互相直接读写对方 DB 文件**。
- **文件系统隔离**：`~/.khyos/` 与 `~/.khyquant/` 各存各的模型、缓存、日志。
- **跨域通信走公共 API**：应用需要底座数据时调用底座暴露的公共 API；底座需要应用数据时
  通过应用暴露的接口获取。**禁止跨库直连 SQL**。

## 六、新应用接入清单（Checklist）

- [ ] 自身 `pyproject.toml` 声明 `[project.entry-points."khyos.apps"]`。
- [ ] 实现 `KhyApp` 子类，提供 `standalone_init()` 与 `eco_init(ctx)`。
- [ ] 入口实现环境感知（`KHYOS_ECO_MODE` + 底座可导入探测），默认独立可运行。
- [ ] 数据全部落在 `~/.<app>/{data,cache,models,logs}`，不写入 `~/.khyos/` 或别的应用目录。
- [ ] 需要底座数据时只走底座公共 API，不直连底座 DB。

## 七、现状与遗留（[Eco-Arch-Unresolved]）

本次「第一根桩」建立了协议、发现机制、双模入口与路径所有权标准；以下涉及**活体数据迁移**，
按防呆规则未在无人值守流程内盲目执行，留待人工评估并设计带回滚的迁移脚本：

1. **应用数据家收敛**：后端现存两类应用数据家混用——统一解析器 `getDataHome()` 默认 `~/.khy`，
   而多个服务（`cleanupService`/`skillRegistry`/`adminService` 等）硬编码 `~/.khyquant`。
   需收敛到单一应用数据家。（标注于 `services/backend/src/utils/dataHome.js`）
2. **底座/应用表物理拆分**：将真正归属底座的表/文件从应用数据家迁出到 `~/.khyos/data/khyos.db`，
   需数据迁移脚本。
3. **回放后退**等应用侧能力缺口与本标准无关，另见各自 TODO。
