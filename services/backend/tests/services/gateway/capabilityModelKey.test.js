'use strict';
/**
 * capabilityModelKey.test.js — 能力缓存键的规范化不变量。
 *
 * 这些断言守的是一个真实事故:主动探测按路由 id(`api:agnes:agnes-2.5-flash`)写库、
 * 被动学习按裸模型名(`agnes-2.5-flash`)写库,教学门与剥离门各读一条键,于是同一模型
 * 留下两条相反裁决,模型在同一轮里既收到完整原生 tools、又收到「你没有原生工具,请用
 * <tool_call> 文本语法」—— 它于是只用散文说「我先用 WebSearch 搜索」而一个工具都不调。
 */
const { capabilityModelKey } = require('../../../src/services/gateway/capabilityModelKey');
describe('capabilityModelKey — 折叠成裸模型名', () => {
});
describe('漂移断言 — 与 apiAdapter.parseProviderModel 同源', () => {
  // 剥前缀的约定在仓库里有三份正则(apiAdapter.js:257/267、aiGateway.js:1231、本模块)。
  // 这条测试拿本模块与 apiAdapter 在同一张表上对撞,任一处演化都会立刻红。
});

describe('Capability Model Key', () => {
  test('三段式路由 id 与裸名折叠成同一个键(事故的直接成因)', () => {
        expect(capabilityModelKey('api:agnes:agnes-2.5-flash')).toBe('agnes-2.5-flash');
        expect(capabilityModelKey('agnes-2.5-flash')).toBe('agnes-2.5-flash');
        assert.equal(
          capabilityModelKey('api:agnes:agnes-2.5-flash'),
          capabilityModelKey('agnes-2.5-flash'),
          '两道闸必须落在同一个键上'
        );
  });

  test('两段式适配器前缀也剥掉', () => {
        expect(capabilityModelKey('claude:sonnet')).toBe('sonnet');
        expect(capabilityModelKey('relay_api:glm-4.7-flash')).toBe('glm-4.7-flash');
        expect(capabilityModelKey('ollama:llama3')).toBe('llama3');
  });

  test('两段式服务商前缀也剥掉(openai:gpt-4o-mini 同样会分裂两道闸)', () => {
        expect(capabilityModelKey('openai:gpt-4o-mini')).toBe('gpt-4o-mini');
        expect(capabilityModelKey('agnes:agnes-2.5-flash')).toBe('agnes-2.5-flash');
        expect(capabilityModelKey('glm:glm-4.7-flash')).toBe('glm-4.7-flash');
  });

  test('ollama 的量化/尺寸 tag 不当作模型名剥(qwen 既是池名又是模型家族)', () => {
        // 若按前缀无条件剥,`qwen:7b` 会以 `7b` 为键 —— 毫无意义,且可能与别的家族撞车。
        expect(capabilityModelKey('qwen:7b')).toBe('qwen:7b');
        expect(capabilityModelKey('qwen:14b-instruct')).toBe('qwen:14b-instruct');
        expect(capabilityModelKey('deepseek:latest')).toBe('deepseek:latest');
        expect(capabilityModelKey('qwen:q4_0')).toBe('qwen:q4_0');
        // 但真正的模型名照常剥
        expect(capabilityModelKey('qwen:qwen-plus')).toBe('qwen-plus');
  });

  test('冒号是模型名一部分时绝不误剥(否则不同模型会塌成同一条记录)', () => {
        // 前导段不是已知适配器 → 原样保留。若无条件剥两段式,`llama3:8b` 与 `qwen2.5:8b`
        // 都会变成 `8b`,两个模型的能力记录混作一条 —— 比键分裂更糟。
        expect(capabilityModelKey('llama3:8b')).toBe('llama3:8b');
        expect(capabilityModelKey('qwen2.5:7b')).toBe('qwen2.5:7b');
        assert.notEqual(capabilityModelKey('llama3:8b'), capabilityModelKey('qwen2.5:7b'));
        // 已知适配器前缀 + 带冒号的模型名 → 只剥前缀,模型名整体保留。
        expect(capabilityModelKey('ollama:llama3:8b')).toBe('llama3:8b');
  });

  test('trim / 大小写归一,空值 → 空串', () => {
        expect(capabilityModelKey('  API:Agnes:Agnes-2.5-Flash ')).toBe('agnes-2.5-flash');
        expect(capabilityModelKey('')).toBe('');
        expect(capabilityModelKey(null)).toBe('');
        expect(capabilityModelKey(undefined)).toBe('');
        expect(capabilityModelKey(123)).toBe('123');
  });

  test('无前缀的普通模型名原样返回', () => {
        expect(capabilityModelKey('gpt-4o')).toBe('gpt-4o');
        expect(capabilityModelKey('deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  test('api 前缀形状上,capabilityModelKey === parseProviderModel().model', () => {
        const { parseProviderModel } = require('../../../src/services/gateway/adapters/apiAdapter');
        const TABLE = [
          'api:agnes:agnes-2.5-flash',
          'api:glm:glm-4.7-flash',
          'api:agnes:agnes-image-2.1-flash',
          'api/agnes/agnes-2.5-flash',
          'gpt-4o',
        ];
        for (const raw of TABLE) {
          const expected = String(parseProviderModel(raw).model || '').trim().toLowerCase();
          expect(capabilityModelKey(raw)).toBe(expected);
        }
  });

});
