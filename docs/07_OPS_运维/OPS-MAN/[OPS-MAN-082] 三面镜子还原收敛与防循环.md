# [OPS-MAN-082] 三面镜子还原收敛与防循环

> 本文件由 `scripts/restore-converge.js --gen-doc` 确定性生成，请勿手改；
> 判定逻辑改在 `scripts/lib/restoreConvergenceVerifier.js`，再重新生成。

## 这一层在解决什么

还原家族已有四层，本文件是**第五层（收官层）**：

1. 三面镜子 `restore-check` / `verify-install` / `hydration-doctor`（各自诊断，**看**）；
2. `restore-plan`（OPS-MAN-075）把三者合成为有序还原方案（**排序**）；
3. `restore-conflicts`（OPS-MAN-076）检测三镜子是否互相矛盾（**矛盾**）；
4. `restore-resolve`（OPS-MAN-079）把矛盾升级成有序恢复链，标出何处交人（**走出**）；
5. `restore-converge`（本文件）在 agent **执行**每一步、重探到新快照后，判定这一步
   是否真的推进了还原，并产出停止条件（**收手 / 继续 / 升级**）。

前四层全是**开环规划**：它们产出「agent 该做什么」的 move（带 action + verify），
但没有一层**闭合执行反馈环**——agent 跑完一步后，没有东西判定它到底有没有让还原前进。
本层就是那缺失的一环：把开环规划器变成**有原则、安全优先、防死循环的闭环自驱 agent**。

## 为什么开环规划不够（真实的 agent 失败模式）

一个自驱 agent 按 move 执行还原时会踩三个坑，而前四层都没人守：

- **无进展死循环**：反复重探，镜子快照一动不动，agent 无限空转。
  （这正是 khy 自己内存里反复出现的「khy 卡住」「idle-watchdog 被自身心跳续命」的
  同一自驱失败模式——只是**还原层此前没人守**。）
- **倒退未被察觉**：某个 move 反而让状态变差（冒出新 blocker），agent 却继续往下走。
- **已收敛却不收手**：还原其实已完成（三镜子全绿），agent 仍机械地跑剩余 move。

本层取**前后两个镜子快照** + **刚尝试的 move**，判定这一步的性质并给出停止条件。

```bash
node scripts/restore-converge.js --json   # 自驱 agent 的闭环用这个
# 每步：执行前采 before → 执行一步 → 重探采 after →
#       verifyConvergence({before, after, move, stallCount})
```

## 四种单步判定与停止条件

| 判定 | 触发 | 停止条件 | 语义 |
|------|------|----------|------|
| `converged` | after 三镜子全绿且无未决项 | `converged-stop` | 还原完成，停止并声称成功 |
| `regressed` | after 冒出 before 没有的新未决项 | `escalate-human` | 倒退最危险，立即止步交人 |
| `advanced` | 未决项严格减少且无新增 | `continue` | 在推进，继续下一步 |
| `stalled` | 未决项集合无变化 | continue→escalate | 无进展累计；连续达上限即判死循环交人 |

> 防循环阈值 `STALL_LIMIT = 2`：连续 2 次执行无任何进展
> （未决项集合既没减也没加），即判定死循环，强制升级交人——不再给第三次空转的机会。

## 判定优先级（安全优先，宁可早停不可空转）

1. **已完全还原**优先于一切：即便同时有噪声，三镜子全绿就应收手（converged-stop）。
2. **倒退**次之：只要冒出净新增未决项，立即 escalate，绝不在倒退上继续自动执行。
3. **推进**：未决项严格减少 → continue。
4. **无进展**：集合不变 → 累计；未达上限再给一次机会，达上限即 escalate。

## 保证（继承项目章程）

- 纯计算、零 IO、绝不抛：判定过程异常一律安全降级为 `escalate-human`（不确定即交人，
  **绝不假报已收敛**）。
- 只**读快照做判定**，绝不触 IO、绝不执行 move——执行副作用永不进本叶子。
- 任何回传给 agent 的 action 文本先过危险令牌自检；命中 commit/push/rm/curl/publish 即隐去。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

