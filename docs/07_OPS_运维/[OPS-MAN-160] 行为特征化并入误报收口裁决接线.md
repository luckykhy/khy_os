# [OPS-MAN-160] 行为特征化并入误报收口裁决接线

## 一句话

`characterizationSnapshot`(纯零 IO 行为特征化叶)能就地差分出「未覆盖文件上的**静默行为漂移**」,`falsePositiveFixGuard.finalize` 也早就接受 `ctx.silentBehaviorChanges`,但生产端从来没有任何代码把 baseline/current 验证快照喂给它 → 纯孤儿能力。本轮接线:`finalize` 在 `ctx.baseline && ctx.current` 存在时就地差分静默漂移并入收口裁决;`agenticHarnessService` 把回归门(`bugfixRegressionGate`)已产出的 baseline/current 验证快照透传进 `finalize`。

## 断桥(能力存在但没接线)

- **生产端**:`characterizationSnapshot.diffBehavior(baseline, current, {coveredFiles}, env)` 逐步对比两份验证快照的 pass/summary 指纹,把「未被改动测试覆盖、pass 状态没变但输出内容漂移」的步骤归为 `silentChanges`(静默行为变化)。
- **消费槽**:`falsePositiveFixGuard.finalize(state, ctx, env)` 早就在 step-3 接受 `ctx.silentBehaviorChanges` 并入 `silent-behavior-change` 收口原因。
- **缺的桥**:没有任何生产代码采集 baseline/current 快照再喂给 finalize。回归门 `bugfixRegressionGate` 恰恰已经产出 `baseline`/`current` 两份快照,却只用于自身的红/绿判定,从未流向误报收口守卫。

## 接线(全 additive · fail-soft · 逐字节回退)

1. **`falsePositiveFixGuard.finalize`**:step-3 优先用调用方预算的 `ctx.silentBehaviorChanges`;若未提供但给了 `ctx.baseline && ctx.current`,则惰性 `require('./characterizationSnapshot')`,门开时就地 `captureBaseline` × 2 + `diffBehavior` 差分。**coveredFiles 复用本守卫自己的 `_computeUncovered`(单一真源,不另造覆盖判定防漂移)**。
2. **`agenticHarnessService`**:在既有 `_fpfGuard.finalize(...)` 调用点,把 `regressionGateReport ? regressionGateReport.baseline/current : null` 透传进 ctx。

## 门控

`KHY_FPF_CHARACTERIZATION`(flagRegistry,default-on)。

- 门关(env ∈ {0,false,off,no})/ 无 baseline+current 快照 / 差分抛错 → `silentBehaviorChanges` 恒 `[]` → 逐字节回退到接线前行为。纯叶 fail-soft,绝不破坏收口裁决。

## 抑制不变量(保留既有语义)

- **全覆盖**:改动文件全部被 sibling 测试覆盖(`allCovered`)→ 归 coveredChanges 不算静默。
- **仅测试步漂移**:测试步天然视为已覆盖 → 不算静默。
- **reproObserved**(红→绿真复现闭环)→ 静默原因被抑制,verdict pass。
- **调用方预算优先**:已提供 `ctx.silentBehaviorChanges` 时不就地差分。

## 裁决

`silent-behavior-change` 原因命中 → low tier `block` / 高 tier `caution`(沿用 finalize 既有 tier 分级)。

## 验证

```
node --test services/backend/tests/services/characterizationFpfWiring.test.js   # 10/10
node --check services/backend/src/services/falsePositiveFixGuard.js
node --check services/backend/src/services/agenticHarnessService.js
```
