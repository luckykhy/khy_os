'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rr = require('../../src/services/rewindResume');

test('isEnabled: default-on, falsy-off', () => {
  assert.strictEqual(rr.isEnabled({}), true);
  assert.strictEqual(rr.isEnabled({ KHY_REWIND_PERSIST: 'true' }), true);
  assert.strictEqual(rr.isEnabled({ KHY_REWIND_PERSIST: 'off' }), false);
  assert.strictEqual(rr.isEnabled({ KHY_REWIND_PERSIST: '0' }), false);
  assert.strictEqual(rr.isEnabled({ KHY_REWIND_PERSIST: 'no' }), false);
  assert.strictEqual(rr.isEnabled({ KHY_REWIND_PERSIST: 'FALSE' }), false);
});

test('REWIND_PERSIST_FIELDS: frozen single source', () => {
  assert.deepStrictEqual(rr.REWIND_PERSIST_FIELDS, ['checkpointId']);
  assert.ok(Object.isFrozen(rr.REWIND_PERSIST_FIELDS));
});

test('pickRewindFields: only present fields, fail-soft', () => {
  assert.deepStrictEqual(rr.pickRewindFields({ role: 'user', content: 'x', checkpointId: 'ck_1' }), { checkpointId: 'ck_1' });
  assert.deepStrictEqual(rr.pickRewindFields({ role: 'user', content: 'x' }), {});
  assert.deepStrictEqual(rr.pickRewindFields({ checkpointId: '' }), {});
  assert.deepStrictEqual(rr.pickRewindFields({ checkpointId: null }), {});
  assert.deepStrictEqual(rr.pickRewindFields(null), {});
  assert.deepStrictEqual(rr.pickRewindFields(undefined), {});
});

test('carryRewindFields: copies checkpointId src->dst, returns dst', () => {
  const dst = { role: 'user', content: 'x' };
  const out = rr.carryRewindFields({ checkpointId: 'ck_9' }, dst, {});
  assert.strictEqual(out, dst);
  assert.strictEqual(dst.checkpointId, 'ck_9');
});

test('carryRewindFields: gate-off -> identity (byte-revert, no field added)', () => {
  const dst = { role: 'user', content: 'x' };
  rr.carryRewindFields({ checkpointId: 'ck_9' }, dst, { KHY_REWIND_PERSIST: 'off' });
  assert.ok(!('checkpointId' in dst));
});

test('carryRewindFields: missing src field -> dst unchanged', () => {
  const dst = { role: 'user', content: 'x' };
  rr.carryRewindFields({ role: 'user' }, dst, {});
  assert.ok(!('checkpointId' in dst));
});

test('carryRewindFields: non-object dst -> fail-soft returns dst as-is', () => {
  assert.strictEqual(rr.carryRewindFields({ checkpointId: 'a' }, null, {}), null);
  assert.strictEqual(rr.carryRewindFields({ checkpointId: 'a' }, undefined, {}), undefined);
});

test('buildRewindPlan: picks nth-from-end target with checkpoint', () => {
  // listUserTargets is newest-first
  const targets = [
    { rankFromEnd: 1, checkpointId: 'ck_c', content: 'third' },
    { rankFromEnd: 2, checkpointId: 'ck_b', content: 'second' },
    { rankFromEnd: 3, checkpointId: 'ck_a', content: 'first' },
  ];
  const p1 = rr.buildRewindPlan(targets, 1);
  assert.strictEqual(p1.ok, true);
  assert.strictEqual(p1.checkpointId, 'ck_c');
  assert.strictEqual(p1.content, 'third');
  assert.strictEqual(p1.hasCheckpoint, true);
  assert.strictEqual(p1.fallbackToLatest, false);

  const p2 = rr.buildRewindPlan(targets, 2);
  assert.strictEqual(p2.checkpointId, 'ck_b');
  assert.strictEqual(p2.rankFromEnd, 2);
});

test('buildRewindPlan: missing checkpointId -> honest fallbackToLatest', () => {
  const targets = [{ rankFromEnd: 1, content: 'no ck' }];
  const p = rr.buildRewindPlan(targets, 1);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.checkpointId, null);
  assert.strictEqual(p.hasCheckpoint, false);
  assert.strictEqual(p.fallbackToLatest, true);
});

test('buildRewindPlan: bad n / out of range -> ok:false', () => {
  const targets = [{ rankFromEnd: 1, checkpointId: 'a', content: 'x' }];
  assert.strictEqual(rr.buildRewindPlan(targets, 0).ok, false);
  assert.strictEqual(rr.buildRewindPlan(targets, -1).ok, false);
  assert.strictEqual(rr.buildRewindPlan(targets, 1.5).checkpointId, 'a'); // floor(1.5)=1 valid
  assert.strictEqual(rr.buildRewindPlan(targets, 'x').ok, false);
  assert.strictEqual(rr.buildRewindPlan(targets, 2).ok, false);
  assert.strictEqual(rr.buildRewindPlan([], 1).ok, false);
  assert.strictEqual(rr.buildRewindPlan(null, 1).ok, false);
});

test('buildRewindPlan: rankFromEnd falls back to idx when target lacks it', () => {
  const targets = [{ checkpointId: 'a', content: 'x' }];
  assert.strictEqual(rr.buildRewindPlan(targets, 1).rankFromEnd, 1);
});

test('describeRewindResume: stable self-describe', () => {
  const d = rr.describeRewindResume();
  assert.strictEqual(d.gate, 'KHY_REWIND_PERSIST');
  assert.deepStrictEqual(d.fields, ['checkpointId']);
  assert.ok(typeof d.summary === 'string' && d.summary.length > 0);
});
