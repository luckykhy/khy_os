# [DESIGN-ARCH-072] 任务最小闭环-裁决接线与交付台账

> **定位**：普通用户任务（非 `/goal` 持久目标）从「模型想停」到「交付完成」之间**最小闭环的单一真源**：收尾裁决接线 + 交付台账。
> **适用边界**：只治理「任务做不完 / 假完成交付 / 交付后无从回查」这一段；不替代 `[DESIGN-ARCH-050]`（项目整体意识与自驱收尾保障，本设计在其软门组合末端补最后一道权威裁决）、`RELIABILITY-PROTOCOL.md`（持久任务可靠性协议，其状态机照旧）、`[DESIGN-ARCH-071]`（通道选择）。
> **根因追溯**：`services/taskClosure.js` 文件头（写于本设计落地之前）已自述：「toolUseLoopCore 在模型不再调用工具时用脆弱散文正则判定收尾」——而其后补的权威仲裁器 `decideClosure` 一直全仓零消费者。

---

## 0. 闭环定义

一个任务算「可靠交付」，当且仅当走完以下五步，且每步有据可查：

```text
登记 → 执行（计划步骤可观测）→ 裁决（close / redrive / close_partial）
    → 交付（含诚实缺口标注）→ 台账（持久、可回查）
```

## 1. 本设计前的断点（2026-08 体检结论）

| 断点 | 位置 | 后果 |
|---|---|---|
| 收尾判定只有词面正则 `isFinalDelivery` | `toolUseLoopCore.js` `_looksConcluded` | 「声称完成但步骤未完成 / 验证未真跑」直接放行收尾 |
| 权威仲裁器 `decideClosure` 死代码 | `taskClosure.js` | 三态仲裁 + redrive 预算 + 证据门从未生效 |
| 任务终态 5 分钟 TTL 即焚 | `taskStore.js` / `backgroundTaskManager.js` | 「上次任务交付了什么、缺什么」无从回查 |
| 交付门零 criteria 时整段跳过 | `agenticHarnessService.js` | 非代码任务（文档/数据/桌面操作）验证形同虚设 |
| headless `-p` 裸奔 | `bin/khy.js` | 循环报错静默回退单发、交付不入账 |

## 2. 修复设计（全部接线，无新状态机）

### 2.1 收尾仲裁门（toolUseLoopCore）

- **接线点**：所有通用 nudge 之后、`goalStopGate` 之前（「想停时」的最后一道门）。
- **形状**：照抄 goalStopGate 黄金范例——判定在纯叶子 `taskClosure.decideClosure`，接线处只做 IO 落地，整块 try/catch fail-soft。
- **三态落地**：
  - `close` → 放行正常交付；
  - `close_partial` → 诚实标注（未完成步骤/未经证实的验证/无证据）随交付追加，经 `_terminalNotice` 通道流式必达；
  - `redrive` → 有界再驱动。其中**结构化信号**（`steps-incomplete` / `verification-missing`）是硬门，不受 `_softRedriveSuppressed` 抑制——实质性假完成正是抑制门（只防同一答案重复生成）的盲区；非结构化「无收尾词」再驱动仍尊重抑制，避免对已交付答案重复生成。
- **预算**：`resolveMaxRedrives`（env `KHY_TASK_CLOSURE_REDRIVE_MAX`，默认 1，clamp [0,6]），耗尽即降级 `close_partial`，绝不无限续跑。
- **门控**：`KHY_TASK_CLOSURE_GATE`（默认开，显式 0/false/off/no 关）。关 → 行为回退到既有软门组合。
- **作用域**：仅 `actionTask`（`_looksLikeActionRequest` 命中）且非 UPH 追问/断路器接管轮；纯问答/闲聊不受此门。

### 2.2 交付台账（deliveryLedger）

- **形态**：追加式 JSONL，`<dataHome>/tasks/delivery_ledger.jsonl`，自裁剪（`KHY_DELIVERY_LEDGER_MAX`，默认 500 条）——存储自限额模式（同 `KHY_TASK_EVENTS_MAX`），活动任务列表 TTL 语义不变。
- **写入点 1（咽喉）**：`backgroundTaskManager.complete/fail/cancel`——本模块一切终态的唯一出口，顺手入账；交付门 fail 的「完成」记 `closure: delivery-gate-fail`，不谎报完整闭环。harnessReport 新增 `deliverySummary`（终态回复摘要）供台账 summary 字段。
- **写入点 2（headless）**：`bin/khy.js` `-p` 原生循环路径——成功/失败/达上限均入账；循环整段抛错回退单发时 `_headlessLoopErr` 一并入账，不再无声无息。纯单发 chat（问答）不入账，避免台账噪音。
- **查询面**：`khy deliveries`（别名：`交付` / `交付记录` / `台账` / `jiaofu`），`--limit` / `--status` / `--task` 过滤，`deliveries stats` 看台账位置与条数。与 `khy receipts`（执行粒度回执）互补：receipts 记「做了什么操作」，deliveries 记「任务级交付结论与缺口」。

### 2.3 交付门零 criteria 兜底（agenticHarnessService + deliveryGate）

- criteria 为空时注入最小兜底标准：`substantive_final_response`（`deliveryGate.CUSTOM_VALIDATORS` 新验证器）——最终回复 ≥30 非空白字符即过，空壳/进度前言/套话拒绝会被拦下并触发修复循环。有模式专属 criteria 时本兜底不参与。

## 3. 环境变量一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `KHY_TASK_CLOSURE_GATE` | 开 | 收尾仲裁门总开关 |
| `KHY_TASK_CLOSURE_REDRIVE_MAX` | 1 | 单次循环内 redrive 预算，clamp [0,6] |
| `KHY_DELIVERY_LEDGER_MAX` | 500 | 台账自裁剪上限，clamp [1,5000] |

## 4. 测试锚点

- `services/__tests__/taskClosure.decideClosure.test.js` — 三态仲裁 + 预算 + 证据门（纯叶子契约）
- `services/__tests__/deliveryLedger.test.js` — 台账追加/截断/过滤/自裁剪/fail-soft
- `services/__tests__/backgroundTaskManager.ledger.test.js` — 终态咽喉 → 台账集成
- `services/__tests__/toolUseLoop.taskClosureGate.smoke.test.js` — 假 chat 驱动循环：redrive 注入 + close_partial 标注 + 有界终止
