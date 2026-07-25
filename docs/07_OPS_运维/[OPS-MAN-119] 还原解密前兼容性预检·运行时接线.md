# [OPS-MAN-119] 还原「解密前」兼容性预检 · 运行时接线（让套件不兼容不再谎报口令错）

> 本文件为手写维护文档（此层是 bundled 运行时接线，无 `--gen-doc` 生成器）。
> 裁决逻辑改在 `services/backend/src/services/restorePreflightCheck.js`，
> 接线改在 `services/backend/src/cli/handlers/publish.js` 的 `_restoreFromSnapshot`。

## 这一层闭合什么：把 OPS-105 / OPS-110 的能力真正接进运行时 restore

OPS-MAN-105（快照格式兼容）与 OPS-MAN-110（加密套件可解密性）早已写好两个 dev 纯叶
（`scripts/lib/snapshotFormatCompat.js` / `scripts/lib/cryptoSuiteCompat.js`），能据快照头
判断「本机 khy 到底解不解得开这个快照」——**但它们只被 dev CLI 消费，从未接进真正的
运行时还原命令 `khy restore`**。运行时 `_restoreFromSnapshot` 在解密前唯一的守卫只是
`header.crypto` 是否存在，然后直接 `decrypt()`。而 `decrypt()`：

- 只认 `algo === 'aes-256-gcm'`（其它抛 `unsupported or missing snapshot crypto header`）；
- **总是跑 `scryptSync`，从不读 `crypto.kdf`**。

于是未来一个 `kdf:'argon2'` 或未知 `algo` 的快照送到旧机器：运行时要么抛底层天书，
要么盲跑 scrypt 派生出**错误密钥** → GCM 认证失败。而这两种失败在 `publish.js` 的
`catch` 里被**一律**改写成误导性的
「该快照由自定义密钥加密，请用 `--secret <密钥>` 指定」——
把「本机能力缺失、请升级 khy」**谎报成「你密钥/口令错了」**。陌生机器上的用户于是
一直找错方向。= **能力存在、没接线的代码**。

本层就是那条缺失的接线：在 bundled 运行时里，**解密之前**给已解析的快照头跑一遍
兼容性预检，把「真因」明确出来，取代那条误导消息。

```bash
khy restore ./Khy-OS   # 解密前先判本机能否解开：套件不兼容 → 提前拦下并说清「请升级 khy」
```

## 二级严重度：只在「证明性不可解」时硬拦，绝不误伤（zero false-block）

| 层 | 判据 | severity | 运行时动作 |
|----|------|----------|-----------|
| 加密套件 | `algo` 缺失/不受支持、`kdf` 存在且不受支持、salt/iv/authTag 残缺 | **block** | 解密前 `throw pf.message`（精确成因） |
| 格式 | `format` 陌生、`formatVersion` 过新/过旧 | **warn** | `printWarn(pf.message)` 后**仍继续**尝试解密 |
| 受支持 / 证据不足 | supported / unverifiable | none | 静默继续，权威留给 `decrypt` 本身 |

- **block = 证明性不可解**：这些条件**必然**让运行时 `decrypt()` 失败（今天只给误导
  消息），故提前拦下并说清「请先升级 khy 再还原，这不是密钥/口令问题」= 严格改善、
  **零误伤**（一个本来能解的快照不会被 block）。
- **warn = 未必阻止解密**：v2 若只改了 tar 内布局、仍用同套件，v1 khy 也能解出字节，
  故只提示、仍尝试，绝不 false-block 一个其实能还原的快照。

## 判定档（最保守优先 · 纯叶 `assessRestorePreflight`）

| status | 条件 | severity | ok |
|--------|------|----------|----|
| `unverifiable` | 缺头 / 数组头 / crypto 非对象 / 预检异常 | none（保守放行） | ✗ |
| `incomplete-material` | 缺 `algo` 或缺 salt/iv/authTag | block | ✗ |
| `unsupported-algo` | `algo` 不在本机支持集 | block | ✗ |
| `unsupported-kdf` | `kdf` 存在且不在本机支持集 | block | ✗ |
| `alien-format` | `format` 存在且非 `khy-source-snapshot` | warn | ✗ |
| `too-new-format` / `too-old-format` | `formatVersion` 越出理解区间 | warn | ✗ |
| `supported` | 套件齐全受支持、格式在理解区间 | none | ✓ |

- **顺序**：加密套件（block）优先于格式（warn）——「证明性不可解」比「格式偏差」更该
  先说清，且能解开与否由套件决定。
- **本机支持集对齐运行时真身**：默认 `supportedAlgos:['aes-256-gcm']`、
  `supportedKdfs:['scrypt']`，与 `sourceSnapshotCrypto.js` 的 `decrypt` 实际能执行集合同步。
  接线处显式传入运行时的 `ALGO` 常量（`sourceSnapshotCrypto.ALGO`）保持 DRY，未来改算法
  单点同步。

## 恒久红线

- **纯诊断/保护叠加层**：block 只把「今天会失败并误报」的解密**提前**拦成清晰错误，
  绝不 block 一个本能成功的还原；warn 从不阻断。门关或异常 → 退化为旧行为（字节等价
  直入 `decrypt`）。
- 门控 `KHY_RESTORE_PREFLIGHT`（default-on；仅 env ∈ {0,false,off,no} 归一后关闭）。
- **红线密钥卫生**：预检只读 `algo`/`kdf`/`format` 字符串、`formatVersion` 数字、以及
  salt/iv/authTag 的**存在性布尔**；**绝不**把 salt/iv/authTag 的**值**读进变量或裁决
  输出（单测断言裁决 JSON 序列化不含密钥值）。
- 叶子纯计算、零 IO、绝不抛；`ok===true` 仅当 `status === supported`。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

## 验证

```bash
npm run test:restore-preflight     # 纯叶单测（15 用例）
# LIVE：合成 kdf:'argon2' 头 → block（解密前抛「请升级 khy」）；
#       合成 format:'v2' 头 → warn（提示后仍尝试）；真快照头 → supported（安心还原）；
#       KHY_RESTORE_PREFLIGHT=0 → 字节等价旧行为，直入 decrypt。
```
