# [OPS-MAN-088] 还原策略台账

> 本文件由 `scripts/restore-ledger.js --gen-doc` 确定性生成，请勿手改；
> 学习判定改在 `scripts/lib/restoreStrategyLedger.js`，再重新生成。

## 这一层补什么缺口：一个从不从自己过去失败中学习的 agent

轨迹日志（OPS-MAN-086）给了**单会话**记忆——一轮自驱里跨进程重建 stallCount、防死循环。
可它是**严格 per-session** 的：每个会话一个 `<session>.jsonl`，彼此不读。后果——

- 会话 A 已用 5 步证明某策略对这台机器的某类卡点是死胡同（次次 stalled → escalate）；
- 会话 B 起来，对同一类卡点**从零把同一死胡同重走一遍**。

人类维护者修一台反复出问题的机器，第二次绝不会再试第一次证明无效的手段；agent 却会。
本层让 agent 拥有同样的常识：跨这台机器**所有会话**回放策略的终局分布，学出哪些已被
反复证明无用，下次直接跳过。

```bash
node scripts/restore-ledger.js --json    # 下次自驱前读它决定跳过哪些策略
node scripts/restore-ledger.js --skips    # 只吐建议跳过的策略（逗号分隔）
```

## 分类（保守，安全优先）

| 分类 | 判据 | 建议 |
|------|------|------|
| `productive` | 该策略在这台机器上**至少一次**真推进（advanced / converged） | 值得再试 |
| `dead` | 跨 **≥ 2 个独立会话**次次卡住、**从未一次**推进 | 建议跳过 |
| `unproven` | 样本不足或信号不清 | 保守：不建议跳过 |

## 安全优先的核心不变量（绝不误伤）

- 只要某策略**哪怕一次**推进，就永远不判 dead——一次成功洗清所有失败。
- dead 门槛是「跨 ≥ 2 个**独立会话**反复失败」，不是「某一会话里连着失败」——
  防止一次运气差就把本可用的策略永久拉黑。
- 台账只产 `recommendedSkips`（建议跳过的死策略），**绝不重排 resolver 的安全恢复链顺序**：
  排序由风险决定（reprobe→reconcile→trust-pessimistic→escalate），学习只做减法、不做重排。
  这是诚实边界——优化「别再试已证死的」，不颠覆安全序。

## 纯度与落盘边界（继承项目章程）

- 叶子是纯 reducer：`deriveStrategyLedger(sessionStreams)` 零 IO、绝不抛；空 / 畸形 →
  空台账，**绝不凭空拉黑任何策略**。
- 读盘在 CLI：遍历 `~/.khy/.restore-trace/*.jsonl` 全会话（dot 前缀目录，授权门 084 已排除）。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

