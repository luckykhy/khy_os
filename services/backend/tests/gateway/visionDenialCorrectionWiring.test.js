'use strict';

/**
 * visionDenialCorrectionWiring.test.js — finishResult 接线单测(OPS-MAN-138)。
 *
 * 验证 aiGatewayGenerateMethod.finishResult 成功侧新增的确定性纠正接缝:
 *   条件 = result.success && options._ocrFallbackApplied && !options._ocrImageTextRead
 *          && detectImageDenial(content) && 门开 && 未含 marker。
 *
 * 手法:直接构造 finishResult 会读到的 options/result 语义等价场景不便(finishResult 是闭包内私有),
 * 故走**源级 wiring 断言**(镜像 ocrUsageFootnoteWiring 的既有做法):读 aiGatewayGenerateMethod.js
 * 源码,断言新接缝的判据、门、marker、fail-soft 结构确实接在 ocrUsageFootnote 块之后、且形态正确。
 * 端到端真链路由 visionDenialCorrectionRealImage.test.js 用真 tesseract 覆盖。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(BE + '/src/services/gateway/aiGatewayGenerateMethod.js', 'utf8');

describe('finishResult 接线:空 OCR 剥图 + 模型否认 → 确定性纠正', () => {
  test('存在守卫条件:success && _ocrFallbackApplied && !_ocrImageTextRead', () => {
    assert.match(
      SRC,
      /result\.success === true && options\._ocrFallbackApplied && !options\._ocrImageTextRead/,
      '判据须精确匹配空 OCR 剥图路径(_ocrFallbackApplied 真 + _ocrImageTextRead 假)',
    );
  });
  test('require 单一真源叶 visionDenialCorrection', () => {
    assert.match(SRC, /require\('\.\/visionDenialCorrection'\)/, '接线须 require 该纯叶');
  });
  test('门 + marker 去重 + detectImageDenial 三重守卫齐备', () => {
    assert.match(SRC, /_vdc\.isEnabled\(process\.env\)/, '门控判定');
    assert.match(SRC, /_vdc\.DENIAL_CORRECTION_MARKER/, 'marker 去重');
    assert.match(SRC, /_vdc\.detectImageDenial\(result\.content\)/, '仅模型否认时触发');
  });
  test('确定性追加 buildDenialCorrectionNote 到 content 末尾', () => {
    assert.match(SRC, /_vdc\.buildDenialCorrectionNote\(\{ count: _imgN, env: process\.env \}\)/);
    assert.match(SRC, /result\.content = `\$\{String\(result\.content \|\| ''\)\}\$\{_footer\}`/);
  });
  test('空 OCR 纠正接在 ocrUsageFootnote 块之后(同族成功侧脚注)', () => {
    const oufIdx = SRC.indexOf('_ouf.buildOcrUsageFootnote');
    // 空 OCR 变体调用精确匹配(无 ocrTextRead 参数),区别于 OPS-140 的 OCR-成功变体调用。
    const emptyVdcIdx = SRC.indexOf('_vdc.buildDenialCorrectionNote({ count: _imgN, env: process.env })');
    assert.ok(oufIdx > 0 && emptyVdcIdx > oufIdx, '空 OCR 纠正接缝须在 ocrUsageFootnote 之后');
  });
  test('fail-soft:接缝包在 try/catch 内', () => {
    // 抓取本接缝片段,断言其后紧跟 catch(fail-soft 注释)。
    const seg = SRC.slice(SRC.indexOf('!options._ocrImageTextRead'));
    const block = seg.slice(0, seg.indexOf('/* fail-soft */') + 20);
    assert.match(block, /try \{/, '接缝须 try 包裹');
    assert.match(block, /catch \{ \/\* fail-soft \*\/ \}/, '须 fail-soft 兜底,绝不打断返回路径');
  });
});

// ── OPS-MAN-140:OCR 成功读出 + 模型仍否认 → OCR-成功变体纠正取代普通「用了 OCR」脚注 ──────────
describe('finishResult 接线:OCR 成功 + 模型否认 → OCR-成功变体纠正(OPS-140)', () => {
  test('挂在 _ocrImageTextRead 成功侧块内(与 ocrUsageFootnote 同守卫)', () => {
    assert.match(
      SRC,
      /result\.success === true && options\._ocrImageTextRead\)/,
      'OCR-成功变体须挂在 _ocrImageTextRead 真的守卫块',
    );
  });
  test('OCR-成功变体判据:子门 isOcrReadDenialEnabled + 独立 marker + detectImageDenial', () => {
    assert.match(SRC, /_vdc\.isOcrReadDenialEnabled\(process\.env\)/, '子门判定');
    assert.match(SRC, /_vdc\.DENIAL_CORRECTION_OCR_READ_MARKER/, '独立 marker 去重');
    assert.match(SRC, /_vdc\.detectImageDenial\(result\.content\)/, '仅模型否认时触发');
  });
  test('OCR-成功变体调用带 ocrTextRead: true', () => {
    assert.match(
      SRC,
      /_vdc\.buildDenialCorrectionNote\(\{ count: _imgN, env: process\.env, ocrTextRead: true \}\)/,
      'OCR-成功变体须显式传 ocrTextRead: true',
    );
  });
  test('否认命中时用 _appended 短路普通 ocrUsageFootnote(不叠加,避免心灵噪音)', () => {
    // _appended 置真后,普通 ocrUsageFootnote 分支被 if (!_appended) 跳过 → 同格只追加一条脚注。
    assert.match(SRC, /let _appended = false;/, '引入 _appended 门闩');
    assert.match(SRC, /_appended = true;/, 'OCR-成功变体追加后置真');
    assert.match(SRC, /if \(!_appended\) \{/, '普通脚注分支被 !_appended 守卫');
  });
  test('OCR-成功变体接缝在普通 ocrUsageFootnote 之前(否认优先)', () => {
    const ocrReadIdx = SRC.indexOf('ocrTextRead: true');
    const oufIdx = SRC.indexOf('_ouf.buildOcrUsageFootnote');
    assert.ok(ocrReadIdx > 0 && oufIdx > ocrReadIdx, 'OCR-成功变体须先判(否认优先),普通脚注为兜底 else');
  });
});
