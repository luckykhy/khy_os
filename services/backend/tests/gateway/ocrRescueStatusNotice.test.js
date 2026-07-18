'use strict';

/**
 * ocrRescueStatusNotice.test.js — 纯叶单测(OPS-MAN-127)。
 * 覆盖:FLAG 名 / 门 default-on 与 off-words / 单复数 / 门关→null / count 畸形→null / adapterName 缺省与裁剪。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const orsn = require(BE + '/src/services/gateway/ocrRescueStatusNotice');

describe('ocrRescueStatusNotice 纯叶(OPS-MAN-127)', () => {
  test('FLAG 名固定', () => {
    assert.equal(orsn.FLAG, 'KHY_OCR_RESCUE_STATUS');
  });

  test('门默认开;仅显式 0/false/off/no 关', () => {
    assert.equal(orsn.isRescueStatusEnabled({}), true);
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(orsn.isRescueStatusEnabled({ KHY_OCR_RESCUE_STATUS: off }), false, `off-word ${off}`);
    }
  });

  test('门开 + count>=1 → 返回实时状态串(含降级到 OCR 的措辞)', () => {
    const s = orsn.buildOcrRescueStatus({ count: 1, adapterName: 'textpool', env: {} });
    assert.ok(typeof s === 'string' && s.length > 0);
    assert.match(s, /已降级用本地 OCR 成功提取/);
    assert.match(s, /1 张图片/);
    assert.match(s, /textpool/);
  });

  test('复数:count>1 → 「N 张图片」', () => {
    const s = orsn.buildOcrRescueStatus({ count: 3, adapterName: 'a', env: {} });
    assert.match(s, /3 张图片/);
  });

  test('adapterName 缺失/空白 → 「当前适配器」;有值则裁剪空白', () => {
    assert.match(orsn.buildOcrRescueStatus({ count: 1, env: {} }), /当前适配器/);
    assert.match(orsn.buildOcrRescueStatus({ count: 1, adapterName: '   ', env: {} }), /当前适配器/);
    assert.match(orsn.buildOcrRescueStatus({ count: 1, adapterName: '  vp  ', env: {} }), /识别，vp 不支持|vp 不支持图像识别/);
  });

  test('门关 → null(逐字节回退:调用方不 emitStatus)', () => {
    assert.equal(orsn.buildOcrRescueStatus({ count: 2, adapterName: 'a', env: { KHY_OCR_RESCUE_STATUS: 'off' } }), null);
  });

  test('count 畸形(0/负/NaN/缺失/非数) → null,绝不抛', () => {
    for (const c of [0, -1, NaN, undefined, null, 'x', {}]) {
      assert.equal(orsn.buildOcrRescueStatus({ count: c, adapterName: 'a', env: {} }), null, `count=${String(c)}`);
    }
  });

  test('无参调用 fail-soft(不抛,返回 null)', () => {
    assert.doesNotThrow(() => orsn.buildOcrRescueStatus());
    assert.equal(orsn.buildOcrRescueStatus({ env: {} }), null);
  });
});

describe('shouldSuppressPrepForClosure 跨层去重谓词(OPS-MAN-148)', () => {
  test('FLAG 名固定', () => {
    assert.equal(orsn.PREP_CLOSURE_DEDUP_FLAG, 'KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP');
  });

  test('去重门默认开;仅显式 0/false/off/no 关', () => {
    assert.equal(orsn.isPrepClosureDedupEnabled({}), true);
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(orsn.isPrepClosureDedupEnabled({ KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP: off }), false, `off-word ${off}`);
    }
  });

  test('门开 + 闭合将发(中间消息 && 闭合门均真) → true(抑制冗余 prep-status)', () => {
    assert.equal(orsn.shouldSuppressPrepForClosure({ intermediateEnabled: true, closureEnabled: true, env: {} }), true);
  });

  test('去重门关 → false(byte-revert:prep-status 与闭合并存)', () => {
    assert.equal(orsn.shouldSuppressPrepForClosure({
      intermediateEnabled: true, closureEnabled: true, env: { KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP: 'off' },
    }), false);
  });

  test('闭合门关(closureEnabled=false) → false(闭合不发 → 不能抑制唯一公告)', () => {
    assert.equal(orsn.shouldSuppressPrepForClosure({ intermediateEnabled: true, closureEnabled: false, env: {} }), false);
  });

  test('中间消息门关(intermediateEnabled=false) → false(共享前提不成立 → 闭合不发)', () => {
    assert.equal(orsn.shouldSuppressPrepForClosure({ intermediateEnabled: false, closureEnabled: true, env: {} }), false);
  });

  test('非严格布尔(truthy 但非 true)→ false(只认显式 true,防误抑制)', () => {
    assert.equal(orsn.shouldSuppressPrepForClosure({ intermediateEnabled: 1, closureEnabled: 'yes', env: {} }), false);
  });

  test('畸形/无参 → false,绝不抛', () => {
    assert.doesNotThrow(() => orsn.shouldSuppressPrepForClosure());
    assert.equal(orsn.shouldSuppressPrepForClosure(), false);
    assert.equal(orsn.shouldSuppressPrepForClosure({ env: {} }), false);
  });
});
