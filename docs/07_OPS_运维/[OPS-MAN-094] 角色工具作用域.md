# [OPS-MAN-094] 角色工具作用域（按 decompose 的 role 收窄子智能体工具集）

> 送别礼第六发（「调工具」维度）。承 [OPS-MAN-083] 依赖感知波次调度、
> [OPS-MAN-087] 波次执行故障感知、[OPS-MAN-091] 波次前驱结果注入、
> [OPS-MAN-092] 跳过与失败在最终报告分列、[OPS-MAN-093] 确定性顺序链拆解。
> 前五发覆盖了「拆任务 → 有序并行 → 收结果」的调度/执行/报告链；本条补上用户
> 明确点名却全 arc 未覆盖的第三根支柱——**调工具**：按子任务的 `role` 收窄它拿到的
> 工具集，让只读角色（探索/验证）拿不到写工具。

## 一句话

`taskDecomposer._inferRole` 给每个 decompose 出的子任务打一个 `role` 字符串
（`explore` / `implement` / `verify` / `general` …）。这个字段贯穿整条 arc，且已有
一个消费者——`subAgentModelSelect` 用它**选模型**。但它一直缺一个 **tool-scoping
消费者**：一个 `role:'explore'` / `role:'verify'` 的**只读**子智能体，经
`AgentTool._runOrchestrated(..., 'general-purpose', ...)` 拉起时拿到的是完整工具集
（含 `Edit` / `Write` / `NotebookEdit`）。本条新增纯叶 `roleToolScope(role)` 把只读
角色映射到应被剥离的 `disallowedTools` 数组，`mergeRoleScopeInto` 把它 union 进既有
denylist——形状与 SSOT `AgentTool.buildSubagentDenylist` 精确对齐，供后续接线。

## 为什么需要它（真实缺口 = role 的 tool-scoping 消费者缺失）

**深挖缺陷（铁证 file:line，producer / 已存在语义 / 断桥）：**

- **Producer**：`services/backend/src/services/taskDecomposer.js` 的 `_inferRole`
  给每个子任务打 `role`。`agenticHarnessService.js:1015`（request 路径）与 `:1082`
  （decompose 事件）都携带它。
- **已存在的只读语义**：`services/backend/src/agents/built-in/exploreAgent.js:58-64`
  与 `readingAgent.js:62-68` 的 `disallowedTools` 明确剥离 `Edit` / `Write` /
  `NotebookEdit`（+ `Agent`）——即侦察 / 只读类 agent 本该拿不到写工具。
- **断桥**：decompose 路径产的 `role:'explore'` / `role:'verify'` 子任务**不映射到**
  这些只读 denylist。它走 `AgentTool._runOrchestrated(..., 'general-purpose', ...)`
  （`agenticHarnessService.js:1090-1093`），fork 出的子智能体拿的是 general-purpose
  的**完整工具集**。SSOT `AgentTool.buildSubagentDenylist`
  （`AgentTool/index.js:197-206`）只 union `agentDef.disallowedTools` ∪ spawn-tool
  （到达深度上限时），**从不按 decompose 的 role 收窄**。

**后果：** 一个「探索代码库」或「验证结果」的只读子智能体仍然拿到
`Write` / `Edit` / `NotebookEdit`。三重损失：①**token 浪费**（无关工具 schema 占
上下文）；②**语义错误**（侦察 / 验证阶段本该只读，却能改文件）；③**安全风险**
（无人值守的 verify 步骤能覆盖用户文件——离机还原场景最怕）。

**与前五发的区别（透镜一的多消费者维度）：** 083/087/091 收割同一段死代码
`executeDependencyAware`；092 追字段到渲染层；093 追到最上游 producer。本条是透镜一
的**多消费者维度**——同一个字段（`role`）已有一个消费者（model selection）却漏了
另一个正交消费者（tool scoping）。找断桥时要枚举「这个字段**应该**驱动几件事」，
而非「有没有任何消费者」。

## 单一真源与形状对齐

- `roleToolScope(role)`（`services/backend/src/services/orchestrator/roleToolScope.js`）
  是唯一的 role→disallowedTools 策略函数，纯、零 IO、绝不抛。
- `mergeRoleScopeInto(base, role)` = `Array.from(new Set([...base, ...roleToolScope(role)]))`
  ——与 SSOT `AgentTool.buildSubagentDenylist`（`Array.from(new Set([...base, ...spawn]))`，
  `AgentTool/index.js:203-204`）**形状精确对齐**。
- **消费 seam（供后续一次 tracked-edit 轮接线）**：在
  `AgentTool.buildSubagentDenylist` 的 union 点，用 `mergeRoleScopeInto(base, role)`
  把 role 作用域并进去即闭合断桥。本条**不改 god-file**（`AgentTool/index.js` 8026 行
  已超限；且分支 blast-radius 已达天花板）——只提供 + 测 + 文档化 seam。

## 语义与保守降级（绝不误伤需要写的角色）

| 情形 | 行为 |
| 门关 `KHY_ROLE_TOOL_SCOPE=0/false/off/no` | `roleToolScope` 返回 `[]` = 逐字节回退今日「不按 role 收窄」 |
| 门开 + 只读角色（explore/verify/plan/research/audit/review） | 返回 `[Edit, Write, NotebookEdit]`（**不含 Bash**） |
| 门开 + write 角色（implement/coder/general） | 返回 `[]`（不误伤需要写的角色） |
| 门开 + 未知角色 | 返回 `[]`（保守，不凭空收窄） |
| 非字符串 / 空串 / 畸形输入 | 返回 `[]`（纯、绝不抛） |

## 门与安全边界

- 门 `KHY_ROLE_TOOL_SCOPE` default-on，仅 `0/false/off/no` 关闭；关闭后
  `roleToolScope` 返回 `[]`，行为逐字节退化为今日（无回归）。门直读 env，**不进
  flagRegistry**（同 `KHY_DEP_WAVE_SCHEDULE` / `_FAULT_STOP` / `_CONTEXT_INJECT` /
  `KHY_MERGE_SKIP_DISTINCT` / `KHY_SEQ_CHAIN_DECOMPOSE` 五个 sibling 门先例，各自独立）。
- **默认不剥 `Bash`**：探索 / 验证常跑只读 shell（`ls` / `grep` / `node --test`），
  剥 Bash 会误伤合法只读命令。宁可保守少剥——诚实边界。未来可加严格模式，本条不做。
- **不碰** god-file / orchestrator 主体 / `AgentTool` wiring；只加纯叶 + 测 + 登记。
  本条只提供策略叶与消费 seam 文档，实际接线留给后续一次 tracked-edit 轮。
- 诚实边界：只把「只读语义」的 role 剥写工具；write / 未知角色不动。dev 机验证止于
  node:test（门开 / 门关 / 边界 / 与 `buildSubagentDenylist` 形状的 union 联通断言），
  不实跑多智能体端到端（需真子任务执行 + god-file 接线）。

## 怎么验证

```
npm run test:role-tool-scope            # 本条 node:test（只读收窄 + 门关回退 + union 联通 12/12）
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要把一类**新的只读角色**纳入收窄（如 `inspect`）：把它加进 `roleToolScope.js`
   的 `_READ_ONLY_ROLES`（小写）。加一条 node:test 覆盖它。
2. 要改**被剥离的工具集**（如严格模式也剥 `Bash`）：改 `_READ_ONLY_DENY` 一处。
   注意默认不剥 Bash 的理由（上文「门与安全边界」）——除非有真实需求别剥。
3. 要**接线**让 arc 真正生效：在 `AgentTool.buildSubagentDenylist` 的 union 点
   （`AgentTool/index.js:203-204`）用 `mergeRoleScopeInto(base, role)` 替换 base
   （形状已对齐、纯加性），并把 decompose 的 role 传到该调用点。这是一次 tracked-edit
   轮的工作（碰 god-file），本条刻意不做。
4. 改完跑 `npm run test:role-tool-scope`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive·新叶；门关（`KHY_ROLE_TOOL_SCOPE=off`）→ `roleToolScope` 返回 `[]` =
  逐字节回退今日行为。不碰 god-file / AgentTool wiring。
