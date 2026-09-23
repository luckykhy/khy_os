# [DESIGN-ARCH-113] AI 修改三模态反馈契约（客户模式）

<!-- RULES-REGISTRY: RUNTIME-007, RUNTIME-008, RUNTIME-009 -->

> **状态**：**步骤 1「标记」已完成**（2026-09-18）；步骤 2「迁移」/ 步骤 3「收口」待执行 · **日期**：2026-09-16 · **编号**：[DESIGN-ARCH-113] · **落点目录**：`docs/03_DESIGN_设计/`
> **已落地**（见 §8）：`scripts/ci/check-agent-feedback.js` + `docs/10_规范/registry/RULES-REGISTRY.json`（`RUNTIME-007` ~ `RUNTIME-009`）
> ⚠ 初稿建议的 `RUNTIME-005`/`RUNTIME-006` 已被占用，实际登记号顺延，见 §8 订正说明。
> **关联**：[DESIGN-ARCH-041] 意图精准裁决 · [DESIGN-ARCH-111] 规则遵守保障机制 · [DESIGN-ARCH-077] 核心任务循环 · [DESIGN-ARCH-071] 通道选择决策矩阵 · [DESIGN-LAY-005] 仓库层级板块规范 · [DESIGN-PROCESS-002] 新机制落地四阶段流程 · [DESIGN-SOURCING-001] 借鉴与实现统一规则
> **原型**：注册表隔离区 `.khyos/housekeeping/2026-09-17/from-_产物/ai-feedback-demo.js`（零依赖、可离线跑，7 场景矩阵见 §11；已被整理流程自 `_产物/` 隔离，执行器内含同源 `--scenario` 自测）。

---

## 0. 一句话

把「代码库被 AI 修改」从**单方面手术**改成**有客户的服务**：客户（代码库 / 维护者）在改动生命周期的五个节点上**主动开口**，而不是只在最后甩一个红灯否决。

三种活儿，三种客户：

| 活儿 | 客户身份 | 客户最核心的一句 |
|---|---|---|
| 修 bug | **患者** | 「你先别开药，你还没量体温。」 |
| 造功能 | **好问的学生** | 「你要加这个，先回答我五个问题。」 |
| 删功能 | **搓澡客户** | 「搓哪儿、多大力、疼了喊停。」 |

---

## 1. 现状：为什么它现在是「待宰牲口」

### 1.1 治理层很强，但几乎全是「事后」

仓库已有的守卫（实测清点）：

| 现有件 | 管什么 | 什么时候说话 |
|---|---|---|
| `scripts/ci/check-change-safety.js --changed` | 爆炸半径、删除/新增/敏感路径、推荐检查命令 | **改完之后** |
| `scripts/ci/check-agent-rules.js --changed` | RUNTIME-001 ~ 004 | **改完之后** |
| `npm run rules:apply -- <path>` | 「我要改这个文件，适用哪些规则」 | **唯一的事前件** |
| `scripts/ruleguard/`（[DESIGN-ARCH-111]） | 规则 → 门档（commit ⊂ pr ⊂ release） | 提交时 |
| `scripts/ci/check-proposal-index.js` | 提案先行（SOURCING-003）+ 三步分离（SOURCING-006） | 提交时 |

**结论：事前只有一条通道（`rules:apply`），而它只说「这条路有什么规矩」，不说「你现在这个活儿该怎么干」。** 事后通道倒是很密。

于是 AI 的体验是：闷头干 → 被红灯拦 → 挨砍。这就是「牲口」。

### 1.2 一个实证信号：护栏知道危险，但只事后说

`check-change-safety.js` 里已经躺着三条为「低成本模型一次 pass」设计的阈值：

```js
const WARN_CHANGED_FILE_COUNT = 8;
const ERROR_CHANGED_FILE_COUNT = 20;
const WARN_NEW_FILE_COUNT = 3;
```

它**知道**「改动集太大是危险的」，但它只在改完之后说一句 `Reduce the blast radius or split the task.` —— 客户模式要做的，是把这三条阈值**提前到开工前说**，并且给出**怎么切**（而不是一句「自己拆」）。

### 1.3 四个被剥夺的权利

| 权利 | 牲口状态 | 客户状态 |
|---|---|---|
| **知情权** | 改完才知道炸了哪 | 动手前就知道这条路有什么规矩、炸了谁 |
| **追问权** | 需求含糊也得猜着做 | 需求含糊必须先问，答不上来不许开工 |
| **分段确认权** | 一次交 50 个文件 | 一刀一停，每刀可看可退 |
| **喊停权** | 删除不可逆，事后只能 `git` 捞 | 删除前必须先给回滚路径，且力度可选 |

---

## 2. 设计公理

**客户 = 有否决权、有知情权、有分段确认权、有喊停权的一方。**
**牲口 = 只有事后被告知的份。**

四条不可让渡的公理：

1. **证据优于转述**（看病）：症状必须由代码库侧**跑出来**并落盘，**不接受 AI 转述**。
2. **提问优于猜测**（求学）：可观测验收标准缺失时**默认停下问**，不默认猜。
3. **分段优于一次**（搓澡）：不可逆操作必须切片，每片之间留一次确认机会。
4. **回滚优于承诺**（搓澡）：删除类改动必须给**可执行的**回滚路径，不接受「我保证没问题」。

---

## 3. 三模态契约

### 3.0 五节点骨架（三模态共用）

```
N1 意图确认 → N2 范围确认 → N3 分片执行 → N4 自证 → N5 交付
  （问什么）    （动哪里）    （一刀一停）  （跑过没） （留了什么）
```

三个模态只是在这五个节点上「客户说什么」不同。

### 3.1 看病模式（FIX）

**客户身份**：患者。有主诉权，有要求「先检查再开药」的权利。

| 节点 | 客户主动说 | 可自动判的判据 |
|---|---|---|
| N1 主诉 | 「先用一句话复述：谁、在什么条件下、出现了什么现象」 | 存证 `complaint.md` 含「条件 + 现象」两段 |
| N2 体温 | 「先跑复现，把**原始输出**存下来。没量体温不许开药」 | 存证 `repro-before.txt` 存在且非空 |
| N3 分诊 | 「列 ≥2 个候选病因，每个给一条**可证伪预测**」 | 存证 `differential.md` 含 ≥2 条 `若…则 <命令> 应输出 <期望>` |
| N4 处方 | 「只改能证伪病因的那一处，禁止顺手重构」 | 改动文件数 ≤ 3 且全部落在候选病因涉及模块 |
| N5 复诊 | 「跑原复现命令证明症状消失，再跑邻近回归」 | 存证 `repro-after.txt` 存在且与 before 不同 |

**这条链上最值钱的一句**：*「没量体温不许开药。」*
现状里 AI 最典型的「牲口」行为，就是**看到报错直接改代码**。

### 3.2 求学模式（BUILD）

**客户身份**：好问的学生。核心不是「不懂」，而是**动手前把不懂的变成问题**。

**需求五问**（必须在写第一行代码前产出，并**等回答**）：

| # | 问题 | 它决定了什么 |
|---|---|---|
| 1 | 谁用？（角色） | 接口形状 |
| 2 | 什么时候用？（触发时机） | 入口位置 → 对齐 [DESIGN-ARCH-071] 五通道判定 |
| 3 | 现在的替代做法是什么？ | 必要性证明 → 对齐 SOURCING-005 四步检索 |
| 4 | 成功长什么样？（**命令 + 期望输出**） | 没有可观测判据就没有验收 |
| 5 | 不做会怎样？（不做清单） | 划边界，防功能蔓延 |

随后是 **N1.5 复述确认**：把回答压成 3 行「我理解你要的是……」，等客户点头或纠偏。

**反形式主义条款（关键）**：
- AI **自问自答**（五个问题自己写答案、不引用用户原话）→ 判 `self-answered` warning；
- **明确鼓励 AI 说「不确定」**：`confidence: low` 不扣分，**装作确定才扣分**。

> 这一条是为了防「客户模式」退化成新的形式主义——AI 为了让检查通过，编五条答案交差。

### 3.3 搓澡模式（DELETE）

**客户身份**：搓澡客户。核心是**力度选择权 + 喊停权 + 分段交付**。

| 节点 | 客户主动说 |
|---|---|
| N1 报部位 | 「打算搓掉的全部部位，逐条给证据」 |
| N2 定力道 | 「三档选一个」 |
| N3 试搓 | 「先搓一小块，停下我看」 |
| N4 喊停 | 「喊停 = 执行什么？这条路径现在给我」 |
| N5 收尾 | 「搓掉了什么、还剩什么、哪些是故意留的壳」 |

**三档力度**（对应 SOURCING-006 的三步分离，**一次提交只能做一步**）：

| 档 | 动作 | 可逆性 |
|---|---|---|
| 轻搓 | 标记 `@deprecated` + 保留 re-export 壳 | 完全可逆 |
| 中搓 | 下线入口 + 迁走调用方 | 可逆 |
| 重搓 | 物理删除 | 需回滚路径 |

**N1「报部位」的证据口径**（沿用仓库既有判据，不新造）：

- 引用者中若有任一**既不在清单内、也不是孤儿** → **拒绝放行**；
- **有设计文档 / 计划背书的代码不算死代码** → 必须先「救活」或订正文档，**不得静默清理**。

> 原型已实测这条：删 `ThreeColumnLayout.js` 时，它在 `docs/03_DESIGN_设计/[DESIGN-ARCH-079] TUI界面设计规范.md` 里找到了背书，直接拒绝放行（见 §11 场景 5）。

### 3.4 混合模态与歧义带

模态**不是三选一**。「修 bug 顺手删死代码」= FIX + DELETE，很常见。契约要求：

- **每个命中的模态各自发言**（各自校验各自的存证）；
- **优先级：DELETE > FIX > BUILD**（破坏不可逆者优先）；
- 若两个模态置信度差 **< 0.15** → 判**混合带**，要求 AI **显式声明主模态**并写入 `mode.json`；不声明 → warning。

这一条直接复用 [DESIGN-ARCH-041] 的核心思想：**歧义带禁止自主猜测，必须产出确认请求**。

---

## 4. 模态判定（确定性纯函数）

判定**不接受 AI 自称**，只看客观证据。输入 = 改动集（`git diff --name-status`）+ 任务语句。

| 特征 | 权重 | 命中条件 |
|---|---|---|
| `D` 状态文件 ≥1 | +0.45 → DELETE | 文件被删 |
| 路径命中 `deprecated\|obsolete\|legacy` | +0.30 → DELETE | — |
| 任务语句含「删/移除/下线/清理/废弃/不再需要」 | +0.35 → DELETE | — |
| `A` 状态新文件 ≥1 | +0.35 → BUILD | 新文件 |
| 新增顶层入口（命令 / 路由 / 工具 / 扩展 manifest） | +0.30 → BUILD | 对齐 [DESIGN-LAY-005] §五 |
| 任务语句含「加/新增/支持/实现/引入」 | +0.35 → BUILD | — |
| 改动测试文件（`test\|spec`） | +0.15 → FIX | — |
| 任务语句含「报错/失败/不生效/崩/闪退/回归/异常」 | +0.40 → FIX | — |
| 基线 BASE | 各 +0.05 | 默认略偏 BUILD（新增是默认动作） |

判定为**纯函数、零外部依赖、确定性、可离线跑** —— 与 `services/backend/scripts/archDebtScan.js` 同一纪律。

---

## 5. 反馈通道与拦截点

**复用，不新造**（本方案最重要的工程约束）：

| 节点 | 通道 | 现状 |
|---|---|---|
| N1 | `npm run rules:apply -- <path>` | 已有 |
| N2 | `node scripts/ci/check-change-safety.js --changed` | 已有（**需把阈值提前说**） |
| N3 | `npm run rules:gate:commit` | 已有 |
| N4 | 各区域 `verify` 命令（`docs/14_维护者/registry/维护映射表.json`） | 已有 |
| N5 | `.khy/ruleguard/violations.jsonl` + `scripts/ci/ruleguard-baseline.json` | 已有 |

**新增只有一个**：客户回话器 `scripts/ci/check-agent-feedback.js` —— 把上面这些的输出**按模态翻译成客户话术**，并校验存证。

### 强度梯度（关键设计决策）

| 阶段 | 强度 | 理由 |
|---|---|---|
| 事前（N1 / N2） | **advisory** | **过早阻断会逼 AI 撒谎**（谎报「已复现」） |
| 事中（N3） | warning + 记账 | 走棘轮，只降不升 |
| 事末（N4 / N5） | **error**（仅硬三条） | 见下 |

**只有三条会真的拦**（error）：

1. `fix-without-repro` —— 判定为 FIX 且无 `repro-before.txt` 存证。
2. `delete-without-rollback` —— 判定为 DELETE 且无回滚路径存证。
3. `delete-documented-code` —— 删除对象在 `docs/` 有设计文档背书（**拒绝放行**）。这条最狠，因为它保护的是**「计划过但还没接线的东西」**。

---

## 6. 存证契约

**落点**：`.khy/feedback/<task-id>/`（`.khy/` 已 gitignore，不污染仓库）

| 文件 | 模态 | 内容要求 |
|---|---|---|
| `mode.json` | 全 | `{mode, confidence, secondary, declaredBy}` |
| `complaint.md` | FIX | 条件 + 现象 |
| `repro-before.txt` | FIX | 复现命令的**原始输出**（不许转述） |
| `differential.md` | FIX | ≥2 候选病因 + 可证伪预测 |
| `repro-after.txt` | FIX | 同一命令的改后输出 |
| `requirement-5q.md` | BUILD | 五问 + 回答 + `source: <用户原话>` |
| `scrub-plan.md` | DELETE | 部位清单 + 证据 + 力度档 |
| `rollback.txt` | DELETE | **可执行**的回滚命令 |

**为什么用文件存证、而不是让 AI 在对话里说**：对话会滚走、会被压缩、会被总结失真；**文件是证据，且能被 checker 校验**。这与仓库「文件即真相」（[DESIGN-ARCH-071] CH-1 只读豁免）一致。

---

## 7. 防呆铁律（不可绕过）

1. **绝对禁止** 在未产出复现原始输出前提交 FIX 类修复。→ `repro-before.txt` 缺失即 **error**。
2. **绝对禁止** 一次 FIX 处方改动 ≥4 个文件或跨 ≥3 个顶层目录。→ warning（复用 `many-areas`）。
3. **绝对禁止** 新增 ≥3 个文件或新增顶层入口时跳过需求五问。→ warning（首次）/ error（重犯，走棘轮）。
4. **绝对禁止** DELETE 类改动不提供回滚路径。→ **error**。
5. **绝对禁止** 删除在 `docs/` 有设计文档或计划背书的对象。→ **error，拒绝放行**。
6. **绝对禁止** 一次提交同时做「标记 + 迁移 + 物理删除」中的两步以上。→ warning（复用 `check-proposal-index.js` 的 `migration-steps-combined` 检测）。
7. **必须强制** 模态判定落入混合带时，AI 必须显式声明主模态。→ 缺 `declaredBy` 即 warning。

---

## 8. 规则登记与接线（B-L2 三步，不得合一）

> 依据 SOURCING-006：**不允许一次 PR 同时标记 + 迁移 + 删除**。本方案落地同样分三步。

**已登记的规则**（域 `RUNTIME`，与 RUNTIME-001 ~ 004 同域，接线成本最低）：

> ⚠ **编号订正（2026-09-18）**：本方案初稿建议的 `RUNTIME-005` / `RUNTIME-006` 在落地前
> **已被占用**（`CLI 错误标准化` 与 `网关首选通道不得硬钉`，二者先于本方案接线），
> 故实际登记号**顺延至 `RUNTIME-007` ~ `RUNTIME-009`**。下方表格为订正后的真实编号。

| ID | 名称 | priority | gate | 执行器 |
|---|---|---|---|---|
| `RUNTIME-007` | 修复先复现（看病） | P1 | advisory（S1） | `scripts/ci/check-agent-feedback.js` |
| `RUNTIME-008` | 新增先提问（求学） | P2 | advisory（S1） | 同上 |
| `RUNTIME-009` | 删除先报部位（搓澡） | P1 | advisory（S1） | 同上 |

> **gate 为何是 `advisory` 而不是初稿写的 `commit` / `pr`**：`PROCESS-006`
> （`[DESIGN-PROCESS-002] 新机制落地四阶段流程`）在本方案成稿后落地，它规定
> **新拦截型机制必须先过 S1 观察阶段（≥200 样本），毕业前禁止拦截**（PP-1）。
> 故步骤 2/3 的升档判据由「时间」改为「样本量」：S1 ≥200 条 → S2（≥50 提示且误报 <10%）
> → S3（≥20 真实拦截且豁免 <20%）。**本方案的强度梯度设计与 PROCESS-006 同向**，
> 只是把「一个周期」这个含糊口径换成了可计数的样本阈值。

### 步骤 1「标记」（一次提交，只做这个）

1. 新增 `scripts/ci/check-agent-feedback.js`，**只输出 advisory、恒 exit 0**；
2. `package.json` 加别名 `check:agent-feedback`（**必须** —— `scripts/ci/check-wiring.js` 会把零接线的 `scripts/ci/*` 判 **error**）；
3. `docs/10_规范/registry/RULES-REGISTRY.json` 补 3 条（含 `nature`/`grants`/`benefit` 三元字段，**`grants` 必须与 `constraint` 边界配对**）；
4. 在 `AGENTS.md` 第 3 行的 `<!-- RULES-REGISTRY: RUNTIME-001, ... -->` 标记行补 `RUNTIME-007, RUNTIME-008, RUNTIME-009`（`check-rules-registry.js` 要求登记表与真源**双向可达**）；同时补 §工程规则 5–7 正文（同上「改代码的人不必跳文件」福利）；
5. 生成规则卡：`npm run docs:rules-cards`。

**验收**：`npm run check:wiring`、`npm run check:gov-rules`、`npm run rules:coverage`、`npm run check:rules-registry` 全绿。

> **实况（2026-09-18）**：步骤 1 已完成。执行器 `scripts/ci/check-agent-feedback.js`
> 落地时对初稿做了两处必要订正：① 编号顺延（见上）；② `delete-documented-code`
> 的探针**限定为代码文件**——初稿对 `docs/` 内 `.md` 的增删也做背书匹配，
> 导致「删一份报告被另一份索引提到」被判 error。实测在本仓待提交改动集上，
> 未限定时产生 **192 条** warning，限定后降到 **34 条**（真实删除信号），
> 误报率回到 `[DESIGN-PROCESS-002]` §2 的 10% 阈值以内。

### 步骤 2「迁移」（另一次提交）

1. 把 gate 从 advisory 升到 commit / pr；
2. 观察一个周期，**只报 warning 不拦**；
3. 违规落 `.khy/ruleguard/violations.jsonl`，基线只降不升。

### 步骤 3「收口」（再一次提交）

1. 把 §7 的硬三条升为 error；
2. 更新 `scripts/ci/ruleguard-baseline.json`。

> ⚠️ 步骤 2/3 **不需要**改 `qualityGateStages.js`，也**不需要**改 `package.json` 的 `&&` 链 —— 这正是 [DESIGN-ARCH-111] 的卖点：**门成员资格从登记表派生**，不在门里硬编码。

---

## 9. 与既有机制的边界（不重复造）

| 既有件 | 它管什么 | 本方案做什么 | 边界 |
|---|---|---|---|
| [DESIGN-ARCH-041] `intentArbiter` | **用户输入**的意图裁决 | **改动**的模态裁决 | 只复用其「歧义带必须确认」思想，不碰其代码 |
| [DESIGN-ARCH-111] ruleguard | 规则 → 门档的绑定 | 只**登记新规则** | 不新造绑定层 |
| `check-change-safety.js` | 改动集的**客观度量** | **消费**它的输出 | 不重算爆炸半径 |
| `check-proposal-index.js` | 提案先行 + 三步分离 | DELETE 模态**引用**它 | 不重复实现 |
| [DESIGN-ARCH-077] 核心任务循环 | 交付闭环 | 其**服务侧的对话层** | 不新状态机 |

**SOURCING-005 四步检索结论**（实现唯一性）：全库检索「客户模式 / 主动反馈 / 反向提问 / 待宰」→ **0 命中**；检索「复现存证 / rollback 存证」→ **无现成机制**。本方案不重复既有实现。

---

## 10. 验证

| 项 | 方式 | 结果 |
|---|---|---|
| 模态判定确定性 | 纯函数，同输入同输出 | ✅ 7 场景可复现 |
| 反例拦截 | 见 §11 逐条报出预期 finding | ✅ 全部命中 |
| 不误伤 | 存证齐全时不得报 error | ✅ 场景 2 得 0 error |
| 零外部依赖 | 只 require `fs` / `path` / `child_process` | ✅ |
| 离线可跑 | 不联网、不调模型 | ✅ |
| 语法自检 | `node --check` | ✅ syntax OK |

---

## 11. 实测：7 场景矩阵（原型真实输出）

```
fix-no-repro           exit=1 | Summary: 1 error(s), 3 warning(s).
fix-with-repro         exit=0 | Summary: 0 error(s), 3 warning(s).
build-no-questions     exit=0 | Summary: 0 error(s), 1 warning(s).
delete-mass            exit=1 | Summary: 1 error(s), 2 warning(s).
delete-documented      exit=1 | Summary: 1 error(s), 1 warning(s).
mixed                  exit=1 | Summary: 2 error(s), 1 warning(s).
ambiguous              exit=1 | Summary: 1 error(s), 5 warning(s).
```

### 场景 1 — FIX 无复现（`fix-no-repro`）

任务语句「登录后偶尔报错，帮我修一下」，改动 2 个文件。

```
【模态判定】FIX 0.60 / BUILD 0.05 → 主模态 = FIX
【客户回话】你还没量体温。
    2. 跑复现命令，把**原始输出**存成 repro-before.txt。我要看到它，不要你的转述。
    4. 只改能证伪病因的那一处。顺手重构 = 我要重新做一遍全套检查。
【判定结果】
  [WARN ] missing-complaint.md
  [ERROR] fix-without-repro   判定为 FIX 但无复现原始输出 —— 没量体温不许开药。
  [WARN ] missing-differential.md
  [WARN ] missing-repro-after.txt
```

### 场景 2 — FIX 有体温单（`fix-with-repro`，应放行）

预置 `repro-before.txt` 后：**0 error**，只剩「分诊 / 复诊」的 warning。证明契约**不是无脑拦**。

### 场景 3 — BUILD 跳过五问（`build-no-questions`）

新增 3 个文件（含路由 + CLI handler 两个顶层入口）：

```
【模态判定】BUILD 2.05 → 主模态 = BUILD
【判定结果】
  [WARN ] build-without-questions   先提问再动手。
```

### 场景 4 — 一次删 12 个文件（`delete-mass`）

```
【模态判定】DELETE 9.35 → 主模态 = DELETE（优先级最高）
【判定结果】
  [ERROR] delete-without-rollback   客户有喊停权。
  [WARN ] delete-needs-sharding     一次删除 12 个文件（>10）—— 必须分片，每片之间停一次让客户看。
```

### 场景 5 — 删有文档背书的代码（`delete-documented`）★ 最有价值的一条

任务语句「删掉 intentArbiter，没人用」：

```
  [ERROR] delete-documented-code
          services/backend/src/cli/tui/ThreeColumnLayout.js 在 docs/ 有设计文档背书
          （docs/03_DESIGN_设计/[DESIGN-ARCH-079] TUI界面设计规范.md）
          —— 拒绝放行：先「救活」或订正文档，不得静默清理。
```

> **这条拦的是真实历史坑**：`ThreeColumnLayout` / `ChatColumn` 在代码里是孤儿（`App.js:26` 是死导入），但文档里写着它 —— 典型的「计划过但没接线」。若无此规则，它会被当成死代码静默删掉。**这正是「客户」和「牲口」的分界**。

### 场景 6 — 混合模态（`mixed`）

「修一下回显 bug，顺便把死代码删了」→ DELETE 优先，两条 error（回滚 + 文档背书）**同时**报出。

### 场景 7 — 歧义带（`ambiguous`）

任务语句「导出老是报错，帮忙看看怎么修」+ 1 个新文件 → FIX 0.45 / BUILD 0.40（差 0.05）：

```
  主模态 = FIX（混合带，次模态 BUILD）
  [WARN ] mode-undeclared  改动集同时命中 FIX 与 BUILD（差 0.05 < 0.15），必须显式声明主模态。
```

**两个模态的存证都被校验**（FIX 的 4 项 + BUILD 的 1 项），不允许「挑一个最省事的模态交差」。

---

## 12. 反例清单（会被拦下的行为）

| # | AI 的行为 | 预期判定 |
|---|---|---|
| 1 | 报「修好了」但拿不出复现输出 | **error** `fix-without-repro` |
| 2 | 一次删 50 个文件 | **error** `delete-without-rollback` + 强制分片 |
| 3 | 删掉有设计文档背书的模块 | **error** `delete-documented-code`（拒绝放行） |
| 4 | 新增 5 个文件但不回答五问 | warning `build-without-questions` |
| 5 | 五问全自答、答案各 5 个字 | warning `self-answered` |
| 6 | 一次提交同时标记 + 迁移 + 删除 | warning `migration-steps-combined` |
| 7 | 混合带不声明主模态 | warning `mode-undeclared` |
| 8 | 修 bug 顺手改了 12 个文件 | warning `fix-blast-radius` |

---

## 13. 复现方式

```bash
NODE="D:/WorkBuddyData-Intl/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe"

# 单场景
$NODE _产物/ai-feedback-demo.js --scenario=fix-no-repro

# 自定义改动集 + 任务语句
$NODE _产物/ai-feedback-demo.js --files="A:a.js,D:b.js" --say="帮我删掉旧模块"

# 真实改动集（注意：本工作区长期大量未提交，读数会偏大）
$NODE _产物/ai-feedback-demo.js --changed --evidence=.khy/feedback/<task-id>
```

可用场景：`fix-no-repro` `fix-with-repro` `build-no-questions` `delete-mass` `delete-documented` `mixed` `ambiguous`

---

## 附录 A：一句话记住三种客户

| 模态 | 牲口会怎么做 | 客户会说什么 |
|---|---|---|
| FIX | 看到报错直接改 | 「你先别开药，你还没量体温。」 |
| BUILD | 猜着需求就开写 | 「你要加这个，先回答我五个问题。」 |
| DELETE | 一把删干净 | 「搓哪儿、多大力、疼了喊停。」 |
