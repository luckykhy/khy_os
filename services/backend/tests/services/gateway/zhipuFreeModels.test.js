'use strict';
/**
 * zhipuFreeModels.test.js �?「智�?key 配好后自动加入免费模型」纯叶子契约锁死�?
 *
 *   - 免费模型清单/端点常量与文档一�?7 �?cogview/cogvideox 属图�?视频);
 *   - 门开(default)�?聊天 id 为对�?视觉(5 �?,augmentGlmPoolModels �?glm 池追加免费聊天模�?
 *   - 门关(0/false/off/no)�?全部逐字节回退(清单空、augment 原样返回入参);
 *   - �?glm poolKey 绝不受影�?绝不�?null / 非数�?/ junk env)�?
 */
const {
  ZHIPU_ENDPOINT,
  ZHIPU_FREE_MODELS,
  zhipuFreeModelsEnabled,
  isGlmPoolKey,
  listZhipuFreeModels,
  zhipuFreeChatModelIds,
  zhipuFreeModelIds,
  augmentGlmPoolModels,
} = require('../../../src/services/gateway/zhipuFreeModels');

describe('Zhipu Free Models', () => {
  test('constants: 7 free models, correct endpoint, cogview/cogvideox tagged image/video', () => {
      expect(ZHIPU_ENDPOINT).toBe('https://open.bigmodel.cn/api/paas/v4');
      expect(ZHIPU_FREE_MODELS.length).toBe(7);
      const ids = ZHIPU_FREE_MODELS.map((m) => m.id);
      assert.deepStrictEqual(ids, [
        'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
        'glm-4-flash-250414', 'glm-4v-flash', 'cogview-3-flash', 'cogvideox-flash',
      ]);
      expect(ZHIPU_FREE_MODELS.find((m) => m.id === 'cogview-3-flash').modality).toBe('image');
      expect(ZHIPU_FREE_MODELS.find((m) => m.id === 'cogvideox-flash').modality).toBe('video');
      // glm-4.5-flash 已下�?不得出现
      expect(!ids).toContain('glm-4.5-flash');
  });

  test('gate default-on (unset / 1 / on)', () => {
      expect(zhipuFreeModelsEnabled({})).toBe(true);
      expect(zhipuFreeModelsEnabled({ KHY_ZHIPU_FREE_MODELS: '1' })).toBe(true);
      expect(zhipuFreeModelsEnabled({ KHY_ZHIPU_FREE_MODELS: 'on' })).toBe(true);
  });

  test('chat ids exclude image/video (5 chat+vision ids)', () => {
      const chat = zhipuFreeChatModelIds({});
      assert.deepStrictEqual(chat, [
        'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
        'glm-4-flash-250414', 'glm-4v-flash',
      ]);
      expect(!chat).toContain('cogview-3-flash');
      expect(!chat).toContain('cogvideox-flash');
      expect(zhipuFreeModelIds({}).length).toBe(7); // 全量�?image/video
  });

  test('isGlmPoolKey tolerant of case/space', () => {
      expect(isGlmPoolKey('glm')).toBe(true);
      expect(isGlmPoolKey(' GLM ')).toBe(true);
      expect(isGlmPoolKey('deepseek')).toBe(false);
      expect(isGlmPoolKey('')).toBe(false);
      expect(isGlmPoolKey(null)).toBe(false);
  });

  test('augment: glm pool gets free chat models appended (existing kept, deduped)', () => {
      const out = augmentGlmPoolModels('glm', ['glm-4.7-flash'], {});
      // existing 'glm-4.7-flash' 保留在前且不重复,其余 4 个追�?
      expect(out[0]).toBe('glm-4.7-flash');
      expect(out.filter((m) => m === 'glm-4.7-flash').length).toBe(1);
      for (const id of ['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4-flash-250414', 'glm-4v-flash']) {
        expect(out.includes(id)).toBeTruthy();
      }
      expect(out.length).toBe(5);
      // 不含 image/video
      expect(!out).toContain('cogview-3-flash');
  });

  test('augment: empty static (占位/离线) �?full 5 free chat models', () => {
      expect(augmentGlmPoolModels('glm').toEqual([], {}), [
        'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
        'glm-4-flash-250414', 'glm-4v-flash',
      ]);
  });

  test('augment: object-shaped existing {id} deduped case-insensitively', () => {
      const out = augmentGlmPoolModels('glm', [{ id: 'GLM-4.7-Flash' }], {});
      // 大小写不敏感去重:不重复追�?glm-4.7-flash
      expect(out.filter((m) => (typeof m === 'string' ? m : m.id).toLowerCase() === 'glm-4.7-flash').length).toBe(1);
  });

  test('augment: non-glm poolKey untouched (strict superset only for glm)', () => {
      expect(augmentGlmPoolModels('deepseek').toEqual(['deepseek-chat'], {}), ['deepseek-chat']);
      expect(augmentGlmPoolModels('openai').toEqual([], {}), []);
  });

  test('gate off (0/false/off/no) �?byte-revert everywhere', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        const env = { KHY_ZHIPU_FREE_MODELS: v };
        expect(zhipuFreeModelsEnabled(env)).toBe(false, v);
        expect(listZhipuFreeModels(env)).toEqual([], v);
        expect(zhipuFreeChatModelIds(env)).toEqual([], v);
        expect(zhipuFreeModelIds(env)).toEqual([], v);
        // augment 原样返回入参内容(byte-revert)
        expect(augmentGlmPoolModels('glm').toEqual(['x'], env), ['x'], v);
        expect(augmentGlmPoolModels('glm').toEqual([], env), [], v);
      }
  });

  test('never throws on junk input', () => {
      expect(() => augmentGlmPoolModels('glm', null, {}).not.toThrow());
      expect(() => augmentGlmPoolModels(null, undefined, null).not.toThrow());
      expect(() => listZhipuFreeModels(null).not.toThrow());
      expect(augmentGlmPoolModels('glm').toEqual(null, {}), [
        'glm-4.7-flash', 'glm-4.6v-flash', 'glm-4.1v-thinking-flash',
        'glm-4-flash-250414', 'glm-4v-flash',
      ]);
  });

  test('listZhipuFreeModels returns fresh copies (caller cannot corrupt frozen source)', () => {
      const a = listZhipuFreeModels({});
      a[0].id = 'mutated';
      expect(ZHIPU_FREE_MODELS[0].id).toBe('glm-4.7-flash');
  });

});

