'use strict';

/**
 * cryptoSuiteCompat.js — 还原「解密套件可执行性 / crypto-suite performability」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第十六层，闭合一条**解密套件断桥（unchecked-KDF misleading-error）**，
 * 直击用户最在意的「完整的**简单**的还原」——解密之前，还原代码从没诚实确认过
 * 「这个快照声明的加密套件（algo + kdf），我这台 khy 到底做不做得了」。
 *
 * ── 它补的缺口：快照头里的 crypto.kdf 是死字段，且失败信息会骗人 ────────────────────
 * 快照构建期 sourceSnapshotCrypto.encrypt 给每个快照头盖全套加密契约：
 *   crypto.algo:   'aes-256-gcm'            ← 对称加密算法
 *   crypto.kdf:    'scrypt'                 ← 密钥派生函数（口令 → 密钥的算法）
 *   crypto.scrypt: { N, r, p, keylen }      ← scrypt 的代价参数
 *   crypto.salt / iv / authTag              ← 派生盐 / 初始向量 / GCM 认证标签（解密必需）
 * 但解密侧 sourceSnapshotCrypto.decrypt **只校验 `crypto.algo`，从不校验 `crypto.kdf`**——
 * grep `kdf` 在整个代码库里只有一处：encrypt 的盖章（第 81 行），**零消费者**。更毒的是：
 *   · decrypt 读 scrypt 参数时是 `(c.scrypt && c.scrypt.N) || SCRYPT.N`——**盲目回退到写死的 scrypt 默认值**；
 *   · 一个未来 `kdf:'argon2'`（无 `c.scrypt` 块）的快照到了旧 khy：decrypt 不看 kdf、照用 scrypt 派生，
 *     派生出**错误的密钥**，`decipher.final()` 抛 "unable to authenticate data"，而调用方把这句
 *     **映射成「口令错误 / wrong secret」**。→ 陌生机器上的用户被告知「密码不对」，真相却是
 *     「这台 khy 根本不会 argon2 这个 KDF」。这是离机还原里最会误导人的假失败。
 * crypto.kdf 上游花心思盖章、跨渠道送达、下游能读，却**在解密前无人据此把关** = 死字段（断桥）。
 * 本层就是那个缺失的**解密前**消费者：把「口令错误」的假象换成诚实的「本机做不了这个加密套件」。
 *
 * ── 它和家族其它层的正交关系（别混淆）──────────────────────────────────────────────
 *   · 105 snapshotFormatCompat：外层快照**信封**契约（format/formatVersion）——「这是不是 khy 快照」。
 *   · 本层 cryptoSuiteCompat：解密**套件**可执行性（algo/kdf + 必需材料）——「我做不做得了这个解密」。
 *   · 108 archiveExtractCompat：解密后**内层归档**形制（plaintextFormat/layout）——「解开后我解不解得包」。
 *   · 095 completenessVerifier：解包后**文件数**——「落地数量对得上吗」。
 *   顺序恰是还原流水线：信封(105) → 解密套件(本层 110) → 真解密 → 内层归档(108) → 解包 → 完整性(095)。
 *
 * ── 怎么判：解密套件门（最保守优先）────────────────────────────────────────────────
 * checkCryptoSuiteCompat(header) 纯函数，绝不抛。header = 解析好的 snapshot.json 对象。
 *   1) header 非对象/数组 / 无 crypto 对象 / crypto.algo 非非空串 → unverifiable（证据不足，绝不谎报）。
 *   2) crypto.algo ∉ SUPPORTED_ALGOS                            → unsupported-algo（本机只做 aes-256-gcm，先升级 khy）。
 *   3) crypto.kdf 存在且 ∉ SUPPORTED_KDFS                       → unsupported-kdf（核心死字段：decrypt 会盲用 scrypt 误派生 → 假「口令错误」）。
 *   4) algo/kdf 都 OK 但 salt/iv/authTag 任一缺失               → incomplete-material（解密材料不全，不是口令错、是快照残缺）。
 *   5) algo ∈ 支持集 且（kdf 缺省 / ∈ 支持集）且材料齐全        → supported（唯一可安心进解密的档）。
 * 裁决 = { status, ok, algo, kdf, supportedAlgos, supportedKdfs, missingMaterial, reason }。
 *
 * ── 恒久红线（继承全家族 + 密钥卫生）──────────────────────────────────────────────
 * · 只读既有事实，绝不臆造 supported：套件陌生 / 材料不全 → 拒绝放行，别喂给 decrypt 换来假「口令错误」。
 * · **绝不读、绝不返回任何密钥/口令/明文材料**：本层只看 algo/kdf 字符串、salt/iv/authTag 的**存在性**，
 *   从不解码它们的字节、从不碰 secret。salt/iv/authTag 只判「是不是非空串」，其值绝不离开本函数。
 * · ok===true 仅当 status==='supported'；其余一律 ok:false。
 * · kdf 缺省是向后兼容的合法情形（老快照 decrypt 回退 scrypt）：不因缺 kdf 卡死；但 kdf 一旦**存在**必须认识。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────────
 * 纯计算、零 IO、无时钟、无随机、无加密调用、绝不抛：任何字段缺失 / 非法 → 保守。
 * 真正读 snapshot.json 的 IO 在 CLI scripts/restore-check-crypto.js 里、fail-soft；本文件只做纯判断。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────────
 * 当解密实现（sourceSnapshotCrypto.decrypt）新增支持的算法 / KDF 时：
 *   ① 把新值加进 SUPPORTED_ALGOS / SUPPORTED_KDFS——**只有 decrypt 真能执行了才加**，别为绿灯谎报；
 *   ② 若新增 KDF 有自己的参数块（如 argon2 的 { m, t, p }），在 decrypt 里按 kdf 分派读取对应参数块，
 *      别再盲目 `|| SCRYPT.N` 回退（那正是本层要堵的坑）；
 *   ③ 新增判定档按**保守优先**插进判定链正确位置，并在下方 _STATUS 常量表登记。
 *      ok 只有一个出口 _verdict——status==='supported' 才 ok:true。
 */

// 本机解密实现（sourceSnapshotCrypto.decrypt / deriveKey）真能执行的加密套件。
// 改解密实现时按 HOW-TO-EXTEND 同步；只登记「decrypt 真能执行」的值。
const SUPPORTED_ALGOS = ['aes-256-gcm']; // createDecipheriv 用的对称算法
const SUPPORTED_KDFS = ['scrypt'];       // deriveKey 用的密钥派生函数

// GCM 解密必需的材料字段（无这三者 decrypt 的 Buffer.from 会崩）。只判存在性，绝不读值。
const REQUIRED_MATERIAL = ['salt', 'iv', 'authTag'];

// 单一裁决的状态枚举（_STATUS 表：新增判定档时在此登记）。
const STATUS_SUPPORTED = 'supported';                 // 套件认识、材料齐全：可安心进解密。
const STATUS_UNSUPPORTED_ALGO = 'unsupported-algo';   // algo 本机做不了：先升级 khy。
const STATUS_UNSUPPORTED_KDF = 'unsupported-kdf';     // kdf 本机做不了：decrypt 会盲用 scrypt 误派生 → 假「口令错误」。
const STATUS_INCOMPLETE_MATERIAL = 'incomplete-material'; // 缺 salt/iv/authTag：快照残缺，不是口令错。
const STATUS_UNVERIFIABLE = 'unverifiable';           // 证据不足：保守，绝不谎报 supported。

/** 非空字符串判定。 */
function _isNonEmptyStr(x) {
  return typeof x === 'string' && x.length > 0;
}

/** 支持集包含判定（大小写敏感——套件名是精确契约值，不做归一）。 */
function _inList(list, value) {
  return Array.isArray(list) && list.indexOf(value) !== -1;
}

/**
 * 唯一构造裁决的出口：ok 只在 status==='supported' 时为真。红线只需在此一处把守。
 * 注意：只带非密钥的 algo/kdf 字符串与「缺哪些材料字段名」，绝不带 salt/iv/authTag 的值。
 */
function _verdict(status, algo, kdf, missingMaterial, reason) {
  return {
    status,
    ok: status === STATUS_SUPPORTED,
    algo: typeof algo === 'string' ? algo : null,
    kdf: typeof kdf === 'string' ? kdf : null,
    supportedAlgos: SUPPORTED_ALGOS.slice(),
    supportedKdfs: SUPPORTED_KDFS.slice(),
    missingMaterial: Array.isArray(missingMaterial) ? missingMaterial.slice() : [],
    reason: String(reason || ''),
  };
}

/**
 * 判定一个已解析的快照头声明的加密套件，本机解密实现能不能执行。绝不抛。绝不碰密钥/明文。
 *
 * @param {object} header  解析好的 snapshot.json 对象
 * @returns {{status:string, ok:boolean, algo:(string|null), kdf:(string|null),
 *            supportedAlgos:string[], supportedKdfs:string[], missingMaterial:string[], reason:string}}
 */
function checkCryptoSuiteCompat(header) {
  // 1) 证据不足：头非对象 / 是数组（typeof []==='object' 经典陷阱，须显式排除）/ 无 crypto 块。
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    return _verdict(STATUS_UNVERIFIABLE, null, null, [],
      '缺快照头（snapshot.json 缺失 / 非对象 / 是数组）：无从判断加密套件，绝不默认进解密');
  }
  const c = header.crypto;
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    return _verdict(STATUS_UNVERIFIABLE, null, null, [],
      '快照头缺 crypto 块（或非对象）：无从确认加密套件');
  }
  const algo = c.algo;
  const kdf = c.kdf;
  if (!_isNonEmptyStr(algo)) {
    return _verdict(STATUS_UNVERIFIABLE, algo, kdf, [],
      '快照头缺 crypto.algo（或非非空字符串）：无从确认对称加密算法');
  }

  // 2) 算法本机做不了：decrypt 只会 aes-256-gcm → 拒绝，让用户升级 khy。
  if (!_inList(SUPPORTED_ALGOS, algo)) {
    return _verdict(STATUS_UNSUPPORTED_ALGO, algo, kdf, [],
      `crypto.algo='${algo}' 不在本机支持集 [${SUPPORTED_ALGOS.join(', ')}]：`
      + '本机解密实现执行不了这个算法，请先升级 khy 再还原');
  }

  // 3) KDF 本机做不了（核心死字段）：kdf 存在且陌生 → decrypt 会盲目按 scrypt 误派生密钥，
  //    最终抛 "unable to authenticate data" 被误标成「口令错误」。此处诚实拦下，别让用户以为密码错。
  if (_isNonEmptyStr(kdf) && !_inList(SUPPORTED_KDFS, kdf)) {
    return _verdict(STATUS_UNSUPPORTED_KDF, algo, kdf, [],
      `crypto.kdf='${kdf}' 不在本机支持集 [${SUPPORTED_KDFS.join(', ')}]：`
      + '本机解密只会用 scrypt 派生密钥，遇到别的 KDF 会误派生出错误密钥、'
      + '最终报「口令错误」骗你——真相是本机做不了这个 KDF，请先升级 khy');
  }

  // 4) 解密材料不全：algo/kdf 都 OK 但缺 salt/iv/authTag → decrypt 的 Buffer.from 会崩。
  //    诚实告知「快照残缺」，别让残缺快照走到解密再报成「口令错误」。
  const missing = REQUIRED_MATERIAL.filter((k) => !_isNonEmptyStr(c[k]));
  if (missing.length > 0) {
    return _verdict(STATUS_INCOMPLETE_MATERIAL, algo, kdf, missing,
      `crypto 块缺解密必需材料 [${missing.join(', ')}]（缺失或非非空串）：`
      + '这是快照残缺、不是口令错误，别拿它去解密');
  }

  // 5) 套件认识、材料齐全：唯一可安心进解密的档。
  const kdfNote = _isNonEmptyStr(kdf) ? `kdf='${kdf}'` : 'kdf 缺省（老快照，回退 scrypt，可容忍）';
  return _verdict(STATUS_SUPPORTED, algo, kdf, [],
    `algo='${algo}' 在支持集 · ${kdfNote} · salt/iv/authTag 齐全：`
    + '加密套件本机执行得了，可继续解密还原');
}

module.exports = {
  checkCryptoSuiteCompat,
  SUPPORTED_ALGOS,
  SUPPORTED_KDFS,
  REQUIRED_MATERIAL,
  STATUS_SUPPORTED,
  STATUS_UNSUPPORTED_ALGO,
  STATUS_UNSUPPORTED_KDF,
  STATUS_INCOMPLETE_MATERIAL,
  STATUS_UNVERIFIABLE,
  _verdict,
  _isNonEmptyStr,
  _inList,
};
