# [DESIGN-AGENT-002] 智能体工具授权矩阵

<!-- RULES-REGISTRY: RUNTIME-010 -->

> **定位**：本文件回答一个问题——**每一个智能体/角色，被明确授予了哪些工具权力；
> 以及没有明确写下来的权力，是否可能被获得**。
>
> **本文件的核心原则（唯一红线）**：
> **默认拒绝。权力只能被明确授予，不得被默认继承。**
> 一个智能体**没有在授权面被显式列为允许**的工具，**必须**在机制上不可获得；
> 「没有声明 ⇒ 全都是我的」**禁止**作为任何路径的默认姿态。
>
> **边界**（与相邻规范谁管什么）：
> - 本文件管**授权面与能力面是否一致**（谁能做什么、做不到的能否做到）；
> - `[DESIGN-AGENT-001]` 管**交接的载荷**（带什么过去、带什么回来），不管授权；
> - `[DESIGN-PROCESS-001]` 管**要不要交接**（G1/G2/G3 准入闸门）；
> - `[DESIGN-ARCH-111]` 管**规则如何被门执行**（登记表/门档/finding 方言）。
>
> **规则 ID**：`RUNTIME-010`（域 RUNTIME，与工程红线 1–9 同族）。登记见 `docs/10_规范/registry/RULES-REGISTRY.json`。
> **落地阶段**：S1（观察期，只记录不阻断）——新机制**禁止直进 S3**（`PROCESS-008`）。

---

## 1. 红线

| # | 必须 / 禁止 | 判据 |
| --- | --- | --- |
| A2-1 | 未**显式授予**的工具，**禁止**可被获得；「未声明」**不得**解释为「全权」 | `builtInAgents.formatAgentLine` 不得对未声明者输出 `All tools` |
| A2-2 | 只读角色**禁止**持有任何可写工具，含 `Bash`（`Bash` 是头号写通道） | `toolProfile.PROFILES.explore.tools` 不得含 shell 家族 |
| A2-3 | 授权解析**禁止** fail-open：未知 profile 名**必须**收敛而非放行 | `toolProfile._resolve` / `filterToolsByProfile` |
| A2-4 | 声明面收窄**必须**有执行面强制与之对应；禁止「只在提示词里禁止」 | `executeTool` 必须同时查 gateway 与 agentContext denylist |
| A2-5 | 同一个「只读角色」集合**禁止**有两份不一致的定义 | `roleToolScope._READ_ONLY_ROLES` 与 `AgentTool.toolFilter` 触发集 |
| A2-6 | 提示词中「你没有权限」**必须**与机制事实一致；不一致即误导 | `constraints.readOnlyProhibitions` |
| A2-7 | 权限判定的失败**禁止**静默降级为放行 | `aiMessageBuilder` 的 `try/catch` |

---

## 2. 授权面的四个声明位（「授予权力」写在哪）

| # | 位置 | 文件 | 语义 | 方向 |
| --- | --- | --- | --- | --- |
| ① | 内置 agent 定义 | `services/backend/src/agents/built-in/*.js` | `tools`（白名单）/ `disallowedTools`（黑名单） | 声明 |
| ② | 插件/用户/项目 agent | `agents/loadAgents.js`、`loadBuiltInMarkdownAgents.js` | 同字段，YAML frontmatter 解析 | 声明 |
| ③ | 运行时角色作用域 | `services/domain/state/orchestrator/roleToolScope.js` | 只读角色 → 剥 `Edit/Write/NotebookEdit` | 收窄 |
| ④ | profile 白名单 | `tools/toolProfile.js` | `minimal/coding/analysis/verification/explore/full` | 收窄 |
| ⑤ | CLI 门 | `cli/printOutputFormat.js` → `tool/toolAccessGateway.js` | `--allowedTools` / `--disallowedTools` | 拦截 |

> ⚠ **两个方向混用是当前混乱的根源**：① 声明是**允许式**（列出来才能用）、
> ③ 收窄是**拒绝式**（列出来就不能用）。二者叠加时，
> 「一份 deny 清单」**永远无法**表达「只允许这些」——它只能减法，不能规定上界。
> **本规范要求：承载业务职责的 agent 必须给出白名单（`tools`）**，
> deny 清单只作为**额外**收紧，不得作为唯一声明。

---

## 3. 当前声明覆盖实况（2026-09-22 取证）

内置 agent 的声明风格**三足鼎立**，且**没有任何一个同时给出白名单与黑名单的完整上界**：

| 风格 | 数量 | 代表 | 风险 |
| --- | --- | --- | --- |
| 仅 `tools` 白名单 | 12 | `browserAgent`、`genImageAgent`、`generalPurposeAgent`、`khyGuideAgent`、`knowledgeAgent`、`knowledgePlanAgent`、`initAgent`、`statuslineSetup` | 白名单外的工具被隐式拒绝——**这一半是符合本规范的** |
| 仅 `disallowedTools` 黑名单 | 15 | `exploreAgent`、`verificationAgent`、`auditAgent`、`planAgent`、`readingAgent`、`mapAgent`、`researchAgent`、`reviewAgent`、`securityAgent`、`performanceAgent`、`debugAgent`、`deployAgent`、`docAgent`、`fixAgent`、`refactorAgent` | **「All tools except X」= 未声明的全部可用**，违反 A2-1 |
| 两者都有 | 2 | `ultraPlanAgent`、`ultraReviewAgent` | 符合本规范 |

**⇒ 15 个 agent 走在「黑名单独木桥」上，只要它们声明里漏列一个工具，那个工具就被静默授予。**

---

## 4. 已取证的三条越权路径

### 4.1 `Bash` —— 唯一从不被剥的写通道（违反 A2-2）

三处互相印证的**刻意决策**，而非疏漏：

| 位置 | 事实 |
| --- | --- |
| `toolProfile.js` `PROFILES.explore` | 描述自称 `'Read-only tools ... (search + read only)'`，`tools` 数组**实际含** `shellCommand, bash, Bash, shell_command` |
| `exploreAgent.js:58` | `disallowedTools` = `[Agent, ExitPlanMode, Edit, Write, NotebookEdit]`——**无 `Bash`**；提示词只写 `NEVER use Bash for: mkdir, touch, rm, cp, mv...`，**不产生强制** |
| `roleToolScope.js` + `roleToolScope.test.js:56` | 注释称「默认不剥 Bash（探索常跑只读命令）」；测试 `'read-only roles do NOT strip Bash (honest boundary)'` **把该行为锁死** |

**后果**：`explore` 角色可执行 `echo x > f`、`sed -i`、`tee`、`git add`、`npm install`——
与 `constraints.readOnlyProhibitions()` 对模型宣称的
`"You do NOT have access to file editing tools — attempting to edit files will fail"`
**直接矛盾**（违反 A2-6）。

### 4.2 定义面收窄、执行面不认（违反 A2-4）

- `tool/toolCalling.js` 的 `executeTool()` 只调 `gatewayDecision(name)`，
  而 `gatewayDecision` **只读 `toolAccessGateway` 单例状态**；该文件 `agentContext` **零命中**。
- `agentContext.disallowedTools` 全仓**只在 `cli/aiMessageBuilder.js:391` 一处被消费**，
  且整段包在 `try { ... } catch { toolDefs = undefined; }` ——
  异常**静默降级为「无工具定义」**，不报错也不收紧（违反 A2-7）。

**后果**：子代理剥 `Edit/Write` **只在「模型看到什么」这一面成立**；
执行面不会用 `agentContext.disallowedTools` 拒绝调用。

### 4.3 三处 fail-open 默认姿态（违反 A2-1 / A2-3）

| 位置 | 行为 |
| --- | --- |
| `toolProfile.filterToolsByProfile` | `if (!allowed) return toolsMap;` ——**未知 profile 名 ⇒ 不过滤 ⇒ 全放行** |
| `toolAccessGateway.isGatewayActive()` | 为假时 `filterToolDefs` 与 `gatewayDecision` **全部放行**（不传 flag 即无门） |
| `builtInAgents.formatAgentLine` | 既无 `tools` 又无 `disallowedTools` ⇒ 输出 **`All tools`** |

**附带**：`roleToolScope._READ_ONLY_ROLES`（7 个：`explore, verify, plan, research, audit, review`）
与 `AgentTool/index.js:862` 的 `toolFilter` 触发集（6 个：`explore, planner, audit, research, reading, map`）
**无一名称完全对应** ⇒ `verify` 被剥写工具**却拿不到只读白名单**（违反 A2-5）。

---

## 5. 权限矩阵（修正后应有的形态）

> 图例：**●** 明确授予 ｜ **○** 明确拒绝 ｜ **✗** 当前实现与声明不符（越权）

| 角色 | Read/Grep/Glob | Edit/Write | `Bash` | 说明 |
| --- | --- | --- | --- | --- |
| `explore` / `Explore` | ● | ○ | **○（改为只读子命令白名单）** | 探索只需搜索与读 |
| `verify` / `verification` | ● | ○ | ●（需跑 build/test） | **允许**写系统状态，但**必须**显式授予 |
| `plan` / `Planner` | ● | ○ | ○ | 只读规划 |
| `audit` / `review` | ● | ○ | ○ | 对抗式审查，只报告 |
| `research` | ● | ○ | ○ | 含 web 检索 |
| `reading` / `map` | ● | ○ | ○ | 纯读 |
| `implement` / `general` | ● | ● | ● | 全权（**显式**授予） |

**关键修正**：`verify` 与 `explore` 的需求**不同**——`verify` 要跑 build/test，
所以它**需要** `Bash`。本规范的做法**不是**一刀切禁 `Bash`，而是：
**把 `Bash` 的授予写进 `verify` 的显式声明里，并从 `explore` 的授权面移除。**

---

## 6. 落地路线（按 `PROCESS-008`，S1 起步）

| 步骤 | 动作 | 验收 |
| --- | --- | --- |
| S1 | 新增守卫 `scripts/ci/check-agent-authz.js`，**只记录不阻断** | 门档 `commit` + `severity: advisory`（⚠ `gate='advisory'` 永不执行） |
| S1 | 修正三处 fail-open：未知 profile 收敛、`formatAgentLine` 输出警告 | 单元测试断言"未知 profile ≠ 全放行" |
| S2 | 从 `explore` profile 移除 shell 家族；`Bash` 改为只读子命令白名单 | 误报率 < 10% |
| S2 | `executeTool` 补读 `agentContext.disallowedTools` | 端到端测试：子代理 deny 的工具**执行面拒绝** |
| S3 | 统一只读角色集合为单一真源 | 加断言：两侧集合相等 |

> **阶段规则**（`PROCESS-008`）：禁止直进 S3；**毕业按样本量计**——
> S1 ≥200 样本 → S2 误报率 <10% → S3 方可豁免；
> **S1/S2 必须旁路记录、禁止阻断**；**禁止同时升两阶**。

---

## 7. 与其他规范的关系

| 规范 | 关系 |
| --- | --- |
| `[DESIGN-AGENT-001]` | 管交接载荷；本文件管授权面。AG-6「只读型禁止派写任务」由本文件 A2-2 提供机制判据 |
| `[DESIGN-ARCH-111]` | 管规则如何被门执行；本文件的 `RUNTIME-010` 按该规范的登记表/门档接线 |
| `[DESIGN-GOV-001]` | 治理总纲十板块；本文件归属其中的 ACP（智能体协作）板块 |
| `AGENTS.md` 工程规则 1–9 | 规则 1 零硬编码 / 规则 3 活动式超时与本文件同属 RUNTIME 域邻域；本文件独立为 AGENT 域 |

---

**变更记录**

| 日期 | 变更 |
| --- | --- |
| 2026-09-22 | 首版。基于对 `exploreAgent` / `roleToolScope` / `toolProfile` / `toolAccessGateway` / `builtInAgents` / `aiMessageBuilder` 的只读取证，确立「默认拒绝、显式授予」原则与 7 条红线 |
