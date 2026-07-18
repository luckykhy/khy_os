# [OPS-MAN-085] 还原补救追索

> 本文件由 `scripts/restore-recourse.js --gen-doc` 确定性生成，请勿手改；
> 补救逻辑改在 `scripts/lib/restoreRecoursePlan.js`，再重新生成。

## 这一层在解决什么

还原家族已闭合成环，本文件是**第七层，是授权门的逆运算**：

- `restore-authorize`（OPS-MAN-084）答 **should I?**（该不该自动开跑：是 / 否 / 问）；
- `restore-converge`（OPS-MAN-082）答 **did it work?**（跑完一步进展如何）；
- `restore-recourse`（本文件）答 **if no, what is the minimal path to yes?**
  （被挡了，把世界改成什么样这个判定就会翻绿）。

整条链此前有个刺眼缺口：**它只会说「不」，从不说「怎么才能变成是」。** 当授权门判
`forbidden`、或 converge 判 `escalate-human`，落在陌生机器上的开发者 / 使用者 / 维护者
只得到一个**死胡同拒绝**。安全 agent 系统里，一个不可操作的拒绝等于把用户推下悬崖——
他知道被挡了，却不知道下一步。本层取一个非授权判定，按它的**每个 blocker** 反查
**最小、有序、安全**的解锁选项，每条标明「谁来做、成本多少、翻到哪一档」。

```bash
node scripts/restore-recourse.js --json   # 撞到拒绝的 agent 读这个找出路
# needed=false → 已授权，无需补救
# needed=true  → options 按成本升序，最短解锁路线在最前
```

## 解锁词表（与授权门 blockers 一一对齐）

| blocker | 补救（可析取多解） | agent 能否自愈 |
|---------|---------------------|----------------|
| `overwrite-risk` | →ask-first；→authorized | 否 |
| `chain-requires-human` | →ask-first；→authorized | 否 |
| `dangerous-move` | （无解锁保证） | 否 |
| `facts-missing` | （无解锁保证） | 是 |
| `assessment-error` | （无解锁保证） | 是 |

> `dangerous-move` 是恒久红线：**无自动解**，只能人工审阅整条链、剔除或确认危险步。
> 拒绝可操作 ≠ 拒绝可被绕过——本层绝不承诺「危险动作可自动解锁」。

## 聚合口径

- `cheapest`：所有补救里成本最低的一条（最省力的第一步）。
- `fullyAgentUnblockable`：**每个** blocker 都能靠 agent 自愈（无需人）才为真。
- `bestReachable`：走完所有补救最好能翻到的授权档，取各 blocker 的**木桶短板**——
  任一 blocker 最好只能到 `ask-first`，则整体上限就是 `ask-first`。

## 保证（继承项目章程）

- 纯计算、零 IO、绝不抛：畸形判定 / 未知 blocker → 产**空补救**并如实标 unresolved，
  **绝不虚构解**（不确定不给假路线，安全优先）。
- 只**读判定出路线**，绝不触 IO、绝不执行补救——动手是人 / agent 的事。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

