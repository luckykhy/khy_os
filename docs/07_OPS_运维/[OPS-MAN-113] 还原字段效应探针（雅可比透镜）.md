# [OPS-MAN-113] 还原字段效应探针（雅可比透镜）

> 本文件由 `scripts/restore-effect-probe.js --gen-doc` 确定性生成，请勿手改；
> 判定逻辑改在 `scripts/lib/restoreEffectProbe.js`，再重新生成。

## 这一层闭合什么：把「死字段」的静态狩猎升级成动态守卫

还原家族已逐层给快照头字段接了消费者：信封 `format`/`formatVersion`（105）、来源
`captureMode`/`includesUncommitted`/`dirty`/`gitCommit`（107）、内层归档
`plaintextFormat`/`layout`（108）、解密套件 `crypto.algo`/`crypto.kdf`（110）。

但「某字段是否**真的**驱动某道门」一直靠人肉 `grep` 静态确认——而 `grep` 会被
**「读了但读完即弃」的假消费者**骗过（字段被读、结果被丢，语法上「有消费者」，行为上却是死的）。
本层是那个缺失的**动态回归守卫**：对每个契约字段做**有限差分**——扰动它（删除 / 换成同类型
的异物值）、跑还原门面板、量最终裁决 `(status, ok)` 的改变。字段的「雅可比」≈0
（任何上下文扰动它、任何门都不反应）= **行为上证死**，无论它语法上是否被读。

## 为什么必须「一批上下文」而不是单个真头

思想源自 Anthropic《Verbalizable Representations Form a Global Workspace in Language
Models》的 **Jacobian lens**：用一个中间量对输出的一阶因果效应、**在一大批上下文上求平均**，
才能把「恰好在这条 trace 里被用到」和「随时准备被用到（load-bearing）」区分开。

落到还原家族：来源门 `restoreProvenance` 用的是**冗余 OR** 信号——
`includesUncommitted===true || dirty===true` 判脏，`captureMode==="HEAD" || includesUncommitted===false` 判净。
在真头上两个脏信号同时为真，单独扰动其一、另一仍兜住裁决 → **单上下文会把
`captureMode`/`includesUncommitted`/`dirty` 误报成死字段**。用「隔离语料」后各信号能被单独证明：

| 上下文 | 构造 | 隔离出的字段 |
|--------|------|--------------|
| `real` | 真快照头原样 | format/formatVersion/crypto.*/plaintextFormat/layout/gitCommit |
| `clean-head` | `captureMode=HEAD`、删 includesUncommitted/dirty | `captureMode` |
| `clean-worktree` | `captureMode=working-tree`、`includesUncommitted=false`、删 dirty | `includesUncommitted` |
| `dirty-flag` | `captureMode=working-tree`、删 includesUncommitted、`dirty=true` | `dirty` |

字段在**任一**上下文动了**任一**门 → `load-bearing`；在整个语料上都不动 → `dead`。

## 判定档

| 档 | 条件 | 裁决 | ok |
|----|------|------|----|
| 1 | 未注入门面板 / 上下文语料为空 | `unverifiable`：证据不足，绝不臆断字段有效 | ✗ |
| 2 | 有契约字段在整个语料上不动任何门 | `regression`：死字段（消费者被摘 / 从未接线） | ✗ |
| 3 | 全部契约字段均 load-bearing | `ok`：还原家族字段接线无回归 | ✓ |

- 契约字段（`CONTRACT_FIELDS`）= 各门**被接线去消费**的 header 字段；契约里出现即代表
  「必须有门消费它」，`dead` 就是红灯。新增门后按叶子 HOW-TO-EXTEND 同步契约 + 隔离语料。
- 非契约字段（`archive`/`sha256`/`fileCount`/`version`/`createdAt`/`notes` 等）本面板不消费，
  报为 `unmonitored`（仅供参考）：它们应由**别处**消费（`fileCount` → 095 完整性对账、
  `sha256` → 传输完整性、`version` → 横幅）；若某个 `unmonitored` 字段其实哪儿都没消费，
  那就是一个**新的死字段**，值得顺着查。
- `--json` 在非 `ok` 时**退出码 2**：CI / 自驱 agent 据此发现「还原字段接线出现回归」。

## 恒久红线（继承全家族 + 密钥卫生）

- 证据不足（无门 / 无语料）一律判 `unverifiable`：绝不臆造绿灯。
- **绝不读、绝不打印、绝不扰动任何密钥/口令/明文材料**：契约字段不含 `crypto.salt`/`iv`/`authTag`，
  extras 只扫顶层键、绝不下探 `crypto`；输出只含字段路径、效应标签、上下文名、门名，绝不含快照头取值。
- 扰动全部**确定性**（删除 + 写死的异物值，绝不用随机 / 时间）；叶子纯计算、零 IO、绝不改入参、绝不抛。
- `ok===true` 仅当 `status === ok`（有门、有语料、零 dead）。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

