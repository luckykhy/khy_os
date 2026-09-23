# [OPS-MAN-090] 还原导航器

> 本文件由 `scripts/restore-navigate.js --gen-doc` 确定性生成，请勿手改；
> 导航逻辑改在 `scripts/lib/restoreNavigator.js`，再重新生成。

## 这一层闭合什么：完整，却不简单

还原家族现有 12 个纯叶 / 10 条 CLI，每条只回答自己那一小块(能不能装 / 水合齐不齐 /
有没有矛盾 / 该不该自驱 / 收敛没 / 学到了什么…)。诊断是**完整**的——但一台陌生机器上的
agent 或人，面对 10 条命令，**得不到一个统一裁决，更没有一句「现在到底该跑哪条命令」**。
本层就是那个缺失的汇聚者：把全家族裁决合成**唯一 next-action**，把「完整」补成「完整且简单」。

端到端采齐(本 CLI 接线)：

```
授权门(该不该自驱) + 检测器/消解器(矛盾/恢复链) + 学习应用器(跨会话该跳哪步) + 追索(被禁怎么解锁)
  -> deriveNextAction -> { status, action, command, actor, why }
```

```bash
node scripts/restore-navigate.js --json   # 陌生机器上的自驱 agent 读它决定下一步
```

## 决策序：安全优先(木桶短板，最危险的先说话)

按**风险从高到低**逐档短路，第一个命中的档决定唯一裁决：

| 档 | 条件 | 裁决 |
|----|------|------|
| 1 | 授权门 `forbidden` | 交人：走 recourse 最省一步(agent 绝不自驱被禁场景) |
| 2 | 硬矛盾(`!safeToAutodrive` 且 `!autoResolvable`) | 交人：`firstHumanMove` |
| 3 | 可自动消解且**已 authorized** | 自驱：第一条 **LIVE** plan move(尊重学习跳过) |
| 3′ | 可自动消解但授权门判 **ask-first** | 给出**同一条**建议下一步，但 `status=ask-first`、`actor=human`：**每步须人工确认**，绝不静默自驱 |
| 4 | 计划为空且已还原(全绿) | DONE：无需动作 |
| 5 | 其它(样本不足 / 判定不清 / 畸形) | 保守交人：看 `--json` 自行决定 |

- **ask-first 不是 authorized**：授权门三态里 `ask-first`(有覆盖风险 / 链要交人但有人在场)
  契约是「每步前须向人确认，不得静默自驱」。导航器**绝不**把它并进 authorized 自驱——
  否则会泄掉三档里最危险的那一档(在有覆盖既有用户数据风险的机器上无人值守开跑)。

- **尊重学习**：档 3 取第一条**未被第十层判 safeToSkip** 的 move；`mustTryDespiteDead`
  的步仍须跑(它是该冲突唯一出路或安全网)。
- **绝不发明命令**：`command` 只从既有 `move.verify` / `recourse.verify` 取，取不到给
  一条**只读**复核命令(绝不给危险动作)。

## 恒久红线(继承全家族)

- `action` / `command` 先过 `_DANGER_TOKENS` 自检：命中即隐去并强制 `actor=human`。
- 只读既有裁决字段，绝不重排、绝不删除、绝不伪造 `authorized`(畸形 → 保守 human)。
- 叶子纯计算、零 IO、绝不抛：任何字段缺失 / 非对象 → 保守 UNKNOWN + human。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

