# [OPS-MAN-098] 并行写冲突检测（多子任务改同一文件时如实告警）

> 送别礼第七发（「收结果」维度·并行写冲突诚实）。承 [OPS-MAN-083] 依赖感知波次调度、
> [OPS-MAN-087] 波次执行故障感知、[OPS-MAN-091] 波次前驱结果注入、
> [OPS-MAN-092] 跳过与失败在最终报告分列、[OPS-MAN-093] 确定性顺序链拆解、
> [OPS-MAN-094] 角色→工具作用域。前六发覆盖「拆任务 → 有序并行 → 收结果」的
> 调度/执行/报告/调工具链；本条补上「收结果」维度里**另一个正交诚实维度**——
> 当多个并行子任务改**同一个文件**时，如实告警可能的写-写覆盖，而非静默坍缩。

## 一句话

每个并行子智能体的结果携带 `filesModified` 数组（producer：`agenticHarnessService.js:1018`）。
`mergeResults`（`taskDecomposer.js`）把所有子任务的 `filesModified` 折进一个**去重
Set**，footer 渲成 `- 修改文件: a.js, b.js`。Set 去重把「同一文件被两个并行子任务
都改过」**静默坍缩成一条**——用户看报告无法区分「3 个文件各改一次」与「2 个文件、
其中一个被两个并行 agent 同时改（last-write-wins、一份工作被静默覆盖丢失）」。本条
新增纯叶 `mergeFileConflicts.js`（`detectFileConflicts` + `formatConflictWarning`），
`mergeResults` 消费它，footer 额外渲一行 `⚠️ 并行写冲突（…）: shared.js（子任务 1, 3）`。

## 为什么需要它（真实缺口 = 并行写-写冲突在报告里不可见）

**深挖缺陷（铁证 file:line，producer / consumer / 断桥）：**

- **Producer**：`services/backend/src/services/agenticHarnessService.js:1018`
  `filesModified: result.filesModified || []`——每个子智能体结果带「改了哪些文件」。
  同一波次（wave）内多个子任务**真并行执行**（`planWaves` 波内并行，OPS-083）。
- **Consumer（渲染最后一公里）**：`services/backend/src/services/taskDecomposer.js`
  的 `mergeResults` 把所有 `filesModified` 无条件 `allFilesModified.add(f)` 折进一个
  **去重 Set**，footer 渲成一行「修改文件」。
- **断桥**：Set 去重使「同一文件被 ≥2 个并行子任务改过」**坍缩成一条**，用户报告
  完全看不到这是并行写重叠。**离机还原 / 无人值守多智能体场景最危险的一类静默数据
  丢失**——两个并行 agent 都声称成功、报告只显示一个文件名、其中一份工作已丢。

**后果：** 用户 / 维护者拿到「修改文件: config.js」，无从得知 config.js 是被两个
并行子任务同时改的（其中一个的改动可能已被覆盖）。诚实的报告应把「静默丢失」变成
「可见告警」，让人有机会复查。

**与前六发的区别（透镜一·同一 consumer 的多个正交诚实维度）：** 092 也改
`mergeResults`，但那是 **skip≠fail 的状态诚实**（一个子任务的状态）；本条是**并行
写-写冲突的诚实**（跨子任务的文件重叠）——同一渲染出口的**另一个正交诚实维度**。
这就是「相同提示词、每轮新收获」：同一函数、不同断桥。找法=对同一 consumer 问
「它对结果诚实吗？在**哪几个正交维度**上诚实/不诚实？」

## 单一真源与形状

- `detectFileConflicts(subtaskFiles)`（`services/backend/src/services/orchestrator/mergeFileConflicts.js`）
  是唯一的冲突检测策略函数，纯、零 IO、绝不抛。入参 `[{label, files}]`，返回被
  ≥`_CONFLICT_MIN`(=2) 个**不同**子任务改过的文件 `[{file, labels}]`。
- `formatConflictWarning(conflicts)` 渲成一行 footer 告警字符串，空 → `''`。
- **消费点**：`mergeResults` 的 footer 段——收集 `perSubtaskFiles`（只对真跑过、
  非跳过、有 filesModified 的子任务），在既有「修改文件」行后追加告警行。既有 skip
  (092)/fail/success 渲染与去重 Set **一字不改**（纯加性）。

## 语义与保守降级（绝不误报）

| 情形 | 行为 |
| 门关 `KHY_MERGE_FILE_CONFLICT=0/false/off/no` | `detectFileConflicts` 返回 `[]` = 逐字节回退今日「只去重、不告警」 |
| 门开 + 同一文件被 ≥2 个不同子任务改 | 返回冲突项，footer 渲 `⚠️ 并行写冲突（…）` |
| 门开 + 每个文件只被 1 个子任务改 | 无冲突（不误报单文件单改） |
| 门开 + 同一子任务重复列同一文件 | label Set 去重后 <2 → 不算冲突 |
| 跳过项（092，无 filesModified） | 天然不参与冲突检测 |
| 畸形输入（null/非数组/项无 files/文件名非字符串/空串） | 安全跳过，绝不抛 |

## 门与安全边界

- 门 `KHY_MERGE_FILE_CONFLICT` default-on，仅 `0/false/off/no` 关闭；关闭后
  `detectFileConflicts` 返回 `[]`，footer 无告警行 = 逐字节退化今日行为（无回归）。
  门直读 env，**不进 flagRegistry**（同 `KHY_DEP_WAVE_SCHEDULE` / `_FAULT_STOP` /
  `_CONTEXT_INJECT` / `KHY_MERGE_SKIP_DISTINCT` / `KHY_SEQ_CHAIN_DECOMPOSE` /
  `KHY_ROLE_TOOL_SCOPE` 六个 sibling 门先例，各自独立）。
- **路径 trim 不 lowercase**：Linux fs 大小写敏感，`A.js` 与 `a.js` 是**不同文件**，
  强行 lowercase 会误报两个不同文件为冲突——诚实边界，只 trim 空白。
- **只如实告知，不阻止 / 仲裁冲突**：真正阻止并行写需运行时文件锁（超纯叶范围）。
  本条只把「静默丢失」变「可见告警」，让人有机会复查。
- **不碰** god-file / orchestrator 主体 / `AgentTool` wiring；只加纯叶 + 薄接线
  `mergeResults` footer + 登记。

## 怎么验证

```
npm run test:merge-file-conflict        # 本条 node:test（检测 + 门关回退 + 接线 mergeResults 联通 18/18）
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要改**冲突阈值**（如 ≥3 才告警）：改 `mergeFileConflicts.js` 的 `_CONFLICT_MIN`
   一处。加一条 node:test 覆盖新阈值。
2. 要改**告警文案**：改 `formatConflictWarning`。
3. **别加 lowercase 归一**：路径大小写敏感（见「门与安全边界」），lowercase 会
   把 `A.js`/`a.js` 误报为同一文件冲突。
4. 要真正**阻止**并行写（不只告警）：那需要运行时文件锁 / 波次内串行化改同一文件的
   子任务，属于 orchestrator 主体的运行时改动（碰 god-file），本条刻意不做。
5. 改完跑 `npm run test:merge-file-conflict`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；门关（`KHY_MERGE_FILE_CONFLICT=off`）→ `detectFileConflicts` 返回
  `[]` = 逐字节回退今日「只去重、不告警」。既有渲染/计数一字不改。不碰 god-file。
