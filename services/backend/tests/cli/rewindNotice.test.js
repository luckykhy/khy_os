'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  rewindDiffStatEnabled,
  buildRewindNotice,
  NOTICE_CODE,
  NOTICE_NO_CODE,
} = require('../../src/cli/rewindNotice');

test('rewindDiffStatEnabled — default ON, off-tokens disable', () => {
  assert.equal(rewindDiffStatEnabled(undefined), true);
  assert.equal(rewindDiffStatEnabled({}), true);
  assert.equal(rewindDiffStatEnabled({ KHY_REWIND_DIFFSTAT: '' }), true);
  assert.equal(rewindDiffStatEnabled({ KHY_REWIND_DIFFSTAT: 'yes' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(rewindDiffStatEnabled({ KHY_REWIND_DIFFSTAT: off }), false, off);
  }
});

test('gate ON + code restored + real stat → diff-stat notice', () => {
  const line = buildRewindNotice(
    { codeRestored: true, stats: { additions: 12, deletions: 4 } }, {});
  assert.equal(line, '已回溯对话与代码（+12/-4 行），可编辑后重发');
});

test('gate ON + code restored + {0,0} (tar-full/no-diff) → plain legacy notice', () => {
  const line = buildRewindNotice(
    { codeRestored: true, stats: { additions: 0, deletions: 0 } }, {});
  assert.equal(line, NOTICE_CODE);
});

test('gate ON + code restored + no stats → plain legacy notice', () => {
  assert.equal(buildRewindNotice({ codeRestored: true }, {}), NOTICE_CODE);
  assert.equal(buildRewindNotice({ codeRestored: true, stats: null }, {}), NOTICE_CODE);
});

test('code NOT restored → conversation-only legacy notice (stats ignored)', () => {
  assert.equal(buildRewindNotice({ codeRestored: false }, {}), NOTICE_NO_CODE);
  assert.equal(
    buildRewindNotice({ codeRestored: false, stats: { additions: 9, deletions: 9 } }, {}),
    NOTICE_NO_CODE);
});

test('gate OFF → byte-identical legacy notices (stats never shown)', () => {
  const env = { KHY_REWIND_DIFFSTAT: '0' };
  assert.equal(
    buildRewindNotice({ codeRestored: true, stats: { additions: 12, deletions: 4 } }, env),
    NOTICE_CODE);
  assert.equal(buildRewindNotice({ codeRestored: false }, env), NOTICE_NO_CODE);
});

test('fail-soft — bad / missing input never throws, degrades to no-code notice', () => {
  assert.equal(buildRewindNotice(undefined, {}), NOTICE_NO_CODE);
  assert.equal(buildRewindNotice(null, undefined), NOTICE_NO_CODE);
  assert.equal(buildRewindNotice({}, {}), NOTICE_NO_CODE);
});

test('stat coercion — NaN / negative counts floor to 0 → plain notice; floats floored', () => {
  assert.equal(
    buildRewindNotice({ codeRestored: true, stats: { additions: NaN, deletions: -3 } }, {}),
    NOTICE_CODE);
  assert.equal(
    buildRewindNotice({ codeRestored: true, stats: { additions: 5.9, deletions: 2.1 } }, {}),
    '已回溯对话与代码（+5/-2 行），可编辑后重发');
});
