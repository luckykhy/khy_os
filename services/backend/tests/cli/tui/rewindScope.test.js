'use strict';

// rewindScope 叶子契约测试(node:test)。
// 覆盖:门控开关、buildRewindScopeChoices(无 checkpointId→null·有→三选)、
// resolveRewindScope(both/conversation/code/未知·门控关→both·无 checkpoint→仅对话)、绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  rewindScopeEnabled,
  rewindSummarizeEnabled,
  buildRewindScopeChoices,
  resolveRewindScope,
} = require('../../../src/cli/tui/rewindScope');

const ON = { KHY_REWIND_SCOPE: '1' };
// Pin the summarize sub-gate OFF to assert the pre-summarize choice set (byte-fallback).
const ON_NOSUM = { KHY_REWIND_SCOPE: '1', KHY_REWIND_SUMMARIZE: 'off' };
const CK = { checkpointId: 'ck-1', rankFromEnd: 0 };
const NOCK = { rankFromEnd: 0 };

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(rewindScopeEnabled({}), true);
  assert.strictEqual(rewindScopeEnabled({ KHY_REWIND_SCOPE: '' }), true);
  assert.strictEqual(rewindScopeEnabled({ KHY_REWIND_SCOPE: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(rewindScopeEnabled({ KHY_REWIND_SCOPE: off }), false, `${JSON.stringify(off)} 应关`);
  }
});

test('摘要子门控默认开,{0,false,off,no,disable,disabled} 关', () => {
  assert.strictEqual(rewindSummarizeEnabled({}), true);
  assert.strictEqual(rewindSummarizeEnabled({ KHY_REWIND_SUMMARIZE: '' }), true);
  assert.strictEqual(rewindSummarizeEnabled({ KHY_REWIND_SUMMARIZE: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF', ' Disabled ']) {
    assert.strictEqual(rewindSummarizeEnabled({ KHY_REWIND_SUMMARIZE: off }), false, `${JSON.stringify(off)} 应关`);
  }
});

test('buildRewindScopeChoices:有 checkpointId + 摘要关 → 三选(both/conversation/code)', () => {
  const choices = buildRewindScopeChoices(CK, ON_NOSUM);
  assert.ok(Array.isArray(choices));
  assert.deepStrictEqual(choices.map((c) => c.value), ['both', 'conversation', 'code']);
  assert.strictEqual(choices[0].value, 'both'); // 默认焦点在 both
});

test('buildRewindScopeChoices:有 checkpointId + 摘要开(默认) → 四选(末尾 summarize)', () => {
  const choices = buildRewindScopeChoices(CK, ON);
  assert.deepStrictEqual(choices.map((c) => c.value), ['both', 'conversation', 'code', 'summarize']);
});

test('buildRewindScopeChoices:无 checkpointId + 摘要开 → [conversation, summarize]', () => {
  const choices = buildRewindScopeChoices(NOCK, ON);
  assert.deepStrictEqual(choices.map((c) => c.value), ['conversation', 'summarize']);
});

test('buildRewindScopeChoices:无 checkpointId + 摘要关 → null(逐字节回退今日无选择)', () => {
  assert.strictEqual(buildRewindScopeChoices(NOCK, ON_NOSUM), null);
});

test('buildRewindScopeChoices:门控关 → null(逐字节回退)', () => {
  assert.strictEqual(buildRewindScopeChoices(CK, { KHY_REWIND_SCOPE: 'off' }), null);
});

test('resolveRewindScope:summarize → 摘要化决策(与 checkpoint 无关)', () => {
  const want = { summarize: true, restoreConversation: false, restoreCode: false };
  assert.deepStrictEqual(resolveRewindScope('summarize', CK, ON), want);
  assert.deepStrictEqual(resolveRewindScope('summarize', NOCK, ON), want);
  assert.deepStrictEqual(resolveRewindScope(' Summarize ', CK, ON), want);
});

test('resolveRewindScope:门控关 → {true,true}(薄壳以 checkpointId 守卫代码侧)', () => {
  assert.deepStrictEqual(
    resolveRewindScope('conversation', CK, { KHY_REWIND_SCOPE: 'off' }),
    { restoreConversation: true, restoreCode: true },
  );
});

test('resolveRewindScope:无 checkpointId → 仅对话', () => {
  assert.deepStrictEqual(
    resolveRewindScope('both', NOCK, ON),
    { restoreConversation: true, restoreCode: false },
  );
});

test('resolveRewindScope:both/未知/缺省 → 对话+代码', () => {
  for (const s of ['both', 'BOTH', undefined, null, 'garbage']) {
    assert.deepStrictEqual(
      resolveRewindScope(s, CK, ON),
      { restoreConversation: true, restoreCode: true },
      `scope=${JSON.stringify(s)}`,
    );
  }
});

test('resolveRewindScope:conversation → 仅对话;code → 仅代码', () => {
  assert.deepStrictEqual(resolveRewindScope('conversation', CK, ON), { restoreConversation: true, restoreCode: false });
  assert.deepStrictEqual(resolveRewindScope('code', CK, ON), { restoreConversation: false, restoreCode: true });
  assert.deepStrictEqual(resolveRewindScope(' Code ', CK, ON), { restoreConversation: false, restoreCode: true });
});

test('坏输入不抛(null/undefined 目标与 env)', () => {
  assert.doesNotThrow(() => buildRewindScopeChoices(null, ON));
  assert.doesNotThrow(() => buildRewindScopeChoices(undefined, undefined));
  assert.doesNotThrow(() => resolveRewindScope(undefined, null, undefined));
  assert.doesNotThrow(() => resolveRewindScope('code', undefined, {}));
  // null 目标 → 仅对话(无 checkpoint)
  assert.deepStrictEqual(resolveRewindScope('code', null, ON), { restoreConversation: true, restoreCode: false });
});
