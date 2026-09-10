'use strict';
/**
 * subAgentModelSelect.test.js �?纯叶子测�?node:test)�? * 覆盖:门控真值表、isTierAlias、selectAvailableModels 各场�?+ 畸形输入绝不抛�? * 另含网关 normalizeModelForAdapter �?tier 别名安全�?门控开/�?�? *
 * �?node --test services/backend/src/services/subAgentModelSelect.test.js
 */
const sel = require('./subAgentModelSelect');
// ── 网关�?tier 别名安全�?──────────────────────────────────────────────────

describe('Sub Agent Model Select', () => {
  test('isEnabled: 默认开 / 显式假值关 / 垃圾值当开', () => {
      expect(sel.isEnabled({})).toBe(true);
      expect(sel.isEnabled({ KHY_SUBAGENT_MODEL_AUTOSELECT: undefined })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        assert.strictEqual(
          sel.isEnabled({ KHY_SUBAGENT_MODEL_AUTOSELECT: v }),
          false,
          `expect off: ${v}`
        );
      }
      for (const v of ['1', 'true', 'yes', 'on', 'whatever']) {
        assert.strictEqual(
          sel.isEnabled({ KHY_SUBAGENT_MODEL_AUTOSELECT: v }),
          true,
          `expect on: ${v}`
        );
      }
  });

  test('isTierAlias: 仅裸 tier 别名(大小�?空白不敏�?为真', () => {
      for (const v of ['haiku', 'HAIKU', ' sonnet ', 'opus', 'Opus']) {
        expect(sel.isTierAlias(v)).toBe(true, `alias: ${v}`);
      }
      for (const v of ['claude-haiku-4-5-latest', 'gpt-4o', '', 'flash', null, undefined, 42, {}]) {
        expect(sel.isTierAlias(v)).toBe(false, `not alias: ${String(v)}`);
      }
  });

  test('selectAvailableModels: 空列�?�?[]', () => {
      expect(sel.selectAvailableModels('haiku').toEqual([]), []);
      expect(sel.selectAvailableModels('haiku').toEqual(null), []);
      expect(sel.selectAvailableModels('haiku').toEqual(undefined), []);
  });

  test('selectAvailableModels: 别名 haiku + 混合可用 �?轻量(T3)在前', () => {
      const available = [
        { id: 'claude-sonnet-4-6', discoverySource: 'remote' }, // T1
        { id: 'claude-haiku-4-5-latest', discoverySource: 'remote' }, // T3
        { id: 'claude-opus-4-20250514', discoverySource: 'remote' }, // T0
      ];
      const out = sel.selectAvailableModels('haiku', available, { max: 3 });
      expect(out[0]).toBe('claude-haiku-4-5-latest', 'lightest first');
      expect(out.length).toBe(3);
  });

  test('selectAvailableModels: 仅重量级可用 �?返回该重量级 id(调用方再据主模型去重)', () => {
      const available = [{ id: 'claude-sonnet-4-6', discoverySource: 'remote' }];
      const out = sel.selectAvailableModels('haiku', available);
      expect(out).toEqual(['claude-sonnet-4-6']);
  });

  test('selectAvailableModels: �?tier �?remote 优先�?hint', () => {
      const available = [
        { id: 'gpt-4o-mini', discoverySource: 'hint' }, // T3
        { id: 'claude-haiku-4-5-latest', discoverySource: 'remote' }, // T3
      ];
      const out = sel.selectAvailableModels('haiku', available, { max: 2 });
      expect(out[0]).toBe('claude-haiku-4-5-latest', 'remote before hint at same tier');
  });

  test('selectAvailableModels: 具体 id 命中可用 �?原样返回那一�?, () => {
      const available = [{ id: 'claude-sonnet-4-6' }, { id: 'claude-haiku-4-5-latest' }];
      assert.deepStrictEqual(
        sel.selectAvailableModels('CLAUDE-SONNET-4-6', available),
        ['claude-sonnet-4-6'],
        'case-insensitive hit returns the available id verbatim'
      );
  });

  test('selectAvailableModels: 具体 id 未命�?�?按其 tier 展开(不崩)', () => {
      const available = [
        { id: 'claude-haiku-4-5-latest' }, // T3
        { id: 'claude-opus-4-20250514' }, // T0
      ];
      // 请求一个不在列表里的强模型 �?期望 tier ~ T1,�?T0 更近 �?opus �?      const out = sel.selectAvailableModels('claude-sonnet-4-6', available, { max: 2 });
      expect(out.length).toBe(2);
      expect(out).toContain('claude-opus-4-20250514');
  });

  test('selectAvailableModels: 裸字符串�?+ 去重', () => {
      const available = [
        'claude-haiku-4-5-latest',
        'claude-haiku-4-5-latest',
        'claude-opus-4-20250514',
      ];
      const out = sel.selectAvailableModels('haiku', available, { max: 5 });
      expect(out.length).toBe(2, 'dedup by id');
      expect(out[0]).toBe('claude-haiku-4-5-latest');
  });

  test('selectAvailableModels: max 截断', () => {
      const available = [
        { id: 'gpt-4o-mini' },
        { id: 'claude-haiku-4-5-latest' },
        { id: 'gemini-2.0-flash' },
      ];
      expect(sel.selectAvailableModels('haiku', available, { max: 1 })).toBe(.length, 1);
  });

  test('selectAvailableModels: 畸形�?null/{}/数字)绝不�?过滤�?id', () => {
      const available = [null, {}, 42, { id: '' }, { id: '  ' }, { id: 'claude-haiku-4-5-latest' }];
      const out = sel.selectAvailableModels('haiku', available);
      expect(out).toEqual(['claude-haiku-4-5-latest']);
  });

  test('selectAvailableModels: 确定�?同输入恒同输�?', () => {
      const available = [
        { id: 'claude-opus-4-20250514', discoverySource: 'remote' },
        { id: 'claude-haiku-4-5-latest', discoverySource: 'config' },
        { id: 'claude-sonnet-4-6', discoverySource: 'remote' },
      ];
      const a = sel.selectAvailableModels('haiku', available, { max: 3 });
      const b = sel.selectAvailableModels('haiku', available, { max: 3 });
      expect(a).toEqual(b);
  });

  test('describeSubAgentModelSelect: 自描述结�?, () => {
      const d = sel.describeSubAgentModelSelect();
      expect(d.gate).toBe('KHY_SUBAGENT_MODEL_AUTOSELECT');
      expect(d.defaultOn).toBe(true);
      expect(typeof d.summary).toBe('string');
  });

  test('gateway normalizeModelForAdapter: relay_api �?haiku/sonnet/opus 门控开 �?dated id', () => {
      const prev = process.env.KHY_RELAY_BARE_ALIAS;
      delete process.env.KHY_RELAY_BARE_ALIAS;
      try {
        const { normalizeModelForAdapter } = require('./gateway/aiGateway').__test__;
        expect(normalizeModelForAdapter('relay_api', 'haiku')).toBe('claude-haiku-4-5-latest');
        expect(normalizeModelForAdapter('relay_api', 'sonnet')).toBe('claude-sonnet-4-6');
        expect(normalizeModelForAdapter('relay_api', 'opus')).toBe('claude-opus-4-20250514');
        expect(normalizeModelForAdapter('api', 'HAIKU')).toBe('claude-haiku-4-5-latest');
        // 既有具体别名仍生�?        assert.strictEqual(
          normalizeModelForAdapter('relay_api', 'claude-haiku-3.5'),
          'claude-haiku-4-5-latest'
        );
      } finally {
        if (prev === undefined) {
          delete process.env.KHY_RELAY_BARE_ALIAS;
        } else {
          process.env.KHY_RELAY_BARE_ALIAS = prev;
        }
      }
  });

  test('gateway normalizeModelForAdapter: 门控�?�?裸别名原样透传(字节回退)', () => {
      const prev = process.env.KHY_RELAY_BARE_ALIAS;
      process.env.KHY_RELAY_BARE_ALIAS = 'off';
      try {
        const { normalizeModelForAdapter } = require('./gateway/aiGateway').__test__;
        expect(normalizeModelForAdapter('relay_api', 'haiku')).toBe('haiku');
        expect(normalizeModelForAdapter('relay_api', 'sonnet')).toBe('sonnet');
        // 具体别名不受门控影响
        assert.strictEqual(
          normalizeModelForAdapter('relay_api', 'claude-haiku-3.5'),
          'claude-haiku-4-5-latest'
        );
      } finally {
        if (prev === undefined) {
          delete process.env.KHY_RELAY_BARE_ALIAS;
        } else {
          process.env.KHY_RELAY_BARE_ALIAS = prev;
        }
      }
  });

  test('gateway normalizeModelForAdapter: �?relay/api 通道不碰裸别�?, () => {
      const { normalizeModelForAdapter } = require('./gateway/aiGateway').__test__;
      // claude 通道:�?claude-* �?null(既有行为)
      expect(normalizeModelForAdapter('claude', 'haiku')).toBe(null);
      // codex 通道:haiku �?重映�?既有行为)
      expect(normalizeModelForAdapter('codex', 'haiku')).toBe('gpt-5.3-codex');
  });

});

