<!-- 文档分类: DESIGN-ARCH-068 | 阶段: 设计 | 原路径: 新建 -->
# [DESIGN-ARCH-068] 仓库层级板块规范

> **强制规范 · 代码侧目录层级的单一真源** · 回答三个问题：①顶层每个目录是哪一层、担什么责；②哪一层可以依赖哪一层；③新代码/新文档/新任务入口该放哪、该叫什么。
>
> **定位**：本文管**代码侧**的目录层级与板块划分。**文档侧**的命名与索引铁律真源是 `[MGMT-STD-001] 项目文档结构与索引铁律规范`，本文只声明「轴」，不复制也不覆盖其编号规则。
>
> **守卫**：`scripts/ci/check-repo-layout.js`（`npm run check:layout`）。本文的层级清单与根目录白名单在该脚本内以常量落地；改本文须同步改守卫，否则守卫会失效而无人察觉。
>
> **谁该读**：任何要新增文件、新增目录、新增任务入口的人或 AI。动手前先在此定位「我这东西属于哪一层」。

---

## 一、层级表（L0–L6）

顶层七个板块目录。**目录名刻意不改**（`services/backend` 被 832 个文件引用，其中 429 个在 `docs/` 下，改名收益不抵 churn）；层级由本表 + 守卫强制，不由目录名的字面顺序表达。

| 层 | 目录 | 一句话职责 | 代表入口 | 语言 |
| --- | --- | --- | --- | --- |
| **L0** | `kernel/` | 手写 OS 内核：抢占式调度、按需分页、COW `fork`、POSIX 信号、ELF+PE 双加载器，QEMU 下引导 | `kernel/src/`、`kernel/boot/` | C / ASM / MoonBit |
| **L1** | `platform/` | Python 启动器（探测环境、拉起 Node）+ 共享包 + 交付编排 | `platform/khy_platform/cli.py` | Python / JS |
| **L2** | `services/` | Node 运行时，**全部业务逻辑**：CLI、AI 网关、各类 service、Web API | `services/backend/bin/khy.js` | Node.js |
| **L3** | `apps/` | 平台**自带**的管理前端（AI 平台 UI） | `apps/ai-frontend/` | Vue 3 + Vite |
| **L4** | `software/` | 跑在平台**之上**的内置默认应用（khyquant 量化终端） | `software/khyquant/` | Python + Vue |
| **L5** | `extensions/` | 外部 IDE / 编辑器桥接，不随主包分发 | `extensions/khy-trae-bridge/` | Node.js |
| **L6** | `tools/` | 独立开发者工具，**不参与运行时** | `tools/khyos-markdown/`、`tools/deepseek-eyes/` | Node.js |

### 1.1 L3 与 L4 的分界（最容易混的一条）

`apps/` 与 `software/` 字面上是近义词，语义上不是：

- **`apps/` = 平台的一部分**。`ai-frontend` 是 Khy-OS 自己的管理界面，没有它平台不完整。随主包分发。
- **`software/` = 跑在平台上的应用**。khyquant 是**内置默认应用，而非项目本身**（见 `README.md` / `AGENTS.md` 同一表述）。它可以被替换、被卸载，平台照样成立。

**判据**：问「删掉它，Khy-OS 还是 Khy-OS 吗？」——是 → `software/`；不是 → `apps/`。

### 1.2 横切层（不编号）

服务于所有层，不参与 L0–L6 的依赖判定：

| 目录 | 职责 |
| --- | --- |
| `scripts/` | 工程任务：CI 守卫、文档站、发布、便携版、恢复、诊断、基准 |
| `packaging/` | 打包清单与**板块切分**（见第二节） |
| `docs/` | 全部文档（两轴命名见第三节） |
| `alpine/` | Alpine 镜像的 etc 覆盖层 |
| `_source/` | 加密源码快照与恢复说明 |

---

## 二、依赖方向（允许边白名单）

**不是**「只允许自上而下」。真实依赖图不是全序 —— Python 启动器在 L1 却要 spawn L2 的 Node 进程，而 L2 的 ai-backend 又要用 L1 的共享包。因此本节用**允许边白名单**，每条边都附实测依据：

| 允许边 | 形式 | 实测依据 |
| --- | --- | --- |
| `L1 → L2` | 进程启动（spawn），非模块导入 | `platform/khy_platform/cli.py`、`_bootstrap.py`、`node_provisioner.py`、`portable.py`、`tray.py` 定位并拉起 `services/backend` |
| `L2 → L1` | workspace 包导入 `@khy/shared` | `services/ai-backend/src/config/database.js` → `require('@khy/shared/config/database')`（包真身在 `platform/packages/shared`） |
| `L3 → L2` | HTTP / REST，**不得**跨目录 import | `apps/ai-frontend/src/api/*` |
| `L4 → L2` | HTTP + 少量进程调用 | `software/khyquant/` → 后端 API |
| `L4 → L1` | 打包清单 | `software/khyquant/setup.py`、`MANIFEST.in` |
| `L2 → L4`，**仅限纯 re-export 壳** | 整个文件就一句 `module.exports = require('…/khyquant/…')` | 57 处，见 §2.1 |
| 横切 → 任意层 | 路径引用 | `scripts/`、`packaging/` 按路径操作各层 |

**禁止边**（守卫 `cross-layer-require` 盯的就是这些）：

- **`L0` 与任何层**：内核独立，与 Node 栈无运行时耦合。`kernel/tools/` 里的构建辅助不算跨层依赖。
- **`L3 → L4`、`L4 → L3`**：两个前端之间不得互相 import。
- **`L2 → L3`**：后端不得反向 import 前端源码（打包脚本按路径复制产物不算）。
- **`L2 → L4` 的非壳引用**：带逻辑的跨目录 import 一律禁止，只有上表那种一行别名壳被容忍。
- **任何层 → `L5` / `L6`**：`extensions/`、`tools/` 是叶子，只被 `scripts/` 触达。
- **跨 workspace 的深层相对路径**：形如 `require('../../../<别的包>/src/...')` 一律禁止，应走 workspace 包名。

### 2.1 实测存量（基线，本轮不修）

守卫首次全仓扫描的结果（`npm run check:layout`）：

| 类别 | 处数 | 性质 |
| --- | --- | --- |
| 纯 re-export 壳（`L2 → L4`） | 57 | **容忍**：兼容别名，不计入违规 |
| 跨 workspace 深层相对 require | 43 | 违规存量，进基线 |
| 指向不存在路径的深层 require | 24 | **潜伏崩溃**，进基线 |

**① `L2 → L4` 的 re-export 壳（57 处，容忍）**

`services/backend/src/{models,controllers,cli/handlers}/` 下有大量一行文件：

```js
// services/backend/src/models/Instrument.js —— 整个文件就这一行
module.exports = require('../../../../software/khyquant/models/Instrument');
```

这是刻意的**路径别名**：`services/backend` 对外保持自己稳定的模块路径，实现归 `software/khyquant` 所有。它不引入逻辑耦合，因此守卫按「整个文件（去注释去空行）恰好是一句 `module.exports = require(…)`」豁免。**壳里一旦写进任何逻辑，豁免立即失效**并计为违规——这是豁免能安全存在的前提。

**② `services/ai-backend` → `services/backend`（违规存量的主体）**

```js
// services/ai-backend/src/routes/aiGatewayAdmin.js
const normalizeCompatibility = require('../../../backend/src/utils/normalizeCompatibility');
// services/ai-backend/src/services/gateway/userModelCatalogGraph.js
const modelCapability = require('../../../../backend/src/services/gateway/modelCapability');
```

这类引用把两个**独立版本轨道**的包（ai-backend 走轨道 2，backend 走轨道 1，见 `AGENTS.md`「版本同步」）在源码层焊死，任何一侧移动文件都会静默断裂。

**拆解方向**：被共用的都是纯函数工具（`parseBoolean`、`maskSecret`、`ensureDirSync`、`httpError`、`normalizeAuthToken`…）与网关元数据（`modelCapability`、`modelTier`、`providerPresets`）。应下沉到 `platform/packages/shared`（即 `@khy/shared`），两侧都按包名导入。

**③ 指向不存在路径的深层 require（24 处，真 bug）**

守卫顺带查出的一类**已经断了但没人发现**的引用 —— 搬迁文件时 `../` 级数算错，而调用点是惰性 require（写在函数体里）或被 `try/catch` 包着，所以启动期不报错，只在跑到那条命令时才炸。已确认的例子：

```js
// software/khyquant/handlers/data.js:9 —— 解析到 software/services/…（不存在）
const marketDataService = require('../../services/marketDataService');
//   同目录树下真身在 software/khyquant/services/marketDataService.js（应为 ../services/…）

// software/khyquant/services/gateway/toolCapabilityStore.js:24 —— 顶层 require，加载即崩
const { getBaseDataDir } = require('../../utils/dataHome');
//   software/khyquant/utils/ 下只有 5 个文件，没有 dataHome

// services/backend/src/cli/sessionColorState.js:31 —— 被 try/catch 吞掉，功能静默降级
require('../../services/session/sessionForestService')
//   真身在 services/backend/src/services/session/（应为 ../services/…）
```

**现状处理**：三类都记入 `scripts/ci/repo-layout-baseline.json`，**只允许下降不允许上升**。全量清单用 `npm run check:layout -- --list=unresolved-require`（或 `--list=cross-layer-require`）打印。真修是独立一轮工作，不在本规范的引入范围内。

---

## 三、命名的三条轴

同一个仓库里并存三套命名体系。它们**各管一维**，混用才是问题，并存不是：

| 轴 | 用在哪 | 形式 | 表达什么 |
| --- | --- | --- | --- |
| **层轴** | 代码顶层目录 | 语义名词（`kernel`/`platform`/…） | 运行时职责层，映射见第一节 |
| **阶段轴** | `docs/` 顶层 | `NN_STAGE_中文/` | 生命周期阶段（立项→设计→实现→测试→部署→运维→管理） |
| **跨阶段轴** | `docs/` 顶层 | `_中文/` | 不属于任何阶段的**跨阶段资产** |

### 3.1 `docs/` 两轴的读法

```
docs/
  01_INIT_立项/ 02_CONCEPTS_概念入门/ 03_DESIGN_设计/ …   ← 编号 = 阶段轴
  _报告/ _模板/ _传承/ _维护者/ _设计模式/ _AI协作预设包/   ← 下划线 = 跨阶段轴
  _assets/ _ref/                                          ← 同轴，本就如此
```

`_` 前缀不是「隐藏」或「不重要」，而是「**不在生命周期序列里**」。`_assets/` 与 `_ref/` 早就在用这个前缀表达同一件事，本轴是把既有惯例显式化，而非新造格式。

> 文件名的编号与格式规则（`[阶段-类型-序号] 中文名.md`）真源在 `[MGMT-STD-001]`，该规范**明文禁止**在任何地方写死具体编号格式。本节只声明目录轴，不涉及文件编号。

### 3.2 根目录白名单

根目录只允许 `README.md` 作为说明性入口，加上 `[MGMT-STD-001]` 第 1.3 条的**封闭白名单**（`LICENSE`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`AGENTS.md`、`CLAUDE.md`、`khy.md`，以及构建/包管理器强制的清单文件）。

真源是 `[MGMT-STD-001]` 第一章，本文不复制其条文，只声明它由 `check-repo-layout.js` 的 `root-whitelist` 规则**强制执行**——此前该铁律无守卫，根目录因此积压了 43 个散落文件。

**已知缺口**：白名单点名的 `CLAUDE.md`、`khy.md`、`LICENSE` 在仓库中**不存在**，而 `[OPS-MAN-169] 项目规则总纲` 把 `CLAUDE.md §1` 当作四条红线的强制真源。红线语义目前只能从 `[OPS-MAN-169]` 的速查摘要间接读到。补写红线原文需要维护者定稿，不由 AI 代笔。

---

## 四、板块（module）轴 —— L2 内部的功能切分

`packaging/modules/modules.json` 定义了一套与目录层级**正交**的板块划分，用于把 L2 单体切成可独立打包的可执行体：

| 板块 id | 名称 | 覆盖 |
| --- | --- | --- |
| `khy-ai` | AI 聊天 REPL | `arena`/`assistant`/`companion`/`learn`/`moa`/`orchestrate`/`persona`/`replay`/`session`/`skill`/`thinkback` handler + `aiChatCore`/`gatewayAdapters` |
| `khy-gateway` | AI 网关服务 | `gateway*` 系列 handler + `aiGateway`/`adapters`/`protocolConverter` |
| `khy-quant` | 量化交易工具 | `backtest`/`data`/`insights`/`market`/`pool`/`receipts`/`training` + `backtestEngine`/`akshareDataService`/`modelTrainingService` |
| `khy-server` | Web 管理后台 | Express 路由、管理面板、数据库模型 |

**要求**：在 `services/backend/src/cli/handlers/` 或 `src/services/` 下新增文件时，同步登记到对应板块的 `handlers` / `services` 数组。漏登记的后果是模块化构建产物缺功能，而全量构建正常——**不会在开发期暴露**。

板块与层级的关系：板块是 L2 内部的**纵向切片**，层级是**横向分层**。一个板块只存在于 L2；跨层的东西（比如 khyquant 的 Python 侧）不属于任何板块。

---

## 五、任务入口命名规约

根 `package.json` 是**唯一**的任务 surface。命名格式：

```
<域>:<动作>[:<变体>]
```

| 域 | 含义 | 落地脚本 |
| --- | --- | --- |
| `check:` | CI 守卫，会亮红灯 | `scripts/ci/*` |
| `docs:` | 文档站构建与体检 | `scripts/docs/*` |
| `test:` | 测试 | `scripts/tests/*`、各 workspace |
| `gate:` | 发布门 | `scripts/release/*` |
| `restore:` | 源码恢复流程 | `scripts/restore/*` |
| `portable:` | 便携版构建打包 | `scripts/portable/*` |
| `maintainer:` | 维护映射表相关 | `scripts/ci/print-maintainer-map.js` |
| `maintenance:` | 生成类维护动作 | `scripts/maintenance/*` |
| `bench:` | 性能基准 | `scripts/bench/*` |
| `hooks:` / `verify:` | 安装与自检 | `scripts/install/*` |

### 5.1 两条硬规则

1. **每个入口必须指向一个已存在的脚本文件。** 引入本规范时实测：文档与 CI 共引用 174 个 `npm run` 目标，其中 145 个在任何 `package.json` 里都不存在——27 个 `scripts/ci/*`、9 个 `scripts/docs/*`、18 个 `scripts/restore/*` 全部不可发现、不可执行，`[OPS-MAN-169]` 那份「做完的定义」验收清单整份跑不通。守卫规则 `dangling-task` 就是为此而设。

2. **不为单个测试文件建入口。** 「跑某一个测试」用 `npm run test:one -- <path>`，不再为每个场景登记一个 `test:<场景名>`。此前积累了约 100 个这类目标（`test:ocr-*`、`test:vision-*`、`test:restore-*`、`test:maintainer-*`），全部有名无实。

**补齐后的现状（2026-08-15）**：根 `package.json` 现有约 90 条 curated 入口，`dangling-task` 从 145 降至 **119**；余下 119 个里约 95 个是第 2 条刻意不提供的 `test:<单场景>`，其余是旧名（`restore-plan` → `restore:plan`、`triage` → `maintainer:triage`、`gen-triage-doc` → `maintenance:triage-doc` 等）与**至今无实现**的目标（`check:quality-gates`、`maintenance:generate`…）。两类都只登记进基线、**不伪造入口**。旧名→新名对照表见 `[OPS-MAN-174] 任务入口总表` 第九节。

完整入口清单见 `[OPS-MAN-174] 任务入口总表`。

---

## 六、放东西的决策流程

新增任何文件前，按序回答：

```
1. 是文档吗？
   └ 是 → 属于某个生命周期阶段？ → docs/NN_STAGE_中文/
          不属于（报告/模板/传承/维护/模式/预设包）→ docs/_中文/
          说明性文件一律不得留在根目录（白名单除外）

2. 是工程任务脚本吗？
   └ 是 → scripts/<域>/，并在根 package.json 登记 <域>:<动作> 入口

3. 是运行时代码吗？
   └ 内核 → kernel/          Python 启动/共享 → platform/
     Node 业务逻辑 → services/（并登记 packaging/modules/modules.json 板块）
     平台自带前端 → apps/     跑在平台上的应用 → software/
     IDE 桥接 → extensions/   独立开发者工具 → tools/

4. 想新建一个顶层目录？
   └ 先改本文第一节 + check-repo-layout.js 的层级清单，否则守卫 layer-registry 会拦住
```

---

## 七、守卫与验证

```powershell
npm run check:layout                                    # 本规范的强制执行者
npm run check:layout -- --list=unresolved-require        # 打印某条发现的全量清单
npm run check:layout -- --update-baseline                # 修完一批后下调基线（绝不上调）
node --test scripts/tests/check-repo-layout.test.js
```

`scripts/ci/check-repo-layout.js` 的七条规则：

| id | 规则 | 级别 |
| --- | --- | --- |
| `root-whitelist` | 根目录说明性 `.md`/`.txt` 须在 `[MGMT-STD-001]` §1.3 白名单内 | error |
| `docs-index-first` | 每个 `docs/` 分类目录须有排序首位的 `00_INDEX_*`（CP-4/CP-5） | error |
| `layer-registry` | 顶层目录须登记在本文第一节的 L0–L6 或横切层清单里 | error |
| `dangling-task` | 被跟踪文件里的 `npm run <目标>` 须能解析到已定义脚本 | warning + 基线 |
| `cross-layer-require` | 跨 workspace 的深层相对 `require`（纯 re-export 壳豁免） | warning + 基线 |
| `unresolved-require` | 深层相对 `require` 指向磁盘上不存在的路径 | warning + 基线 |
| `docs-index-complete` | 阶段目录里的文档须出现在主索引 `docs/00_INDEX_文档索引.md`（CP-3） | warning + 基线 |

`docs-index-first` 只管「每个目录有没有就近索引」，管不到「主入口漏没漏链」——后者是 `docs-index-complete`。
该规则对 `02_CONCEPTS_概念入门/` 与 `09_STORY_修仙学AI/` **豁免**：这两个小白向目录的可达性由
`scripts/docs/check_beginner_docs.js`（禁孤儿页/禁死链/禁死胡同）保证，比主索引点名更强；主索引只链其目录入口。

四条 warning 规则用 `scripts/ci/repo-layout-baseline.json` 记录已知违规数，**只降不升**（与仓库既有的 `frontend-size-baseline.json`、duplication 基线同一套路）。超过基线即自动升为 error。

本守卫**刻意全仓扫描**，不接受 `--changed`：层级是仓库的全局属性，只看改动集会漏掉「别人搬走了索引文件」这类破坏。

**一处盲区（新增文件时务必注意）**：`dangling-task` 与 `cross-layer-require` 走 `git grep`，只看**被跟踪**内容 —— 新文件在 `git add` 之前它一个字都读不到。后果是：一份新文档里写的 `npm run <还不存在的目标>` 在本地扫描时不计数，等它进了索引/提交才突然把计数顶到基线以上、把 warning 变成 CI 的 error。**新增文档后自查一次**：

```bash
git grep -I -o -h --untracked -E 'npm run [a-zA-Z0-9:_-]+' | sort -u
```

尤其别在正文里把占位符写成 `npm run X` 或 `npm run test:<单场景>` —— 正则 `[a-zA-Z0-9:_-]+` 会把 `X`、`test:` 当成真目标名。占位符一律写 `npm run <目标>`；引用历史旧名时（如本仓 `[OPS-MAN-174]` 第九节的旧名→新名对照表）**去掉 `npm run ` 前缀**，只写目标名本身。

**CI 接线**：`.github/workflows/pr-gate.yml` 的 `Check repo layout` 步骤跑

```bash
node scripts/ci/check-repo-layout.js --promote=root-whitelist,docs-index-first,layer-registry
```

三条 error 级规则阻断合并；四条 warning 级规则由基线棘轮把关（超基线自动升 error）。因为守卫不接受 `--changed`，该步骤**不需要** `GIT_BASE_REF` 环境变量，与相邻的 `check-change-safety` / `check-agent-rules` 步骤不同。维护归属登记在 `docs/_维护者/维护映射表.json` 的 `repo-layout` area（`verify` 字段即上面两条命令）。

守卫的可移植性约定：`--promote=<id>` 精确挑选要阻断的规则，`--strict-warnings` 全部升级，`--list=<id>` 打全量清单，拼错 id 以**退出码 2** 失败（不静默放过）——与 `check-change-safety.js` 同一套参数语义。测试通过 `KHY_REPO_LAYOUT_ROOT` 指向临时 fixture 仓库，不依赖本仓库当时的真实违规数。

---

## 关联

- 文档结构与索引铁律（文档侧真源）：`[MGMT-STD-001] 项目文档结构与索引铁律规范`
- 项目规则总纲（红线/命名/权限/MCP 索引层）：`[OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp`
- 任务入口总表：`[OPS-MAN-174] 任务入口总表`
- 文档排版与格式控制：`[DESIGN-ARCH-023] khyos文档排版与格式控制规范`
- 设计模式标注规范：`[DESIGN-ARCH-015] 编码规范`
- 维护区域映射（111 个 area → 文件 → 验证命令）：`docs/_维护者/维护映射表.json`
