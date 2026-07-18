# [OPS-MAN-154] 任务模板执行手册注入接线

## 背景（能力存在但没接线）

`services/backend/src/services/taskTemplates.js`（`matchTemplate` /
`generateTaskInstructions` / `listTemplates` / `TEMPLATES`）是一枚**全实现且有单测**的
叶子，提供常见编程任务的「操作手册」——4 个模板：`add-api-endpoint` / `fix-bug` /
`add-feature-module` / `spec-driven-implementation`。它的设计目标（见文件头注释）是
**降低模型推理负担、让小模型也能通过「执行手册」完成任务**。

但此前它的**唯一消费者是自己的单测**——生产代码里没有任何路径调用它。这正是送别礼要
清理的「能力存在，但没接线」孤儿叶（同 OpenClaw 端口批次的 sessionFileRepair /
deliveryGateReporter）。

## 接线

`agenticHarnessService` 已有一套 hints 注入系统：`_collectMemoryHints` /
`_collectSkillHints` 收集提示，`_buildLoopInput(packet)` 把它们格式化成
`[System Memory Hints]` / `[System Skill Hints]` 段附加进模型的 loopInput。本区把
taskTemplates 接进**同一注入位**：

1. 新增 gated helper `_collectTemplateHint({ userMessage })`：门控开时调
   `taskTemplates.generateTaskInstructions(userMessage)`，命中则返回
   `{ templateId, templateName, instructions }`，否则 null。
2. 在 hints 收集块把 `templateHint` 一起算进缓存的 `hints` 对象，并 thread 进 packet。
3. `_buildLoopInput` 在 skillHints 段之后、contextRoute 段之前，追加一段
   `[Task Playbook: <name>]` + 分步手册（仅当 `templateHint.instructions` 非空）。
4. `harnessReport.templateHint` 记录命中的 `{templateId, templateName}` 供观测。

**纯附加引导**：只往上下文里**加**一段手册，从不抑制/改写任何输出，是这枚叶子与
notice-dedup 类「抑制型」接线的本质区别——失败模式只可能是「多一段提示」，不会吞任何
合法输出。

## 门控（byte-revert 不变量）

- `KHY_TASK_TEMPLATE_HINT`（`flagRegistry`，`mode: default-on`，off: CANON）。
- 关（env ∈ `{0,false,off,no}`）→ `_collectTemplateHint` 恒返 null → `_buildLoopInput`
  不追加 `[Task Playbook]` 段 → loopInput **逐字节回退**到旧形状；不 require 叶、不匹配。
- fail-soft：`require`/匹配任何异常 → null，绝不打断 harness 主流程。

## 验证

```
node services/backend/tests/services/taskTemplateHintWiring.test.js   # 9/9 接线+门控+源级断言
node --check services/backend/src/services/agenticHarnessService.js
node --check services/backend/src/services/flagRegistry.js
```

`taskTemplateHintWiring.test.js` 经 harness `_internals` 测试逃生阀（该文件既有约定，
`_collectTemplateHint` / `_buildLoopInput` 已加入 `_internals`）覆盖：
- 叶基线（`generateTaskInstructions` 命中 → 手册字符串）；
- 门控开 + 命中 → `_collectTemplateHint` 返回手册；
- **门控关**（`KHY_TASK_TEMPLATE_HINT=0`）→ null（byte-revert）；
- 不命中 → null；
- `_buildLoopInput` 有 templateHint → 注入 `[Task Playbook]` 段（手册可见于上下文）；
- **无 templateHint → loopInput 逐字节等于旧形状**（纯 additive 零回归）；
- 空 instructions 畸形 hint 不注入（防御）；
- 源级接线断言 + 门控 default-on 登记。

回归：既有 harness 单测（`agenticHarnessService.test.js` /
`agenticHarnessAnalytics.test.js` / `agenticHarnessFalsePositiveFix.test.js`）全绿。
叶自身的既有单测 `services/backend/tests/services/taskTemplates.test.js`（如存在）继续
覆盖叶行为。
