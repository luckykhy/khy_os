# [OPS-MAN-092] 跳过与失败在最终报告分列（收结果的诚实最后一公里）

> 送别礼第四发（收结果的诚实最后一公里）。承 [OPS-MAN-083] 依赖感知波次调度、
> [OPS-MAN-087] 波次执行故障感知、[OPS-MAN-091] 波次前驱结果注入。本条补上
> 「收结果」诚实性的**最后一行**——被依赖失败牵连而跳过的子任务，在最终报告里
> 不再和真正跑失败的子任务混为一谈。

## 一句话

khy 已能有序拆波、并行执行、依赖失败则跳过下游并如实汇报、下游波携带前驱产出。
但**最终把所有子任务结果折叠成用户可读报告**的那一步（`mergeResults`）此前
**从不消费** `skipped` 标记——一个「因上游失败被跳过」的子任务，和一个「真的跑起来
然后失败」的子任务，在报告里长得一模一样（同一句 `失败:`、同一个 `失败: N 项`
计数）。本条让 `mergeResults` 消费 `skipped`：跳过项渲成独立状态
`跳过（依赖失败）`，footer 拆出独立的 `跳过（依赖失败）: N 项` 计数，与 `失败: N 项`
分列。用户一眼看清「谁真失败、谁是被牵连」。

## 为什么需要它（真实缺口 = 一个跨轮次产出的字段在最后一公里无消费者）

**深挖缺陷（铁证 file:line，producer/consumer 断桥）：**

- **Producer**：`services/backend/src/services/agenticHarnessService.js:1176`
  （OPS-MAN-087）为被上游失败牵连的子任务合成
  `{ success:false, skipped:true, error:'依赖失败，已跳过' }`。
- **Consumer（唯一渲染路径）**：`services/backend/src/services/taskDecomposer.js`
  的 `mergeResults`——它逐项只读 `result.success` / `result.error`，**从不看
  `result.skipped`**。跳过项 `success !== false` 为假 → 落进 `failCount` → 渲成
  `**状态**: 失败: 依赖失败，已跳过`，并计进 footer 的 `失败: N 项`。

**后果：** 用户看最终报告无法区分「3 项失败」与「1 项真失败、2 项因它被跳过」。
OPS-MAN-087 在上游辛苦建立的**因果区分**，在最后一公里的 merge 步被抹平。且
`mergeResults` 此前**零直接测试覆盖**（唯一 require `taskDecomposer` 的测试是
wave-scheduler，不测 merge 的 skip 行为）。

**与前三发的区别（换透镜）：** 083/087/091 都收割同一段零调用者死代码
`subAgentOrchestrator.js` 的 `executeDependencyAware`（透镜二：死代码印证设计意图）。
本条改用**透镜一**——追一条数据字段从产出到消费的全链，找断桥。`skipped` 就是一个
**跨轮次产出、但在渲染层无消费者的死字段**。

## 单一真源与分层

- `mergeResults`（`services/backend/src/services/taskDecomposer.js`）是所有
  子任务结果折叠成用户报告的**唯一**入口。本条只在此单函数内加消费逻辑：
  - 新增计数器 `skipCount`（与 `successCount` / `failCount` 并列）。
  - 逐项判定 `const isSkipped = _skipDistinctEnabled() && result.skipped === true;`
    - 跳过项：`skipCount++`，渲 `**状态**: 跳过（依赖失败）` + `result.error`
      （**不**渲 `(无输出)` 噪声），**不**计入 `failCount`、**不**采集
      `filesModified`（跳过项没跑、无产出）。
    - 非跳过项：**逐字节保持今日逻辑**。
  - footer：`失败: N 项` 之后加 `if (skipCount > 0)` 的 `跳过（依赖失败）: N 项`。
- 门 `KHY_MERGE_SKIP_DISTINCT`（default-on）由 `_skipDistinctEnabled()` 函数式
  **每调用读一次**（便于测试注入 env、纯、绝不抛），**不进 flagRegistry**
  （同 `KHY_DEP_WAVE_SCHEDULE` / `_FAULT_STOP` / `_CONTEXT_INJECT` 三门先例，
  各自独立）。

## 语义与保守降级（绝不改非跳过项行为）

| 情形 | 行为 |
| 门关 `KHY_MERGE_SKIP_DISTINCT=0/false/off/no` | `isSkipped` 恒 false → 跳过项照今日走 `失败` 分支、计入 failCount、无 `跳过` footer（逐字节回退） |
| 门开 + `result.skipped === true` | 渲 `跳过（依赖失败）`、`skipCount++`、不计 failCount、不采 filesModified |
| 门开 + 非跳过项（真成功/真失败） | 逐字节保持今日 `success = result.success !== false` 分支 |
| 门开 + 无跳过项 | footer 无 `跳过` 行（与今日一致） |
| `result` 为 null | `未执行`（不变，不当作跳过） |
| `aggregated` 为空 | `所有子任务未返回结果。`（不变） |

## 门与安全边界

- 门 `KHY_MERGE_SKIP_DISTINCT` default-on，仅 `0/false/off/no` 关闭；关闭后
  `mergeResults` 对跳过项逐字节退化为今日「折进失败」行为（无回归）。sibling 门
  直读 env，**不进 flagRegistry**。四门（三个 `KHY_DEP_WAVE_*` + 本门）各自独立。
- **不碰** god-file / orchestrator / `AgentTool/index.js`；只编辑 `mergeResults`
  单函数 + 新测 + 登记。`skipped` 的 producer（`agenticHarnessService` 波循环）
  **本条不改**——只补 consumer 端。
- 诚实边界：只在**多波 + fault-stop 真产出 skip 项**时可见效果；单波/无跳过 →
  footer 无 `跳过` 行、逐字节今日行为。`skipped` 来源仍是 OPS-MAN-087
  （`KHY_DEP_WAVE_FAULT_STOP` default-on）；fault-stop 关则无 skip 项产出，本条
  consumer 自然 no-op。dev 机验证止于 node:test 门开/门关双路径 + 边界，不实跑
  多智能体端到端（需真 LLM 渠道产真 skip 链）。

## 怎么验证

```
npm run test:merge-skip-distinct        # 本条 node:test（门开分列 + 门关回退 + 边界）7/7
npm run test:maintainer:safety          # 已并入的 must 守卫集（含本测文件）
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要改「跳过项如何渲染」：改 `mergeResults` 里 `isSkipped` 分支的状态文案
   （`跳过（依赖失败）`）与 body 取值（`result.error || '依赖失败，已跳过'`）。
   保持不采集 `filesModified`、不渲 `(无输出)`。
2. 要改「跳过与失败在 footer 如何计数」：改 `skipCount` 的初始化与 footer 的
   `跳过（依赖失败）: N 项` push。保持 `skipCount` 不并入 `failCount`。
3. 要新增一类「非真失败」的终态（如「已取消」）：在 `mergeResults` 里比照
   `isSkipped` 加一个 `isCancelled` 判定 + 独立计数 + 独立 footer 行，切勿把它
   折进 `失败`。相应的 producer 标记（如 `result.cancelled`）在
   `agenticHarnessService` 波循环合成。
4. 改完跑 `npm run test:merge-skip-distinct`（必须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive；非跳过项路径逐字节不变；门关（`KHY_MERGE_SKIP_DISTINCT=off`）→
  跳过项照今日走 `失败` 分支 = 逐字节回退。
