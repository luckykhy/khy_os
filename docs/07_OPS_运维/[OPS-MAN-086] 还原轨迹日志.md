# [OPS-MAN-086] 还原轨迹日志

> 本文件由 `scripts/restore-trace.js --gen-doc` 确定性生成，请勿手改；
> 判定 / 回放逻辑改在 `scripts/lib/restoreTraceJournal.js`，再重新生成。

## 这一层在补什么缝（一个可复现的真实缺陷）

`restore-converge`（OPS-MAN-082）的防死循环签名是

```
verifyConvergence({ before, after, move, stallCount })
```

其中 `stallCount`（连续无进展次数）**必须由调用方自己维护**。可 restore 的真实场景
是陌生机器上**一次次独立的 CLI 调用**——每次进程「起 → 判 → 退」。跨进程 `stallCount`
每回都从 0 起，于是 agent 在同一卡点空转 100 次、每次都被判「第 1/2 次 stall」，
**防死循环在进程边界上根本不生效**：永远升不了级、交不了人。这正是 khy 自己反复修的
「卡住 / idle-watchdog 自续命」同一类自驱失败，只是搬到了还原层、此前无人守。

本层用一条**追加式、可推导**的事件流消灭这道缝：每尝试一步就 append 一个事件；下次
进程起来先回放整条轨迹 `deriveJournalState`，派生出**真实的跨进程 stallCount**，再喂回
`verifyConvergence({ stallCount })`——循环计数终于跨进程连上了。

```bash
node scripts/restore-trace.js record        # 跑一次判定并落轨迹
node scripts/restore-trace.js --stall-count  # 下次 converge 该带的 stallCount
node scripts/restore-trace.js --json         # 恢复中的 agent 读它接着干
```

## stallCount 回放规则（与 restore-converge 逐字对齐）

| verdict | 对 stallCount 的贡献 |
|---------|----------------------|
| `advanced` | 清零（0） |
| `converged` | 清零（0） |
| `regressed` | 保持不变 |
| `stalled` | 累加（+1） |

> 终结（terminal）= 见到 `converged`，或任一 `escalate-human`（regressed / stalled 达阈值）。
> 未知 verdict 保守保持 stallCount 不变——**绝不虚增、亦不假报收敛**。

## 纯度与安全边界（继承项目章程）

- 叶子是 **reducer + 事件构造器**，零 IO、绝不抛：空 / 畸形事件流 → 干净初始态
  （attempts:0, stallCount:0, 非终结）；异常绝不假报终结。
- 落盘 / 读盘在 CLI：append 到 `~/.khy/.restore-trace/<session>.jsonl`，**dot 前缀目录**
  正好被授权门（OPS-MAN-084）的用户数据探测（过滤 `!startsWith('.')`）排除——
  **操作轨迹不是用户数据**，不会误触 overwrite-risk，家族语义自洽。
- 任何回传文本（move.action）先过 `_DANGER_TOKENS` 自检，命中即隐去——危险 shell 绝不
  原样写进可读轨迹。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

