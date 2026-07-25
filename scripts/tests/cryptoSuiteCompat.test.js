'use strict';

/**
 * cryptoSuiteCompat.test.js — 还原「解密套件可执行性」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/cryptoSuiteCompat.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：
 *   · 保守优先：头缺失 / 数组 / 无 crypto / algo 类型错 → unverifiable，绝不谎报 supported；
 *   · algo 不在支持集 → unsupported-algo；
 *   · kdf 存在且不在支持集 → unsupported-kdf（离机断桥要抓的假「口令错误」）；
 *   · 缺 salt/iv/authTag → incomplete-material（快照残缺，不是口令错）；
 *   · kdf 缺省是老快照合法情形 → algo+材料齐全即 supported；
 *   · ok===true 当且仅当 status==='supported'；
 *   · 密钥卫生：裁决绝不带 salt/iv/authTag 的值；
 *   · 任何畸形输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const M = require('../lib/cryptoSuiteCompat');
const {
  checkCryptoSuiteCompat,
  SUPPORTED_ALGOS, SUPPORTED_KDFS, REQUIRED_MATERIAL,
  STATUS_SUPPORTED, STATUS_UNSUPPORTED_ALGO, STATUS_UNSUPPORTED_KDF,
  STATUS_INCOMPLETE_MATERIAL, STATUS_UNVERIFIABLE,
  _isNonEmptyStr, _inList,
} = M;

// 与真实 shipped snapshot.json 的 crypto 块对齐的最小合法头。
function goodHeader(cryptoOver = {}) {
  return {
    crypto: {
      algo: SUPPORTED_ALGOS[0], kdf: SUPPORTED_KDFS[0],
      scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },
      salt: 'kbuAg9TJ7ySgAdatNcFD7w==', iv: 'eDu+AYM3M0QK04Y0', authTag: 'Eg1A5SsX1HKvBPC+JnLAKg==',
      ...cryptoOver,
    },
  };
}

// ── 档 5：supported（唯一 ok:true）─────────────────────────────────────────────

test('认识的 algo + 认识的 kdf + 材料齐全 → supported + ok:true', () => {
  const r = checkCryptoSuiteCompat(goodHeader());
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.algo, 'aes-256-gcm');
  assert.strictEqual(r.kdf, 'scrypt');
  assert.deepStrictEqual(r.missingMaterial, []);
});

test('真实 shipped crypto 块（aes-256-gcm / scrypt）→ supported', () => {
  const r = checkCryptoSuiteCompat({
    format: 'khy-source-snapshot', formatVersion: 1,
    crypto: {
      algo: 'aes-256-gcm', kdf: 'scrypt',
      scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },
      salt: 'kbuAg9TJ7ySgAdatNcFD7w==', iv: 'eDu+AYM3M0QK04Y0', authTag: 'Eg1A5SsX1HKvBPC+JnLAKg==',
    },
  });
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
});

test('kdf 缺省（老快照）+ algo/材料齐全 → 仍 supported（向后兼容，decrypt 回退 scrypt）', () => {
  const h = goodHeader();
  delete h.crypto.kdf;
  const r = checkCryptoSuiteCompat(h);
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kdf, null);
});

test('scrypt 参数块缺省 + 其余齐全 → 仍 supported（decrypt 有默认参数回退，材料才是硬需求）', () => {
  const h = goodHeader();
  delete h.crypto.scrypt;
  const r = checkCryptoSuiteCompat(h);
  assert.strictEqual(r.status, STATUS_SUPPORTED);
});

// ── 档 3：unsupported-kdf（核心断桥）───────────────────────────────────────────

test('未来 argon2 KDF → unsupported-kdf + ok:false（旧 khy 盲用 scrypt 误派生的假「口令错误」）', () => {
  const r = checkCryptoSuiteCompat(goodHeader({ kdf: 'argon2' }));
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_KDF);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /口令错误|误派生|升级 khy/);
});

test('unsupported-kdf 优先于材料判定（先抓套件做不了）', () => {
  // kdf 陌生 + 同时缺材料：应命中 unsupported-kdf（套件做不了比材料残缺更靠前）。
  const h = goodHeader({ kdf: 'argon2' });
  delete h.crypto.salt;
  const r = checkCryptoSuiteCompat(h);
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_KDF);
});

// ── 档 2：unsupported-algo ─────────────────────────────────────────────────────

test('未来 chacha20-poly1305 算法 → unsupported-algo + ok:false', () => {
  const r = checkCryptoSuiteCompat(goodHeader({ algo: 'chacha20-poly1305' }));
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_ALGO);
  assert.strictEqual(r.ok, false);
});

test('unsupported-algo 优先于 kdf 判定（算法是最外层，先抓）', () => {
  const r = checkCryptoSuiteCompat(goodHeader({ algo: 'chacha20-poly1305', kdf: 'argon2' }));
  assert.strictEqual(r.status, STATUS_UNSUPPORTED_ALGO);
});

// ── 档 4：incomplete-material ───────────────────────────────────────────────────

test('缺 authTag → incomplete-material + ok:false + missingMaterial 指名', () => {
  const h = goodHeader();
  delete h.crypto.authTag;
  const r = checkCryptoSuiteCompat(h);
  assert.strictEqual(r.status, STATUS_INCOMPLETE_MATERIAL);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missingMaterial, ['authTag']);
  assert.match(r.reason, /残缺|不是口令/);
});

test('缺多个材料 → missingMaterial 全列出（按 REQUIRED_MATERIAL 顺序）', () => {
  const h = goodHeader();
  delete h.crypto.salt;
  delete h.crypto.iv;
  const r = checkCryptoSuiteCompat(h);
  assert.strictEqual(r.status, STATUS_INCOMPLETE_MATERIAL);
  assert.deepStrictEqual(r.missingMaterial, ['salt', 'iv']);
});

test('材料为空串（非缺失但无效）→ incomplete-material', () => {
  const r = checkCryptoSuiteCompat(goodHeader({ iv: '' }));
  assert.strictEqual(r.status, STATUS_INCOMPLETE_MATERIAL);
  assert.deepStrictEqual(r.missingMaterial, ['iv']);
});

// ── 档 1：unverifiable（保守）──────────────────────────────────────────────────

test('null 头 → unverifiable + ok:false', () => {
  const r = checkCryptoSuiteCompat(null);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('数组头 → unverifiable（typeof []==="object" 经典陷阱须显式排除）', () => {
  const r = checkCryptoSuiteCompat([]);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('无 crypto 块 → unverifiable', () => {
  const r = checkCryptoSuiteCompat({ format: 'khy-source-snapshot' });
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
});

test('crypto 是数组 → unverifiable（须显式排除）', () => {
  const r = checkCryptoSuiteCompat({ crypto: [] });
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
});

test('crypto.algo 非字符串（缺 / 数字）→ unverifiable', () => {
  for (const bad of [undefined, 1, '', null]) {
    const r = checkCryptoSuiteCompat(goodHeader({ algo: bad }));
    assert.strictEqual(r.status, STATUS_UNVERIFIABLE, `algo=${JSON.stringify(bad)}`);
  }
});

// ── 恒久红线 & 密钥卫生 & 纯度 ──────────────────────────────────────────────────

test('ok===true 当且仅当 status==="supported"', () => {
  assert.strictEqual(checkCryptoSuiteCompat(goodHeader()).ok, true);
  for (const r of [
    checkCryptoSuiteCompat(null),
    checkCryptoSuiteCompat([]),
    checkCryptoSuiteCompat(goodHeader({ algo: 'x' })),
    checkCryptoSuiteCompat(goodHeader({ kdf: 'argon2' })),
    checkCryptoSuiteCompat(goodHeader({ authTag: '' })),
  ]) {
    assert.strictEqual(r.ok, r.status === STATUS_SUPPORTED);
    assert.strictEqual(r.ok, false);
  }
});

test('密钥卫生：裁决绝不带 salt/iv/authTag 的值（只有存在性经 missingMaterial 字段名体现）', () => {
  const secretSalt = 'SUPER_SECRET_SALT_VALUE_kbuAg9TJ';
  const r = checkCryptoSuiteCompat(goodHeader({ salt: secretSalt }));
  const serialized = JSON.stringify(r);
  assert.strictEqual(serialized.includes(secretSalt), false, '裁决不得泄露 salt 值');
  assert.strictEqual(serialized.includes('eDu+AYM3M0QK04Y0'), false, '裁决不得泄露 iv 值');
  assert.strictEqual(serialized.includes('Eg1A5SsX1HKvBPC+JnLAKg=='), false, '裁决不得泄露 authTag 值');
});

test('裁决始终带支持集快照（新副本，不外泄内部数组引用）', () => {
  const r = checkCryptoSuiteCompat(goodHeader());
  assert.deepStrictEqual(r.supportedAlgos, SUPPORTED_ALGOS);
  assert.deepStrictEqual(r.supportedKdfs, SUPPORTED_KDFS);
  r.supportedAlgos.push('tampered');
  assert.strictEqual(SUPPORTED_ALGOS.includes('tampered'), false);
});

test('任何畸形输入绝不抛', () => {
  const weird = [undefined, null, NaN, [], {}, '', 0, false, Symbol('x'),
    { crypto: null }, { crypto: 'x' }, { crypto: { algo: [] } },
    { crypto: { algo: 'aes-256-gcm', kdf: 99 } }];
  for (const w of weird) {
    assert.doesNotThrow(() => checkCryptoSuiteCompat(w));
  }
});

test('kdf 非串（数字）但 algo/材料齐全 → 视同缺省 supported（kdf 非串不当陌生 KDF 误拦）', () => {
  const r = checkCryptoSuiteCompat(goodHeader({ kdf: 99 }));
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.kdf, null);
});

// ── helper 单元 ───────────────────────────────────────────────────────────────

test('_isNonEmptyStr / _inList 基础语义', () => {
  assert.strictEqual(_isNonEmptyStr('x'), true);
  assert.strictEqual(_isNonEmptyStr(''), false);
  assert.strictEqual(_inList(['scrypt'], 'scrypt'), true);
  assert.strictEqual(_inList(['scrypt'], 'SCRYPT'), false); // 大小写敏感：精确契约值
  assert.strictEqual(_inList(null, 'x'), false);
  assert.deepStrictEqual(REQUIRED_MATERIAL, ['salt', 'iv', 'authTag']);
});
