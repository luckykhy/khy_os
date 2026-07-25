# [OPS-MAN-105] 还原快照格式兼容性对账

> 本文件由 `scripts/restore-check-format.js --gen-doc` 确定性生成，请勿手改；
> 判定逻辑改在 `scripts/lib/snapshotFormatCompat.js`，再重新生成。

## 这一层闭合什么：format / formatVersion 是死字段

快照构建期 `makeSourceSnapshot.js` 给每个快照头（`snapshot.json`）盖两枚契约印章：

- `format: "khy-source-snapshot"` —— 「这确实是 khy 源码快照，不是别的什么 tar」；
- `formatVersion: 1` —— 「快照头 / 密文布局的 schema 版本」。

这两枚印章随 pip/npm 包漂洋过海到陌生机器。但还原 / 自愈侧
（`sourceHealService.decrypt`、`cli/handlers/publish.js` 的 restore 处理器）
**只校验 `crypto.algo === "aes-256-gcm"`，从不校验 `format` / `formatVersion`**——
`grep "khy-source-snapshot"` 在整个还原代码库里 **零消费者**。后果在离机场景最毒：

- 陌生机器上装的是**旧** khy（旧还原代码），却拿到一个**未来** `formatVersion=2` 的快照
  （密文 / 头布局已变但 `crypto.algo` 仍是 aes-256-gcm）→ 旧代码盲目解密：要么抛一句
  密码学天书（`unable to authenticate data`），要么更糟——静默按旧布局误解析新快照；
- 或者 `snapshot.json` 根本不是 khy 快照（复制错目录 / 第三方 tar）→ 没有任何一层
  先问一句「这是我认识的格式吗」，直接进解密。

`format` / `formatVersion` 上游花心思盖章、跨渠道送达、下游能读，却**在还原前无人据此把关**
= 死字段（断桥）。本层就是那个缺失的**前置**消费者：在完整性对账（第十二层 095）之前，
先回答最基础的一问——「这个快照的格式，本机 khy 的还原代码到底看不看得懂？」

```bash
node scripts/restore-check-format.js ./Khy-OS --json    # ① 先判格式：本机看得懂吗？
khy restore ./Khy-OS                                    # ② 格式兼容才敢解密还原
node scripts/restore-verify-complete.js ./Khy-OS --json # ③ 再对账数量：真完整吗？（095）
```

## 判定档：格式契约门（最保守优先）

| 档 | 条件 | 裁决 | ok |
|----|------|------|----|
| 1 | 头非对象 / `format` 非串 / `formatVersion` 非有限数 | `unverifiable`：证据不足，绝不谎报 supported | ✗ |
| 2 | `format !== "khy-source-snapshot"` | `alien`：这不是 khy 源码快照，别信别解密 | ✗ |
| 3 | `formatVersion > MAX` | `too-new`：快照比本机还原代码更新，**先升级 khy** | ✗ |
| 4 | `formatVersion < MIN` | `too-old`：格式过旧，勿用当前解析误读 | ✗ |
| 5 | `MIN ≤ formatVersion ≤ MAX` 且档 2 通过 | `supported`：唯一可安心继续还原的档 | ✓ |

- 本机能理解的区间由叶子常量 `MIN_FORMAT_VERSION` / `MAX_FORMAT_VERSION` 定义
  （当前均为 `1`）；快照布局做不向后兼容变更时按叶子 HOW-TO-EXTEND 递增。
- `--json` 在非 `supported` 时**退出码 2**：陌生机器上的自驱 agent 据此**不敢盲目解密**。

## 恒久红线（继承全家族）

- 证据不足 / 格式陌生 / 版本超纲一律**拒绝放行**：绝不臆造 `supported`。
- `ok===true` 仅当 `status === supported`；其余一律 `ok:false`。
- 这是**前置**门（先于完整性对账 095、授权 088、导航 090）——看不懂格式，后面所有诊断都无意义。
- 叶子纯计算、零 IO、绝不抛；真正读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

