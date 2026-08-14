'use strict';

/**
 * snapshotFormatCompat.test.js — 还原「快照格式兼容性」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/snapshotFormatCompat.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：
 *   · 保守优先：头缺失 / 字段类型错 → unverifiable，绝不谎报 supported；
 *   · format 不是 khy 源码快照 → alien；
 *   · formatVersion 超出本机理解区间 → too-new / too-old（离机断桥要抓的盲目解密假绿）；
 *   · ok===true 当且仅当 status==='supported'；
 *   · 任何畸形输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const M = require('../lib/snapshotFormatCompat');
const {
  checkSnapshotFormatCompat,
  SUPPORTED_FORMAT, MIN_FORMAT_VERSION, MAX_FORMAT_VERSION,
  STATUS_SUPPORTED, STATUS_TOO_NEW, STATUS_TOO_OLD,
  STATUS_ALIEN, STATUS_UNVERIFIABLE,
  _isFiniteNum, _verdict,
} = M;

// 与真实 shipped snapshot.json 对齐的最小合法头。
function goodHeader(over = {}) {
  return { format: SUPPORTED_FORMAT, formatVersion: MAX_FORMAT_VERSION, ...over };
}

// ── 档 5：supported（唯一 ok:true）─────────────────────────────────────────────

test('认识的格式 + 版本在理解区间 → supported + ok:true', () => {
  const r = checkSnapshotFormatCompat(goodHeader());
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.format, SUPPORTED_FORMAT);
  assert.strictEqual(r.formatVersion, MAX_FORMAT_VERSION);
  assert.strictEqual(r.understoodMin, MIN_FORMAT_VERSION);
  assert.strictEqual(r.understoodMax, MAX_FORMAT_VERSION);
});

test('真实 shipped 头形状（含额外字段）也 supported', () => {
  const r = checkSnapshotFormatCompat({
    format: 'khy-source-snapshot', formatVersion: 1, layout: 'git-archive',
    sha256: 'deadbeef', fileCount: 5865, version: '0.1.190', gitCommit: 'abc',
    crypto: { algo: 'aes-256-gcm' },
  });
  assert.strictEqual(r.status, STATUS_SUPPORTED);
  assert.strictEqual(r.ok, true);
});

// ── 档 3：too-new（离机断桥核心：旧 khy 遇未来快照）──────────────────────────────

test('formatVersion 高于本机最新 → too-new + ok:false（先升级 khy）', () => {
  const r = checkSnapshotFormatCompat(goodHeader({ formatVersion: MAX_FORMAT_VERSION + 1 }));
  assert.strictEqual(r.status, STATUS_TOO_NEW);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /升级 khy/);
});

test('formatVersion 远高于本机 → too-new', () => {
  const r = checkSnapshotFormatCompat(goodHeader({ formatVersion: 99 }));
  assert.strictEqual(r.status, STATUS_TOO_NEW);
  assert.strictEqual(r.ok, false);
});

// ── 档 4：too-old ─────────────────────────────────────────────────────────────

test('formatVersion 低于本机最早 → too-old + ok:false', () => {
  const r = checkSnapshotFormatCompat(goodHeader({ formatVersion: MIN_FORMAT_VERSION - 1 }));
  assert.strictEqual(r.status, STATUS_TOO_OLD);
  assert.strictEqual(r.ok, false);
});

// ── 档 2：alien（不是 khy 源码快照）────────────────────────────────────────────

test('format 不是 khy 源码快照 → alien + ok:false', () => {
  const r = checkSnapshotFormatCompat({ format: 'some-other-tarball', formatVersion: 1 });
  assert.strictEqual(r.status, STATUS_ALIEN);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不是本机认识的还原对象/);
});

test('alien 优先于版本判定（陌生 format 即便版本合法也不解密）', () => {
  const r = checkSnapshotFormatCompat({ format: 'evil', formatVersion: MAX_FORMAT_VERSION });
  assert.strictEqual(r.status, STATUS_ALIEN);
  assert.strictEqual(r.ok, false);
});

// ── 档 1：unverifiable（证据不足，保守）────────────────────────────────────────

test('null 头 → unverifiable + ok:false，绝不抛', () => {
  const r = checkSnapshotFormatCompat(null);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('非对象头（字符串 / 数字 / undefined）→ unverifiable，绝不抛', () => {
  for (const bad of ['x', 42, undefined, [], true]) {
    const r = checkSnapshotFormatCompat(bad);
    assert.strictEqual(r.ok, false, `输入 ${JSON.stringify(bad)} 不应 ok`);
  }
});

test('缺 format 字段 → unverifiable', () => {
  const r = checkSnapshotFormatCompat({ formatVersion: 1 });
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('format 非字符串 → unverifiable', () => {
  const r = checkSnapshotFormatCompat({ format: 123, formatVersion: 1 });
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('缺 formatVersion → unverifiable', () => {
  const r = checkSnapshotFormatCompat({ format: SUPPORTED_FORMAT });
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('formatVersion 非有限数（NaN / Infinity / 字符串）→ unverifiable', () => {
  for (const bad of [NaN, Infinity, -Infinity, '1', null]) {
    const r = checkSnapshotFormatCompat({ format: SUPPORTED_FORMAT, formatVersion: bad });
    assert.strictEqual(r.ok, false, `formatVersion=${String(bad)} 不应 ok`);
  }
});

// ── 契约恒等式 ────────────────────────────────────────────────────────────────

test('ok===true 当且仅当 status==="supported"', () => {
  const cases = [
    goodHeader(),                                           // supported
    goodHeader({ formatVersion: MAX_FORMAT_VERSION + 1 }),  // too-new
    goodHeader({ formatVersion: MIN_FORMAT_VERSION - 1 }),  // too-old
    { format: 'alien', formatVersion: 1 },                  // alien
    null,                                                   // unverifiable
  ];
  for (const h of cases) {
    const r = checkSnapshotFormatCompat(h);
    assert.strictEqual(r.ok, r.status === STATUS_SUPPORTED,
      `ok 与 supported 不一致：${JSON.stringify(r)}`);
  }
});

test('understoodMin/Max 始终回显本机常量', () => {
  const r = checkSnapshotFormatCompat(null);
  assert.strictEqual(r.understoodMin, MIN_FORMAT_VERSION);
  assert.strictEqual(r.understoodMax, MAX_FORMAT_VERSION);
  assert.ok(MIN_FORMAT_VERSION <= MAX_FORMAT_VERSION, 'MIN 不得大于 MAX');
});

test('_isFiniteNum 只认有限数', () => {
  assert.strictEqual(_isFiniteNum(1), true);
  assert.strictEqual(_isFiniteNum(0), true);
  assert.strictEqual(_isFiniteNum(NaN), false);
  assert.strictEqual(_isFiniteNum(Infinity), false);
  assert.strictEqual(_isFiniteNum('1'), false);
});

test('_verdict 唯一放行出口：非 supported 一律 ok:false', () => {
  assert.strictEqual(_verdict(STATUS_SUPPORTED, SUPPORTED_FORMAT, 1, 'x').ok, true);
  assert.strictEqual(_verdict(STATUS_TOO_NEW, SUPPORTED_FORMAT, 2, 'x').ok, false);
  assert.strictEqual(_verdict(STATUS_ALIEN, 'y', 1, 'x').ok, false);
});
