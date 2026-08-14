# [OPS-MAN-095] 还原解包完整性对账

> 本文件由 `scripts/restore-verify-complete.js --gen-doc` 确定性生成，请勿手改；
> 对账逻辑改在 `scripts/lib/restoreCompletenessVerifier.js`，再重新生成。

## 这一层闭合什么：fileCount 是个死字段

快照构建期 `makeSourceSnapshot.js` 用 `git ls-tree -r --name-only` 数出 tar 里应有的文件数，
写进 `snapshot.json` 的 `fileCount`，随 pip/npm 包送到陌生机器。但还原侧 `khy restore`
只在成功横幅里**打印**它（"共 N 个文件"），**从不拿它跟磁盘上真正落地的文件数对账**——
`_extractTarGz` 只看 `tar` 的退出码。tar 退出 0 却少解文件的情况真实存在：
磁盘中途写满、路径过长（Windows MAX_PATH）、不被支持的条目类型、权限/符号链接被跳过……
此时用户看到绿字「源码已完整还原」，磁盘上却缺文件 = **对用户最重要那条路径上的最毒假绿**。
本层就是那个缺失的消费者：把「期望文件数」与「实际落地文件数」对账，给出诚实裁决。

```bash
khy restore ./Khy-OS                          # 解包源码快照
node scripts/restore-verify-complete.js ./Khy-OS --json   # 再对账一次：数量真吻合吗？
```

## 判定档：对账 + 前置门（最保守优先）

| 档 | 条件 | 裁决 | ok |
|----|------|------|----|
| 1 | 期望非正 / 实际缺失或非法 | `unverifiable`：证据不足，绝不默认 complete | ✗ |
| 2 | `sha256Verified===false` 或 `tarExitZero===false` | `corrupt`：前置校验已失败 | ✗ |
| 3 | 实际 **<** 期望 | `incomplete`：**静默少解**（断桥要抓的假绿） | ✗ |
| 4 | 实际 **>** 期望 | `over-extracted`：残留 / 口径漂移，提示人核对 | ✗ |
| 5 | 实际 **===** 期望 且前置通过 | `complete`：唯一可安心说「完整还原」 | ✓ |

- **对账口径**：`expected` 取自快照头 `fileCount`（= `git ls-tree -r` 的 blob 数）；
  `actual` 递归数还原目录里的常规文件（排除 `.git` 与快照 sidecar，不跟随符号链接），
  与 `git archive` 落地口径对齐。
- `--json` 在非 `complete` 时**退出码 2**：陌生机器上的自驱 agent 据此**不把还原当完整**。

## 恒久红线（继承全家族）

- 证据不足绝不谎报 `complete`：任何字段缺失 / 非法 → 保守 `unverifiable`。
- `ok===true` 仅当 `status === complete`；其余一律 `ok:false`。
- 叶子纯计算、零 IO、绝不抛；真正数磁盘、读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

