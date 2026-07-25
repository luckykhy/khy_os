# [OPS-MAN-110] 还原解密套件可执行性对账

> 本文件由 `scripts/restore-check-crypto.js --gen-doc` 确定性生成，请勿手改；
> 判定逻辑改在 `scripts/lib/cryptoSuiteCompat.js`，再重新生成。

## 这一层闭合什么：crypto.kdf 是死字段，且失败信息会骗人

快照构建期 `sourceSnapshotCrypto.encrypt` 给每个快照头盖全套加密契约：

- `crypto.algo: "aes-256-gcm"` —— 对称加密算法；
- `crypto.kdf: "scrypt"` —— 密钥派生函数（口令 → 密钥的算法）；
- `crypto.scrypt: { N, r, p, keylen }` —— scrypt 代价参数；
- `crypto.salt / iv / authTag` —— 派生盐 / 初始向量 / GCM 认证标签（解密必需）。

但解密侧 `sourceSnapshotCrypto.decrypt` **只校验 `crypto.algo`，从不校验 `crypto.kdf`**——
`grep kdf` 在整个代码库里只有一处：`encrypt` 的盖章（第 81 行），**零消费者**。更毒的是：

- `decrypt` 读 scrypt 参数时是 `(c.scrypt && c.scrypt.N) || SCRYPT.N`——**盲目回退到写死的 scrypt 默认值**；
- 一个未来 `kdf:"argon2"`（无 `c.scrypt` 块）的快照到了**旧** khy：`decrypt` 不看 kdf、照用 scrypt 派生，
  派生出**错误的密钥**，`decipher.final()` 抛 `unable to authenticate data`，而调用方把这句
  **映射成「口令错误 / wrong secret」**。

→ 陌生机器上的用户被告知「密码不对」，真相却是「这台 khy 根本不会 argon2 这个 KDF」。
这是离机还原里**最会误导人的假失败**。`crypto.kdf` 上游花心思盖章、跨渠道送达、下游能读，却
**在解密前无人据此把关** = 死字段（断桥）。本层就是那个缺失的**解密前**消费者：把假的
「口令错误」换成诚实的「本机做不了这个加密套件 / 快照材料残缺」。

## 它和家族其它层的正交关系（别混淆）

| 层 | 管什么 | 一句话 |
|----|--------|--------|
| 105 `snapshotFormatCompat` | 外层快照信封（`format`/`formatVersion`） | 「这是不是 khy 快照」 |
| **110 本层 `cryptoSuiteCompat`** | **解密套件可执行性**（`algo`/`kdf` + 必需材料） | **「我做不做得了这个解密」** |
| 108 `archiveExtractCompat` | 解密后内层归档形制（`plaintextFormat`/`layout`） | 「解开后我解不解得包」 |
| 095 `completenessVerifier` | 解包后文件数 | 「落地数量对得上吗」 |

顺序恰是还原流水线：信封(105) → **解密套件(本层 110)** → 真解密 → 内层归档(108) → 解包 → 完整性(095)。

```bash
node scripts/restore-check-format.js  ./Khy-OS --json   # ① 信封格式：本机看得懂吗？（105）
node scripts/restore-check-crypto.js  ./Khy-OS --json   # ② 解密套件：本机解得了吗？（本层 110）
node scripts/restore-check-archive.js ./Khy-OS --json   # ③ 内层归档：本机解包器解得开吗？（108）
khy restore ./Khy-OS                                    # ④ 三门都过才敢真解密解包还原
node scripts/restore-verify-complete.js ./Khy-OS --json # ⑤ 再对账数量：真完整吗？（095）
```

## 判定档：解密套件门（最保守优先）

| 档 | 条件 | 裁决 | ok |
|----|------|------|----|
| 1 | 头非对象 / 数组 / 无 `crypto` 块 / `algo` 非非空串 | `unverifiable`：证据不足，绝不谎报 | ✗ |
| 2 | `crypto.algo` ∉ 支持集 | `unsupported-algo`：本机执行不了这个算法，**先升级 khy** | ✗ |
| 3 | `crypto.kdf` 存在且 ∉ 支持集 | `unsupported-kdf`：会误派生 → 假「口令错误」，**先升级 khy** | ✗ |
| 4 | 缺 `salt`/`iv`/`authTag` 任一 | `incomplete-material`：快照残缺，**不是口令错误** | ✗ |
| 5 | `algo` ∈ 支持集且（`kdf` 缺省 / ∈ 支持集）且材料齐全 | `supported`：唯一可安心进解密的档 | ✓ |

- 本机解密真能执行的套件由叶子常量 `SUPPORTED_ALGOS` / `SUPPORTED_KDFS` 定义
  （当前 `["aes-256-gcm"]` / `["scrypt"]`）；解密实现新增支持时按叶子 HOW-TO-EXTEND 同步——
  **只有 decrypt 真能执行了才加进支持集**，别为绿灯谎报。
- `--json` 在非 `supported` 时**退出码 2**：陌生机器上的自驱 agent 据此**不敢盲目解密**、
  也**不把失败当口令错**。

## 恒久红线（继承全家族 + 密钥卫生）

- 套件陌生 / 材料残缺一律**拒绝放行**：绝不臆造 `supported`，绝不让残缺快照走到解密换来假「口令错误」。
- **绝不读、绝不打印任何密钥/口令/明文材料**：只看 `algo`/`kdf` 字符串与 `salt`/`iv`/`authTag` 的**存在性**，
  其值绝不离开判定、绝不落盘、绝不进输出。
- `kdf` 缺省是老快照的合法向后兼容情形（decrypt 回退 scrypt）；但 `kdf` 一旦**存在**必须是认识的 KDF。
- `ok===true` 仅当 `status === supported`；叶子纯计算、零 IO、零加密调用、绝不抛。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

