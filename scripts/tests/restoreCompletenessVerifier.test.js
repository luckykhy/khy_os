'use strict';

/**
 * restoreCompletenessVerifier.test.js — 还原「解包完整性」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreCompletenessVerifier.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：
 *   · 对账优先保守：证据不足 → unverifiable，绝不谎报 complete；
 *   · 实际 < 期望 → incomplete（断桥要抓的静默少解假绿）；
 *   · sha256 / tar 前置失败 → corrupt（完整性无从谈起）；
 *   · ok===true 当且仅当 status==='complete'；
 *   · 任何畸形输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const V = require('../lib/restoreCompletenessVerifier');
const {
  verifyExtractionCompleteness,
  STATUS_COMPLETE, STATUS_INCOMPLETE, STATUS_OVER_EXTRACTED,
  STATUS_CORRUPT, STATUS_UNVERIFIABLE,
  _isFiniteNum, _verdict,
} = V;

// ── 档 5：complete（唯一 ok:true）─────────────────────────────────────────────

test('数量吻合 + 前置通过 → complete + ok:true', () => {
  const r = verifyExtractionCompleteness({ expectedFileCount: 1200, actualFileCount: 1200 });
  assert.strictEqual(r.status, STATUS_COMPLETE);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.missing, 0);
  assert.strictEqual(r.extra, 0);
});

test('显式 sha256Verified/tarExitZero 为 true 也 complete', () => {
  const r = verifyExtractionCompleteness({
    expectedFileCount: 10, actualFileCount: 10, sha256Verified: true, tarExitZero: true,
  });
  assert.strictEqual(r.status, STATUS_COMPLETE);
  assert.strictEqual(r.ok, true);
});

// ── 档 3：incomplete（断桥核心回归）───────────────────────────────────────────

test('实际 < 期望 → incomplete + ok:false + missing 精确', () => {
  const r = verifyExtractionCompleteness({ expectedFileCount: 1200, actualFileCount: 1187 });
  assert.strictEqual(r.status, STATUS_INCOMPLETE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.missing, 13);
  assert.strictEqual(r.extra, 0);
  assert.match(r.reason, /静默少解|缺 13/);
});

test('少解哪怕一个文件也判 incomplete（绝不四舍五入成 complete）', () => {
  const r = verifyExtractionCompleteness({ expectedFileCount: 1000, actualFileCount: 999 });
  assert.strictEqual(r.status, STATUS_INCOMPLETE);
  assert.strictEqual(r.ok, false);
});

// ── 档 4：over-extracted ──────────────────────────────────────────────────────

test('实际 > 期望 → over-extracted + ok:false + extra 精确', () => {
  const r = verifyExtractionCompleteness({ expectedFileCount: 100, actualFileCount: 105 });
  assert.strictEqual(r.status, STATUS_OVER_EXTRACTED);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.extra, 5);
  assert.strictEqual(r.missing, 0);
});

// ── 档 2：corrupt（前置失败优先于数量吻合）────────────────────────────────────

test('sha256Verified===false → corrupt（即便数量吻合）', () => {
  const r = verifyExtractionCompleteness({
    expectedFileCount: 100, actualFileCount: 100, sha256Verified: false,
  });
  assert.strictEqual(r.status, STATUS_CORRUPT);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /sha256/);
});

test('tarExitZero===false → corrupt', () => {
  const r = verifyExtractionCompleteness({
    expectedFileCount: 100, actualFileCount: 100, tarExitZero: false,
  });
  assert.strictEqual(r.status, STATUS_CORRUPT);
  assert.match(r.reason, /tar/);
});

test('corrupt 优先于 incomplete（前置失败最先命中）', () => {
  const r = verifyExtractionCompleteness({
    expectedFileCount: 100, actualFileCount: 50, sha256Verified: false,
  });
  assert.strictEqual(r.status, STATUS_CORRUPT); // 不是 incomplete
});

// ── 档 1：unverifiable（保守，绝不谎报 complete）───────────────────────────────

test('期望缺失 → unverifiable', () => {
  const r = verifyExtractionCompleteness({ actualFileCount: 100 });
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('期望为 0 / 负 → unverifiable（不可对账）', () => {
  assert.strictEqual(verifyExtractionCompleteness({ expectedFileCount: 0, actualFileCount: 0 }).status, STATUS_UNVERIFIABLE);
  assert.strictEqual(verifyExtractionCompleteness({ expectedFileCount: -5, actualFileCount: 10 }).status, STATUS_UNVERIFIABLE);
});

test('实际非法（负 / NaN / 非数字）→ unverifiable', () => {
  assert.strictEqual(verifyExtractionCompleteness({ expectedFileCount: 100, actualFileCount: -1 }).status, STATUS_UNVERIFIABLE);
  assert.strictEqual(verifyExtractionCompleteness({ expectedFileCount: 100, actualFileCount: NaN }).status, STATUS_UNVERIFIABLE);
  assert.strictEqual(verifyExtractionCompleteness({ expectedFileCount: 100, actualFileCount: '100' }).status, STATUS_UNVERIFIABLE);
});

test('实际为 0 而期望 > 0 → incomplete（0 是合法非负，不是 unverifiable）', () => {
  const r = verifyExtractionCompleteness({ expectedFileCount: 100, actualFileCount: 0 });
  assert.strictEqual(r.status, STATUS_INCOMPLETE);
  assert.strictEqual(r.missing, 100);
});

test('Infinity 期望 → unverifiable（非有限）', () => {
  assert.strictEqual(verifyExtractionCompleteness({ expectedFileCount: Infinity, actualFileCount: 10 }).status, STATUS_UNVERIFIABLE);
});

// ── 绝不抛：任何畸形输入 ──────────────────────────────────────────────────────

test('非对象 / null / 数组 → unverifiable，绝不抛', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const r = verifyExtractionCompleteness(bad);
    assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
    assert.strictEqual(r.ok, false);
  }
});

// ── 内部件锁定 ────────────────────────────────────────────────────────────────

test('_isFiniteNum 只认有限数', () => {
  assert.strictEqual(_isFiniteNum(0), true);
  assert.strictEqual(_isFiniteNum(1.5), true);
  assert.strictEqual(_isFiniteNum(NaN), false);
  assert.strictEqual(_isFiniteNum(Infinity), false);
  assert.strictEqual(_isFiniteNum('3'), false);
  assert.strictEqual(_isFiniteNum(null), false);
});

test('_verdict：ok 只在 complete 时为真', () => {
  assert.strictEqual(_verdict(STATUS_COMPLETE, 5, 5, 'x').ok, true);
  assert.strictEqual(_verdict(STATUS_INCOMPLETE, 5, 3, 'x').ok, false);
  assert.strictEqual(_verdict(STATUS_UNVERIFIABLE, null, null, 'x').ok, false);
});

test('_verdict：非法 expected/actual 归一为 null，diff 不算', () => {
  const r = _verdict(STATUS_UNVERIFIABLE, NaN, undefined, 'x');
  assert.strictEqual(r.expected, null);
  assert.strictEqual(r.actual, null);
  assert.strictEqual(r.missing, 0);
  assert.strictEqual(r.extra, 0);
});
