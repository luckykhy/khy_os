'use strict';

/**
 * ocrRescueStatusPrep.test.js — 纯叶单测(OPS-MAN-132,承 OPS-127)。
 * 覆盖 buildOcrRescuePrepStatus / isRescuePrepStatusEnabled / PREP_FLAG:
 *   门 default-on 与 off-words / 单复数 / modelName 缺省与裁剪 / count 畸形→null / 门关→null / fail-soft。
 *
 * 与 OPS-127 的 buildOcrRescueStatus 正交:那条给 Site3(post-failure 救援网,主语「适配器」),
 * 本条给 prep 期 Site1/Site2(主语「模型」),独立门 KHY_OCR_RESCUE_STATUS_PREP。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const orsn = require(BE + '/src/services/gateway/ocrRescueStatusNotice');

describe('ocrRescueStatusNotice prep 期纯叶(OPS-MAN-132)', () => {
  test('PREP_FLAG 名固定,且与 Site3 门分开', () => {
    assert.equal(orsn.PREP_FLAG, 'KHY_OCR_RESCUE_STATUS_PREP');
    assert.notEqual(orsn.PREP_FLAG, orsn.FLAG);
  });

  test('门默认开;仅显式 0/false/off/no 关', () => {
    assert.equal(orsn.isRescuePrepStatusEnabled({}), true);
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(orsn.isRescuePrepStatusEnabled({ KHY_OCR_RESCUE_STATUS_PREP: off }), false, `off-word ${off}`);
    }
  });

  test('门开 + count>=1 → 返回实时状态串(含降级到 OCR 的措辞)', () => {
    const s = orsn.buildOcrRescuePrepStatus({ count: 1, modelName: 'text-only-model', env: {} });
    assert.ok(typeof s === 'string' && s.length > 0);
    assert.match(s, /已降级用本地 OCR 成功提取/);
    assert.match(s, /1 张图片/);
    assert.match(s, /text-only-model/);
  });

  test('复数:count>1 → 「N 张图片」', () => {
    assert.match(orsn.buildOcrRescuePrepStatus({ count: 3, modelName: 'm', env: {} }), /3 张图片/);
  });

  test('modelName 缺失/空白 → 「当前模型」;有值则裁剪空白', () => {
    assert.match(orsn.buildOcrRescuePrepStatus({ count: 1, env: {} }), /当前模型/);
    assert.match(orsn.buildOcrRescuePrepStatus({ count: 1, modelName: '   ', env: {} }), /当前模型/);
    assert.match(orsn.buildOcrRescuePrepStatus({ count: 1, modelName: '  glm  ', env: {} }), /glm 不支持图像识别/);
  });

  test('门关 → null(逐字节回退:调用方不 emitStatus)', () => {
    assert.equal(orsn.buildOcrRescuePrepStatus({ count: 2, modelName: 'm', env: { KHY_OCR_RESCUE_STATUS_PREP: 'off' } }), null);
  });

  test('独立门:关 Site3 门不影响 prep 门,反之亦然', () => {
    // 关 Site3 门(KHY_OCR_RESCUE_STATUS)→ prep 仍可用
    assert.ok(orsn.buildOcrRescuePrepStatus({ count: 1, modelName: 'm', env: { KHY_OCR_RESCUE_STATUS: 'off' } }));
    // 关 prep 门 → Site3 仍可用
    assert.ok(orsn.buildOcrRescueStatus({ count: 1, adapterName: 'a', env: { KHY_OCR_RESCUE_STATUS_PREP: 'off' } }));
  });

  test('count 畸形(0/负/NaN/缺失/非数) → null,绝不抛', () => {
    for (const c of [0, -1, NaN, undefined, null, 'x', {}]) {
      assert.equal(orsn.buildOcrRescuePrepStatus({ count: c, modelName: 'm', env: {} }), null, `count=${String(c)}`);
    }
  });

  test('无参调用 fail-soft(不抛,返回 null)', () => {
    assert.doesNotThrow(() => orsn.buildOcrRescuePrepStatus());
    assert.equal(orsn.buildOcrRescuePrepStatus({ env: {} }), null);
  });
});
