# [OPS-MAN-108] 还原归档形制可提取性对账

> 本文件由 `scripts/restore-check-archive.js --gen-doc` 确定性生成，请勿手改；
> 判定逻辑改在 `scripts/lib/archiveExtractCompat.js`，再重新生成。

## 这一层闭合什么：plaintextFormat / layout 是死字段

快照构建期 `makeSourceSnapshot.js` 给每个快照头（`snapshot.json`）盖两枚**内层归档**印章：

- `plaintextFormat: "tar.gz"` —— 「密文解密后是一团 tar.gz，请用 gzip+tar 解包」；
- `layout: "git-archive"` —— 「这团 tar 的内部布局是 git archive（尊重 .gitignore、无 .git）」。

这两枚印章描述的是**解密之后**那层归档的形制，随 pip/npm 包漂洋过海到陌生机器。但还原 / 自愈侧的
解包器（`sourceHealService._extractTarGz`、`cli/handlers/publish.js` 的 restore 提取）
**把 `tar -xzf` 写死**，从不读 `plaintextFormat` / `layout`——这两个字段在整个还原代码库里
**零消费者**。后果在离机场景最毒：

- 未来某版 khy 改用 `tar.zst` / `zip` 打包源码（`plaintextFormat` 变），陌生机器上的**旧** khy
  仍盲目 `tar -xzf`：gzip 头对不上 → 抛一句解包天书，或更糟——部分字节被误当 gzip 流吐出半个目录；
- `layout` 若从 `git-archive` 变成含 `.git` 的全量 tar，语义已不同（还原横幅仍印「目录布局原样」骗人），
  却没有任何一层先问「这归档形制我认得吗」。

`plaintextFormat` / `layout` 上游花心思盖章、跨渠道送达、下游能读，却**在解包前无人据此把关**
= 死字段（断桥）。本层就是那个缺失的**解包前**消费者。

## 它和家族其它层的正交关系（别混淆）

| 层 | 管什么 | 一句话 |
|----|--------|--------|
| 105 `snapshotFormatCompat` | 外层快照信封契约（`format`/`formatVersion`） | 「这是不是 khy 快照」 |
| 107 `restoreProvenance` | git 来源（`captureMode`/`includesUncommitted`） | 「这源码等于哪个提交」 |
| 095 `completenessVerifier` | 解包后文件数 | 「落地数量对得上清单吗」 |
| **108 本层 `archiveExtractCompat`** | **解密后、解包前的内层归档形制**（`plaintextFormat`/`layout`） | **「我的 tar -xzf 认不认识这团解密归档」** |

位置恰在「信封看得懂(105)」之后、「解包完整(095)」之前。

```bash
node scripts/restore-check-format.js  ./Khy-OS --json   # ① 信封格式：本机看得懂吗？（105）
node scripts/restore-check-archive.js ./Khy-OS --json   # ② 内层归档：本机解包器解得开吗？（本层 108）
khy restore ./Khy-OS                                    # ③ 两门都过才敢解密解包还原
node scripts/restore-verify-complete.js ./Khy-OS --json # ④ 再对账数量：真完整吗？（095）
```

## 判定档：解包能力门（最保守优先）

| 档 | 条件 | 裁决 | ok |
|----|------|------|----|
| 1 | 头非对象 / 数组 / `plaintextFormat` 非非空串 | `unverifiable`：证据不足，绝不谎报 supported | ✗ |
| 2 | `plaintextFormat` ∉ 支持集 | `unsupported-format`：本机 `tar -xzf` 解不开，**先升级 khy** | ✗ |
| 3 | 格式可解压但 `layout` 存在且 ∉ 支持集 | `unknown-layout`：能解开却不认识内部布局，别当「原样」 | ✗ |
| 4 | `plaintextFormat` ∈ 支持集且（`layout` 缺省 / ∈ 支持集） | `supported`：唯一可安心交给解包器的档 | ✓ |

- 本机解包器真能解开的形制由叶子常量 `SUPPORTED_PLAINTEXT_FORMATS` / `SUPPORTED_LAYOUTS` 定义
  （当前 `["tar.gz"]` / `["git-archive"]`）；解包实现新增支持时按叶子 HOW-TO-EXTEND 同步——
  **只有解包器真支持了才加进支持集**，别为绿灯谎报。
- `--json` 在非 `supported` 时**退出码 2**：陌生机器上的自驱 agent 据此**不敢盲目解包**。

## 恒久红线（继承全家族）

- 形制陌生 / 证据不足一律**拒绝放行**：绝不臆造 `supported`，绝不盲目 `tar -xzf`。
- `ok===true` 仅当 `status === supported`；其余一律 `ok:false`。
- `layout` 缺省是老快照的合法向后兼容情形（格式支持即放行）；但 `layout` 一旦**存在**就必须是认识的形制。
- 叶子纯计算、零 IO、绝不抛；真正读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

