'use strict';

/**
 * ocrLanguageNotice.test.js — 纯叶子单测:锁定「OCR 语言包可用性」诚实告诫的判据与门控回退。
 *
 * 背景(/goal 2026-07-12,第四条正交诚实轴,直击「没有识图模型下准确识别图片」):
 * docHelper.py 把请求的 `chi_sim+eng` 经 _resolve_lang 窄化成本机装了 traineddata 的子集(如仅 eng),
 * 被丢弃语言的文字根本无法识别。本叶据 requestedLang 减 effective lang 的集合差算出被丢弃语言并告诫。
 *
 * 核心陷阱(诚实边界):无丢弃 / 无法内省(requested==effective)/ 门关 / 畸形 → null,绝不误报;
 * osd 不计入(仅方向检测非文字语言);集合差稳定排序、去重。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/services/gateway/ocrLanguageNotice');
const { isEnabled, computeDroppedLangs, buildLanguageNotice, FLAG } = leaf;

test('门 default-on:未设置 env → isEnabled true', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(FLAG, 'KHY_OCR_LANGUAGE_NOTICE');
});

test('门可关:0/false/off/no → isEnabled false(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(isEnabled({ [FLAG]: off }), false, `off-word ${off} 应关门`);
  }
});

test('computeDroppedLangs:请求 jpn+eng、生效仅 eng → dropped=[jpn]', () => {
  const d = computeDroppedLangs([{ requestedLang: 'jpn+eng', lang: 'eng' }]);
  assert.deepEqual(d, ['jpn']);
});

test('computeDroppedLangs:请求==生效(chi_sim+eng 都装)→ 无丢弃', () => {
  const d = computeDroppedLangs([{ requestedLang: 'chi_sim+eng', lang: 'chi_sim+eng' }]);
  assert.deepEqual(d, []);
});

test('computeDroppedLangs:跨多图并集去重 + 稳定排序', () => {
  const d = computeDroppedLangs([
    { requestedLang: 'jpn+eng', lang: 'eng' },
    { requestedLang: 'kor+chi_sim+eng', lang: 'chi_sim+eng' },
    { requestedLang: 'jpn+eng', lang: 'eng' }, // 重复 jpn
  ]);
  assert.deepEqual(d, ['jpn', 'kor']);
});

test('computeDroppedLangs:osd 不计入丢弃(仅方向检测非文字语言)', () => {
  const d = computeDroppedLangs([{ requestedLang: 'osd+eng', lang: 'eng' }]);
  assert.deepEqual(d, []);
});

test('computeDroppedLangs:缺 requestedLang(旧缓存)→ 不产生丢弃', () => {
  assert.deepEqual(computeDroppedLangs([{ lang: 'eng' }]), []);
  assert.deepEqual(computeDroppedLangs([{ requestedLang: '', lang: 'eng' }]), []);
});

test('computeDroppedLangs:畸形输入(非数组/含 null/标量)→ [],绝不抛', () => {
  assert.doesNotThrow(() => computeDroppedLangs());
  assert.deepEqual(computeDroppedLangs(undefined), []);
  assert.deepEqual(computeDroppedLangs('x'), []);
  assert.deepEqual(computeDroppedLangs([null, 1, 'y', {}]), []);
});

test('buildLanguageNotice:有丢弃 → 含语言名与安装提示', () => {
  const s = buildLanguageNotice({ dropped: ['chi_sim', 'jpn'], env: {} });
  assert.ok(s, '应产出告诫');
  assert.match(s, /chi_sim、jpn/);
  assert.match(s, /未安装以下 OCR 语言包/);
  assert.match(s, /可能未被识别/);
  assert.match(s, /tesseract-ocr-chi_sim/); // 安装提示用首个
});

test('buildLanguageNotice:无丢弃(空数组)→ null(无误报,逐字节回退)', () => {
  assert.equal(buildLanguageNotice({ dropped: [], env: {} }), null);
});

test('buildLanguageNotice:dropped 非数组 → null', () => {
  assert.equal(buildLanguageNotice({ dropped: 'jpn', env: {} }), null);
  assert.equal(buildLanguageNotice({ env: {} }), null);
});

test('buildLanguageNotice:门关 → null(即便有丢弃也逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(
      buildLanguageNotice({ dropped: ['jpn'], env: { [FLAG]: off } }),
      null,
      `门关(${off})应不告诫`
    );
  }
});

test('buildLanguageNotice:畸形输入绝不抛,返回 null', () => {
  assert.doesNotThrow(() => buildLanguageNotice());
  assert.equal(buildLanguageNotice(), null);
});
