'use strict';

/**
 * localBrainImageView.test.js — Tier-1「本地图片识别 / 看图」处理器回归。
 * 落一张最小合法 PNG 到临时文件,驱动 isImageViewIntent → detect → execute → format。
 * OCR 引擎在测试环境常缺失/图中无字 → 断言**优雅降级**(仍给出视觉描述,不抛、不谎报)。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const iv = require('../src/services/localBrainImageView');

/** 造一张最小合法 PNG(签名 + IHDR),尺寸 40×30,RGBA。 */
function writeTempPng(width = 40, height = 30) {
  const b = Buffer.alloc(26);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;   // bit depth
  b[25] = 6;   // RGBA
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-imgview-'));
  const p = path.join(dir, 'sample.png');
  fs.writeFileSync(p, b);
  return p;
}

describe('localBrainImageView — intent detection', () => {
  test('image extension + verb → intent true', () => {
    assert.equal(iv.isImageViewIntent('识别图片 ~/a.png'), true);
    assert.equal(iv.isImageViewIntent('看看 /tmp/x.jpg'), true);
    assert.equal(iv.isImageViewIntent('描述这张图 ./pic.webp'), true);
    assert.equal(iv.isImageViewIntent('recognize screenshot.PNG'), true);
  });

  test('bare image path (no verb) → intent true', () => {
    assert.equal(iv.isImageViewIntent('~/Pictures/photo.jpeg'), true);
    assert.equal(iv.isImageViewIntent('"/tmp/my shot.png"'), true);
  });

  test('non-image files never match (leaves file_view alone)', () => {
    assert.equal(iv.isImageViewIntent('查看 config.json'), false);
    assert.equal(iv.isImageViewIntent('看看 README.md'), false);
    assert.equal(iv.isImageViewIntent('cat main.py'), false);
  });

  test('unrelated text → false', () => {
    assert.equal(iv.isImageViewIntent('今天天气怎么样'), false);
    assert.equal(iv.isImageViewIntent(''), false);
    assert.equal(iv.isImageViewIntent('x'.repeat(400)), false);
  });

  test('gate off → intent always false', () => {
    const prev = process.env.KHY_LOCAL_IMAGE_VIEW;
    process.env.KHY_LOCAL_IMAGE_VIEW = '0';
    try {
      assert.equal(iv.isImageViewIntent('识别图片 ~/a.png'), false);
    } finally {
      if (prev === undefined) delete process.env.KHY_LOCAL_IMAGE_VIEW;
      else process.env.KHY_LOCAL_IMAGE_VIEW = prev;
    }
  });
});

describe('localBrainImageView — detect path extraction', () => {
  test('extracts bare path token', () => {
    const plan = iv.detectImageView('识别图片 /tmp/a.png', { cwd: '/tmp' });
    assert.equal(plan.type, 'image_view');
    assert.equal(plan.filePath, '/tmp/a.png');
    assert.equal(plan.label, 'a.png');
  });

  test('extracts quoted path with spaces', () => {
    const plan = iv.detectImageView('看看 "/tmp/my shot.png"', { cwd: '/tmp' });
    assert.equal(plan.filePath, '/tmp/my shot.png');
  });
});

describe('localBrainImageView — execute + format (real temp PNG)', () => {
  test('execute reads header, describes dims, degrades OCR gracefully', () => {
    const p = writeTempPng(40, 30);
    try {
      const plan = iv.detectImageView(`识别图片 ${p}`, { cwd: path.dirname(p) });
      const result = iv.executeImageView(plan);
      assert.equal(result.success, true);
      assert.equal(result.meta.format, 'png');
      assert.equal(result.meta.width, 40);
      assert.equal(result.meta.height, 30);
      assert.match(result.description, /PNG/);
      assert.match(result.description, /40×30/);
      // OCR present as a shaped object regardless of engine availability.
      assert.ok(result.ocr && typeof result.ocr.available === 'boolean');

      const out = iv.formatImageView(result);
      assert.match(out, /本地识别.*未使用模型|未使用模型/);
      assert.match(out, /40×30/);
      // Never fabricates image content: if OCR unavailable, says so honestly.
      if (!result.ocr.available) assert.match(out, /未提取到文字/);
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  test('missing file → honest failure', () => {
    const result = iv.executeImageView({ type: 'image_view', filePath: '/tmp/does-not-exist-xyz.png' });
    assert.equal(result.success, false);
    assert.match(result.error, /不存在/);
    assert.match(iv.formatImageView(result), /失败/);
  });

  test('non-image file → honest "无法识别为图片"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-imgview-'));
    const p = path.join(dir, 'fake.png');
    fs.writeFileSync(p, 'this is plain text, not an image');
    try {
      const result = iv.executeImageView({ type: 'image_view', filePath: p });
      assert.equal(result.success, false);
      assert.match(result.error, /无法识别为图片/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('localBrainImageView — registered in localBrainService Tier-1', () => {
  test('image_view executor + formatter wired, before file_view', () => {
    const lb = require('../src/services/localBrainService');
    // No-model deterministic dispatch should route an image path to image_view.
    const p = writeTempPng(20, 20);
    try {
      const plan = lb.detectDeterministic(`识别图片 ${p}`, { cwd: path.dirname(p) });
      assert.ok(plan, 'plan should be produced');
      assert.equal(plan.type, 'image_view');
      const result = lb.executeDeterministic(plan, { cwd: path.dirname(p) });
      assert.equal(result.type, 'image_view');
      assert.equal(result.success, true);
      const formatted = lb.formatDeterministicResult(result);
      assert.match(formatted, /20×20/);
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });
});
