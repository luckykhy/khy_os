'use strict';

/**
 * toolResultTransparency — 工具结果透明化纯叶子单测。
 *
 * 验证:① 门控字节回退;② 真实输出体口径(text > content > output);
 *      ③ 综合判定 shouldRenderTransparentBody = 门控开 且 有真实输出体。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const tr = require('../../src/cli/toolResultTransparency');

describe('transparencyEnabled — 门控 KHY_TOOL_RESULT_TRANSPARENT', () => {
  test('未设(默认)→ 开', () => {
    assert.equal(tr.transparencyEnabled({}), true);
  });
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    test(`=${off} → 关`, () => {
      assert.equal(tr.transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: off }), false);
    });
  }
  test('=1 / 任意其他真值 → 开', () => {
    assert.equal(tr.transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: '1' }), true);
    assert.equal(tr.transparencyEnabled({ KHY_TOOL_RESULT_TRANSPARENT: 'yes' }), true);
  });
});

describe('selectResultBody — 真实输出体口径 text > content > output', () => {
  test('text 优先', () => {
    assert.equal(tr.selectResultBody({ text: 'T', content: 'C', output: 'O' }), 'T');
  });
  test('无 text → content', () => {
    assert.equal(tr.selectResultBody({ content: 'C', output: 'O' }), 'C');
  });
  test('仅 output', () => {
    assert.equal(tr.selectResultBody({ output: 'O' }), 'O');
  });
  test('无任何体 / null / 空串 / 纯空白 → ""', () => {
    assert.equal(tr.selectResultBody(null), '');
    assert.equal(tr.selectResultBody({}), '');
    assert.equal(tr.selectResultBody({ success: true }), '');
    assert.equal(tr.selectResultBody({ text: '' }), '');
    assert.equal(tr.selectResultBody({ text: '   \n  ' }), '');
  });
  test('非字符串体 → JSON 序列化', () => {
    assert.equal(tr.selectResultBody({ text: { a: 1 } }), '{"a":1}');
  });
  test('循环引用不抛 → ""', () => {
    const o = {}; o.self = o;
    assert.equal(tr.selectResultBody({ text: o }), '');
  });
});

describe('shouldRenderTransparentBody — 门控 × 输出体矩阵', () => {
  const body = { output: 'wrote 12 lines' };
  const empty = { success: true };
  test('门控开 + 有体 → true', () => {
    assert.equal(tr.shouldRenderTransparentBody(body, {}), true);
  });
  test('门控开 + 无体 → false(回退 ✓ 摘要)', () => {
    assert.equal(tr.shouldRenderTransparentBody(empty, {}), false);
  });
  test('门控关 + 有体 → false(字节回退)', () => {
    assert.equal(tr.shouldRenderTransparentBody(body, { KHY_TOOL_RESULT_TRANSPARENT: '0' }), false);
  });
});
