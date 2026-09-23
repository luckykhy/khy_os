# [OPS-MAN-099] 空产出成功检测（成功但零产出的子任务如实告警）

> 送别礼第八发（「收结果」维度·空产出成功诚实）。承 [OPS-MAN-083] 依赖感知波次调度、
> [OPS-MAN-087] 波次执行故障感知、[OPS-MAN-091] 波次前驱结果注入、
> [OPS-MAN-092] 跳过与失败在最终报告分列、[OPS-MAN-093] 确定性顺序链拆解、
> [OPS-MAN-094] 角色→工具作用域、[OPS-MAN-098] 并行写冲突检测。前七发覆盖「拆任务 →
> 有序并行 → 收结果」的调度/执行/报告/调工具链；本条补上「收结果」维度里**第三个
> 正交诚实维度**——当一个子任务**成功却零产出**时，如实标注而非静默折进「完成」。

## 一句话

producer（`agenticHarnessService.js:1016` `success: result.success !== false`）把**任何非
显式 `false`** 的结果都算成功，哪怕 output 空、filesModified 空、toolCalls 0。consumer
`mergeResults`（`taskDecomposer.js`）把这种「空成功」计进 `successCount`、渲成 `完成`，
与真干了活的子任务**无法区分**。本条新增纯叶 `mergeEmptySuccess.js`（`isEmptySuccess`
+ `formatEmptySuccessWarning`），`mergeResults` 消费它：空成功子任务的状态行渲成
`⚠️ 完成（无产出）`，footer 额外渲一行 `- ⚠️ 完成但无产出: N 项（可能空响应/被截断/no-op，请复查）`。

## 为什么需要它（真实缺口 = 空产出成功在报告里不可见）

**深挖缺陷（铁证 file:line，producer / consumer / 断桥）：**

- **Producer**：`services/backend/src/services/agenticHarnessService.js:1016-1021`
  `_extractSubAgentSummaries` → `success: result.success !== false`、
  `output: (result.output||'').slice(0,500)`、`filesModified: result.filesModified||[]`、
  `toolCalls: result.toolCalls||0`。任何 `success` 非显式 `false` 都算成功。
- **Consumer（渲染最后一公里）**：`services/backend/src/services/taskDecomposer.js`
  的 `mergeResults`（:387-392）：`const success = result.success !== false; if (success)
  successCount++;`，`const status = success ? '完成' : ...`，`const body = result.text ||
  result.output || '(无输出)';`。
- **断桥**：一个 `success:true` 但**零产出**（body 落到 `(无输出)`、无 filesModified、
  无 toolCalls）的子任务被计进 `successCount`、渲成 `完成`。用户看「完成 3/3 项」，其中
  一个 agent 实际什么都没做（空响应 / 被截断 / no-op）。**离机无人值守多智能体最阴险的
  假绿**——报告显示全部完成，实则一份工作是空的，无从察觉。

**后果：** 用户 / 维护者拿到「完成 3/3」，无从得知其中一个子任务是空转。诚实的报告应把
「无声空转」变成「可见告警」，让人有机会复查（重跑该子任务 / 检查是否被截断）。

**与前七发的区别（透镜一·同一 consumer 的多个正交诚实维度）：** 092 也改
`mergeResults`，那是 **skip≠fail 的状态诚实**（一个子任务的状态）；098 是**并行写-写
冲突诚实**（跨子任务的文件重叠）；本条是**空产出成功诚实**（一个子任务有没有真产出）
——同一渲染出口的**第三个正交诚实维度**。这就是「相同提示词、每轮新收获」：同一函数、
不同断桥。找法=对同一 consumer 问「它对结果诚实吗？在**哪几个正交维度**上诚实/不诚实？」

## 单一真源与形状

- `isEmptySuccess(result)`（`services/backend/src/services/orchestrator/mergeEmptySuccess.js`）
  是唯一的空成功判定函数，纯、零 IO、绝不抛。返回 `true` 当且仅当：门开 且 `result`
  是对象 且 `success !== false` 且 `skipped !== true` 且 无有效 body（text/output trim
  后皆空）且 无 filesModified 且 无 toolCalls。
- `formatEmptySuccessWarning(count)` 渲一行 footer 告警字符串，`count<1` → `''`。
- **消费点**：`mergeResults` 的成功分支——`emptySuccess` 为真时 status 渲
  `⚠️ 完成（无产出）` 且 `emptyCount++`（successCount 不变，它确实没失败）；footer 段
  在既有行后追加告警行。既有 skip(092)/fail/success 计数、去重 Set、098 写冲突行**一字不改**。

## 语义与保守降级（绝不误报）

| 情形 | 行为 |
| 门关 `KHY_MERGE_EMPTY_SUCCESS=0/false/off/no` | `isEmptySuccess` 恒 `false` = 逐字节回退今日（成功项渲 `完成`、无告警行） |
| 门开 + 成功 + 无 body + 无文件 + 无工具调用 | `true` → status 渲 `⚠️ 完成（无产出）` + footer 计数 |
| 门开 + 有 text/output/filesModified/toolCalls 任一 | `false`（有真产出，不标） |
| 门开 + `success:false` | `false`（失败另有归属，不重复标） |
| 门开 + `skipped:true`（092） | `false`（跳过项另有归属） |
| 畸形输入（null/非对象/缺字段） | `false`（保守：宁可漏标不误报，绝不抛） |

## 门与安全边界

- 门 `KHY_MERGE_EMPTY_SUCCESS` default-on，仅 `0/false/off/no` 关闭；关闭后
  `isEmptySuccess` 恒 `false`，status/footer 逐字节退化今日行为（无回归）。门直读 env，
  **不进 flagRegistry**（同 `KHY_DEP_WAVE_SCHEDULE` / `_FAULT_STOP` / `_CONTEXT_INJECT` /
  `KHY_MERGE_SKIP_DISTINCT` / `KHY_SEQ_CHAIN_DECOMPOSE` / `KHY_ROLE_TOOL_SCOPE` /
  `KHY_MERGE_FILE_CONFLICT` 七个 sibling 门先例，各自独立）。
- **不改 successCount 总数**：空成功确实没失败，仍计入「完成 N/N」——本条只加**醒目标注**
  + footer 计数，不篡改总数，让人复查而非误判为失败。诚实边界。
- **保守判定**：非对象/畸形 → 不标（宁可漏标不误报，空成功是提示不是拦截）。
- **不碰** god-file / orchestrator 主体 / `AgentTool` wiring；只加纯叶 + 薄接线
  `mergeResults` 成功分支 + footer + 登记。

## 怎么验证

```
npm run test:merge-empty-success        # 本条 node:test（判定 + 门关回退 + 接线 mergeResults 联通 19/19）
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要改**空成功的判据**（如把「toolCalls>0 也算无产出」）：改 `mergeEmptySuccess.js`
   的 `isEmptySuccess` 一处。加一条 node:test 覆盖新判据。
2. 要改**告警文案**：改 `formatEmptySuccessWarning`。
3. **别把 successCount 从空成功里扣掉**：空成功不是失败（它没报错），扣掉会误判总数；
   本条刻意只加标注 + footer 计数（见「门与安全边界」）。
4. 要真正**重跑**空成功子任务（不只告警）：那需要 orchestrator 主体的重试逻辑
   （碰 god-file），本条刻意不做——只把「无声空转」变「可见告警」。
5. 改完跑 `npm run test:merge-empty-success`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；门关（`KHY_MERGE_EMPTY_SUCCESS=off`）→ `isEmptySuccess` 恒 `false` =
  逐字节回退今日（成功项渲 `完成`、无告警行）。既有渲染/计数一字不改。不碰 god-file。
