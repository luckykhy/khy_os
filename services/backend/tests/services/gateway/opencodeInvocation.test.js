'use strict';

/**
 * opencodeInvocation.test.js — 纯叶子「指挥 opencode」调用参数契约(node:test,零 IO、确定性)。
 *
 * 验收要点:
 *  - 门控 isEnabled:未设/任意非关键字 → 开;0/false/off/no(含大小写/空白) → 关。
 *  - looksLikeProviderModel:仅单斜杠两侧非空的 provider/model 为真;裸模型/路径式/空 → 假。
 *  - buildRunArgs:基础 ['run','__PROMPT__'];format/session/continue/agent/model 按需拼接;
 *    非法 model 不注入。
 *  - applyModelArg:合法 model 追加 --model,不改入参;非法 → 原样浅拷贝。
 *  - fail-soft:坏输入不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const oc = require('../../../src/services/gateway/adapters/opencodeInvocation');

test('isEnabled 默认开;仅显式 0/false/off/no 关', () => {
  assert.equal(oc.isEnabled({}), true);
  assert.equal(oc.isEnabled({ KHY_OPENCODE: '1' }), true);
  assert.equal(oc.isEnabled({ KHY_OPENCODE: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(oc.isEnabled({ KHY_OPENCODE: v }), false, v);
  }
});

test('looksLikeProviderModel:仅 provider/model 形式为真', () => {
  assert.equal(oc.looksLikeProviderModel('anthropic/claude-sonnet-4-6'), true);
  assert.equal(oc.looksLikeProviderModel('openai/gpt-5'), true);
  assert.equal(oc.looksLikeProviderModel('  openai/gpt-5  '), true);
  // 裸模型 / 路径式 / 斜杠贴边 / 非串 / 空 → 假
  assert.equal(oc.looksLikeProviderModel('gpt-5'), false);
  assert.equal(oc.looksLikeProviderModel('a/b/c'), false);
  assert.equal(oc.looksLikeProviderModel('/model'), false);
  assert.equal(oc.looksLikeProviderModel('provider/'), false);
  assert.equal(oc.looksLikeProviderModel(''), false);
  assert.equal(oc.looksLikeProviderModel(null), false);
  assert.equal(oc.looksLikeProviderModel(42), false);
});

test('buildRunArgs:基础形态 = [run, __PROMPT__]', () => {
  assert.deepEqual(oc.buildRunArgs(), ['run', '__PROMPT__']);
  assert.deepEqual(oc.buildRunArgs({}), ['run', '__PROMPT__']);
  assert.deepEqual(oc.buildRunArgs(null), ['run', '__PROMPT__']);
});

test('buildRunArgs:按需拼接 format/continue/session/agent/model', () => {
  const args = oc.buildRunArgs({
    format: 'json',
    continueSession: true,
    sessionId: 'ses_abc',
    agent: 'build',
    model: 'anthropic/claude-sonnet-4-6',
  });
  assert.deepEqual(args, [
    'run', '__PROMPT__',
    '--format', 'json',
    '--continue',
    '--session', 'ses_abc',
    '--agent', 'build',
    '--model', 'anthropic/claude-sonnet-4-6',
  ]);
});

test('buildRunArgs:非法 model 不注入;default 格式省略 --format', () => {
  const args = oc.buildRunArgs({ model: 'gpt-5', format: 'default' });
  assert.deepEqual(args, ['run', '__PROMPT__']);
});

test('applyModelArg:合法追加、非法原样、不改入参', () => {
  const base = ['run', 'hello'];
  const out = oc.applyModelArg(base, 'openai/gpt-5');
  assert.deepEqual(out, ['run', 'hello', '--model', 'openai/gpt-5']);
  assert.deepEqual(base, ['run', 'hello'], '入参不被修改');

  assert.deepEqual(oc.applyModelArg(['run', 'hi'], 'gpt-5'), ['run', 'hi']);
  assert.deepEqual(oc.applyModelArg(undefined, 'openai/gpt-5'), ['--model', 'openai/gpt-5']);
});

test('fail-soft:坏输入不抛', () => {
  assert.doesNotThrow(() => oc.buildRunArgs(123));
  assert.doesNotThrow(() => oc.applyModelArg('not-array', null));
  assert.doesNotThrow(() => oc.isEnabled());
});
