# [OPS-MAN-107] 还原来源可溯性对账

> 本文件由 `scripts/restore-provenance.js --gen-doc` 确定性生成，请勿手改；
> 判定逻辑改在 `scripts/lib/restoreProvenance.js`，再重新生成。

## 这一层闭合什么：captureMode / includesUncommitted 是死字段

快照构建期 `makeSourceSnapshot.js` 忠实记录了这份快照是**怎么捕获**的：

- `captureMode: "working-tree" | "HEAD"` —— 从工作树打包，还是从某个提交 archive；
- `includesUncommitted: true | false` —— 是否含未提交改动（tracked 改动 + untracked）；
- `dirty: true | false` —— 捕获时工作树是否脏；
- `gitCommit: "<sha>"` —— 捕获时 HEAD 所在提交。

这些随 pip/npm 包送到陌生机器。但还原侧 `cli/handlers/publish.js` 的成功横幅
**只打印 `gitCommit`**（`commit 44a491fb · 目录布局原样`），
**从不读 `includesUncommitted` / `captureMode`**——`grep includesUncommitted` 在还原代码里
**零消费者**。后果对维护者最毒：

- 真实 shipped 快照就是**脏捕获**（`captureMode="working-tree"` · `includesUncommitted=true`）——
  还原出来的源码 = 提交 `44a491fb` **加上未提交增量**，**不等于** `44a491fb` 这个干净提交；
- 但维护者在陌生机器上只看到横幅那句「commit 44a491fb · 目录布局原样」→ 合理地误判
  「我还原的就是 44a491fb」→ 拿它去 `git diff 44a491fb` 看到一堆幻影差异、或把它当成
  「发布的那份代码」——全错，因为它比那个提交多了未提交的活儿。

`captureMode` / `includesUncommitted` 上游忠实记录、跨渠道送达、下游能读，却**在还原时
无人据此向维护者澄清来源** = 死字段（断桥）。本层就是那个缺失的消费者：把「这份还原源码
到底等于哪个 git 状态」从一句会误导的「commit X」，变成一次诚实的裁决。

```bash
node scripts/restore-check-format.js ./Khy-OS --json     # ① 格式看得懂吗？（105）
khy restore ./Khy-OS                                     # ② 解密还原
node scripts/restore-verify-complete.js ./Khy-OS --json  # ③ 文件数对得上吗？（095）
node scripts/restore-provenance.js ./Khy-OS --json       # ④ 这源码到底等于哪个 git 状态？（本层）
```

## 判定档：来源诚实门（最保守优先 · 没有正面证据绝不谎称 clean）

| 档 | 条件 | 裁决 | ok |
|----|------|------|----|
| 1 | 头非对象 | `unverifiable`：无从判断来源 | ✗ |
| 2 | 无 `gitCommit` | `no-provenance`：没记录任何提交，无从溯源 | ✗ |
| 3 | `includesUncommitted===true` 或 `dirty===true` | `dirty`：== 提交 X + 未提交增量，**不等于干净提交** | ✗ |
| 4 | HEAD 归档，或 working-tree 且 `includesUncommitted===false` | `clean`：可证 == 提交 X | ✓ |
| 5 | 有提交、非脏，但无正面 clean 证据 | `indeterminate`：保守，不臆断 clean | ✗ |

- `ok===true` **仅当** `status===clean`（还原源码可证等于某个干净提交）——「简单还原」里最强的一档：
  维护者可以放心把它当成「就是那个提交」。
- `--json` 在非 `clean` 时**退出码 2**：陌生机器上的自驱 agent 据此**不把还原源码当作发布快照**。
- **只披露不阻拦**：`dirty` 是**合法且完整**的还原（内容一字不缺），只是不等于干净提交——
  本层把「静默误导」变成「诚实标注」，不改变还原本身的成败。

## 恒久红线（继承全家族）

- 没有正面 clean 证据绝不谎称 `clean`：任何脏 / 不确定 / 缺来源 → `ok:false`，诚实披露。
- `ok===true` 仅当 `status === clean`；其余一律 `ok:false`。
- 叶子纯计算、零 IO、绝不抛；真正读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

