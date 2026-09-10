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
const oc = require('../../../src/services/gateway/adapters/opencodeInvocation');

describe('Opencode Invocation', () => {
  test('isEnabled 默认开;仅显式 0/false/off/no 关', () => {
      expect(oc.isEnabled({})).toBe(true);
      expect(oc.isEnabled({ KHY_OPENCODE: '1' })).toBe(true);
      expect(oc.isEnabled({ KHY_OPENCODE: 'true' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(oc.isEnabled({ KHY_OPENCODE: v })).toBe(false);
      }
  });

  test('looksLikeProviderModel:仅 provider/model 形式为真', () => {
      expect(oc.looksLikeProviderModel('anthropic/claude-sonnet-4-6')).toBe(true);
      expect(oc.looksLikeProviderModel('openai/gpt-5')).toBe(true);
      expect(oc.looksLikeProviderModel('  openai/gpt-5  ')).toBe(true);
      // 裸模型 / 路径式 / 斜杠贴边 / 非串 / 空 → 假
      expect(oc.looksLikeProviderModel('gpt-5')).toBe(false);
      expect(oc.looksLikeProviderModel('a/b/c')).toBe(false);
      expect(oc.looksLikeProviderModel('/model')).toBe(false);
      expect(oc.looksLikeProviderModel('provider/')).toBe(false);
      expect(oc.looksLikeProviderModel('')).toBe(false);
      expect(oc.looksLikeProviderModel(null)).toBe(false);
      expect(oc.looksLikeProviderModel(42)).toBe(false);
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
      expect(() => oc.buildRunArgs(123).not.toThrow());
      expect(() => oc.applyModelArg('not-array', null).not.toThrow());
      expect(() => oc.isEnabled().not.toThrow());
  });

});
