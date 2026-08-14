'use strict';

/**
 * resultLineGlyph — 结果行起首字形纯叶子单测。
 *
 * 验证:① 门控 KHY_RESULT_ELBOW 字节回退口径;
 *      ② resultLineLead 门控开 → 暗色 `⎿`(无 color)、关 → 绿色 `✓`。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const rg = require('../../src/cli/resultLineGlyph');

describe('resultElbowEnabled — 门控 KHY_RESULT_ELBOW', () => {
  test('未设(默认)→ 开', () => {
    assert.equal(rg.resultElbowEnabled({}), true);
  });
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    test(`=${off} → 关`, () => {
      assert.equal(rg.resultElbowEnabled({ KHY_RESULT_ELBOW: off }), false);
    });
  }
  test('=1 / 任意其他真值 → 开', () => {
    assert.equal(rg.resultElbowEnabled({ KHY_RESULT_ELBOW: '1' }), true);
    assert.equal(rg.resultElbowEnabled({ KHY_RESULT_ELBOW: 'yes' }), true);
  });
});

describe('resultLineLead — 结果行起首装饰单一真源', () => {
  test('门控开 → 暗色 ⎿ elbow(无 color,继承终端)', () => {
    const lead = rg.resultLineLead({});
    assert.equal(lead.glyph, '⎿ ');
    assert.equal(lead.color, undefined);
    assert.equal(lead.dim, true);
  });
  test('门控关 → 绿色 ✓(字节回退)', () => {
    const lead = rg.resultLineLead({ KHY_RESULT_ELBOW: '0' });
    assert.equal(lead.glyph, '✓ ');
    assert.equal(lead.color, 'green');
    assert.equal(lead.dim, true);
  });
});
