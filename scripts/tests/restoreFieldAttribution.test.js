'use strict';

/**
 * restoreFieldAttribution.test.js — 字段-消费者归属探针（label preservation）纯叶单测
 *   node --test scripts/tests/restoreFieldAttribution.test.js
 *
 * 覆盖：faithful 全绿 / cross-talk 检出 miswired / partial（多属主缺一）/ dead 照实报 /
 *   unattributed（无 wiredBy）/ 证据不足 unverifiable 传播 / 绝不抛（畸形 probeResult）/
 *   _opsNums·_gateHasNum·_distinctGates·_classifyField 工具单测 / 密钥卫生（输出不含 header 值）/
 *   与真还原门面板端到端（真快照 faithful；注入 mis-wired 门 → cross-talk 而 OPS-113 仍绿）。
 */

const test = require('node:test');
const assert = require('node:assert');

const A = require('../lib/restoreFieldAttribution');
const { probeHeaderEffects, buildContextCorpus } = require('../lib/restoreEffectProbe');
const { checkSnapshotFormatCompat } = require('../lib/snapshotFormatCompat');
const { checkCryptoSuiteCompat } = require('../lib/cryptoSuiteCompat');
const { checkArchiveExtractCompat } = require('../lib/archiveExtractCompat');
const { assessRestoreProvenance } = require('../lib/restoreProvenance');

const SECRET_SALT = 'SALT_MUST_NOT_LEAK_kbuAg9TJ';
const SECRET_IV = 'IV_MUST_NOT_LEAK_eDu+AYM3';
const SECRET_TAG = 'TAG_MUST_NOT_LEAK_Eg1A5SsX';
function realish() {
  return {
    format: 'khy-source-snapshot', formatVersion: 1, layout: 'git-archive',
    captureMode: 'working-tree', includesUncommitted: true, dirty: true,
    archive: 'khy-os-source.tar.gz.enc', plaintextFormat: 'tar.gz',
    sha256: 'deadbeef', fileCount: 5865, version: '0.1.190',
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

// 手搓一个 probeResult（只需 fields[].{path,wiredBy,hits}），与真门面板解耦，覆盖各归属档。
function pr(fields) { return { status: 'ok', ok: true, fields }; }
function field(path, wiredBy, gates) {
  return { path, wiredBy, hits: gates.map((g) => ({ context: 'real', gate: g })) };
}

// ── 工具单测 ──────────────────────────────────────────────────────────────────

test('_opsNums 抽编号令牌：单/多/无', () => {
  assert.deepStrictEqual(A._opsNums('OPS-107'), ['107']);
  assert.deepStrictEqual(A._opsNums('OPS-105+108'), ['105', '108']);
  assert.deepStrictEqual(A._opsNums('no-number'), []);
  assert.deepStrictEqual(A._opsNums(undefined), []);
  assert.deepStrictEqual(A._opsNums(null), []);
});

test('_gateHasNum 子串匹配数字令牌', () => {
  assert.strictEqual(A._gateHasNum('provenance(107)', '107'), true);
  assert.strictEqual(A._gateHasNum('crypto(110)', '107'), false);
  assert.strictEqual(A._gateHasNum(null, '107'), false);
});

test('_distinctGates 去重稳定排序 + 畸形 hits 不抛', () => {
  assert.deepStrictEqual(
    A._distinctGates([{ gate: 'b(2)' }, { gate: 'a(1)' }, { gate: 'b(2)' }]),
    ['a(1)', 'b(2)']
  );
  assert.deepStrictEqual(A._distinctGates(null), []);
  assert.deepStrictEqual(A._distinctGates([null, { nogate: 1 }, 'x']), []);
});

test('_classifyField 五档判定', () => {
  assert.strictEqual(A._classifyField(['provenance(107)'], ['107']).attribution, A.ATTR_FAITHFUL);
  assert.strictEqual(A._classifyField(['provenance(107)', 'crypto(110)'], ['110']).attribution, A.ATTR_CROSS_TALK);
  assert.strictEqual(A._classifyField(['format(105)'], ['105', '108']).attribution, A.ATTR_PARTIAL);
  assert.strictEqual(A._classifyField([], ['107']).attribution, A.ATTR_DEAD);
  assert.strictEqual(A._classifyField(['x(9)'], []).attribution, A.ATTR_UNATTRIBUTED);
});

// ── 顶层归属判定 ──────────────────────────────────────────────────────────────

test('全 faithful → ok', () => {
  const r = A.assessFieldAttribution({ probeResult: pr([
    field('format', 'OPS-105', ['format(105)']),
    field('crypto.algo', 'OPS-110', ['crypto(110)']),
    field('gitCommit', 'OPS-107', ['provenance(107)']),
  ]) });
  assert.strictEqual(r.status, A.STATUS_OK);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.summary.faithful, 3);
  assert.strictEqual(r.offenders.length, 0);
});

test('cross-talk（字段驱动非属主门）→ miswired ok:false，且列入 offenders', () => {
  const r = A.assessFieldAttribution({ probeResult: pr([
    field('format', 'OPS-105', ['format(105)']),
    // crypto.algo 泄漏到 provenance(107)：真串扰，OPS-113 数得到 ≥1 门却看不见错门
    field('crypto.algo', 'OPS-110', ['crypto(110)', 'provenance(107)']),
  ]) });
  assert.strictEqual(r.status, A.STATUS_MISWIRED);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.summary.crossTalk, 1);
  assert.strictEqual(r.offenders.length, 1);
  assert.strictEqual(r.offenders[0].path, 'crypto.algo');
  assert.deepStrictEqual(r.offenders[0].foreignGates, ['provenance(107)']);
});

test('partial（多属主字段缺一属主门）→ miswired', () => {
  const r = A.assessFieldAttribution({ probeResult: pr([
    field('sharedField', 'OPS-105+108', ['format(105)']), // 声明 105+108，实际只反应 105
  ]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.summary.partial, 1);
  assert.deepStrictEqual(r.fields[0].missingNums, ['108']);
});

test('dead（一门不反应）照实报 → miswired，不臆断绿', () => {
  const r = A.assessFieldAttribution({ probeResult: pr([
    field('gitCommit', 'OPS-107', []),
  ]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.summary.dead, 1);
  assert.strictEqual(r.fields[0].attribution, A.ATTR_DEAD);
});

test('unattributed（无 wiredBy）→ 保守非 ok', () => {
  const r = A.assessFieldAttribution({ probeResult: pr([
    { path: 'orphan', hits: [{ context: 'real', gate: 'format(105)' }] },
  ]) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.summary.unattributed, 1);
  assert.strictEqual(r.fields[0].wiredBy, null);
});

test('证据不足（上游无字段 / 畸形）→ unverifiable ok:false，绝不抛', () => {
  for (const bad of [undefined, null, {}, { fields: [] }, { fields: null }, { fields: 'x' }, 42, 'str']) {
    const r = A.assessFieldAttribution({ probeResult: bad });
    assert.strictEqual(r.status, A.STATUS_UNVERIFIABLE);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.fields.length, 0);
  }
  // 完全没 opts 也不抛
  assert.strictEqual(A.assessFieldAttribution().status, A.STATUS_UNVERIFIABLE);
  assert.strictEqual(A.assessFieldAttribution(null).ok, false);
});

test('绝不抛：字段畸形（hits 非数组 / path 非串 / 门名非串）', () => {
  const r = A.assessFieldAttribution({ probeResult: pr([
    { path: 123, wiredBy: 'OPS-105', hits: 'nope' },
    { path: 'ok', wiredBy: 'OPS-107', hits: [{ gate: 42 }, null] },
  ]) });
  assert.strictEqual(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.fields));
});

// ── 密钥卫生 ──────────────────────────────────────────────────────────────────

test('密钥卫生：任何密钥材料值都不出现在归属裁决序列化里', () => {
  // 真门面板跑一次，把 probeResult 喂进来；序列化后不得含 salt/iv/tag 值。
  const header = realish();
  const contexts = buildContextCorpus(header);
  const probeResult = probeHeaderEffects({ contexts, gates: realPanel(), extrasFrom: header });
  const r = A.assessFieldAttribution({ probeResult });
  const blob = JSON.stringify(r);
  assert.strictEqual(blob.includes(SECRET_SALT), false);
  assert.strictEqual(blob.includes(SECRET_IV), false);
  assert.strictEqual(blob.includes(SECRET_TAG), false);
  // 且 gitCommit 的**值**也不该出现在归属裁决里（只报路径/门名/OPS 号）。
  assert.strictEqual(blob.includes('44a491fb07f3'), false);
});

// ── 端到端：真还原门面板 + 与 OPS-113 的正交性 ────────────────────────────────

test('端到端：真快照 + 真门面板 → 10 契约字段全 faithful，ok exit0 语义', () => {
  const header = realish();
  const contexts = buildContextCorpus(header);
  const probeResult = probeHeaderEffects({ contexts, gates: realPanel(), extrasFrom: header });
  const r = A.assessFieldAttribution({ probeResult });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.summary.contract, 10);
  assert.strictEqual(r.summary.faithful, 10);
  assert.strictEqual(r.summary.crossTalk, 0);
});

test('正交性：注入 mis-wired 门 → 归属探针报 cross-talk，而 OPS-113 仍绿（它看不见错门）', () => {
  const header = realish();
  const contexts = buildContextCorpus(header);
  // 一个被污染的 provenance 门：裁决额外依赖 crypto.algo（关注点泄漏）。
  const provLeak = (h) => {
    const algo = h && h.crypto && h.crypto.algo;
    if (algo && algo !== 'aes-256-gcm') return { status: 'algo-leak', ok: false };
    return assessRestoreProvenance(h);
  };
  const badPanel = [
    { name: 'format(105)', fn: checkSnapshotFormatCompat },
    { name: 'crypto(110)', fn: checkCryptoSuiteCompat },
    { name: 'archive(108)', fn: checkArchiveExtractCompat },
    { name: 'provenance(107)', fn: provLeak },
  ];
  const probeResult = probeHeaderEffects({ contexts, gates: badPanel, extrasFrom: header });

  // OPS-113（效应探针）在这个坏面板上依旧全绿——crypto.algo 仍 ≥1 门反应。
  assert.strictEqual(probeResult.ok, true);

  // OPS-114（归属探针）抓住串扰：crypto.algo 泄漏到 provenance(107)。
  const r = A.assessFieldAttribution({ probeResult });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, A.STATUS_MISWIRED);
  const off = r.offenders.find((x) => x.path === 'crypto.algo');
  assert.ok(off, '应把 crypto.algo 列为 offender');
  assert.strictEqual(off.attribution, A.ATTR_CROSS_TALK);
  assert.ok(off.foreignGates.includes('provenance(107)'));
});
