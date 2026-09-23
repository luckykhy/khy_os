# DESIGN-ARCH-029 · Agent「有限窗口降级与强制兜底」执行协议

> 状态：已实现（services/backend）
> 关联代码：`services/backend/src/services/resilience/`、`services/toolCalling.executeTool`（接入点）、`services/toolError.js`
> 关联测试：`tests/services/resilience/resilience.test.js`（23 用例绿）
> 关联规范：[DESIGN-ARCH-027] 依赖自愈机制（同为 executeTool 单漏斗的非侵入挂载）、[DESIGN-ARCH-025] 元规划协议（"零侵入、自带闭环"先例）、[DESIGN-ARCH-028] 通信防御零静默失败（穷尽兜底后的归因/包装层）

## 1. 问题陈述

Agent 在工具失败时表现出两种互为镜像的病：

- **娇气病（原地躺平）**：第一个工具一失败就 `catch(e)→return {success:false}`，既不降级、也不换路，把本可自动续航的任务直接判死。
- **死缠烂打（死循环重试）**：失败后既不换方法也不换参数，原封不动再发同一发子弹（"让我再试一次"），在同类错误上空转，燃烧 Token。

协议要消灭这两端，并强制：穷尽有限路径后**必须交差**一份结构化兜底，而不是只丢一句"失败"。

### 1.1 自调查结论（硬中断点 / 重试环审计）

对 `services/backend/src` 真实执行路径（executeTool / toolUseLoop / Web 三件套）审计：

**A. 娇气病硬中断点（存在可用降级却未走）：**

| 位置 | 形态 | 问题 |
|---|---|---|
| `tools/WebFetchTool/index.js:171-173` | `catch→{success:false,'Fetch failed'}` | 单次抓取失败即死，仓库已有 `playwrightSearch.fetchRenderedHtml()` 可渲染反爬页却从不回退，瞬态网络错误也不重试。**真娇气病。** |
| `tools/WebFetchTool/index.js:284-285` | `statusCode>=400` 立即 reject | 无重试 / 无降级。 |
| `tools/WebBrowserTool/index.js:42-48` | puppeteer 缺失 `return {success:false}` | 已接依赖自愈（DESIGN-ARCH-027），但无 playwright 降级，无 puppeteer 即完全不浏览。 |
| `toolUseLoop.js:1631-1643` | 非瞬态 `errorType`（rate_limit/auth）即 `stopped:true` | rate_limit 本可延迟重试，却硬停。轻微。 |

**正确的硬停（非娇气病，已排除）**：`WebFetchTool` 的 URL 校验（:118）与 SSRF 拦截（:130）属安全闸门必须 fail-closed；`toolCalling.js:2673-2686` 入参校验失败；`WebSearchTool` 之下 `searchUnified` 本身已是完整级联。

**B. 重试环（死缠烂打）**：主路径上**未发现真正的无界重试**——主循环 `IterationBudget`（≤100 + 绝对墙钟超时）、瞬态恢复（`transientRecoveryMax` 0–6 + 退避抖动 + 冷却 fail-fast）、`webSearchService` 队列空恰重试一次、`healingLoop` 依赖装好后恰重试一次、`toolCallGuardrail` 的 `[STOP]` 去重，**均已有界且多在"输入改变后"才重试**。

**结论**：真正缺的不是"给重试加上限"，而是**把娇气病的死胡同接上有限深度的降级树 + 强制兜底**。本协议据此落地。

## 2. 设计目标

1. **禁止原地躺平**：核心意图绑定降级树，单点失败必向下降级，绝不在第一个 Plan 上判死。
2. **禁止死缠烂打**：同 Plan 同类错误重试 ≤1，且那一次只在"依赖/参数被真正修复"后放行；树深 ≤3；预算见底立即熔断。
3. **兜底必须交差**：穷尽路径后输出 `failed_with_salvage` 结构化 JSON（尝试记录 + 残留数据 + 下一步建议）。
4. **零侵入**：自带有限窗口 + 兜底闭环，不外科手术改写 4000 行 toolUseLoop；接入点仅把 `executeTool` 包成 runner（对齐 ARCH-025/027 先例）。

## 3. 架构

```
ResilienceCoordinator（门面 index.js）
   │  run(intent, context)
   ▼
BudgetAwareExecutor（budgetExecutor.js）──── 自顶向下遍历降级树
   ├─ 预算闸门①  remainingPct < floor(10%)        → 熔断 → 兜底
   ├─ 预算闸门②  remainingUnits < remainingPlans  → 熔断 → 兜底
   ├─ DeadLoopDetector（deadLoopDetector.js）同一发子弹 → 强制跳过
   ├─ 每 Plan：首发 +（仅"修复输入后"）至多 1 次重试
   ├─ 失败 → onDegrade 注入「禁止道歉/直接下一个 Plan」上下文 → 向下降级
   └─ 树遍历完毕仍败 → SalvageProtector（salvage.js）→ failed_with_salvage JSON

FallbackTree（fallbackTree.js）  深度硬上限 3 / maxRetry 写死 1 / Object.freeze
errorSignature.js                callSignature（去重指纹）+ classifyFailure（短原因码）
intentTrees.js                   内置 fetch-web-content 树（WebBrowser→WebFetch→WebSearch）
```

### 3.1 降级熔断树（fallbackTree.js）

一个意图绑定一条**有序、有限**的 Plan 链：`Root → Plan A → B → C → 兜底`。硬约束全部在数据结构层强制：

- **① 深度硬上限 `MAX_FALLBACK_DEPTH = 3`**（硬编码）。定义第 4 个 Plan 直接抛 `FallbackTreeError`——**绝不静默截断**（截断会让人误以为"已覆盖全部路径"）。
- **② `maxRetry` 恒 `MAX_RETRY_PER_PLAN = 1`**，忽略 `spec.maxRetry`，外部无法放大。
- **③ `build()` 产出 `Object.freeze`**，下游运行期无法偷偷加层。

Plan 形状：`{ plan, tool, buildParams(ctx), maxRetry:1, isSuccess?, extractSalvage?, suggestion? }`。

### 3.2 预算感知执行器（budgetExecutor.js）

每开启新 Plan 前核算剩余预算（统一 `snapshot()→{totalUnits,remainingUnits,remainingPct}` 契约，支持 `makeStepBudget` 步数预算与 `makeTokenBudget` Token 预算两种适配器）：

- `remainingPct < floorPct`（默认 10%，env `KHY_RESILIENCE_BUDGET_FLOOR_PCT`）→ 熔断 `budget-floor`。
- `remainingUnits < remainingPlans`（不足以支撑后续全部节点）→ 熔断 `budget-insufficient`。

失败必向下降级、**绝不回头重试上一个 Plan**；模型在环路径每次降级注入强制上下文：

> Plan A 因 [具体原因] 失败。剩余预算：X%。系统强制要求你基于剩余能力规划 Plan B（工具：…）。你的剩余工具：[…]。禁止道歉，禁止输出"让我再试一次"而不改变方法，直接输出 Plan 的工具调用。

执行器自身任何异常都 fail-safe 收敛为兜底 JSON（`executor-error`），绝不抛给上层。

### 3.3 死循环检测（deadLoopDetector.js）

`callSignature(tool,params)`（与键序无关、忽略 Symbol 键）把调用压成指纹。`inspect()` 与"上一发已执行"签名比对，或会话内重复出现 → `dead=true` 强制跳过。那唯一一次重试由 `changed(prev,next)` 判定——**新旧签名不同才算"真的换了输入"**，否则视为同类死缠拒绝。

### 3.4 强制兜底协议（salvage.js）

```json
{
  "status": "failed_with_salvage",
  "intent": "获取网页内容",
  "attempted_paths": [ { "plan": "WebBrowser", "reason": "missing-dependency", "retry": 0 }, … ],
  "salvage_data": "抠到的最长残料（部分正文 / 搜索线索）",
  "next_action_suggestion": "可执行的下一步（装依赖 / 换源 / 提预算…）"
}
```

防呆：`attempted_paths` 必非空（预算从一开始见底也登记一条合成记录）；`salvage_data` 与 `next_action_suggestion` 字段恒在；建议依"最后一类失败 + 熔断原因"映射成可执行话术。

## 4. 防呆清单（与 /goal 硬要求逐条对应）

| # | 要求 | 落地 |
|---|---|---|
| ① | 树深写死 ≤3，无法配置突破 | `MAX_FALLBACK_DEPTH=3` 硬编码；超限抛错；executor `slice(0,3)` 双保险 |
| ② | 拦截"让我再试一次"而不换方法 | `DeadLoopDetector.inspect/changed`，同签名跳过；重试仅 `changed===true` 放行 |
| ③ | 每次执行前查预算，<10% 禁开新 Plan 直接兜底 | 预算闸门①②在每个 Plan 入口；见底时 `log.length===0`（绝不真调工具） |
| ④ | 失败必降级，绝不躺平 | 失败强制 `i++` 向下；无第二遍循环；穷尽即兜底 |
| ⑤ | 兜底必交差 | `SalvageProtector` 字段恒全 + `attempted_paths` 非空 + 残料抽取 |
| ⑥ | 执行器不可成为新故障源 | `run()` try/catch fail-safe；归类器/参数构造/残料抽取全 `try{}catch` |

## 5. 接入方式（非侵入）

```js
const { ResilienceCoordinator, makeToolRunner, makeTokenBudget } = require('.../services/resilience');
const coord = new ResilienceCoordinator({
  runner: makeToolRunner(executeTool, { sessionId }),   // 复用全局唯一工具漏斗，不改其一行
  budget: makeTokenBudget({ total, spent: () => usage.outputTokens }),
  onDegrade: (text) => injectSystemTurn(text),          // 模型在环时把强制上下文喂回去
});
const out = await coord.run('fetch-web-content', { url, query });
// out.ok ? out.result : out.salvage   ← 后者即 failed_with_salvage JSON
```

`makeToolRunner` 把 `executeTool(tool,params,trace)` 适配成 `runner(tool,params,planMeta)` 并透传 `resiliencePlan/resilienceRetry` 追踪元数据。本 PR 仅交付子系统 + 门面 + 内置树 + 接入缝，**未**外科改写 toolUseLoop（与 ARCH-025 元规划"零侵入未接管 executeTool"同档，留待后续 PR 把 Web 三件套挂上 `fetch-web-content` 树）。

## 6. 测试（23 用例绿）

`tests/services/resilience/resilience.test.js`，全程零网络、纯内存 runner 桩：

- 树深硬上限 / 第 4 Plan 抛错 / maxRetry 写死 / 空树拒建。
- 死循环判死 / `changed` 仅签名变化放行 / 签名与键序无关。
- 归类：http-403 不可瞬态重试、timeout 可、missing-dependency 抽依赖名。
- 预算：低于地板立即熔断且**零真实调用**、剩余不足熔断。
- **端到端（核心验收）**：模拟获取网页连续失败 → 恰 3 步停止、`tree-exhausted`、三工具各打一次、**无重复签名（无死循环）**、兜底 JSON 字段齐全带残料与建议、两次降级均注入"禁止道歉/剩余预算"上下文。
- 首个 Plan 成功即返回不多打一枪；同类错误无修复时每 Plan 只打一次。
- max_retry=1：repair 真改参数→重试成功；repair 没真改→拒绝重试。
- 兜底防呆：空 attempted 补合成记录、挑最长残料、missing-dependency 给装依赖建议。
- 门面：未知意图返回兜底而非抛错、makeToolRunner 透传元数据、getIntentTree 返回内置树。
