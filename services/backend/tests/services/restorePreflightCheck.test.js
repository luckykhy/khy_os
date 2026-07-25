'use strict';

/**
 * Unit tests for restorePreflightCheck.js — the bundled runtime leaf that runs a
 * PRE-DECRYPT compatibility preflight over a snapshot header (run via `node --test`).
 *
 * 覆盖：
 *   - assessRestorePreflight 各档：supported(ok/none) / unsupported-algo(block) /
 *     unsupported-kdf(block) / incomplete-material(block) / alien-format(warn) /
 *     too-new-format(warn) / too-old-format(warn) / unverifiable(none)。
 *   - 二级严重度不变量：ok 仅当 supported；block↔severity block；warn↔severity warn。
 *   - zero false-block：受支持套件 + 未知/缺格式 → 绝不 block；格式异形只 warn。
 *   - 红线密钥卫生：裁决输出（JSON 序列化）绝不含 salt/iv/authTag 的值。
 *   - 绝不抛：对抗性输入（null / 数组 / 非对象 crypto / 循环引用）全部保守放行。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const PF = require('../../src/services/restorePreflightCheck');
const { assessRestorePreflight: a } = PF;

// 一个「本机受支持」的完整头（对齐运行时 aes-256-gcm + scrypt 套件）。
function goodHeader(over) {
  return {
    format: 'khy-source-snapshot',
    formatVersion: 1,
    sha256: 'deadbeef',
    crypto: {
      algo: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: 'c2FsdA==',
      iv: 'aXY=',
      authTag: 'dGFn',
      ...(over || {}),
    },
    ...(over && over.__top ? over.__top : {}),
  };
}

test('supported: 完整受支持套件 + 理解区间格式 ⇒ ok/none，不 block 不 warn', () => {
  const r = a(goodHeader());
  assert.strictEqual(r.status, PF.STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.warn, false);
  assert.strictEqual(r.severity, PF.SEVERITY_NONE);
  assert.strictEqual(r.algo, 'aes-256-gcm');
  assert.strictEqual(r.kdf, 'scrypt');
});

test('supported: 缺 kdf 字段（老快照）不视为不支持 ⇒ 仍 supported', () => {
  const h = goodHeader();
  delete h.crypto.kdf;
  const r = a(h);
  assert.strictEqual(r.status, PF.STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kdf, null);
});

test('unsupported-algo: 未来算法 ⇒ block，消息指向升级而非口令', () => {
  const r = a(goodHeader({ algo: 'aes-256-siv' }));
  assert.strictEqual(r.status, PF.STATUS_UNSUPPORTED_ALGO);
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.severity, PF.SEVERITY_BLOCK);
  assert.match(r.message, /升级 khy/);
  assert.doesNotMatch(r.message, /--secret/);
});

test('unsupported-kdf: argon2 ⇒ block（避免盲跑 scrypt 误派生被谎报口令错）', () => {
  const r = a(goodHeader({ kdf: 'argon2' }));
  assert.strictEqual(r.status, PF.STATUS_UNSUPPORTED_KDF);
  assert.strictEqual(r.block, true);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /升级 khy|派生/);
  assert.doesNotMatch(r.message, /口令错误」——请用/);
});

test('incomplete-material: 缺 algo ⇒ block incomplete-material，missingMaterial 含 algo', () => {
  const h = goodHeader();
  delete h.crypto.algo;
  const r = a(h);
  assert.strictEqual(r.status, PF.STATUS_INCOMPLETE_MATERIAL);
  assert.strictEqual(r.block, true);
  assert.deepStrictEqual(r.missingMaterial, ['algo']);
});

test('incomplete-material: 缺 salt/iv/authTag ⇒ block，列出所有缺失项', () => {
  const h = goodHeader();
  delete h.crypto.salt;
  delete h.crypto.authTag;
  const r = a(h);
  assert.strictEqual(r.status, PF.STATUS_INCOMPLETE_MATERIAL);
  assert.strictEqual(r.block, true);
  assert.deepStrictEqual(r.missingMaterial, ['salt', 'authTag']);
  assert.match(r.message, /残缺|不是口令/);
});

test('alien-format: format 异形但套件受支持 ⇒ warn（继续尝试，绝不 block）', () => {
  const r = a(goodHeader({ __top: { format: 'some-other-snapshot' } }));
  assert.strictEqual(r.status, PF.STATUS_ALIEN_FORMAT);
  assert.strictEqual(r.warn, true);
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /仍将尝试还原/);
});

test('too-new-format: formatVersion 过新 ⇒ warn（不 false-block）', () => {
  const r = a(goodHeader({ __top: { formatVersion: 2 } }));
  assert.strictEqual(r.status, PF.STATUS_TOO_NEW_FORMAT);
  assert.strictEqual(r.warn, true);
  assert.strictEqual(r.block, false);
  assert.strictEqual(r.formatVersion, 2);
});

test('too-old-format: formatVersion 过旧 ⇒ warn', () => {
  const r = a(goodHeader({ __top: { formatVersion: 0 } }));
  assert.strictEqual(r.status, PF.STATUS_TOO_OLD_FORMAT);
  assert.strictEqual(r.warn, true);
  assert.strictEqual(r.block, false);
});

test('crypto 套件优先级：不支持 algo + 异形 format 同时存在 ⇒ 先 block algo（证明性不可解优先）', () => {
  const r = a(goodHeader({ algo: 'xchacha', __top: { format: 'weird' } }));
  assert.strictEqual(r.status, PF.STATUS_UNSUPPORTED_ALGO);
  assert.strictEqual(r.block, true);
});

test('unverifiable: 缺头 / 数组头 / crypto 非对象 ⇒ none，保守放行', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    const r = a(bad);
    assert.strictEqual(r.status, PF.STATUS_UNVERIFIABLE);
    assert.strictEqual(r.block, false);
    assert.strictEqual(r.ok, false);
  }
  const r2 = a({ format: 'khy-source-snapshot', crypto: [1, 2] });
  assert.strictEqual(r2.status, PF.STATUS_UNVERIFIABLE);
  assert.strictEqual(r2.block, false);
});

test('可注入本机支持集：把 aes-256-gcm 从支持集移除 ⇒ 之前 supported 的头变 block', () => {
  const r = a(goodHeader(), { supportedAlgos: ['aes-256-cbc'] });
  assert.strictEqual(r.status, PF.STATUS_UNSUPPORTED_ALGO);
  assert.strictEqual(r.block, true);
});

test('红线密钥卫生：裁决 JSON 序列化绝不含 salt/iv/authTag 的值', () => {
  const h = goodHeader({
    salt: 'S3CR3T_SALT_VALUE_XYZ',
    iv: 'S3CR3T_IV_VALUE_XYZ',
    authTag: 'S3CR3T_TAG_VALUE_XYZ',
  });
  const serialized = JSON.stringify(a(h));
  assert.doesNotMatch(serialized, /S3CR3T_SALT_VALUE_XYZ/);
  assert.doesNotMatch(serialized, /S3CR3T_IV_VALUE_XYZ/);
  assert.doesNotMatch(serialized, /S3CR3T_TAG_VALUE_XYZ/);
  // 缺失材料分支同样不得泄漏（missingMaterial 只放字段名）。
  const h2 = goodHeader({ salt: 'ANOTHER_SECRET_SALT' });
  delete h2.crypto.iv;
  const s2 = JSON.stringify(a(h2));
  assert.doesNotMatch(s2, /ANOTHER_SECRET_SALT/);
});

test('绝不抛：对抗性输入（循环引用 crypto / getter 抛错）全部 unverifiable 或安全裁决', () => {
  const circ = { format: 'khy-source-snapshot', formatVersion: 1, crypto: {} };
  circ.crypto.self = circ.crypto;
  circ.crypto.algo = 'aes-256-gcm';
  circ.crypto.salt = 's'; circ.crypto.iv = 'i'; circ.crypto.authTag = 't';
  assert.doesNotThrow(() => a(circ));

  const throwy = {
    format: 'khy-source-snapshot', formatVersion: 1,
    get crypto() { throw new Error('boom'); },
  };
  let r;
  assert.doesNotThrow(() => { r = a(throwy); });
  assert.strictEqual(r.status, PF.STATUS_UNVERIFIABLE);
  assert.strictEqual(r.block, false);
});

test('severity 不变量：每个 status 的 block/warn/ok 三布尔与 severity 自洽', () => {
  const cases = [
    [a(goodHeader()), PF.SEVERITY_NONE, true, false, false],
    [a(goodHeader({ algo: 'x' })), PF.SEVERITY_BLOCK, false, true, false],
    [a(goodHeader({ __top: { format: 'z' } })), PF.SEVERITY_WARN, false, false, true],
    [a(null), PF.SEVERITY_NONE, false, false, false],
  ];
  for (const [r, sev, ok, block, warn] of cases) {
    assert.strictEqual(r.severity, sev);
    assert.strictEqual(r.ok, ok);
    assert.strictEqual(r.block, block);
    assert.strictEqual(r.warn, warn);
  }
});
