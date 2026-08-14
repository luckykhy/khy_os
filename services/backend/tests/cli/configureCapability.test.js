'use strict';

/**
 * Configure tool tests (node:test).
 *
 * Drives the model-callable "Configure" tool with an injected writeEnvPatch
 * (context.writeEnvPatch) so no real .env is touched. Verifies: list is
 * read-only, on/off resolve a friendly name to its KHY_* key and persist the
 * right value, raw KHY_* keys and raw `set` values pass through, and unknown
 * capabilities fail soft with guidance — never an instruction to edit a file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tool = require('../../src/tools/configureCapability');

function contentOf(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (typeof res.content === 'string') return res.content;
  if (Array.isArray(res.content)) return res.content.map((c) => (c && c.text) || '').join('');
  return String(res.content || '');
}

function capturingContext() {
  const calls = [];
  return {
    calls,
    ctx: { writeEnvPatch: (envMap, unsetKeys) => { calls.push({ envMap, unsetKeys }); return '/tmp/test/.env'; } },
  };
}

test('isReadOnly: list/get is read-only; toggle is not', () => {
  assert.equal(tool.isReadOnly({ action: 'list' }), true);
  assert.equal(tool.isReadOnly({}), true);
  assert.equal(tool.isReadOnly({ capability: 'change-watch', state: 'off' }), false);
});

test('action=list → enumerates capabilities, writes nothing', async () => {
  const { calls, ctx } = capturingContext();
  const res = await tool.execute({ action: 'list' }, ctx);
  const text = contentOf(res);
  assert.match(text, /change-watch/);
  assert.match(text, /KHY_CHANGE_WATCH/);
  assert.equal(calls.length, 0);
});

test('off by friendly name → persists KHY_CHANGE_WATCH=off', async () => {
  const { calls, ctx } = capturingContext();
  const res = await tool.execute({ action: 'off', capability: '改动监视' }, ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].envMap, { KHY_CHANGE_WATCH: 'off' });
  assert.match(contentOf(res), /已关闭/);
  assert.match(contentOf(res), /持久化/);
});

test('on by id → persists KHY_RTK_MODE=true', async () => {
  const { calls, ctx } = capturingContext();
  await tool.execute({ capability: 'rtk', state: 'on' }, ctx);
  assert.deepEqual(calls[0].envMap, { KHY_RTK_MODE: 'true' });
});

test('raw KHY_* key toggle works even when not in the registry', async () => {
  const { calls, ctx } = capturingContext();
  await tool.execute({ action: 'on', capability: 'KHY_EXPERIMENTAL_X' }, ctx);
  assert.deepEqual(calls[0].envMap, { KHY_EXPERIMENTAL_X: 'true' });
});

test('action=set with raw value passes the exact value through', async () => {
  const { calls, ctx } = capturingContext();
  await tool.execute({ action: 'set', capability: 'KHY_SOME_LIMIT', value: '42' }, ctx);
  assert.deepEqual(calls[0].envMap, { KHY_SOME_LIMIT: '42' });
});

test('unknown capability → soft guidance, no write, never "edit a file"', async () => {
  const { calls, ctx } = capturingContext();
  const res = await tool.execute({ action: 'on', capability: '不存在的能力xyz' }, ctx);
  assert.equal(calls.length, 0);
  const text = contentOf(res);
  assert.match(text, /未识别/);
  assert.doesNotMatch(text, /编辑文件|去文件里改|手动修改/);
});

test('missing state on a known capability → asks for state, no write', async () => {
  const { calls, ctx } = capturingContext();
  const res = await tool.execute({ capability: 'change-watch' }, ctx);
  assert.equal(calls.length, 0);
  assert.match(contentOf(res), /state/);
});
