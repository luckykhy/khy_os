'use strict';

/**
 * restoreProvenance.test.js — 还原「来源可溯性」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreProvenance.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：
 *   · 没有正面 clean 证据绝不谎称 clean；
 *   · 脏捕获（includesUncommitted/dirty）→ dirty（== 提交 X + 未提交增量，不等于干净提交）；
 *   · ok===true 当且仅当 status==='clean'；
 *   · 任何畸形输入绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const M = require('../lib/restoreProvenance');
const {
  assessRestoreProvenance,
  STATUS_CLEAN, STATUS_DIRTY, STATUS_INDETERMINATE,
  STATUS_NO_PROVENANCE, STATUS_UNVERIFIABLE,
  _verdict, _isNonEmptyStr,
} = M;

const SHA = '44a491fb07f33694939cb28a1771bb30f5b0f66b';

// ── 档 4：clean（唯一 ok:true）─────────────────────────────────────────────────

test('HEAD 归档 → clean + ok:true', () => {
  const r = assessRestoreProvenance({ gitCommit: SHA, captureMode: 'HEAD' });
  assert.strictEqual(r.status, STATUS_CLEAN);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shortCommit, SHA.slice(0, 12));
});

test('working-tree 且 includesUncommitted===false → clean', () => {
  const r = assessRestoreProvenance({
    gitCommit: SHA, captureMode: 'working-tree', includesUncommitted: false,
  });
  assert.strictEqual(r.status, STATUS_CLEAN);
  assert.strictEqual(r.ok, true);
});

// ── 档 3：dirty（离机断桥核心：真 shipped 快照就是这一档）──────────────────────

test('真实 shipped 头（脏 working-tree 捕获）→ dirty + ok:false', () => {
  const r = assessRestoreProvenance({
    format: 'khy-source-snapshot', formatVersion: 1,
    captureMode: 'working-tree', includesUncommitted: true, dirty: true,
    gitCommit: SHA, version: '0.1.190',
  });
  assert.strictEqual(r.status, STATUS_DIRTY);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.includesUncommitted, true);
  assert.match(r.reason, /未提交增量/);
  assert.match(r.reason, new RegExp(SHA.slice(0, 12)));
});

test('includesUncommitted:true 单独即判 dirty', () => {
  const r = assessRestoreProvenance({ gitCommit: SHA, includesUncommitted: true });
  assert.strictEqual(r.status, STATUS_DIRTY);
  assert.strictEqual(r.ok, false);
});

test('dirty:true 单独即判 dirty（即便 includesUncommitted 未记录）', () => {
  const r = assessRestoreProvenance({ gitCommit: SHA, dirty: true });
  assert.strictEqual(r.status, STATUS_DIRTY);
  assert.strictEqual(r.ok, false);
});

test('dirty 优先于 clean 证据（脏即便声称 includesUncommitted:false 的矛盾也走 dirty）', () => {
  // includesUncommitted:true 与 clean 证据不会同时正向命中；此处验证 dirty 判定在 clean 之前。
  const r = assessRestoreProvenance({ gitCommit: SHA, captureMode: 'HEAD', includesUncommitted: true });
  assert.strictEqual(r.status, STATUS_DIRTY);
  assert.strictEqual(r.ok, false);
});

// ── 档 5：indeterminate（有提交、非脏、但无正面 clean 证据）──────────────────────

test('working-tree 但 includesUncommitted 未记录 → indeterminate（保守不臆断 clean）', () => {
  const r = assessRestoreProvenance({ gitCommit: SHA, captureMode: 'working-tree' });
  assert.strictEqual(r.status, STATUS_INDETERMINATE);
  assert.strictEqual(r.ok, false);
});

test('只有 gitCommit、无 captureMode、无 dirty 标记 → indeterminate', () => {
  const r = assessRestoreProvenance({ gitCommit: SHA });
  assert.strictEqual(r.status, STATUS_INDETERMINATE);
  assert.strictEqual(r.ok, false);
});

// ── 档 2：no-provenance ────────────────────────────────────────────────────────

test('无 gitCommit → no-provenance + ok:false', () => {
  const r = assessRestoreProvenance({ captureMode: 'working-tree', includesUncommitted: false });
  assert.strictEqual(r.status, STATUS_NO_PROVENANCE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.gitCommit, null);
});

test('gitCommit 非字符串 / 空串 → no-provenance', () => {
  for (const bad of ['', 123, null, undefined, {}]) {
    const r = assessRestoreProvenance({ gitCommit: bad, captureMode: 'HEAD' });
    assert.strictEqual(r.status, STATUS_NO_PROVENANCE, `gitCommit=${JSON.stringify(bad)}`);
    assert.strictEqual(r.ok, false);
  }
});

// ── 档 1：unverifiable（证据不足，保守）────────────────────────────────────────

test('null 头 → unverifiable + ok:false，绝不抛', () => {
  const r = assessRestoreProvenance(null);
  assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  assert.strictEqual(r.ok, false);
});

test('非对象头（字符串 / 数字 / 数组 / 布尔）→ unverifiable，绝不抛', () => {
  for (const bad of ['x', 42, undefined, [], true]) {
    const r = assessRestoreProvenance(bad);
    assert.strictEqual(r.ok, false, `输入 ${JSON.stringify(bad)} 不应 ok`);
    assert.strictEqual(r.status, STATUS_UNVERIFIABLE);
  }
});

// ── 契约恒等式 ────────────────────────────────────────────────────────────────

test('ok===true 当且仅当 status==="clean"', () => {
  const cases = [
    { gitCommit: SHA, captureMode: 'HEAD' },                                   // clean
    { gitCommit: SHA, includesUncommitted: true },                            // dirty
    { gitCommit: SHA, captureMode: 'working-tree' },                          // indeterminate
    { captureMode: 'HEAD' },                                                   // no-provenance
    null,                                                                      // unverifiable
  ];
  for (const h of cases) {
    const r = assessRestoreProvenance(h);
    assert.strictEqual(r.ok, r.status === STATUS_CLEAN,
      `ok 与 clean 不一致：${JSON.stringify(r)}`);
  }
});

test('裁决始终回显规范化字段（shortCommit 取前 12 位 / 非法字段归 null）', () => {
  const r = assessRestoreProvenance({
    gitCommit: SHA, captureMode: 'working-tree', includesUncommitted: 'yes' /* 非布尔 */, version: 42 /* 非串 */,
  });
  assert.strictEqual(r.shortCommit, SHA.slice(0, 12));
  assert.strictEqual(r.includesUncommitted, null, '非布尔 includesUncommitted 归 null');
  assert.strictEqual(r.version, null, '非串 version 归 null');
});

test('_isNonEmptyStr 只认非空字符串', () => {
  assert.strictEqual(_isNonEmptyStr('a'), true);
  assert.strictEqual(_isNonEmptyStr(''), false);
  assert.strictEqual(_isNonEmptyStr(null), false);
  assert.strictEqual(_isNonEmptyStr(1), false);
});

test('_verdict 唯一放行出口：非 clean 一律 ok:false', () => {
  assert.strictEqual(_verdict(STATUS_CLEAN, { gitCommit: SHA }, 'x').ok, true);
  assert.strictEqual(_verdict(STATUS_DIRTY, { gitCommit: SHA }, 'x').ok, false);
  assert.strictEqual(_verdict(STATUS_UNVERIFIABLE, null, 'x').ok, false);
});
