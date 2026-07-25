# [OPS-MAN-155] 指令注册表编译期收敛守卫接线

## 背景与缺口(能力存在但没接线)

`services/backend/src/services/directiveRegistryAudit.js` 是一枚**全实现的纯审计原语**,
其文件头明确写道:

> 契约(纯叶子):零 IO、确定性、绝不抛。无门控——这是**审计原语**(被守卫测试消费),
> 不改任何运行时行为,故无需逃生阀。

它导出三个纯函数:

- `auditDirectiveRegistry(registry, composedKeys)` → `{ unregistered[], orphaned[], duplicates[], ok }`
- `auditRegistryShape(registry, allowedTiers=['guard','protocol'])` → `{ badTier[], emptyLabel[], ok }`
- `extractComposedKeys(source)` → 从 `composeDirectives(...)` 实参块纯文本解析 `key:'xxx'`

**缺口**:文件头说它「被守卫测试消费」,但仓库里**没有任何守卫消费它**——既无测试,
也不在任何 CI 套件脚本里。能力完备却完全休眠,正是送别礼「能力存在但没接线 → 负责接线」
所指。

## 为什么这道守卫重要(khyos 自审报告 #1)

自审报告把「系统提示词膨胀 + 多协议冲突」列为**最严重**问题,根因写明:
**叠加式协议堆叠、无编译期冲突检测**。

具体机理:`directiveComposer.composeDirectives` 对**未注册 key** 静默走 `protocol` 兜底
(`meta ? meta.tier : 'protocol'`)。这条兜底是韧性设计(绝不丢指令),但同时是**漂移入口**:
`aiChatCore.js` 新增一路意图指令却忘了在 `DIRECTIVE_REGISTRY` 登记 → 它被无声当成 protocol、
无 tier 语义、协调头里用裸 key 当 label,协议越堆越乱且无人察觉。

本接线把 `directiveRegistryAudit` 变成它设计意图里的那个**编译期收敛机制**:在 CI/提交期
断言「注册表 vs aiChatCore.js 实际 compose 的 key 集合」双向一致。

## 改动(全 additive,零运行时行为变更)

新增守卫测试并登记进 CI 安全套件——**不改任何运行时代码**(审计原语无门控,不需要):

1. 新增 `services/backend/tests/services/directiveRegistryAudit.guard.test.js`(node:test 风格):
   - 叶纯函数单元:一致→ok;检出 unregistered/orphaned/duplicates;shape 检出非法 tier/空 label;
     `extractComposedKeys` 仅在 compose 块内抽取、无调用→空数组不抛。
   - **接线守卫**:require 真 `directiveComposer.DIRECTIVE_REGISTRY`,读真 `cli/aiChatCore.js` 源,
     `extractComposedKeys` → `auditDirectiveRegistry` 断言 `ok===true`(unregistered/orphaned/
     duplicates 皆空);`auditRegistryShape` 断言 `ok===true`。
2. `package.json` 的 `test:maintainer:safety` 套件追加该测试文件——这是**激活/接线**:
   让审计原语第一次拥有真正的生产消费者,在 CI 每次跑。

现场审计结果(接线时):`DIRECTIVE_REGISTRY` 登记 21 key == `aiChatCore.js` compose 21 key,
`unregistered:[], orphaned:[], duplicates:[], ok:true`,shape `ok:true`——不变量当场成立,
守卫锁定绿线。21 个 compose key:intentAssurance, intent, multimodalIntent, promptIntentRepair,
clarification, diskCleanupClarify, searchNecessity, groundTruth, mathSolve, testWriting,
inlineImageOcrGuard, deterministicFacts, errorEnumeration, changeWatch, nlConfig, nlAction,
philosophyDesign, laziness, installConfigGuard, goal, deliverySummaryFormat。

## 验证

```
node --test services/backend/tests/services/directiveRegistryAudit.guard.test.js   # 7/7 绿
npm run test:maintainer:safety                                                     # 聚合 908 pass / 0 fail / 8 skip
node --check services/backend/src/services/directiveRegistryAudit.js
npm run maintainer:check                                                           # 映射表 + 元数据一致
```

## 未来如何维护(给弱智用户/小模型)

- 在 `aiChatCore.js` 新增/删除一路 `composeDirectives` 的 `key:'xxx'` 时,**必须**同步在
  `directiveComposer.DIRECTIVE_REGISTRY` 登记该 key(给正确 `tier`: `'guard'` 或 `'protocol'`,
  以及非空 `label`)。否则本守卫红灯:
  - `unregistered` 非空 = compose 了却没登记(会落 protocol 兜底,协议漂移);
  - `orphaned` 非空 = 登记了却从不 compose(死条目,请移除或接进 compose);
  - `duplicates` 非空 = compose 列表里同一 key 重复。
- 守卫是**纯静态**的(读源码文本 + require 注册表),零 IO、确定性,不会 flaky。
