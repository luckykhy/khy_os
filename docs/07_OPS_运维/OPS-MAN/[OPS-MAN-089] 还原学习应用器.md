# [OPS-MAN-089] 还原学习应用器

> 本文件由 `scripts/restore-apply.js --gen-doc` 确定性生成，请勿手改；
> 应用逻辑改在 `scripts/lib/restoreSkipApplier.js`，再重新生成。

## 这一层闭合什么：一条断桥(产出了学习，却无人消费)

策略台账(OPS-MAN-088)跨会话学出 `recommendedSkips`——这台机器上已被反复证明无用的策略。
但它的**消费点为零**：台账花力气产出了学习，恢复链却从不读它，于是 agent 仍会按原序把
已证死的策略再走一遍。**上游产出、下游能吃、中间无人接线 = 死字段**。本层就是那个缺失的
消费者，把 `recommendedSkips` 应用到 resolver 的 `moves` 上，让「学到的」变成「用上的」。

端到端闭环(本 CLI 接线)：

```
gatherAssessments(三面镜子) -> detectRestoreConflicts(矛盾) -> resolveRestoreConflicts(有序恢复链)
  -> readAllSessions + deriveStrategyLedger(跨会话学出死策略) -> applyLearnedSkips(标注到链上)
```

```bash
node scripts/restore-apply.js --json   # 自驱 agent 读它决定跳哪步、试哪步
```

## 怎么应用：只标注，不删除，不重排(诚实边界)

台账划下红线：「学习只做减法，**绝不重排安全恢复链顺序**」。本层严格遵守，逐 move 标注：

| 标注 | 含义 |
|------|------|
| `learnedDead` | 该 move 的 strategy 属于跨会话已证死的集合 |
| `safeToSkip` | 已证死**且**跳过它不搁浅任何冲突(它 covers 的每个冲突都另有非死 move 兜底)**且**不是安全网 |
| `mustTryDespiteDead` | 已证死但**是唯一出路**或**是 escalate 安全网** → 仍须一试或升级交人 |

- **保序**：`plan` 与输入 `moves` 顺序逐一对应，绝不重排(reprobe→reconcile→
  trust-pessimistic→escalate 的安全序由风险决定，不可因学习颠覆)。
- **不删**：绝不移除任何 move。学习是**建议性标注**，执行者(agent)再决定跳不跳。
- **不搁浅冲突**：死策略若是某冲突的唯一出路，绝不建议跳过——否则等于静默放弃还原，
  比「再试一次已知无用」更危险。
- **不吞交人出口**：`escalate` 是最后的人力安全网，**永远** `safeToSkip=false`。

## 纯度与安全边界(继承项目章程)

- 叶子纯计算、零 IO、绝不抛：畸形 moves / 空 skips → 原样透传全部 move、零跳过建议(保守)。
- 读盘串链在本 CLI；应用判定在叶子。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

