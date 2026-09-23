# [DESIGN-LAY-002] 目录层级与文件归类规范

<!-- RULES-REGISTRY: LAYOUT-001 -->


> **定位**：管「新文件该放哪个目录、叫什么名、属于谁可见」。层级模型本身（L0–L6 与依赖边）真源在 `[DESIGN-LAY-005]`，本文**只补它留下的四个空白**：可见性轴、分层命名映射、文件归类、完整树示例。
>
> **结论**：① 仓库有**四条轴**，层轴（L0–L6）之外新增**可见性轴** PUB / INT / PRV，两轴正交，判位置先看层轴再看可见性轴；② 目录名风格由**语言轴**决定（JS/TS 用 camelCase、Python/C 用 snake_case、扩展包 id 用 kebab-case），不是一种风格打天下；③ `.js` 是 L2 的运行时语言，`.mjs`/`.cjs`/`.ts` 只允许出现在 `apps/` 与少量脚本边缘，`.vue` 只允许出现在前端层。

> **本文不写死任何编号格式。** 目录**名**的风格族属语言轴约束，可机械判定；而 `docs/` 内文档的编号与索引文件名格式，真源在 `[MGMT-STD-001]` 第 2.3 条——由执行 AI 依目标目录现有文件序列动态决策，本文一律不规定。第 5 节树中的 `00_INDEX_`、`[TAG-NNN]` 等字样**仅描述磁盘现状**，不得反向固化为本文的强制条文（`[MGMT-STD-001]` 第 2.3 条明文禁止）。

---

## 1. 红线

> 每行均可写成守卫断言或评审 checklist 项。守卫列写「人工」表示暂无机械检查。

| **编号** | **红线** | **触发条件** | **违规后果** | **守卫** |
|---|---|---|---|---|
| LAY-1 | 新文件必须落在 L0–L6 或横切层内 | 新建未登记顶层目录 | 拒收；须先改 ARCH-068 + 守卫 | `layer-registry` |
| LAY-2 | 跨层依赖必须经 PUB 包，不得深层相对路径 | `require('../../../<别的包>/src/...')` | 判违规；改走 workspace 包名 | `cross-layer-require` |
| LAY-3 | 跨层可见的代码必须是 pnpm workspace 包 | 目录名含 `shared`/`common` 但无 `package.json` | 判违规；要么注册包，要么降级为 PRV | 人工 |
| LAY-4 | 构建产物不得进入源码层 | `build/`、`dist/`、`*.egg-info` 被 git 跟踪 | 拒收；须保持 `.gitignore` | `check-build-artifacts` |
| LAY-5 | `docs/` 内 `.md` 必有同名 `.html` | 新增 `.md` 未跑 `docs:build` | CI 红灯非零退出 | `verify_docs_site.js` |
| LAY-6 | 根目录只放白名单说明文件 | 根出现非白名单 `.md`/`.txt` | 判违规；收容进 `docs/` | `root-whitelist` |
| LAY-7 | 目录名风格必须匹配所在层语言轴 | L2 出现 kebab 目录、L1 出现 camel 目录 | 人工评审拦截 | 人工 |
| LAY-8 | `_` 前缀在代码树内一律表示 PRV | 代码树内 `_xxx` 被跨包依赖 | 判违规；改为 PUB 包或去掉前缀 | 人工 |

---

## 2. 第 4 轴：可见性（PUB / INT / PRV）

> **结论**：ARCH-068 只回答「文件在哪一层」，没回答「谁能依赖它」。可见性轴与层轴**正交**——同一个 L2 目录里既有 PUB（`@khy/shared` 被 L4 依赖）也有 PRV（`_llmDecomposer.js` 只有同目录能碰）。层轴决定目录归属，可见性轴决定 import 权限。

### 2.1 三档定义

按「能被谁依赖」划分，判定依据是可执行的，不是主观印象。

| **档** | **谁能依赖** | **形态硬要求** | **命名信号** |
|---|---|---|---|
| `PUB` 共享 | 跨层（L0–L6 任意） | 必须是 pnpm workspace 包，`package.json` 带 `"private": true` | 包名 `@khy/*`，目录名不带 `_` |
| `INT` 内部 | 仅同层目录内 | 普通目录，无额外形态要求 | 语义名词目录 |
| `PRV` 私有 | 仅同包/同子树 | 无；靠命名前缀声明意图 | `_` 前缀、`__tests__/` |

`PUB` 之所以要求「必须是包」：只有包才有 `exports` 边界、才能被 `pnpm-workspace.yaml` 声明、才能被 `prepack.js` 打进产物。目录本身没有这些能力，所以「一个共享目录」是不存在的，只有「一个共享包」。

### 2.2 判定四问

新建或移动文件时自上而下问，首个命中即停。

| **顺序** | **问** | **命中即** |
|---|---|---|
| 1 | 别的层需要依赖它吗？ | → 建/并入 PUB 包，进 `platform/packages/` |
| 2 | 只有同层内的其他目录需要？ | → INT，留在本层现有语义目录下 |
| 3 | 只有同目录/同子树需要？ | → PRV，加 `_` 前缀或就地放置 |
| 4 | 都不需要，是给人看的产物？ | → `docs/` 或 `_产物/`，不进任何层 |

### 2.3 现状登记

仓库当前**只有两个 PUB 包**，这是刻意收敛的结果，不是偶然。

| **包名** | **路径** | **版本** | **模块制** | **可见性** |
|---|---|---|---|---|
| `@khy/shared` | `platform/packages/shared` | 1.6.5 | CommonJS | PUB |
| `@khy/ui-shared` | `platform/packages/ui-shared` | 0.1.0 | ESM | PUB |

`@khy/shared` 的 `src/index.js` 头部注释是仓库里**唯一一处**「谁可以依赖我」的书面声明（原文写明供 Trading backend 与 AI Management backend 共用）。新增 PUB 包必须仿照补同样一段。

已登记的 PRV 实体（列举供比对，不是白名单）：

- `services/backend/vendor/shared/` —— 构建期镜像，仅经 npm `file:` 解析；开发期由 `scripts/install/link-shared-dev.js` 软链到工作区真源，`prepack.js` 打包时替换为真实副本。
- `services/backend/src/services/_llmDecomposer.js` —— 807 个条目里唯一的下划线私有文件。
- `platform/khy_platform/_bootstrap.py`、`_ui.py`、`_resources/` —— Python 包内私有。
- `kernel/moonbit/_build/` —— 工具生成输出，非源码。
- `.khyos/deadcode-quarantine/` —— 显式隔离的死代码分桶，编号分桶存放。

**应下沉清单**（ARCH-068 第 2.1② 节已点名，本文只登记不执行）：`parseBoolean`、`maskSecret`、`ensureDirSync`、`httpError`、`normalizeAuthToken`、`modelCapability`、`modelTier`、`providerPresets` 八个纯函数目前在多个 backend 重复。另有四处 `gateway` 分层副本（`services/backend`、`services/ai-backend`、`software/khyquant`、`platform/packages/shared`）与 `src/constants/{models.js,serviceDefaults.js}` 的两份重复——这些是本文判定框架的**存量债**，本文不动它们。

---

## 3. `_` 前缀用法裁定

> **结论**：同一个 `_` 前缀在仓库里曾同时表示三种不相干的意思，是查找混乱的主要来源之一。
> **2026-09-16 起 `docs/` 顶层改用统一编号轴**（见 `[DESIGN-LAY-005]` §3.1），`_` 只剩两种含义，且**只限于代码树内**。

| **用法** | **含义** | **裁定** |
|---|---|---|
| `_bootstrap.py`、`_resources/`、`_llmDecomposer.js` | 包内私有实现 | **保留**，归 PRV。仅限代码树内 |
| `khy-Trajectory/_probe*.txt` 等 | 临时探测草稿 | **判定为草稿**。草稿不得进入 `docs/` 正文层级，只能落 `_产物/` 或轨迹目录 |

> **已废止的第三种含义**：`docs/_规范/`、`docs/_报告/` 曾以 `_` 表示「跨阶段资产，不在生命周期序列里」。
> 该含义**已废止**——`docs/` 顶层现统一为 `NN_中文/`，「编号 ≥ 10」即表达跨阶段，真源 `[DESIGN-LAY-005]` §3.1。
> 废止理由有二：① `_` 在资源管理器与 `ls` 中排序位置不确定，读者无法凭名字预判顺序；
> ② 同一个 `_` 同时表「跨阶段」与「包内私有/草稿」两义，与 LAY-8 冲突。
> 存量目录已于同日改名（`_规范`→`10_规范`、`_报告`→`11_报告`、`_assets`→`19_资产`、`_archive`→`18_归档` 等），**不保留 `_` 别名**。

边界：代码树内 `_` 一律 PRV（见 LAY-8）；草稿没有第四种合法去处，一律走 `_产物/`（该目录语义已是「产出即冻结、不再维护」）。

---

## 4. 分层 → 命名风格映射

> **结论**：风格由**语言轴**决定，不由层号决定。层号只告诉你「在哪」，语言轴告诉你「怎么写名」。此表是 `[DESIGN-NAM-001]` 第 10.1 节的层级化落地，不替代它。

| **层** | **顶层目录** | **主语言** | **目录名风格** | **文件名风格** |
|---|---|---|---|---|
| L0 | `kernel/` | C / Nasm | `snake_case` | `snake_case` |
| L1 | `platform/khy_platform` | Python | `snake_case` | `snake_case` |
| L2 | `services/backend` | Node（CJS） | `camelCase` | `camelCase` |
| L2 | `services/ai-backend` | Node（CJS） | `camelCase` | `camelCase` |
| L3 | `apps/*` | Vue / TS / Dart | `camelCase` | `camelCase` |
| L4 | `software/khyquant` | Python + Vue | `snake_case`（Py） | `snake_case`（Py） |
| L5 | `extensions/<分类>/<id>` | 混合 | `kebab-case` 分类 + id | 随包语言 |
| L6 | `tools/` | 混合 | `kebab-case` | 随包语言 |
| 横切 | `scripts/`、`packaging/` | JS | `kebab-case` | `kebab-case` |

两条补充口径：

- L5 的 `<分类>` 取自封闭集合 `tools`、`protocols`、`mcp`、`scripts`、`software`、`bridges`，`<id>` 必须等于叶子目录名且与 `khy.extension.json` 的 `id` 一致，深度上限 2 层（真源 `[DESIGN-TOOL-002]`）。
- 例外是 `platform/khy_platform` 与 `services/khy-os-backend`/`khy-ai-backend`：外层目录跟随包名风格（Python 用 snake、npm 包用 kebab），内层再按上表执行。这是存量现实，不追溯修改。

---

## 5. 文件归类标准

> **结论**：扩展名即语言，语言即层级。下表是「这个扩展名允许落在哪几层」的封闭口径，超出即需人工说明理由。

| **扩展名** | **语言 / 职责** | **允许层级** | **备注** |
|---|---|---|---|
| `.js` | Node 运行时（CJS） | L2 主体，L3/L4 前端少量 | 存量 6622 个 |
| `.mjs` | ESM 边缘脚本 | L3、横切、L5 | 不与 `.js` 混放于 L2 |
| `.cjs` | CJS 显式标记 | L3、L5、横切 | 多用于测试对偶 |
| `.ts` / `.tsx` | TypeScript | 仅 L3 的 Electron 应用 | L2 不引入 |
| `.vue` | Vue SFC | L3、L4 前端 | 不越层 |
| `.py` | Python | L1、L4、横切、L6 | L2 不放业务 `.py` |
| `.c` / `.h` | C | 仅 L0 | 全仓唯一 |
| `.asm` | Nasm | 仅 L0 | 引导 + 内核例程 |
| `.mbt` | MoonBit | L0、L1 插件 SDK | 生态桥接 |
| `.md` + `.html` | 文档 + 孪生 | `docs/`、各层 README | 孪生必成对，见 LAY-5 |
| `.json` | 配置 / 契约 | 全部层 | 放被其约束的目录内 |
| `.bat` / `.sh` / `.ps1` | 启动与运维脚本 | 根（PATH 入口）、`scripts/`、L5 | 三档放置见下 |

启动器三档放置：① 需进系统 `PATH` 的 CLI 入口留仓库根（`khy.bat`、`khy.sh`）；② 便携/安装型脚本入 `extensions/scripts/<id>/`；③ 工程任务脚本入 `scripts/`，共享逻辑写 `scripts/lib/`，脚本主体保持薄壳。同一脚本的 `.bat` 与 `.sh` 应成对同目录，便于跨平台切换。

产物与源码分界：`build/`、`dist/`、`dist-electron/`、`*.egg-info/` 属构建工具生成目录，由守卫的封闭集合排除，必须保持被忽略状态。层内的运行期输出（如 `apps/*/out/`、`dist-ts/`）不得与源码同级存放。

---

## 6. 典型目录树（示例，非强制格式）

> **结论**：这是**当前磁盘现状**的浓缩示意，用于回答「放新东西前先看哪张图」。每个节点标注层号与可见性档；`docs/` 侧的编号写法是现状描述，非本文强制格式（见文首边界声明）。

```text
khy-os/
├── kernel/                          # L0 · INT  手写 OS 内核（C + Nasm）
│   ├── boot/                        #      引导例程（long_mode、isr、context_switch）
│   ├── src/                         #      内核主体（pmm、sched、elf、ramfs、net、agentbus）
│   ├── userland/                    #      内核行为一致性测试（.asm 形式）
│   ├── bridge/                      # INT   JS ↔ OS 协议桥（agent、protocol、mcp）
│   └── docs/                        #      本层双语教程，不入全局 docs 轴
├── platform/                        # L1 · INT  Python 启动器 + 共享包 + 交付编排
│   ├── khy_platform/                #      轻量启动器，拉起 Node（snake_case）
│   │   └── _resources/              # PRV   包内资源与私有实现
│   ├── packages/shared/             # PUB   @khy/shared 1.6.5（跨层唯一入口）
│   ├── packages/ui-shared/          # PUB   @khy/ui-shared 0.1.0（前端共用）
│   ├── packages/moonbit-plugin-sdk/ # INT   MoonBit 插件 SDK
│   └── delivery/                    # INT   交付编排（adapters、orchestrator、tasks）
├── services/                        # L2 · INT  Node 运行时，全部业务逻辑
│   ├── backend/                     #      khy-os-backend（CJS，807 个 services 条目）
│   │   ├── src/cli/                 # INT   命令层：router、aliases、handlers、tui、repl
│   │   ├── src/services/            # INT   业务层：gateway、domain、agentsight…
│   │   │   └── _llmDecomposer.js    # PRV   807 条目中唯一的下划线私有文件
│   │   ├── src/routes/              # INT   HTTP 路由（58 个）
│   │   ├── src/constants/           # INT   单一真源默认值（serviceDefaults.js）
│   │   ├── src/contracts/           # INT   a2a / acp / mobile 契约
│   │   ├── src/utils/               # INT   工具函数（117 个）
│   │   ├── vendor/shared/           # PRV   @khy/shared 构建期镜像（非源码）
│   │   └── tests/                   # PRV   本包测试（含 __tests__、_smoke 子约定）
│   └── ai-backend/                  #      khy-ai-backend（与 backend 共享版本轨道）
├── apps/                            # L3 · INT  平台自带管理前端
│   ├── ai-frontend/                 #      Vue 3 + Vite（type: module）
│   ├── khyos-desktop/               #      Electron + TS 桌面端
│   ├── provider-hub/                #      Electron + TS 模型通道中心
│   ├── khy-mobile/                  #      Flutter 移动端
│   └── khy-os-client-app/           #      Flutter / Dart 客户端
├── software/                        # L4 · INT  跑在平台之上的内置应用
│   └── khyquant/                    #      量化交易终端（Python + Vue）
│       ├── khy_quant/               #      包内实现（snake_case）
│       ├── services/  routes/       # INT   业务与路由
│       └── frontend/                # INT   Vue 交易 UI
├── extensions/                      # L5 · INT  内置拓展（契约见 ARCH-069）
│   ├── tools/                       #      khy-markdown、khy-notebook、khy-dsh-compat
│   ├── scripts/                     #      便携/安装/诊断类可执行拓展（6 个）
│   └── bridges/                     #      外部 IDE 桥接（khy-trae-bridge）
├── tools/                           # L6 · INT  独立开发者工具（叶子，仅被 scripts 触达）
│   └── deepseek-eyes/               #      独立 Python 工具包
├── scripts/                         # 横切 · INT 工程任务脚本
│   ├── ci/                          #      64 个 check-*.js 守卫（含 layout / gov-rules）
│   ├── lib/                         # INT   脚本共享逻辑，主体保持薄壳
│   ├── tests/                       # PRV   与 lib/ 一一对应的守卫用例
│   ├── docs/                        #      docs-site 构建与孪生校验工具
│   └── release/                     #      构建与发布编排
├── packaging/                       # 横切 · INT 打包清单与板块切分
│   ├── build/   installer/          #      构建脚本与 NSIS 安装器
│   ├── modules/                     # INT   modules.json 模块登记
│   └── npm/                         #      @khy-os/khy-os 发布清单
├── docs/                            # 横切 · 文档统一编号轴（01–09 阶段 / 10–19 跨阶段）
│   ├── 01_INIT_立项/ … 09_STORY_修仙学AI/   # 01–09：生命周期阶段（9 个编号目录）
│   ├── 10_规范/                      # 10–19：跨阶段资产（规范族，本文所在目录）
│   ├── 11_报告/ 12_模板/ 13_传承/ 14_维护者/ 15_维护记录/
│   ├── 16_设计模式/ 17_AI协作预设包/ 18_归档/ 19_资产/
│   └── 00_INDEX_文档索引.md          # 主索引（现状示例，非强制格式）
├── electron/                        # 根级例外 · 根 package.json 的 electron:dev 入口
├── tests/                           # 根级例外 · 仅 DEBT.md 测试债务登记
├── _产物/                           # 根级例外 · 工作产物暂存区，产出即冻结
├── deploy/   patches/               # 根级例外 · 部署试验 / 第三方依赖补丁
└── khy_os.egg-info/  build/ …       # 生成目录（封闭集合，必须保持被忽略）
```

树中每个顶层节点都在守卫的 `LAYERS` 或 `CROSSCUTTING` 封闭集合内；新增顶层目录须同时改 ARCH-068 与守卫清单，否则 `layer-registry` 直接拦截。

---

## 7. 反例 → 正例

| **反例** | **问题** | **修法** |
|---|---|---|
| 在 `services/backend/src/` 新建 `shared-utils/` 供 L4 引用 | 目录冒充 PUB，无包边界 | 下沉为 `platform/packages/shared` 的导出，或降级为 PRV |
| `require('../../../../software/khyquant/models/X')` | 深层跨层相对路径 | 走 workspace 包名（现存的 57 个单行 re-export 壳仅限纯转发） |
| 在 L2 新建 `api-service.js` | 违反层语言轴（LAY-7） | 改 `apiService.js` |
| 在 `docs/07_OPS_运维/` 放 `_probe1.txt` 草稿 | `_` 被误用为草稿标记 | 草稿移 `_产物/`，正式文档走 docs 轴 |
| 新增 `.md` 后直接提交 | 缺 `.html` 孪生，LAY-5 红灯 | 先跑 `npm run docs:build` 再提交 |
| 在 `services/backend/src/` 放 `deploy.py` | Python 越层进 L2 | 移 `scripts/` 或 `platform/` |
| 在 `docs/` 顶层新建 `_新目录/` | `_` 表「跨阶段」的含义已废止；且与 PRV/草稿的 `_` 撞车 | 改用 `NN_中文/`，编号接 `10`–`19` 段续编（ARCH-068 §3.1） |
| 给 `docs/` 新增一个 `10_`–`19_` 之外的编号段（如 `20_`） | 段位意义是硬约定：`≤09` 阶段、`≥10` 跨阶段 | 复用 `10`–`19` 续编；确需扩段须先改 ARCH-068 §3.1 与守卫 |

---

## 8. 冲突裁决（存量矛盾三条）

> **结论**：本次成文时发现三处既有文档与磁盘现状互相矛盾。按 `[MGMT-STD-008]` 第 2.2 条裁决算法逐条裁定，并如实标注处理力度。

**① `.html` 孪生是否入版本控制 —— 裁定：入。**
`[OPS-MAN-169]` 第 2.5 条规定「`.md` 必有同名 `.html`，由 `docs:build` 生成、`verify_docs_site.js` 硬门校验」，且 `.gitignore` 全文件**无任何 html 条目**，git 已跟踪 461 个 `docs/` 下的 `.html`（磁盘 642 个）。而 `[DESIGN-DOC-001]` 第 6 节原称「HTML 为导出格式，不纳入版本控制」并附了一段并不存在的 gitignore 片段。裁定以 OPS-MAN-169 + 硬门 + 实际跟踪状态为准，`DESIGN-DOC-001` 第 6 节已于 2026-09-15 同步修正。

**② JS 文件名 camelCase 还是 kebab-case —— 裁定：camelCase 优先，不追溯改名。**
`[DESIGN-NAM-001]` 第 10.1 节规定 JS 文件 `camelCase`（示例 `aiGateway.js`），`[DESIGN-ARCH-073]` 规范快速参考卡给出 `user-service.js` 并标注「应该用 kebab-case」。ARCH-073 是**参考卡**，不是一条规则卡，未登记于 `RULES-REGISTRY.json`，因此不进入裁决算法；且存量 6622 个 `.js` 全为 camelCase。裁定 NAM-001 优先。ARCH-073 的示例文字不追溯修改，读者以本文为准。

**③ `_source/` 注册表幻影 —— 裁定：已废弃，待三处同步清除。**
ARCH-068 第 1.2 节将 `_source/` 登记为横切层，守卫 `CROSSCUTTING` 与 `repo-layout-baseline.json` 同步含该键，但磁盘上该目录**不存在**（全仓无一处）。这是「文档说有、守卫有、磁盘没有」的三方分叉。裁定其为已废弃登记。清除须**三处同步**（ARCH-068 第 1.2 节表格 + 守卫 `CROSSCUTTING` + baseline），因 ARCH-068 第 1.4 节明文禁止文档与守卫单边修改。本次不执行，登记为待办。

---

## 9. 校验（守卫）

> **结论**：本文不新增守卫脚本。下表是每条红线的现有覆盖情况，标「人工」者已在此明示，属有意留白而非遗漏。
>
> 本文 8 条红线已作为规则 `LAYOUT-001` 登记于 `RULES-REGISTRY.json`（domain `LAYOUT` / priority `P1` / status `active`），由 `check-gov-rules.js` 的 GOV-TOOL-006 校验字段完整性与权力-约束配对铁律。

| **红线** | **覆盖者** | **级别** |
|---|---|---|
| LAY-1 | `scripts/ci/check-repo-layout.js` → `layer-registry` | error |
| LAY-2 | 同上 → `cross-layer-require`、`unresolved-require` | warning + 基线 |
| LAY-3 | 无守卫 → 人工评审（对照第 2.3 节 PUB 清单） | 人工 |
| LAY-4 | `scripts/ci/check-build-artifacts.js` | error |
| LAY-5 | `scripts/docs/verify_docs_site.js` | 硬门非零退出 |
| LAY-6 | `check-repo-layout.js` → `root-whitelist`、`root-junk` | error |
| LAY-7 | 无守卫 → 人工评审（对照第 4 节映射表） | 人工 |
| LAY-8 | 无守卫 → 人工评审（对照第 3 节裁定） | 人工 |

运行方式：`npm run check:layout`（含 LAY-1/2/6）、`npm run docs:verify`（含 LAY-5）、`npm run check:structure`（全链）。基线文件 `scripts/ci/repo-layout-baseline.json` 当前各 warning 计数为 0，本文不得使其升高。

---

## 10. 例外与豁免

- **纯 re-export 壳**：`module.exports = require('<远端路径>');` 形式的单行转发允许跨层（现存 57 处），**仅当保持单行**；一旦加入任何逻辑即违反 LAY-2。真源 ARCH-068 第 2.1① 节。
- **生成目录**：`build/`、`dist/`、`dist-electron/`、`*.egg-info/` 由守卫封闭集合排除，不参与层级判定。
- **层内测试目录名**：`tests/`、`test/`、`__tests__/`、`_smoke/` 四种写法并存，守卫已按此集合识别；本文不收敛存量写法，但**新增**测试目录统一用 `tests/`。
- **Python 与 JS 混放**：`services/backend/akshare_scripts/` 等历史 Python 目录留在 L2，属存量债，不追溯迁移。
- **编号格式**：本文不规定任何编号格式，见文首边界声明。

---

## 11. 版本历史

| **版本** | **日期** | **变更** |
|---|---|---|
| 1.0.0 | 2026-09-15 | 初始版本。新增可见性轴（PUB/INT/PRV）与 `_` 前缀三义裁定；补分层命名映射、文件归类矩阵、完整典型树；裁决 HTML 孪生、JS 命名风格、`_source/` 幻影三条存量矛盾 |
| 1.1.0 | 2026-09-16 | 随 `[DESIGN-LAY-005]` §3.1 的「`docs/` 双轴收敛为单轴」同步修订：§3 去掉 `docs/_*` 那条裁定（`_` 在 `docs/` 的「跨阶段」含义废止，由「编号 ≥ 10」取代）；§6 典型树更新为 `01`–`09` 阶段 / `10`–`19` 跨阶段；§7 新增两条反例（`docs/` 顶层新建 `_目录`、越段编号）。 |

> 本文约 200 行，超过 `[DESIGN-DOC-001]` 第 12 节建议的 150 行上限，原因是用户明确要求「完整典型目录树 + 逐层职责标注」这一节无法压缩，且四个空白主题需在同一篇内闭合以免读者跨篇拼读。红线、反例、校验三节均已按骨架压缩为表格。

---

*本规范由 khy-os 架构团队维护；层级模型真源见 `[DESIGN-LAY-005]`*
