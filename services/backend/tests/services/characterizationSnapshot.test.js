'use strict';

/**
 * characterizationSnapshot.test.js — 行为特征快照 / 差分纯模块单测。
 *
 * 守护(goal 2026-06-25):
 *   1. 非测试步骤(build/typecheck)在「存在未覆盖改动」时变化 → silentChanges。
 *   2. 测试步骤变化 → 归 coveredChanges(由回归门覆盖,不算静默)。
 *   3. 改动文件全被测试覆盖 → 任何步骤变化都不算静默。
 *   4. 指纹确定性;off / 畸形输入 fail-soft。
 *
 * 纯叶子,node:test(由 test:node 自动发现)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const c = require('../../src/services/characterizationSnapshot');

const ON = { KHY_FPF_CHARACTERIZATION: 'on' };
const snap = (steps) => ({ steps });

describe('characterizationSnapshot — 差分', () => {
  test('未覆盖改动 + 非测试步骤变化 → silentChanges', () => {
    const base = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'build', pass: true, summary: 'ok' },
      { name: 'test', pass: true, summary: '10 passed' },
    ]) });
    const cur = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'build', pass: true, summary: 'WARN: deprecated api used' }, // 输出变了,pass 没变
      { name: 'test', pass: true, summary: '10 passed' },
    ]) });
    const d = c.diffBehavior(base, cur, { coveredFiles: [] }, ON);
    assert.equal(d.silentChanges.length, 1);
    assert.equal(d.silentChanges[0].step, 'build');
    assert.equal(d.coveredChanges.length, 0);
  });

  test('测试步骤变化 → coveredChanges(非静默)', () => {
    const base = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'test', pass: true, summary: '10 passed' },
    ]) });
    const cur = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'test', pass: false, summary: '2 failed' },
    ]) });
    const d = c.diffBehavior(base, cur, { coveredFiles: [] }, ON);
    assert.equal(d.silentChanges.length, 0);
    assert.equal(d.coveredChanges.length, 1);
    assert.equal(d.coveredChanges[0].step, 'test');
  });

  test('改动全被覆盖 → 非测试步骤变化也不算静默', () => {
    const base = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'build', pass: true, summary: 'ok' },
    ]) });
    const cur = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'build', pass: false, summary: 'error' },
    ]) });
    const d = c.diffBehavior(base, cur, { coveredFiles: ['src/foo.js'] }, ON);
    assert.equal(d.silentChanges.length, 0);
    assert.equal(d.coveredChanges.length, 1);
  });

  test('无变化 → 空', () => {
    const base = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'build', pass: true, summary: 'ok' },
    ]) });
    const cur = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([
      { name: 'build', pass: true, summary: 'ok' },
    ]) });
    const d = c.diffBehavior(base, cur, { coveredFiles: [] }, ON);
    assert.equal(d.silentChanges.length, 0);
    assert.equal(d.coveredChanges.length, 0);
  });
});

describe('characterizationSnapshot — 指纹/开关/fail-soft', () => {
  test('指纹确定性', () => {
    const a = c._DEFAULTS._fp('hello world');
    const b = c._DEFAULTS._fp('hello world');
    const x = c._DEFAULTS._fp('hello worlD');
    assert.equal(a, b);
    assert.notEqual(a, x);
    assert.match(a, /^[0-9a-f]{8}$/);
  });

  test('off → 恒空', () => {
    const base = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([{ name: 'build', pass: true, summary: 'ok' }]) });
    const cur = c.captureBaseline({ changedFiles: ['src/foo.js'], verificationSnapshot: snap([{ name: 'build', pass: false, summary: 'x' }]) });
    const d = c.diffBehavior(base, cur, { coveredFiles: [] }, { KHY_FPF_CHARACTERIZATION: 'off' });
    assert.equal(d.silentChanges.length, 0);
  });

  test('畸形输入不抛', () => {
    assert.doesNotThrow(() => c.captureBaseline(null));
    assert.doesNotThrow(() => c.captureBaseline({ verificationSnapshot: { steps: 'nope' } }));
    assert.doesNotThrow(() => c.diffBehavior(null, null, {}, ON));
    assert.doesNotThrow(() => c.diffBehavior({}, {}, { coveredFiles: 7 }, ON));
  });
});
