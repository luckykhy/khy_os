# OPS-MAN-152 交付门人类可读报告落盘接线

## 背景 — 能力存在但没接线

`deliveryGateReporter.js`(225 行)提供 `generateDeliveryReport` /
`saveDeliveryReport` / `extractGateBMetrics`,能把 deliveryGate 的评估结果渲染成
带**逐条判定 + 缺失项 + 改进建议**的 markdown/text 报告。叶子全实现、有单测
(`deliveryGateReporter.test.js`),但**零生产消费者**——只有它自己的测试 require 它。

同时,活跃的 `deliveryGate.evaluateDelivery` 被 `agenticHarnessService.js`(37 处引用)
消费,harness 跑完把结果:

- 挂到返回值 `harness.deliveryGate`(结构化摘要:verdict/passed/missing 标签);
- 经 `saveSessionTrace` 记录结构化摘要。

但**从不产出 markdown 报告**。`delivery_verdict` 事件也只带
verdict/blockedBy/summary,REPL 的 `onEvent` 处理器根本没有渲染分支
(retry/continuation/regression 有,delivery 全被丢弃)。于是 `generateDeliveryReport`
这份「让 verdict 更可见」的能力完全没有触达用户/维护者的路径。

## 修改 — 全 additive · 门控 · fail-soft · 字节回退

在 harness 最终 verdict 定案处(`delivery_verdict` 事件紧邻其后,`deliveryGateReport`
在作用域内),把完整报告经 `saveDeliveryReport` 落到本项目轨迹目录:

```
~/.khyquant/projects/<hash>/delivery-gate-report.md
```

该目录与 `saveSessionTrace` 同源(`projectMemoryService.getProjectDir`,自动
`ensureDir`),是维护者已知的每项目落盘位置。并发 `delivery_gate_report` 事件告知
路径与 verdict。

- **门控**:`KHY_DELIVERY_GATE_REPORT`(default-on)。关(env ∈ {0,false,off,no})
  → 不 require、不落盘、不发事件 → harness 行为**逐字节回退**。off-word 列表与既有
  `KHY_VERIFICATION_GATE` 门同形。
- **fail-soft**:落盘全包在 `try/catch`,报告是装饰性,绝不打断主流程(与
  `delivery_gate` best-effort 约定一致)。
- **两个 orphan export 都被激活**:`saveDeliveryReport` 内部调用
  `generateDeliveryReport`。

### 触碰的文件

| 文件 | 改动 |
| --- | --- |
| `services/backend/src/services/flagRegistry.js` | 注册 `KHY_DELIVERY_GATE_REPORT` default-on |
| `services/backend/src/services/agenticHarnessService.js` | `delivery_verdict` 后新增门控落盘块 |
| `services/backend/tests/services/deliveryGateReporter.test.js` | +3 测(落盘一致性 / harness 接线源级断言 / 门注册) |
| `docs/维护者/维护映射表.json` | 新增 area `delivery-gate-report-artifact` |

god-file 检查:agenticHarnessService 1882 行、flagRegistry 2483 行,均 < 2500。

## 验证(全绿)

```
node services/backend/tests/services/deliveryGateReporter.test.js   # 9/9 通过
node --check services/backend/src/services/agenticHarnessService.js # OK
node --check services/backend/src/services/flagRegistry.js          # OK
```

**LIVE 端到端**:真实 `evaluateDelivery`(3 条 criteria over 真 backend 目录·1 缺失·
1 警告)→ 输出直接喂 `generateDeliveryReport` / `saveDeliveryReport` → 833 字节 markdown
报告,verdict/statistics/missing/remediation 全渲染、无抛错。证明形状匹配为真(非仅
对手写 mock),报告是 evaluateDelivery 输出的干净 drop-in。

## 不变量

1. 门关 → 字节回退(不 require deliveryGateReporter,harness 与改前逐字节一致)。
2. `deliveryGateReport` 为 null(criteria 为空 / 门评估异常)→ 跳过,不落盘。
3. 落盘 fail-soft,任何 IO 异常都被吞,主返回不受影响。

## 教训

- 「能力存在没接线」的真身有两种:零消费者的 flag,以及**全实现+有测但只有自己
  测试 require 的叶子**。deliveryGateReporter 属后者。
- 接线前必先证「触达路径真实」:先确认 onEvent 的消费者(replSession/queryEngine)
  是否渲染该类事件——发现 delivery 事件被全丢弃 → 改用**落盘到已知轨迹目录**这条
  真实可达的表面,而不是发一个没人渲染的事件(那还是「接进虚空」)。
- 形状匹配靠读真源(evaluateDelivery 返回对象 439-456 行)+ LIVE 端到端跑真
  evaluateDelivery,而非只信手写 mock——早前一次 field-presence grep 因属性简写
  (`passedCount,` / `results,`)误报缺字段,读真源才纠正。

不 commit(feat/0.1.104,红线:禁 AI 自动 commit/push)。
