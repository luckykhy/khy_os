# [OPS-MAN-101] 角色归属诚实（最终报告按角色标注子任务并把失败按类型分布）

> 送别礼第九发（「收结果」维度·角色归属诚实）。承 [OPS-MAN-083] 依赖感知波次调度、
> [OPS-MAN-087] 波次执行故障感知、[OPS-MAN-091] 波次前驱结果注入、
> [OPS-MAN-092] 跳过与失败在最终报告分列、[OPS-MAN-093] 确定性顺序链拆解、
> [OPS-MAN-094] 角色→工具作用域、[OPS-MAN-098] 并行写冲突检测、
> [OPS-MAN-099] 空产出成功检测。前八发覆盖「拆任务 → 有序并行 → 收结果」的
> 调度/执行/报告/调工具链；本条补上「收结果」维度里**第四个正交诚实维度**——
> 最终报告把每个子任务的 `role`（实现/验证/探索/通用）折没了，一个失败的**验证**
> 子任务（结果未经校验，严重）与一个失败的**探索**子任务（可恢复）无法区分。

## 一句话

`decompose`（`taskDecomposer._inferRole`）给每个子任务打上 `role`
（implement/verify/explore/general），这个 role 已被**选模型**（subAgentModelSelect）
与 **094 工具作用域**（roleToolScope）消费，但唯一面向用户的汇总报告 `mergeResults`
把它**整个折掉**：子任务表头渲成 `### 子任务 3: <preview>`，失败渲成 `失败: <err>`，
**完全看不出失败的是哪一类工作**。本条新增纯叶 `mergeRoleAttribution.js`
（`formatRoleTag` + `formatRoleFailureSummary`），`mergeResults` 消费它：表头渲成
`### 子任务 3（验证）: <preview>`，footer 额外渲一行
`- ⚠️ 失败分布: 验证 1 项、探索 1 项（验证失败=结果未经校验，请复查）`。

## 为什么需要它（真实缺口 = 失败的类型在报告里不可见）

**深挖缺陷（铁证 file:line，producer / consumer / 断桥）：**

- **Producer**：`services/backend/src/services/taskDecomposer.js` 的 `_inferRole`
  给每个子任务打 `role`（implement/verify/explore/general，优先级
  implement>verify>explore>general）。该字段**有活跃消费者**：subAgentModelSelect
  按 role 选模型；OPS-MAN-094 `roleToolScope` 按 role 收窄只读角色的工具集。
- **Consumer（渲染最后一公里）**：同文件的 `mergeResults`——表头
  `const header = \`### 子任务 ${idx}: ${preview}\`;`，失败分支渲 `失败: <err>`。
  **role 在这里被整个折掉**，报告里没有任何 role 信息。
- **断桥**：一个 `role: 'verify'` 的子任务失败，和一个 `role: 'explore'` 的子任务
  失败，在报告里**渲成完全一样的匿名「失败」**。但语义天差地别：失败的验证 =
  这批工作**未经校验**（严重，必须复查），失败的探索 = 可恢复（实现+验证可能仍通过）。
  **离机无人值守多智能体场景**下，用户拿到「失败 2 项」却无从判断严重性。

**后果：** 用户 / 维护者拿到匿名「失败 N 项」，无从得知失败的严重性分布。诚实的报告
应把「失败的类型」摊开，尤其**失败的验证**要醒目标注（结果未经校验），让人优先复查。

**与前八发的区别（透镜一·同一 consumer 的多个正交诚实维度）：** 092 改
`mergeResults` 的 **skip≠fail 状态诚实**；098 是**并行写-写冲突诚实**（跨子任务的
文件重叠）；099 是**空产出成功诚实**（一个子任务有没有真产出）；本条是**角色归属
诚实**（失败的是哪一类工作）——同一渲染出口的**第四个正交诚实维度**。这就是
「相同提示词、每轮新收获」：同一函数、不同断桥。找法=对同一 consumer 问
「它对结果诚实吗？在**哪几个正交维度**上诚实/不诚实？」。**本轮关键纪律=负向验证**：
装饰一个字段前先确认它**有活跃消费者**——否则它自身就是死字段（正是本方法论要猎的坑）。
role 已被 selectModel + roleToolScope 消费，是活字段，装饰它诚实、非死代码。

## 单一真源与形状

- `formatRoleTag(role)`（`services/backend/src/services/orchestrator/mergeRoleAttribution.js`）
  渲一个可抑制的表头角色标签，如 `（验证）`。门关 / 非字符串 / 未知 role → `''`
  （逐字节回退：表头仍是 `### 子任务 N: preview`）。
- `formatRoleFailureSummary(failedRoles)` 把**失败**子任务的 role 数组按桶计数，
  渲一行**不带前导 `- `** 的 footer 字符串；门关 / 非数组 / 空 → `''`。当失败里含
  `verify` 时追加 `（验证失败=结果未经校验，请复查）` 严重提示。
- `roleLabel(role)` / `_roleAttributionEnabled()` 为辅助导出。
- **消费点**：`mergeResults`——(a) 表头拼 `roleTag = formatRoleTag(subtask.role)`；
  (b) 累加器 `failedRoles`，在 `if (!result)` 空结果分支与 `else` 失败分支各
  `failedRoles.push(subtask.role)`；(c) footer 段追加 `formatRoleFailureSummary(failedRoles)`。
  既有 skip(092)/098 写冲突/099 空产出行、successCount/failCount 计数、去重 Set **一字不改**。

## 语义与保守降级（绝不误报、绝不丢失败）

| 情形 | 行为 |
| 门关 `KHY_MERGE_ROLE_ATTRIBUTION=0/false/off/no` | `formatRoleTag`/`formatRoleFailureSummary` 恒 `''` = 逐字节回退今日（表头无标签、footer 无分布行） |
| 门开 + 已知 role（implement/verify/explore/general） | 表头渲 `（实现/验证/探索/通用）`；失败计入对应桶 |
| 门开 + 未知 / 畸形 role 的**表头** | 标签抑制为 `''`（标签是装饰，宁可无标签也不错标） |
| 门开 + 未知 / 畸形 role 的**失败计数** | 归入 `通用` 桶（失败绝不丢：桶计数之和==failCount，诚实不变量） |
| 门开 + 失败里含 `verify` | footer 追加 `（验证失败=结果未经校验，请复查）` |
| 畸形输入（null/非数组/空） | 返 `''`（保守：绝不抛，绝不重分类成败） |

## 门与安全边界

- 门 `KHY_MERGE_ROLE_ATTRIBUTION` default-on，仅 `0/false/off/no` 关闭；关闭后两函数
  恒 `''`，表头/footer 逐字节退化今日行为（无回归）。门直读 env，**不进 flagRegistry**
  （同 `KHY_DEP_WAVE_SCHEDULE` / `_FAULT_STOP` / `_CONTEXT_INJECT` / `KHY_MERGE_SKIP_DISTINCT`
  / `KHY_SEQ_CHAIN_DECOMPOSE` / `KHY_ROLE_TOOL_SCOPE` / `KHY_MERGE_FILE_CONFLICT` /
  `KHY_MERGE_EMPTY_SUCCESS` 八个 sibling 门先例，各自独立）。
- **不改 successCount / failCount**：本条只加**表头标签 + footer 失败分布**，不篡改任何
  成败计数（那由 `mergeResults` 拥有）。诚实边界。
- **失败绝不丢**：每个失败 role 必落进某个桶（未知 → 通用），桶计数之和 == failCount。
  标签是装饰可抑制，失败计数是账目不可丢——两者对畸形输入的处理刻意不同。
- **不碰** god-file / orchestrator 主体 / `AgentTool` wiring；只加纯叶 + 薄接线
  `mergeResults` 表头/失败分支/footer + 登记。

## 怎么验证

```
npm run test:merge-role-attribution     # 本条 node:test（判定 + 门关回退 + 接线 mergeResults 联通 17/17）
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要**加一个新 role**：在 `mergeRoleAttribution.js` 的 `_ROLE_LABELS` 加一条即可。
   失败分布的桶对未映射 role 回退到 `通用`，所以漏加只会退化成安全计数，绝不崩、绝不丢失败。
2. 要改**表头标签文案**：改 `formatRoleTag`（返回 `（label）` 的那处）。
3. 要改**失败分布文案 / 严重提示**：改 `formatRoleFailureSummary`。
4. **别把 role 装饰扩到 successCount/failCount**：本条刻意只加标注，不碰任何成败计数
   （那由 `mergeResults` 拥有，见「门与安全边界」）。
5. **装饰任何 producer 字段前先确认它有活跃消费者**（负向验证纪律）：role 之所以值得
   装饰，是因为它已被 selectModel + roleToolScope 消费，是活字段而非死字段。
6. 改完跑 `npm run test:merge-role-attribution`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；门关（`KHY_MERGE_ROLE_ATTRIBUTION=off`）→ 两函数恒 `''` = 逐字节回退今日
  （表头无标签、footer 无分布行）。既有渲染/计数一字不改。不碰 god-file。
