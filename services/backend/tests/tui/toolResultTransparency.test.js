'use strict';
/**
 * toolResultTransparency — 工具结果透明化纯叶子单测。
 *
 * 验证:① 门控字节回退;② 真实输出体口径(text > content > output);
 *      ③ 综合判定 shouldRenderTransparentBody = 门控开 且 有真实输出体。
 */
const tr = require('../../src/cli/toolResultTransparency');
describe('transparencyEnabled — 门控 KHY_TOOL_RESULT_TRANSPARENT', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
  }
});
describe('selectResultBody — 真实输出体口径 text > content > output', () => {
  test('无任何体 / null / 空串 / 纯空白 → ""', () => {
    expect(tr.selectResultBody(null)).toBe('');
    expect(tr.selectResultBody({})).toBe('');
    expect(tr.selectResultBody({ success: true })).toBe('');
    expect(tr.selectResultBody({ text: '' })).toBe('');
    expect(tr.selectResultBody({ text: '   \n  ' })).toBe('');
  });
  test('循环引用不抛 → ""', () => {
    const o = {}; o.self = o;
    expect(tr.selectResultBody({ text: o })).toBe('');
  });
});
describe('shouldRenderTransparentBody — 门控 × 输出体矩阵', () => {
  const body = { output: 'wrote 12 lines' };
  const empty = { success: true };
});

describe('Tool Result Transparency', () => {
  test('未设(默认)→ 开', () => {
        expect(tr.transparencyEnabled({})).toBe(true);
  });

  test('=${off} → 关', () => {
          expect(tr.transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: off })).toBe(false);
  });

  test('=1 / 任意其他真值 → 开', () => {
        expect(tr.transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: '1' })).toBe(true);
        expect(tr.transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: 'yes' })).toBe(true);
  });

  test('text 优先', () => {
        expect(tr.selectResultBody({ text: 'T', content: 'C', output: 'O' })).toBe('T');
  });

  test('无 text → content', () => {
        expect(tr.selectResultBody({ content: 'C', output: 'O' })).toBe('C');
  });

  test('仅 output', () => {
        expect(tr.selectResultBody({ output: 'O' })).toBe('O');
  });

  test('非字符串体 → JSON 序列化', () => {
        expect(tr.selectResultBody({ text: { a: 1 } })).toBe('{"a":1}');
  });

  test('门控开 + 有体 → true', () => {
        expect(tr.shouldRenderTransparentBody(body, {})).toBe(true);
  });

  test('门控开 + 无体 → false(回退 ✓ 摘要)', () => {
        expect(tr.shouldRenderTransparentBody(empty, {})).toBe(false);
  });

  test('门控关 + 有体 → false(字节回退)', () => {
        expect(tr.shouldRenderTransparentBody(body, { KHY_TOOL_RESULT_TRANSPARENT: '0' })).toBe(false);
  });

});
