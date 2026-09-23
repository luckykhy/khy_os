# [DESIGN-AGENT-001] 子智能体交接契约

<!-- RULES-REGISTRY: AGENT-001 -->

> **定位**：本文件回答一个问题——**主智能体与子智能体之间、子智能体与子智能体之间，
> 一次「交接」里必须带走什么、必须带回什么**。它是交接的**报文契约**。
>
> **边界**（与相邻规范谁管什么）：
> - 本文件管**交接的载荷**（带什么过去、带什么回来）；
>   `[DESIGN-PROCESS-001]` 管**要不要交接**（G1/G2/G3 准入闸门）；
>   `[DESIGN-ARCH-116]` 管**交接通道的实现**（`@khy-plugin-sdk`）。
> - 本文件**不新增**任何工具或通道，只约束既有 `Agent` / `SendMessage` 工具的**用法**。
>
> **规则 ID**：`AGENT-001`。登记见 `docs/10_规范/registry/RULES-REGISTRY.json`。
> **上游依据**：`[DESIGN-ARCH-121]` §K-04（对《Claude Code 实战》ch04 §4.4
> 「交接契约」的借鉴与 khyos 本地化）。

---

## 1. 红线

| # | 必须 / 禁止 | 判据 |
| --- | --- | --- |
| AG-1 | **子智能体之间不得假定共享内存**——所有跨体传递必须走报文 | 见 §2 |
| AG-2 | 派发时**必须**给出自包含 prompt；承载性信息**禁止**指望父对话自动可见 | `AgentTool/index.js:317` |
| AG-3 | 派发时**必须**显式指定**所有权**：哪些文件/模块/职责归它管，可否写入 | `AgentTool/index.js:352` |
| AG-4 | 并发派发**仅限真正独立**的子任务；有依赖的**必须**留在主流程串行 | `AgentTool/index.js:354` |
| AG-5 | 子智能体产出**必须**带 `file:line` 引用；禁止「我改好了」这类无证据声明 | 见 §3 信封 |
| AG-6 | 只读型子智能体（`Explore` 等）**禁止**派发写任务 | `exploreAgent.js` 用 `disallowedTools` 硬闸 |
| AG-7 | 继续既有子智能体**必须**用 `SendMessage`，禁止重复 spawn 同职责智能体 | `AgentTool/index.js:355` |
| AG-8 | 子智能体的产出**对用户不可见**——主智能体**必须**在回复中转述 | `AgentTool/index.js:357` |
| AG-9 | 后台型子智能体启动后**禁止**轮询等待 | `AgentTool/index.js:356` |

---

## 2. 为什么必须按「报文」而非「共享内存」设计

书侧（ch04 §4.4）的论断：**子智能体是独立进程，不是共享堆里的对象。**
khyos 的实现**完全印证**这一点——`AgentTool` 的提示词里写得很直白：

```text
The sub-agent runs independently with its own tool-use loop. It receives only a
compact summary of recent parent context (recent intent + file paths, or an explicit
`parent_context_summary` you pass) — NOT the full conversation.
You MUST still provide a detailed, self-contained prompt with all necessary context.
```

**机制真源**（`services/backend/src/tools/AgentTool/index.js`）：

| 行 | 内容 |
| --- | --- |
| `317` | 「只收到紧凑摘要，**不是**完整对话」——隔离的官方说明 |
| `368` | `parent_context_summary` 入参（显式摘要优先） |
| `691` / `795` | `parentContextSummary` 透传 |
| `853` | `childDepthOf(parentContext) + 1` 层级账本 |
| `912-919` | 父上下文摘要构造：**显式 `parent_context_summary` 优先**，否则从父对话历史确定性摘要 |

**推论**：忘记传上下文不是「模型疏忽」，而是**契约违规**——
因为界面设计上就是隔离的。这解释了 khyos 历史上一类「子智能体答非所问」的故障。

---

## 3. 交接信封（两向）

### 3.1 下行：派发信封（主 → 子）

| 字段 | 必填 | 内容 | 对应红线 |
| --- | --- | --- | --- |
| `description` | ✅ | 3–5 词任务概括 | AG-2 |
| `prompt` | ✅ | **自包含**任务书：目标 / 输入 / 约束 / 期望产出 | AG-2 |
| `parent_context_summary` | 承载性信息时 ✅ | 父对话摘要（**显式传**，不指望自动推导） | AG-2 |
| `subagent_type` | ✅ | 选型（`Explore` / `audit` / `fix` / `research` / `reading` / `map` / `general-purpose`） | AG-6 |
| **所有权声明**（写进 `prompt`） | ✅ | 可写的文件/模块；不可碰的边界 | AG-3 |
| `subtasks` | 仅并行型 | **仅限真正独立**的子任务 | AG-4 |

**所有权声明的写法**（书侧 ch04 的 handoff contract，khyos 用散文承载）：

```text
【你可以写】services/backend/src/permissions/patternMatcher.js
【禁止触碰】.khy/permissions.json（配置真源，由主流程改）
【产出要求】改动清单 + 每条带 file:line + 一句「为什么这样改」
```

### 3.2 上行：回报信封（子 → 主）

子智能体的产出**没有强制 schema**（返回 `{success, output, ...}`，`output` 是自由文本），
故本规范给出**内容契约**——`output` 必须包含：

| # | 段 | 要求 |
| --- | --- | --- |
| 1 | **结论** | 一句话先行 |
| 2 | **证据** | 每条结论带 `file:line`（AG-5） |
| 3 | **未决** | 没做完的、需要父决策的，显式列出 |
| 4 | **风险** | 引入的新风险 / 未验证的假设 |

> ⚠️ **`output` 是自由文本而非结构化字段**，故 AG-5 目前**无法自动校验**，
> 属评审 checklist 项。若要机械化，需先给 `_runStandaloneAgent` 的返回加 schema——
> 那是接口变更，须先过 `[DESIGN-SOURCING-001]` 的提案流程。

---

## 4. 五种子智能体模式与交接形态的对应

书侧（ch04）归纳五种模式，khyos 的 26 个内置 agent 可直接映射：

| 模式 | khyos 对应 | 交接形态 | 关键约束 |
| --- | --- | --- | --- |
| 只读型 | `Explore` / `reading` / `map` / `research` | 下行给**问题**，上行给**报告** | AG-6：`disallowedTools` 已硬闸（`exploreAgent.js`） |
| 执行型 | `fix` / `refactor` / `editAndWrite` | 下行给**findings + file:line**，上行给**diff 说明** | 「只修被交付的缺陷，不扩大 scope」 |
| 并行型（MapReduce） | `subtasks` 数组 | 下行 N 份独立任务，上行 N 份聚合 | AG-4：独立性是前提 |
| 流水线型（责任链） | `audit → fix` | 上游产出即下游输入 | 必须**串行**，禁止并行化 |
| 团队型 | 多 worker 并发 | 各自独立报文 | AG-7：续用 `SendMessage` 而非重 spawn |

> `audit → fix` 是 khyos 显式设计的一对（`AgentTool/index.js:340`：
> 「audit finds, fix closes」），**是流水线型的现行范例**，可作为其他链路的模板。

---

## 5. 校验（守卫）

| 红线 | 守卫 | 状态 |
| --- | --- | --- |
| AG-1 / AG-2 / AG-3 / AG-4 | `scripts/ci/check-agent-handoff.js` | **待建** |
| AG-5 | 依赖产出 schema 化 | 待工具化 |
| AG-6 | **已有硬闸**：`exploreAgent.js` 的 `disallowedTools` | ✅ 已经具备 |
| AG-7 / AG-8 / AG-9 | 无自动守卫，评审 checklist | 待工具化 |

> 建议的机械化切入点（成本最低）：解析 `AgentTool` 调用日志，
> 统计「未传 `parent_context_summary` 但 prompt 长度 < 200 字符」的派发，
> 这类几乎必然是 AG-2 违规。见 §K-11 的 S1 观测阶段。

---

## 6. 版本历史

| 日期 | 变更 |
| --- | --- |
| 2026-09-18 | 首版。依据 `[DESIGN-ARCH-121]` §K-04。把书的「交接契约」落为 khyos 的两向信封（下行派发 / 上行回报），并锚定到既有机制真源 `AgentTool/index.js` 的 `parent_context_summary`（`:317`/`:368`/`:912-919`）。26 个内置 agent 按书侧五模式完成映射，`audit → fix` 认定为流水线型范例。 |
