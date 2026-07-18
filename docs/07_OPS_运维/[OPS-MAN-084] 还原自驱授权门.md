# [OPS-MAN-084] 还原自驱授权门

> 本文件由 `scripts/restore-authorize.js --gen-doc` 确定性生成，请勿手改；
> 授权逻辑改在 `scripts/lib/restoreAutonomyGate.js`，再重新生成。

## 这一层在解决什么

还原家族已有五层，本文件是**第六层，也是它的头**：

1. 三面镜子 `restore-check` / `verify-install` / `hydration-doctor`（**看**）；
2. `restore-plan`（OPS-MAN-075）把三者合成为有序还原方案（**排序**）；
3. `restore-conflicts`（OPS-MAN-076）检测三镜子是否互相矛盾（**矛盾**）；
4. `restore-resolve`（OPS-MAN-079）把矛盾升级成有序恢复链，标出何处交人（**走出**）；
5. `restore-converge`（OPS-MAN-082）agent 跑完一步后判进展、防死循环（**收敛**）；
6. `restore-authorize`（本文件）在**开跑任何 move 之前**判定「该不该在这台机器上
   自动动手」（**授权**）。

前五层回答的是执行**过程**的问题（怎么做、做完了没）。`converge` 关的是循环的**尾**；
本层关的是循环的**头**——**「我到底该不该自动开跑？」** 这是安全 agent 的「should I?」
先于「how」：动手之前，先确认这一步不会擅自覆盖用户既有可用数据、链里没藏危险动作、
该交人时能交到人。

```bash
node scripts/restore-authorize.js --json   # 自驱 agent 动手前先读这个
# authorized → 自驱整条链；ask-first → 每步问人；forbidden → 整条交人
```

## 三档授权与降级逻辑

| 授权 | 触发 | 含义 |
|------|------|------|
| `authorized` | 链干净·无覆盖风险·无危险动作 | agent 可自驱整条还原链 |
| `ask-first` | 有覆盖风险 / 链要交人，**且有人在场** | 每步前向人确认，不得静默自驱 |
| `forbidden` | 含危险动作；或有覆盖风险却**问不到人** | 不得自驱，整条交人 |

## 判定优先级（安全优先，宁可不动不可擅动）

1. **危险动作最高优先**：恢复链任一 move 命中破坏性 shell（rm/push/publish）→
   直接 `forbidden`，即便有人在场也绝不让 agent 自驱危险动作（恒久红线）。
2. **链要交人 / 有覆盖风险**：有人在场 → `ask-first`；问不到人 → `forbidden`
   （既有风险又无人确认，安全默认就是不动这台机器）。
3. **干净环境** → `authorized`。
4. **facts 畸形 / 判定异常** → `ask-first`（不确定绝不 `authorized`，但也不硬堵，交人看一眼）。

## 覆盖风险怎么判

CLI 探测 `~/.khy` 下是否已有用户数据（配置 / 代理节点 / 任务）。有 = 这台机器上已经
有人在用 khy，无人值守地「还原」可能把它们盖掉——用户从没同意过。探测失败一律保守
当「有风险」（宁可 `ask-first` 也不擅自覆盖）。是否有人在场由 stdin 是否 TTY 判定。

## 保证（继承项目章程）

- 纯计算、零 IO、绝不抛：判定过程异常一律安全降级 `ask-first`（不确定**绝不** `authorized`）。
- 只**读事实做判定**，绝不触 IO、绝不执行 move——动手是 agent 的事，授权是本门的事。
- 危险 action 原文经隐去后才回传；授权门自身绝不复述 rm/push/publish。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

