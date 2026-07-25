'use strict';

/**
 * restoreEffectProbe.test.js — 雅可比透镜（有限差分效应探针）纯叶单测
 *   node --test scripts/tests/restoreEffectProbe.test.js
 *
 * 覆盖：load-bearing / dead 检测、unverifiable 证据不足、ok iff 零 dead、扰动不改入参（深克隆）、
 *   绝不抛（畸形头 / 抛异常的门）、密钥卫生（裁决不含密钥材料值）、隔离语料构造、
 *   与真还原门面板的端到端接线（10 契约字段全 load-bearing；摘掉一个消费者→其字段变 dead）。
 */

const test = require('node:test');
const assert = require('node:assert');

const L = require('../lib/restoreEffectProbe');
const { checkSnapshotFormatCompat } = require('../lib/snapshotFormatCompat');
const { checkCryptoSuiteCompat } = require('../lib/cryptoSuiteCompat');
const { checkArchiveExtractCompat } = require('../lib/archiveExtractCompat');
const { assessRestoreProvenance } = require('../lib/restoreProvenance');

// 一个贴近真快照头的代表性头（含密钥材料值，用于密钥卫生断言）。
const SECRET_SALT = 'SALT_MUST_NOT_LEAK_kbuAg9TJ';
const SECRET_IV = 'IV_MUST_NOT_LEAK_eDu+AYM3';
const SECRET_TAG = 'TAG_MUST_NOT_LEAK_Eg1A5SsX';
function realish() {
  return {
    format: 'khy-source-snapshot',
    formatVersion: 1,
    layout: 'git-archive',
    captureMode: 'working-tree',
    includesUncommitted: true,
    dirty: true,
    archive: 'khy-os-source.tar.gz.enc',
    plaintextFormat: 'tar.gz',
    sha256: 'deadbeef',
    fileCount: 5865,
    version: '0.1.190',
    gitCommit: '44a491fb07f33694939cb28a1771bb30f5b0f66b',
    crypto: {
      algo: 'aes-256-gcm', kdf: 'scrypt', scrypt: { N: 16384, r: 8, p: 1, keylen: 32 },
      salt: SECRET_SALT, iv: SECRET_IV, authTag: SECRET_TAG,
    },
  };
}

function realPanel() {
  return [
    { name: 'format(105)', fn: checkSnapshotFormatCompat },
    { name: 'crypto(110)', fn: checkCryptoSuiteCompat },
    { name: 'archive(108)', fn: checkArchiveExtractCompat },
    { name: 'provenance(107)', fn: assessRestoreProvenance },
  ];
}

// ── 核心逻辑（用 stub gate，与真叶解耦）──────────────────────────────────────

test('load-bearing: 契约字段扰动改变 stub 门裁决 → load-bearing', () => {
  // 门只在 header.k === 'good' 时 ok。契约字段 k 的扰动会打破它。
  const gate = { name: 'g', fn: (h) => ({ status: h && h.k === 'good' ? 's' : 'x', ok: !!(h && h.k === 'good') }) };
  const v = L.probeHeaderEffects({
    contexts: [{ name: 'c', header: { k: 'good' } }],
    gates: [gate],
    contract: [{ path: 'k', wiredBy: 'T' }],
  });
  assert.strictEqual(v.status, 'ok');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.fields[0].effect, 'load-bearing');
  assert.ok(v.fields[0].hits.length > 0);
});

test('dead: 契约字段无门消费 → dead + status regression + ok:false + exit 语义', () => {
  const gate = { name: 'g', fn: () => ({ status: 's', ok: true }) }; // 恒定，谁都不消费
  const v = L.probeHeaderEffects({
    contexts: [{ name: 'c', header: { k: 'x', other: 1 } }],
    gates: [gate],
    contract: [{ path: 'k', wiredBy: 'T' }],
  });
  assert.strictEqual(v.status, 'regression');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.fields[0].effect, 'dead');
  assert.deepStrictEqual(v.deadFields, ['k']);
});

test('ok iff 零 dead：一活一死 → 整体 regression', () => {
  const gate = { name: 'g', fn: (h) => ({ status: h && h.a === 'good' ? 's' : 'x', ok: !!(h && h.a === 'good') }) };
  const v = L.probeHeaderEffects({
    contexts: [{ name: 'c', header: { a: 'good', b: 1 } }],
    gates: [gate],
    contract: [{ path: 'a', wiredBy: 'A' }, { path: 'b', wiredBy: 'B' }],
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.summary.loadBearing, 1);
  assert.strictEqual(v.summary.dead, 1);
  assert.deepStrictEqual(v.deadFields, ['b']);
});

test('unverifiable：无门 → 证据不足、ok:false、不臆断绿', () => {
  const v = L.probeHeaderEffects({ contexts: [{ name: 'c', header: { k: 1 } }], gates: [] });
  assert.strictEqual(v.status, 'unverifiable');
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.fields, []);
});

test('unverifiable：无上下文语料 → 证据不足、ok:false', () => {
  const v = L.probeHeaderEffects({ contexts: [], gates: realPanel() });
  assert.strictEqual(v.status, 'unverifiable');
  assert.strictEqual(v.ok, false);
});

test('扰动绝不改入参（深克隆）：探测后原 header 逐字节不变', () => {
  const h = realish();
  const before = JSON.stringify(h);
  L.probeHeaderEffects({ contexts: [{ name: 'c', header: h }], gates: realPanel(), extrasFrom: h });
  assert.strictEqual(JSON.stringify(h), before);
});

test('绝不抛：抛异常的门 + 畸形上下文头都不崩', () => {
  const throwing = { name: 'boom', fn: () => { throw new Error('gate blew up'); } };
  assert.doesNotThrow(() => {
    const v = L.probeHeaderEffects({
      contexts: [{ name: 'c', header: null }, { name: 'd', header: 42 }, { name: 'e', header: { k: 1 } }],
      gates: [throwing],
      contract: [{ path: 'k', wiredBy: 'T' }],
    });
    assert.ok(v && typeof v === 'object');
  });
});

test('密钥卫生（红线）：序列化裁决绝不含 salt/iv/authTag 的值', () => {
  const h = realish();
  const v = L.probeHeaderEffects({
    contexts: L.buildContextCorpus(h),
    gates: realPanel(),
    extrasFrom: h,
  });
  const s = JSON.stringify(v);
  assert.ok(!s.includes(SECRET_SALT), 'salt 值泄漏进裁决');
  assert.ok(!s.includes(SECRET_IV), 'iv 值泄漏进裁决');
  assert.ok(!s.includes(SECRET_TAG), 'authTag 值泄漏进裁决');
  // 契约里也绝不出现 crypto.salt/iv/authTag 这些密钥材料字段
  for (const cf of L.CONTRACT_FIELDS) {
    assert.ok(!/salt|iv|authTag/i.test(cf.path), `契约不该含密钥材料字段 ${cf.path}`);
  }
});

// ── 隔离语料构造 ───────────────────────────────────────────────────────────────

test('buildContextCorpus：真头派生 4 个隔离上下文', () => {
  const corpus = L.buildContextCorpus(realish());
  assert.strictEqual(corpus.length, 4);
  assert.deepStrictEqual(corpus.map((c) => c.name), ['real', 'clean-head', 'clean-worktree', 'dirty-flag']);
  const byName = Object.fromEntries(corpus.map((c) => [c.name, c.header]));
  assert.strictEqual(byName['clean-head'].captureMode, 'HEAD');
  assert.strictEqual('includesUncommitted' in byName['clean-head'], false);
  assert.strictEqual(byName['clean-worktree'].includesUncommitted, false);
  assert.strictEqual(byName['dirty-flag'].dirty, true);
});

test('buildContextCorpus：非对象基准头 → 单 base 上下文（走 unverifiable 前置）', () => {
  assert.deepStrictEqual(L.buildContextCorpus(null).map((c) => c.name), ['base']);
  assert.deepStrictEqual(L.buildContextCorpus([1, 2]).map((c) => c.name), ['base']);
});

// ── 端到端：真还原门面板 + 隔离语料 ────────────────────────────────────────────

test('端到端：真快照头 + 真门面板 → 10 契约字段全 load-bearing、ok', () => {
  const h = realish();
  const v = L.probeHeaderEffects({
    contexts: L.buildContextCorpus(h),
    gates: realPanel(),
    extrasFrom: h,
  });
  assert.strictEqual(v.status, 'ok');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.summary.contract, 10);
  assert.strictEqual(v.summary.loadBearing, 10);
  assert.strictEqual(v.summary.dead, 0);
  for (const f of v.fields) assert.strictEqual(f.effect, 'load-bearing', `${f.path} 应 load-bearing`);
});

test('端到端回归：摘掉 provenance(107) 消费者 → 其 4 字段变 dead、exit2 语义', () => {
  const h = realish();
  const panelNo107 = realPanel().filter((g) => g.name !== 'provenance(107)');
  const v = L.probeHeaderEffects({
    contexts: L.buildContextCorpus(h),
    gates: panelNo107,
    extrasFrom: h,
  });
  assert.strictEqual(v.status, 'regression');
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(
    v.deadFields.slice().sort(),
    ['captureMode', 'dirty', 'gitCommit', 'includesUncommitted'],
  );
});

test('extras：非契约字段分类（本面板不消费 → unmonitored；不含 crypto 下探）', () => {
  const h = realish();
  const v = L.probeHeaderEffects({
    contexts: L.buildContextCorpus(h),
    gates: realPanel(),
    extrasFrom: h,
  });
  const byPath = Object.fromEntries(v.extras.map((e) => [e.path, e.effect]));
  assert.strictEqual(byPath['fileCount'], 'unmonitored');
  assert.strictEqual(byPath['sha256'], 'unmonitored');
  // crypto 是契约字段的顶层段，绝不作为 extra 出现（→ 绝不下探 salt/iv/authTag）
  assert.ok(!('crypto' in byPath), 'crypto 不该出现在 extras（否则会下探密钥材料）');
});
