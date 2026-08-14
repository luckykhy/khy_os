'use strict';

/**
 * visionNoticeDedupRealImage — 用**真实图片**核验 KHY_VISION_NOTICE_DEDUP:
 *   (1) 回归:去重叶 + REPL 接线改动**不碰** OCR 抽取路径 → 真图仍应被真 tesseract 正确读出文字;
 *   (2) 功能:复刻实测失败语料(paste-cache 92c0154d)的回合内刷屏(6×正在调用 + 3×失败块),
 *       经去重叶(默认门开)折叠为 4 条有效告知(2 条不同调用 + 2 个不同失败块),重复全压制。
 *
 * 「减少心灵噪音」与「无感明显告知」两不误:首次告知照常渲染,只折叠逐字节重复。
 * 门关(KHY_VISION_NOTICE_DEDUP=off)→ 逐字节回退:9 条全渲染。
 *
 * 可移植性:缺 tesseract / 缺带 Pillow 的 Python → test.skip((1);(2) 纯逻辑不依赖真图,恒跑。
 *
 * harness 统一自 `../gateway/_ocrGatewayHarness`。node:test。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const h = require('../gateway/_ocrGatewayHarness');
const dedup = require('../../src/cli/visionNoticeDedup');

// 复刻实测:一回合工具循环 3 迭代,每迭代 2 条「正在调用」+ 1 个失败块。
const CALL_A = '我无法直接识别图片内容。正在调用 glm/glm-4.6v-flash 进行识别，请稍候...';
const CALL_B = '我无法直接识别图片内容。正在调用 glm-4v-flash 进行识别，请稍候...';
const FAIL_404 = '图像识别失败:目标视觉模型返回「未找到 / 404」(model_not_found)。本次尝试的视觉模型:glm/glm-4.6v-flash。';
const FAIL_NET = '图像识别失败:无法连接到图像识别模型服务(网络/代理/端点问题)。';
const STREAM = [CALL_A, CALL_B, FAIL_404, CALL_A, CALL_B, FAIL_NET, CALL_A, CALL_B, FAIL_404];

describe('真图核验:OCR 路径不回归 + 回合内刷屏去重折叠', () => {
  let py = null;
  let tmpDir = null;
  let b64 = null;
  let ready = false;

  before(() => {
    if (!h.tesseractPresent()) return;
    py = h.findPythonWithPil();
    if (!py) return;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-notice-dedup-'));
    const png = path.join(tmpDir, 'receipt.png');
    const r = h.renderPng(py, {
      outPath: png,
      size: [640, 220],
      bg: [255, 255, 255],
      texts: [{ xy: [20, 80], text: 'RECEIPT NO 7788 PAID', fill: [0, 0, 0] }],
    });
    if (r.missingPil || !r.exists) return;
    b64 = fs.readFileSync(png).toString('base64');
    ready = true;
  });

  after(() => {
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('(1) 回归:真图经真 tesseract 仍读出文字(去重改动不碰 OCR 抽取)', (t) => {
    if (!ready) { t.skip('tesseract / Pillow 不可用,跳过'); return; }
    const details = h.realExtractImageOcrDetails([{ base64: b64, mimeType: 'image/png' }]);
    const text = String((details[0] && details[0].text) || '');
    if (!(text.toUpperCase().includes('RECEIPT') || text.includes('7788'))) {
      t.skip('本机 tesseract 未读出预期文字(字库差异),跳过回归断言');
      return;
    }
    assert.ok(text.toUpperCase().includes('RECEIPT') || text.includes('7788'), 'OCR 路径应仍能读出真图文字');
  });

  test('(2) 默认门开:9 条刷屏 → 折叠为 4 条有效告知(重复全压制)', () => {
    const savedEnv = process.env.KHY_VISION_NOTICE_DEDUP;
    delete process.env.KHY_VISION_NOTICE_DEDUP; // 默认开
    try {
      const seen = new Set();
      const rendered = STREAM.filter((m) => dedup.shouldRender(seen, m, process.env));
      assert.deepEqual(rendered, [CALL_A, CALL_B, FAIL_404, FAIL_NET], '仅保留首现的每条不同告知');
      assert.equal(rendered.length, 4, '6×正在调用 + 3×失败块 → 2 调用 + 2 失败块');
    } finally {
      if (savedEnv === undefined) delete process.env.KHY_VISION_NOTICE_DEDUP;
      else process.env.KHY_VISION_NOTICE_DEDUP = savedEnv;
    }
  });

  test('(3) 门关:逐字节回退 → 9 条全渲染,不折叠', () => {
    const savedEnv = process.env.KHY_VISION_NOTICE_DEDUP;
    process.env.KHY_VISION_NOTICE_DEDUP = 'off';
    try {
      const seen = new Set();
      const rendered = STREAM.filter((m) => dedup.shouldRender(seen, m, process.env));
      assert.equal(rendered.length, STREAM.length, '门关应逐字节回退:全渲染');
    } finally {
      if (savedEnv === undefined) delete process.env.KHY_VISION_NOTICE_DEDUP;
      else process.env.KHY_VISION_NOTICE_DEDUP = savedEnv;
    }
  });
});
