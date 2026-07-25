'use strict';

/**
 * textEmphasisPolicy — 输出排版强调层单元测试。
 *
 * 验证 Goal「该加粗的加粗、该调大字体的调大」的判定真源:
 *  - isEmphasisEnabled 默认开、仅显式 falsy 关;isBigHeadingsEnabled 默认关、仅显式 truthy 开。
 *  - headingDescriptor:各级标题都 bold,层级 tone 正确,越界 clamp。
 *  - shouldBoldHeading:强调开 → 各级都加粗;关 → false(字节回退)。
 *  - bigHeadingPrefix:关 → '';开 → 仅 H1/H2 给 DEC 双宽前缀,H3+ 不放大。
 *  - 绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEC_DOUBLE_WIDTH,
  isEmphasisEnabled,
  isBigHeadingsEnabled,
  headingDescriptor,
  shouldBoldHeading,
  bigHeadingPrefix,
} = require('../src/services/typeset/textEmphasisPolicy');

const ON = { KHY_TYPESET_EMPHASIS: '1' };
const OFF = { KHY_TYPESET_EMPHASIS: 'off' };
const BIG_ON = { KHY_TYPESET_BIG_HEADINGS: '1' };
const BIG_OFF = { KHY_TYPESET_BIG_HEADINGS: 'off' };

describe('isEmphasisEnabled — 默认开,仅显式 falsy 关', () => {
  test('无 env / 空 → 开', () => {
    assert.equal(isEmphasisEnabled({}), true);
    assert.equal(isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: '' }), true);
  });
  test('显式 falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(isEmphasisEnabled({ KHY_TYPESET_EMPHASIS: v }), false, v);
    }
  });
});

describe('isBigHeadingsEnabled — 默认关(实验性),仅显式 truthy 开', () => {
  test('无 env / 空 → 关', () => {
    assert.equal(isBigHeadingsEnabled({}), false);
    assert.equal(isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: '' }), false);
  });
  test('显式 truthy → 开', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'ON']) {
      assert.equal(isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: v }), true, v);
    }
  });
  test('显式 falsy → 关', () => {
    assert.equal(isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: '0' }), false);
    assert.equal(isBigHeadingsEnabled({ KHY_TYPESET_BIG_HEADINGS: 'off' }), false);
  });
});

describe('headingDescriptor — 各级标题层级真源', () => {
  test('1..6 全部加粗,tone 分级', () => {
    assert.deepEqual(headingDescriptor(1), { level: 1, bold: true, tone: 'h1', prominent: true });
    assert.deepEqual(headingDescriptor(2), { level: 2, bold: true, tone: 'h2', prominent: true });
    assert.deepEqual(headingDescriptor(3), { level: 3, bold: true, tone: 'h3', prominent: false });
    assert.equal(headingDescriptor(4).bold, true);
    assert.equal(headingDescriptor(4).tone, 'muted');
    assert.equal(headingDescriptor(6).bold, true);
  });
  test('越界 / 非法 → clamp 到 [1,6]', () => {
    assert.equal(headingDescriptor(0).level, 1);
    assert.equal(headingDescriptor(99).level, 6);
    assert.equal(headingDescriptor(NaN).level, 1);
    assert.equal(headingDescriptor(undefined).level, 1);
  });
});

describe('shouldBoldHeading — 强调开各级加粗,关字节回退', () => {
  test('门控开 → 各级 true', () => {
    for (const lvl of [1, 2, 3, 4, 5, 6]) {
      assert.equal(shouldBoldHeading(lvl, ON), true, `level ${lvl}`);
    }
  });
  test('门控关 → false(逐字节回退到非加粗)', () => {
    assert.equal(shouldBoldHeading(3, OFF), false);
    assert.equal(shouldBoldHeading(1, OFF), false);
  });
});

describe('bigHeadingPrefix — 默认关恒空,开则仅 H1/H2 放大', () => {
  test('门控关 → 恒 ""(无字节变化)', () => {
    assert.equal(bigHeadingPrefix(1, BIG_OFF), '');
    assert.equal(bigHeadingPrefix(1, {}), '');
    assert.equal(bigHeadingPrefix(2, BIG_OFF), '');
  });
  test('门控开 → H1/H2 给 DEC 双宽,H3+ 不放大', () => {
    assert.equal(bigHeadingPrefix(1, BIG_ON), DEC_DOUBLE_WIDTH);
    assert.equal(bigHeadingPrefix(2, BIG_ON), DEC_DOUBLE_WIDTH);
    assert.equal(bigHeadingPrefix(3, BIG_ON), '');
    assert.equal(bigHeadingPrefix(6, BIG_ON), '');
  });
  test('DEC_DOUBLE_WIDTH 即 VT100 双宽行序列 ESC#6', () => {
    assert.equal(DEC_DOUBLE_WIDTH, '\x1b#6');
  });
});

describe('绝不抛 — fail-soft', () => {
  test('异常 / 缺参输入全部 doesNotThrow', () => {
    assert.doesNotThrow(() => isEmphasisEnabled(null));
    assert.doesNotThrow(() => isBigHeadingsEnabled(null));
    assert.doesNotThrow(() => headingDescriptor({}));
    assert.doesNotThrow(() => shouldBoldHeading('x', null));
    assert.doesNotThrow(() => bigHeadingPrefix(undefined, null));
  });
});
