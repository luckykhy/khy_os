# [OPS-MAN-128] restore 解密后内层归档形制解包前把关 · 接线（让陌生机器上盲目 `tar -xzf` 变成「请升级 khy」精确成因）

> 本文件为手写维护文档（此层是死能力接线，无 `--gen-doc` 生成器）。承接 OPS-MAN-119（解密前预检接线）/ OPS-MAN-117（还原完整性对账接线）——同属「dev 侧已建好裁决逻辑 + 验证过、却只被 dev CLI 消费、从未接进运行时命令」的死能力接线家族。
> 判定逻辑在 bundled 运行时纯叶 `services/backend/src/services/restoreArchiveExtractCheck.js`（零 IO · 绝不抛）；
> 接线改在 `services/backend/src/cli/handlers/publish.js` 的 `_restoreFromSnapshot`。

## 这一层闭合什么：plaintextFormat / layout 是运行时死字段

快照构建期 `services/backend/scripts/makeSourceSnapshot.js` 给每个快照头（`snapshot.json`）盖两枚
**内层归档**印章：

- `plaintextFormat: 'tar.gz'`（第 244 行）——「密文解密后是一团 tar.gz，请用 gzip+tar 解包」；
- `layout: 'git-archive'`（第 239 行）——「这团 tar 的内部布局是 git archive（尊重 .gitignore、无 .git）」。

这两枚印章描述的是**解密之后**那层归档的形制。dev 侧早已写好纯叶
`scripts/lib/archiveExtractCompat.js`（含契约测试 `scripts/tests/archiveExtractCompat.test.js`）
能据此判断「本机 `tar -xzf` 认不认识这团解密归档」——**但它只被 dev CLI 消费**
（`scripts/restore-check-archive.js` / `scripts/restore-effect-probe.js`），
**从未接进运行时还原路径**。运行时 `_restoreFromSnapshot`（`publish.js:748`）解密 + sha256 校验后，
把 `tar -xzf` 写死（`_extractTarGz`，`publish.js:715`），**从不读 `plaintextFormat` / `layout`**——
grep 这两个字段在整个运行时还原代码里零消费者 = 死字段（断桥）。

后果在离机场景最毒：

- 未来某版 khy 改用 `tar.zst` / `zip` 打包源码（`plaintextFormat` 变），陌生机器上的**旧** khy 仍
  盲目 `tar -xzf`：gzip 魔数对不上 → 抛一句解包天书，或更糟——半个目录被误当 gzip 流吐出。
- `layout` 若从 `git-archive` 变成含 .git 的全量 tar，语义已不同（还原横幅仍印「目录布局原样」骗人），
  却没有任何一层先问「这归档形制我认得吗」。

`plaintextFormat` / `layout` 上游花心思盖章、跨渠道送达、下游能读，却**在解包前无人据此把关** =
死字段。本层就是那个缺失的**解包前**消费者。

## 和已接线的 restorePreflightCheck（OPS-MAN-119）正交，别混淆

| 层 | 时机 | 读的字段 | 问的问题 |
|---|---|---|---|
| `restorePreflightCheck`（OPS-119） | 解密**前** | 外层信封 `format`/`formatVersion` + 加密套件 `crypto.algo`/`kdf`/salt·iv·authTag | 「这是不是 khy 快照 / 本机解不解得开密文」 |
| **本层 `restoreArchiveExtractCheck`（OPS-128）** | 解密**后**、解包**前** | 内层归档 `plaintextFormat`/`layout` | 「密文解开成一团归档后，本机 `tar -xzf` 认不认识、解不解得包」 |

两者读的字段完全不重叠——预检管密文，本层管解密后的归档形制。

## 修法：sha256 校验之后、创建目标目录之前插入把关

`_restoreFromSnapshot` 在 `header.sha256` 校验之后、`dest` 解析/`mkdir`/`_extractTarGz` **之前**：

```js
if (_restoreArchiveCheckEnabled()) {
  const ac = assessArchiveExtractCompat(header);
  if (ac.block) throw new Error(ac.message);   // 格式不支持 → 抛精确成因，在任何文件系统改动前拦下
  if (ac.warn) printWarn(ac.message);          // layout 陌生 → 只提示、仍解包
}
```

放在这里而非解包点右侧，是为了**在创建目标目录 / 盲目解包之前**就 block——不给磁盘留下空目录、
不解出半个损坏目录。

`assessArchiveExtractCompat(header)` 纯函数、绝不抛，返回二级严重度裁决：

- **block（硬拦）**：`plaintextFormat` 不在本机 `tar -xzf` 支持集（`SUPPORTED_PLAINTEXT_FORMATS=['tar.gz']`）
  → `unsupported-format`。这**证明性地**会让盲目 `tar -xzf` 解出天书，故抛精确「请升级 khy」成因，
  取代下方误导性的解包失败 = 严格改善、零误伤。
- **warn（告警仍解包）**：格式受支持但 `layout` **存在且**不在 `SUPPORTED_LAYOUTS=['git-archive']`
  → `unknown-layout`。`tar -xzf` 仍能解出字节，只是别信「目录布局原样」，故只提示、仍解包，绝不 false-block。
- **none（静默继续）**：`supported`（形制认识）/ `unverifiable`（证据不足 / `layout` 缺省的老快照向后兼容）
  → 权威留给 `tar` 本身。`layout` 缺省是老快照合法情形，格式支持即放行，不因缺 `layout` 卡死。

## 门控 / fail-soft

- 门 `KHY_RESTORE_ARCHIVE_CHECK`（默认开；env ∈ {0,false,off,no} 归一后关）。关 → 跳过把关、直入
  `tar -xzf`（字节等价旧行为：盲目解包）。
- 纯叶 `assessArchiveExtractCompat` 零 IO、内部 try/catch、绝不抛：任何字段缺失/非法 → 保守
  `unverifiable`（放行由 tar 裁决），绝不 false-block 一个其实能还原的快照。

## 恒久红线

- 只读归档形制串（`plaintextFormat` / `layout`），**绝不碰任何密钥**（专测断言裁决 JSON 不含密钥值）。
- 形制陌生 / 证据不足 → 绝不谎报 supported。`ok===true` 仅当 `status==='supported'`。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

## HOW-TO-EXTEND

当源码打包的内层归档形制变更时：① 在 `makeSourceSnapshot.js` 改 `plaintextFormat`/`layout` 盖章值；
② **只有当** `_extractTarGz` 解包器真支持了该形制，才把对应值加进 `SUPPORTED_PLAINTEXT_FORMATS` /
`SUPPORTED_LAYOUTS`——别为了绿灯谎报；③ 新增判定档按**保守优先**插进判定链正确位置，并在
`_SEVERITY_BY_STATUS` 表登记严重度。

## 验证

```bash
npm run test:restore-archive-check      # 本层 bundled 纯叶单测（15 用例）
npm run test:restore-preflight          # OPS-119 无回归
node --test scripts/tests/archiveExtractCompat.test.js   # dev 侧原叶无回归
# LIVE（真 crypto 构造 tar.gz 快照，驱动真实 _restoreFromSnapshot via options.from）:
#   header.plaintextFormat='zip'（篡改）→ block：抛「请升级 khy」精确成因，目标目录未创建、无半个目录;
#   KHY_RESTORE_ARCHIVE_CHECK=0 + 同快照 → 盲目 tar -xzf 成功解包（字节等价旧行为）;
#   plaintextFormat='tar.gz'/layout='git-archive' → 正常还原，无回归;
#   layout='full-fs-with-git'（陌生）→ warn + 仍解包。
```
