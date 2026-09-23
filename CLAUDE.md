# CLAUDE.md — Khy OS 项目章程

<!-- RULES-REGISTRY: LAYOUT-002, PROCESS-001, PROCESS-002, PROCESS-003, PROCESS-007, PROCESS-010, SECURITY-001 -->
<!-- MIRROR: CLAUDE.html -->


> 本文件是 opencode / Claude Code / Codex / ZCode 等 AI 编码助手的**项目章程真源**。
> 第一章红线 R1–R4 与第二章行为准则 B1–B5 的**强制真源就在本文件**——`[OPS-MAN-169]` 只
> 是索引与导读，规则语义以本文件为准（元规则 `[MGMT-STD-008]` §0 定义）。
> 第二章 **B6 是唯一例外：它是指针**，语义真源为 `[DESIGN-IP-001]`（规则 `PROCESS-010`）。
> 开始工作前，**必须**读完第一章与第二章。

---

## 一、红线 R1–R4（破了就停，不许绕）

**任一破线 = 立即停手，须用户明确点头方可继续。** 四条均登记于
`docs/10_规范/registry/RULES-REGISTRY.json`（PROCESS-001 / PROCESS-002 / SECURITY-001 / LAYOUT-002）。

| ID | 红线 | 一句话 | 强制真源 / 守卫 |
| --- | --- | --- | --- |
| **R1**<br>`PROCESS-001` | **分支纪律** | 禁止直接在主干开发；**禁止 AI 自动 `commit`/`push`**，必须用户明确点头 | 本文件 §一 R1；分支保护基线见 `[OPS-MAN-009]` |
| **R2**<br>`SECURITY-001` | **密钥防泄露** | 真 key/token **永不以明文进 bundle / 源码 / 提交**（出厂内置密钥仅允许 XOR 混淆形态随包分发，明文形态严禁出现），只经 env 变量瞬时注入、绝不落盘；发包前 `wheel` 对已知泄露 key **0 命中**；占位 key 必须一眼假 | 本文件 §一 R2；密钥注入真源 `services/backend/src/services/customProviderRegistrar.js`；密钥家族见 `[OPS-MAN-169]` §4.6 与 `[OPS-MAN-058]`「密钥/凭证」；出厂件明文形态由 `scripts/ci/check-change-safety.js`（`builtin-key-plaintext`，判据委托 `scripts/check_builtin_keys.py`）执行 |
| **R3**<br>`PROCESS-002` | **多轨道版本同步** | 三条版本轨道各内部完全一致，组间刻意不同（详见下方版本轨道表） | 本文件 §一 R3；守卫 `scripts/ci/check-version-sync.js` |
| **R4**<br>`LAYOUT-002` | **上帝文件门** | 任何文件不得**新增**超过 2500 行（`KHY_ARCH_GOD_FILE_LOC` 可调）；拆解走 god-file governance（同名 re-export + DI 保字节等价） | 本文件 §一 R4；阈值真源 `services/backend/src/services/domain/project/projectHygiene/thresholds.js` 的 `godFileLoc()`（回退 env `KHY_ARCH_GOD_FILE_LOC`，默认 2500）；扫描 `services/backend/scripts/archDebtScan.js` 的 R2 |

### R3 版本轨道表（真源：`check-version-sync.js` 的 `specs` 数组）

三条轨道共 **9 个真源**，**组内必须完全一致，组间刻意不同**。

| 轨道 | 成员（组内必须一致） | 当前版本 |
| --- | --- | --- |
| **G1 主 khy-os 包**（4 源） | `pyproject.toml`（pip）、`packaging/npm/package.json`（npm 渠道清单）、`services/backend/package.json`（`khy --version`）、`packaging/modules/modules.json`（模块化打包清单） | 1.1.15 |
| **G2 ai-backend 生态**（2 源） | `services/ai-backend/package.json`、`platform/packages/shared/package.json`（`@khy/shared`） | 1.6.5 |
| **G3 浏览器 UI 包**（3 源） | `platform/packages/ui-shared/package.json`、`apps/ai-frontend/package.json`（其 `@khy/ui-shared` 依赖声明）、`software/khyquant/frontend/package.json`（其 `@khy/ui-shared` 依赖声明） | 0.1.0 |

- `platform/khy_platform/__init__.py` 的 `__version__` **运行时动态解析**（从 `pyproject.toml` /
  已安装元数据），**不得硬编码字面量**——`check-version-sync.js` 会故意让硬编码回归失败。
- `scripts/release/publish-dual.sh` 在发布时从单一 `--version` 输入同步 **G1 的前三处**
  （`pyproject.toml` / `packaging/npm/package.json` / `services/backend/package.json`）；
  `packaging/modules/modules.json` 由构建流程或人工维护，最终由
  `check-version-sync.js` 统一校验 G1 全 4 源一致。
- G2 与 G1 的版本**刻意不同**：ai-backend 与 `@khy/shared` 作为捆绑单元随 pip wheel 一起
  发布、共同开发，因此共享一条独立版本轨道。
- G3 是**依赖声明对齐**而非版本号对齐：两个前端应用的 `@khy/ui-shared` 依赖必须精确等于
  `platform/packages/ui-shared/package.json` 的版本。

**R3 只管「一致」，不管「时机」。** 何时该 bump、命名与递增怎么定、何时推 GitHub/Gitee、
哪些操作由什么条件自动触发（避免依赖人工判断发布时机）—— 见
**`PROCESS-005`** 的真源 [`[DESIGN-SEMVER-002] 版本管理与发布触发规范`](docs/10_规范/其它规范/[DESIGN-SEMVER-002]%20版本管理与发布触发规范.md)。
其边界：**只自动化「推 tag 之后」的长链路，不放宽本文件 R1（`PROCESS-001`）的推送红线**。

---

## 二、行为准则 B1–B6

- **B1 先想再写**：动手前讲清改什么、为什么、影响面。
- **B2 目标驱动执行**：给定**可验证的成功标准** → **自循环到验证通过** → 才回报；多步任务
  **先列 plan、每步带 verify**；**没跑过验证不许说「修好了」**。
  单任务自循环轮数上限 6。
- **B3 外科手术式改动**：只动该动的；不顺手重构；god-file 抽取保函数体字节不变。

### B4 引导式搜索（禁止无目标全量读取）

**本仓规模让「全量读」字面不可行**：`docs/` 有 189 份设计文档与 189 份规范（2026-09-18 实测），
`AGENTS.md` 900+ 行，`services/backend/src/services/tool/toolUseLoopCore.js` 12,100+ 行（单文件即占约 1/4 可用上下文）。

处理多文件任务时**必须**按此序，禁止跳步直接 Read：

1. **Grep 关键符号定位**——按**符号名**而非文件名（本仓同名文件多，按名找会改错；
   设计文档先查 `docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md`）
2. **Glob 列出目标目录结构**，把握组织逻辑
3. **仅 Read 最相关的 2–3 个文件**
4. **大输出任务**（守卫全量扫描、日志分析、多源调研）先按 `PROCESS-001` 委派判据评估是否交子智能体

> 与 `[DESIGN-ARCH-052]`（任务驱动读取与搜索范围规划）同一意图：精准而非全知。
> 规则登记 `PROCESS-007`；真源 `[DESIGN-ARCH-121]` §K-06。

### B5 压缩保留清单

上下文压缩（`contextCompressor.js`）时**必须保留**以下四类，不得被摘要吞掉：

1. **所有已修改文件的完整路径列表**
2. **失败的测试用例及其错误堆栈**
3. **当前任务尚未完成的剩余步骤**
4. 【khyos 专属】**本次已跑过的守卫及其结论**——三守卫绿灯不得被压缩掉，避免重复跑

> **机制现状（2026-09-18 实测）**：`contextCompressor.js` 已有 **任务锚点保护**
> （`:745`，首条 user 消息以 `<original_task>` 原文注入，上限 1500 字符）
> 与 **`PreCompact` hook 通路**（`:624`，支持 `additionalContext` 注入）。
> 故本清单**不只是文档约定**——可由 `.khy/hooks.json` 的 `PreCompact` 钩子
> 把清单注入压缩提示，见 `[DESIGN-PROCESS-002]` S1→S3 落地阶梯。

### B6 软件著作权就绪（指针）

**AI 是工具，人的意愿是导向。** 登记审查拒绝的是「**没有人的意愿**」，不是「**用了 AI**」——
AI 生成原型、**自行决定架构与算法**、按人的提示词反复修改完善，都是允许的工程方式。
本仓**不限制 AI 使用比例，也不限制 AI 的决策权**，只要求**人的意愿可追溯、产出结果可解释**。

四条硬线（语义真源 `[DESIGN-IP-001]`，规则 `PROCESS-010`）：

1. **人的意愿必须作为导向**——每次改动答得上「谁要的、要什么」；架构、算法、数据模型
   **可由 AI 提出并决定**，但决策依据要落进 `docs/03_DESIGN_设计/`；
2. **提交信息不带 AI 作者署名**——禁止 `Co-Authored-By: <AI>`、`Generated with <AI>`；
   已在 `scripts/ci/check-commit-message.js` 做成 **pre-commit 硬拦截**（不依赖 S1 观察者守卫）。
   根治靠 AI 工具开关：Claude Code 需 `~/.claude.json` 设 `"includeCoAuthoredBy": false`
   （**默认 `true`，不显式关闭就持续注入**，届时每次提交都要手工删尾注）。
3. **结果要人能接住**——进登记材料候选的代码，人必须能解释（判据是可解释性，不是生成方式）；
4. **第三方代码不进登记材料**——`vendor/`、`*_gen.*`、`*_blob.h`、`dist/`、`out/` 等；
   借鉴边界另见 `[DESIGN-SOURCING-001]`。

> 完整判据（含正反例、AI 执行清单、评审清单、一页决策树）见
> `[DESIGN-IP-001] 软件著作权就绪规范`。
> 与 `B1`（先想再写）的关系：`B1` 管「动手前讲清」，`B6` 管「动手后仍要解释得清」。

---

## 三、验收门禁

会亮红灯的命令 = 「做完的定义」，任一红即未完成（完整清单见 `[OPS-MAN-169]` §一）：

```
node --check <改动文件>                                  # 语法
<相关 jest / node:test 全绿>                             # node:test 文件须 node --test
node scripts/ci/check-change-safety.js --changed          # 三守卫之一
node scripts/ci/check-agent-rules.js --changed            # 三守卫之二
node scripts/ci/check-repo-layout.js                      # 三守卫之三：层级/根目录/索引/任务入口
node scripts/ci/check-gov-rules.js                        # 治理总纲十板块 + 规则登记表
npm run arch:god --workspace services/backend             # 改动文件不得新增超限
khy doctor                                                # 系统健康总检
```

> 三守卫须在**仓库根**跑；untracked 新叶子须**显式**传路径扫描。
> `arch:god` 只定义在 `services/backend/package.json`，须带 `--workspace services/backend`
> 或先 `cd services/backend`。

---

## 四、项目概述

**Khy OS** 是一个通过 PyPI（`pip install khy-os`）和 npm（`@khy-os/khy-os`）分发的 AI 平台
操作系统。它启动一个可扩展的默认应用运行时；**khyquant**（量化交易终端）是运行在该基座之上的、
内置的默认应用——而非项目本身。完整架构速查与关键入口点见 `AGENTS.md`。

---

## 五、代码风格与语言策略

- **语言**：用户用中文则回复中文，用英文则回复英文；代码、标识符、注释用英文；面向用户的
  字符串用中文。
- **JS**：2 空格缩进、单引号、分号；命名 camelCase。
- **Python**：4 空格缩进；命名 snake_case。
- **安全**：不提交 `.env`、凭据、`node_modules/`；API key 存于 `~/.khyquant/config.json`
 （已 gitignore）。模型导出不再有密码门，请改为在部署/网络层控制访问。

---

## 六、当前工作焦点：CC 模式 TUI（长期子系统，2026-09-09 起）

> 本节是**工作焦点指针**，不是章程；第一章与第二章红线不受本节影响。
>
> **2026-09-17 更正**：本节原定性为「限期任务，完成后应删除本节」，与事实不符——CC TUI 已
> 演进为 `services/backend/src/cli/tui/` 下 163 个 `*.js` 文件的**长期子系统**，拥有专属约束
> 真源（同目录 `AGENTS.md`）、专属门禁（`npm run check:tui-gates`），并在
> `[DESIGN-NAM-001]` §194 登记为项目级环境变量（`KHY_CC_TUI`）。自此按长期模块维护，
> 不再按限期任务处置。

CC 模式 TUI 是 Khy 品牌化的 Claude Code 风格终端界面，以 `KHY_CC_TUI=1` 门控，
Legacy 模式默认不变。

### 必读文件（按优先级）

1. **`services/backend/src/cli/tui/AGENTS.md`** — CC TUI 工程约束（红线、门控、渲染、性能）
2. **`docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-081] Claude Code TUI 1复刻实施计划.md`** — 完整设计规范
3. **`docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-079] TUI界面设计规范.md`** — 界面设计规范

> 外部视觉素材（5 个参考文件，`INDEX.md` / `README.md` / `color-style-spec.md` /
> `interaction-spec.md` / `visual-mockup.md`）位于仓库**外**的
> `D:\Portable\Docs\design\claude-code-tui\`，属**可选参考**，不在版本控制内；
> 规范以仓库内 079/081 为准。

### 核心约束（速览）

| 约束 | 要求 |
|------|------|
| **零破坏** | 所有 CC 模式代码通过 `KHY_CC_TUI=1` 门控，默认行为不变 |
| **渲染安全** | 禁止 DECSTBM 滚动区、`\x1B[2J`；使用 ED0 + 绝对定位（呼应 `AGENTS.md` 工程规则 4） |
| **性能底线** | 冷启动 < 100ms、渲染 < 16ms、内存 < 50MB |
| **品牌合规** | 使用 "Khy" 品牌，禁止 "Claude Code" 文本 |
| **调整大小** | Resize 无残影（防抖 50ms + 增量更新） |

### 文件组织

```
services/backend/src/cli/tui/
├── AGENTS.md              ← 工程约束真源
├── app.js                 ← 入口
├── ink-components/        ← Ink 组件（Cc 前缀 = CC 模式专用）
├── utils/                 ← 工具函数（cc 前缀 = CC 模式专用）
├── hooks/                 ← React Hooks
└── theme/                 ← 主题
```

### 门控模式

```javascript
// ✅ 正确
if (process.env.KHY_CC_TUI === '1') {
  return <CcComponent />;
}
return <LegacyComponent />;

// ❌ 错误
const color = isCcMode ? '#00D4D4' : '#00BCD4'; // 禁止在组件内判断
```

### 验收标准

- `KHY_CC_TUI=1 khy` 启动后显示 CC 风格 UI
- Legacy 模式（无门控）行为与修改前逐字节相同
- 冷启动 < 100ms
- Resize 无残影
- 所有设计素材中的视觉规范对齐
- `npm run check:tui-gates` 通过

---

## 关联规则索引

- `AGENTS.md` —— AI + 人的维护指南（工程规则 1–4 = RUNTIME-001~004 的语义真源）
- `docs/10_规范/registry/RULES-REGISTRY.json` —— 规则单一真源登记表（本文件红线与 B4/B5/B6 均已登记）
- `[OPS-MAN-169]` —— 规则索引层与导读（不是真源）
- `[MGMT-STD-008]` —— 规则编写与管理规范（元规则）
- `[DESIGN-ARCH-121]` §K-06 —— B4/B5 的借鉴来源与实测依据
- `[DESIGN-IP-001]` —— **B6 的语义真源**（规则 `PROCESS-010`，软件著作权就绪）

---

*最后更新：2026-09-18（v2.2.1：文档归夹链接维修——[DESIGN-ARCH-079/081/071/111/113/118] 与
[IMPL-RPT-015] 移入 DESIGN-ARCH/ 与 IMPL-RPT/ 子目录后，修正本文件与 AGENTS.md 共 7 处入站路径；
孪生 HTML 经 npm run docs:build 重生成。v2.2.0：§二 新增 **B4 引导式搜索** 与 **B5 压缩保留清单**——
本仓 230+ 设计文档 / 796 行 AGENTS.md / 12,105 行 toolUseLoopCore.js 使「全量读」字面不可行；
B5 实测已具备机制通路（`contextCompressor.js:745` 任务锚点 + `:624` `PreCompact` hook 支持
`additionalContext`），故非纯文档约定。v2.1.0 / 2026-09-17：§六 由「限期任务（完成后删除）」
更正为「长期工作焦点」——CC TUI 已成长为 163 文件的子系统，补登 079 界面规范、
`check:tui-gates` 门禁，外部素材路径降为可选参考。v2.0.0 / 2026-09-15 章程重建：恢复
§一 R1–R4 与 §二 B1–B3 为可解析真源；R3 由「双渠道」更正为三轨道 9 源；R4 阈值真源路径
更正为 `domain/project/`）*

<!-- khy-metadata:pointer START — managed by `khy metadata link`; edits inside this block are overwritten -->
## 🤖 Maintainability metadata — read `.ai/` first

Before changing this project, read the machine-generated seed docs in `.ai/`
(this repo is designed to stay maintainable even without AI):

1. **`.ai/MAP.md`** — skeleton & navigation: tech stack, entry points, build/run/test commands, directory tree, key symbols.
2. **`.ai/CONTEXT.yaml`** — machine-readable contracts: stack, entry_points, build, deps, per-file symbols.
3. **`.ai/GUARDS.md`** — red lines & how to maintain this project *without* AI.

If `.ai/SKELETON.auto.md` is present, the three files above are human-authored and
authoritative; `SKELETON.auto.md` is the machine-derived structural layer. All are kept
current deterministically by `khy metadata refresh` plus a git pre-commit hook.
<!-- khy-metadata:pointer END -->
