'use strict';

/**
 * ocrUsageFootnote.test.js — 纯叶子单测(OPS-MAN-126,承 OPS-124)。
 *
 * 叶子职责:OCR 成功路径上的**确定性**用户可见披露。四个导出:
 *   · isFootnoteEnabled(env) — 门 KHY_OCR_USAGE_FOOTNOTE,default-on,仅 CANON off-words 关。
 *   · answerAlreadyDisclosesOcr(content) — 正文是否已披露 OCR(命中则无需脚注,保持无感)。
 *   · buildOcrUsageFootnote({count,env}) — 门开且 count 正整数 → 用户可见脚注;门关/畸形 → null。
 *   · OCR_USAGE_FOOTNOTE_MARKER — 去重标记。
 * 全程零 IO、绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const ouf = require(BE + '/src/services/gateway/ocrUsageFootnote');

describe('ocrUsageFootnote.isFootnoteEnabled', () => {
  test('FLAG 名', () => {
    assert.equal(ouf.FLAG, 'KHY_OCR_USAGE_FOOTNOTE');
  });
  test('默认开(空 env)', () => {
    assert.equal(ouf.isFootnoteEnabled({}), true);
  });
  test('仅 CANON off-words 关', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(ouf.isFootnoteEnabled({ KHY_OCR_USAGE_FOOTNOTE: off }), false, `off ${off}`);
    }
  });
  test('其他真值/杂串 → 开', () => {
    for (const on of ['1', 'true', 'on', 'yes', 'whatever']) {
      assert.equal(ouf.isFootnoteEnabled({ KHY_OCR_USAGE_FOOTNOTE: on }), true, `on ${on}`);
    }
  });
});

describe('ocrUsageFootnote.answerAlreadyDisclosesOcr', () => {
  test('拉丁 OCR 大小写不敏感 → true', () => {
    assert.equal(ouf.answerAlreadyDisclosesOcr('via OCR'), true);
    assert.equal(ouf.answerAlreadyDisclosesOcr('用了 ocr 识别'), true);
    assert.equal(ouf.answerAlreadyDisclosesOcr('Ocr 读取'), true);
  });
  test('中文 OCR 表述 → true', () => {
    assert.equal(ouf.answerAlreadyDisclosesOcr('经光学字符识别'), true);
    assert.equal(ouf.answerAlreadyDisclosesOcr('光学识别所得'), true);
    assert.equal(ouf.answerAlreadyDisclosesOcr('这是文字识别的结果'), true);
  });
  test('未提 OCR → false', () => {
    assert.equal(ouf.answerAlreadyDisclosesOcr('发票金额是 100 元'), false);
    assert.equal(ouf.answerAlreadyDisclosesOcr('图片里有一只猫'), false);
  });
  test('畸形输入 fail-soft → false', () => {
    assert.equal(ouf.answerAlreadyDisclosesOcr(''), false);
    assert.equal(ouf.answerAlreadyDisclosesOcr(null), false);
    assert.equal(ouf.answerAlreadyDisclosesOcr(undefined), false);
    assert.equal(ouf.answerAlreadyDisclosesOcr(123), false);
    assert.equal(ouf.answerAlreadyDisclosesOcr({}), false);
  });
});

describe('ocrUsageFootnote.buildOcrUsageFootnote', () => {
  test('门开 + count=1 → 单数脚注,含 marker + 「本地 OCR」措辞', () => {
    const s = ouf.buildOcrUsageFootnote({ count: 1, env: {} });
    assert.ok(typeof s === 'string' && s.length > 0);
    assert.ok(s.includes(ouf.OCR_USAGE_FOOTNOTE_MARKER), '含去重 marker');
    assert.match(s, /这张图片/, '单数措辞');
    assert.match(s, /本地 OCR 文字识别读取/, '明确「用了 OCR」');
    assert.match(s, /当前模型不支持直接看图/, '说明降级原因');
  });
  test('门开 + count=3 → 复数措辞', () => {
    const s = ouf.buildOcrUsageFootnote({ count: 3, env: {} });
    assert.match(s, /这 3 张图片/, '复数措辞');
  });
  test('门关 → null(逐字节回退)', () => {
    assert.equal(ouf.buildOcrUsageFootnote({ count: 1, env: { KHY_OCR_USAGE_FOOTNOTE: 'off' } }), null);
    assert.equal(ouf.buildOcrUsageFootnote({ count: 5, env: { KHY_OCR_USAGE_FOOTNOTE: '0' } }), null);
  });
  test('count 非正整数 / 缺失 / 畸形 → null(不追加)', () => {
    assert.equal(ouf.buildOcrUsageFootnote({ count: 0, env: {} }), null);
    assert.equal(ouf.buildOcrUsageFootnote({ count: -1, env: {} }), null);
    assert.equal(ouf.buildOcrUsageFootnote({ count: NaN, env: {} }), null);
    assert.equal(ouf.buildOcrUsageFootnote({ env: {} }), null);
    assert.equal(ouf.buildOcrUsageFootnote({ count: 'abc', env: {} }), null);
  });
  test('无参 fail-soft → null(不抛)', () => {
    assert.equal(ouf.buildOcrUsageFootnote(), null);
  });
});
