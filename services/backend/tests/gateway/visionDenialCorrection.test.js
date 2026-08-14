'use strict';

/**
 * visionDenialCorrection.test.js — 纯叶子单测(OPS-MAN-138)。
 *
 * 叶子职责:空 OCR 剥图路径上「模型仍谎称没收到图」的**确定性纠正脚注**。四个导出:
 *   · isEnabled(env) — 门 KHY_VISION_DENIAL_CORRECTION,default-on(经 flagRegistry),仅 CANON off-words 关。
 *   · detectImageDenial(content) — 正文是否在**否认收到图**(命中否认句且未同时承认);承认「收到图但读不出」→ false。
 *   · buildDenialCorrectionNote({count,env}) — 门开 → 用户可见纠正脚注(含 marker);门关 → null。
 *   · DENIAL_CORRECTION_MARKER — 去重标记。
 * 全程零 IO、绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const BE = require('path').resolve(__dirname, '..', '..');
const vdc = require(BE + '/src/services/gateway/visionDenialCorrection');

describe('visionDenialCorrection.isEnabled', () => {
  test('FLAG 名', () => {
    assert.equal(vdc.FLAG, 'KHY_VISION_DENIAL_CORRECTION');
  });
  test('默认开(空 env)', () => {
    assert.equal(vdc.isEnabled({}), true);
  });
  test('仅 CANON off-words 关', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(vdc.isEnabled({ KHY_VISION_DENIAL_CORRECTION: off }), false, `off ${off}`);
    }
  });
  test('其他真值/杂串 → 开', () => {
    for (const on of ['1', 'true', 'on', 'yes', 'whatever']) {
      assert.equal(vdc.isEnabled({ KHY_VISION_DENIAL_CORRECTION: on }), true, `on ${on}`);
    }
  });
});

describe('visionDenialCorrection.detectImageDenial', () => {
  test('实测语料:模型否认收到图 → true', () => {
    // 取自 paste-cache 92c0154d 真实失败语料。
    assert.equal(vdc.detectImageDenial('我注意到你发了一条结构化提示，但消息里没有附带图片。'), true);
    assert.equal(vdc.detectImageDenial('关键发现：当前对话中没有任何图片附件。'), true);
    assert.equal(vdc.detectImageDenial('你发送的是一条纯文本的结构化提示，没有附带任何图片文件、URL 或 data URI。'), true);
    assert.equal(vdc.detectImageDenial('我无法描述不存在的内容。'), true);
  });
  test('其他常见否认表述 → true', () => {
    assert.equal(vdc.detectImageDenial('我没有收到图片'), true);
    assert.equal(vdc.detectImageDenial('未收到图片,请重新发送'), true);
    assert.equal(vdc.detectImageDenial('没有图片附件'), true);
    assert.equal(vdc.detectImageDenial('图片并未成功上传'), true);
  });
  test('模型已诚实承认「收到图但读不出」→ false(合规,不纠正)', () => {
    assert.equal(vdc.detectImageDenial('我收到了你的图片,但当前通道读不出它的内容'), false);
    assert.equal(vdc.detectImageDenial('当前模型不支持视觉,无法识别图片内容'), false);
    // 承认句 + 否认词共现(罕见)→ 视为已承认,不纠正,避免与模型自己的说明打架。
    assert.equal(vdc.detectImageDenial('我收到了图片,但没有办法直接看图片,建议换模型'), false);
    assert.equal(vdc.detectImageDenial('已通过 OCR 读取,但没有读到清晰的图片文字'), false);
  });
  test('正常作答(既不否认也不承认)→ false', () => {
    assert.equal(vdc.detectImageDenial('发票金额是 100 元'), false);
    assert.equal(vdc.detectImageDenial('这是一段普通回复,没有涉及任何视觉话题'), false);
  });
  test('畸形输入 fail-soft → false', () => {
    assert.equal(vdc.detectImageDenial(''), false);
    assert.equal(vdc.detectImageDenial(null), false);
    assert.equal(vdc.detectImageDenial(undefined), false);
    assert.equal(vdc.detectImageDenial(123), false);
    assert.equal(vdc.detectImageDenial({}), false);
  });
});

describe('visionDenialCorrection.buildDenialCorrectionNote', () => {
  test('门开 + count=1 → 单数纠正脚注,含 marker + 「已经收到」措辞 + 方案', () => {
    const s = vdc.buildDenialCorrectionNote({ count: 1, env: {} });
    assert.ok(typeof s === 'string' && s.length > 0);
    assert.ok(s.includes(vdc.DENIAL_CORRECTION_MARKER), '含去重 marker');
    assert.match(s, /1 张图片/, '单数措辞');
    assert.match(s, /已经收到/, '明确「图片已收到」纠正');
    assert.match(s, /并非「没有图片」/, '直接反驳否认');
    assert.match(s, /khy gateway model/, '给出换视觉模型方案');
  });
  test('门开 + count=3 → 复数措辞', () => {
    const s = vdc.buildDenialCorrectionNote({ count: 3, env: {} });
    assert.match(s, /3 张图片/, '复数措辞');
  });
  test('count 缺失/畸形 → 泛称「图片」但仍追加(门开即纠正)', () => {
    const s = vdc.buildDenialCorrectionNote({ env: {} });
    assert.ok(typeof s === 'string' && s.includes(vdc.DENIAL_CORRECTION_MARKER));
    assert.match(s, /你确实上传了图片/, '泛称仍纠正');
    const s2 = vdc.buildDenialCorrectionNote({ count: 0, env: {} });
    assert.ok(typeof s2 === 'string' && s2.includes(vdc.DENIAL_CORRECTION_MARKER), 'count=0 仍泛称追加');
  });
  test('门关 → null(逐字节回退)', () => {
    assert.equal(vdc.buildDenialCorrectionNote({ count: 1, env: { KHY_VISION_DENIAL_CORRECTION: 'off' } }), null);
    assert.equal(vdc.buildDenialCorrectionNote({ count: 5, env: { KHY_VISION_DENIAL_CORRECTION: '0' } }), null);
  });
  test('无参 fail-soft → null(不抛)', () => {
    // 无 env → 落 process.env(默认开),但无 count → 泛称仍可能追加;此处仅验不抛。
    assert.doesNotThrow(() => vdc.buildDenialCorrectionNote());
  });
});

// ── OCR-成功变体(OPS-MAN-140):OCR 已读出文本、模型仍否认收到图 → 否认感知纠正 ──────────
describe('visionDenialCorrection.isOcrReadDenialEnabled(OPS-140 子门)', () => {
  test('OCR_READ_FLAG 名', () => {
    assert.equal(vdc.OCR_READ_FLAG, 'KHY_VISION_DENIAL_CORRECTION_OCR_READ');
  });
  test('默认开(空 env)', () => {
    assert.equal(vdc.isOcrReadDenialEnabled({}), true);
  });
  test('仅 CANON off-words 关', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      assert.equal(vdc.isOcrReadDenialEnabled({ KHY_VISION_DENIAL_CORRECTION_OCR_READ: off }), false, `off ${off}`);
    }
  });
  test('子门与父门正交独立:父门关不影响子门,子门关不影响父门', () => {
    // 父门关、子门默认开 → OCR-成功变体仍出。
    assert.equal(vdc.isOcrReadDenialEnabled({ KHY_VISION_DENIAL_CORRECTION: 'off' }), true);
    // 子门关、父门默认开 → 空 OCR 变体仍出。
    assert.equal(vdc.isEnabled({ KHY_VISION_DENIAL_CORRECTION_OCR_READ: 'off' }), true);
  });
});

describe('visionDenialCorrection.buildDenialCorrectionNote(ocrTextRead:true)', () => {
  test('门开 + count=1 → OCR-成功纠正:独立 marker + 「已成功读出」+ 「据 OCR 重新作答」出路', () => {
    const s = vdc.buildDenialCorrectionNote({ count: 1, env: {}, ocrTextRead: true });
    assert.ok(typeof s === 'string' && s.length > 0);
    assert.ok(s.includes(vdc.DENIAL_CORRECTION_OCR_READ_MARKER), '含 OCR-成功变体去重 marker');
    assert.ok(!s.includes(vdc.DENIAL_CORRECTION_MARKER), '不含空 OCR 变体 marker(两 marker 互斥)');
    assert.match(s, /1 张图片/, '单数措辞');
    assert.match(s, /已成功读出/, '点明 OCR 已读出文字(区别空 OCR 变体的「未能读出」)');
    assert.match(s, /并非「没有图片」/, '直接反驳否认');
    assert.match(s, /据 OCR/, '给出「据 OCR 文本重新作答」出路');
    assert.ok(!/未能从图中读出文字/.test(s), '绝不复用空 OCR 变体「未能读出」措辞');
  });
  test('门开 + count=2 → 复数措辞', () => {
    const s = vdc.buildDenialCorrectionNote({ count: 2, env: {}, ocrTextRead: true });
    assert.match(s, /2 张图片/, '复数措辞');
  });
  test('子门关 → null(逐字节回退到普通 ocrUsageFootnote 分支)', () => {
    assert.equal(vdc.buildDenialCorrectionNote({ count: 1, env: { KHY_VISION_DENIAL_CORRECTION_OCR_READ: 'off' }, ocrTextRead: true }), null);
    assert.equal(vdc.buildDenialCorrectionNote({ count: 3, env: { KHY_VISION_DENIAL_CORRECTION_OCR_READ: '0' }, ocrTextRead: true }), null);
  });
  test('变体隔离:OCR-成功变体只看子门,不受父门关影响', () => {
    // 父门关、子门默认开 → OCR-成功变体仍出(证两门独立)。
    const s = vdc.buildDenialCorrectionNote({ count: 1, env: { KHY_VISION_DENIAL_CORRECTION: 'off' }, ocrTextRead: true });
    assert.ok(typeof s === 'string' && s.includes(vdc.DENIAL_CORRECTION_OCR_READ_MARKER));
  });
  test('隔离反向:空 OCR 变体只看父门,不受子门关影响(既有行为逐字节不变)', () => {
    const s = vdc.buildDenialCorrectionNote({ count: 1, env: { KHY_VISION_DENIAL_CORRECTION_OCR_READ: 'off' } });
    assert.ok(typeof s === 'string' && s.includes(vdc.DENIAL_CORRECTION_MARKER), '空 OCR 变体不受子门关影响');
  });
  test('ocrTextRead 缺省 → 走空 OCR 变体(既有行为,含旧 marker)', () => {
    const s = vdc.buildDenialCorrectionNote({ count: 1, env: {} });
    assert.ok(s.includes(vdc.DENIAL_CORRECTION_MARKER) && !s.includes(vdc.DENIAL_CORRECTION_OCR_READ_MARKER));
  });
});
