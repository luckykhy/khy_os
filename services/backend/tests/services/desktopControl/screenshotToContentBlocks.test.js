'use strict';

/**
 * screenshotToContentBlocks.test.js — 截图 → 内容块转换的回归测试。
 *
 * 覆盖：当 os.tmpdir() 与 os.homedir() 不在同一根目录（例如 TMP=D:\tmp、
 * home=C:\Users\x）时，受管截图目录下的文件必须被接受——否则视觉内容块永远
 * 不会被注入，模型看不到屏幕，问「桌面上有什么」就只能靠 OCR 硬猜。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { convertScreenshot } = require('../../../src/services/desktopControl/screenshotToContentBlocks');

// 1x1 red PNG (valid magic + IHDR)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makePng(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(PNG_B64, 'base64'));
}

describe('convertScreenshot — 受管截图目录路径校验', () => {
  const origDir = process.env.KHY_SCREENSHOT_DIR;
  const origHome = os.homedir;
  let tmpRoot;

  beforeEach(() => {
    // 模拟 tmpdir 与 homedir 在不同根（回归场景：D:\tmp vs C:\Users\25789）
    tmpRoot = path.join(process.env.TEMP || os.tmpdir(), 'khy-stcb-test', `tmp_${Date.now()}`);
    process.env.KHY_SCREENSHOT_DIR = path.join(tmpRoot, 'khy-desktop', 'captures');
    // 冻结 homedir 为一个与 tmpRoot 无关的假根，确保校验只依赖 captures 目录。
    os.homedir = () => path.join(tmpRoot, 'fake_home');
  });

  afterEach(() => {
    if (origDir === undefined) delete process.env.KHY_SCREENSHOT_DIR;
    else process.env.KHY_SCREENSHOT_DIR = origDir;
    os.homedir = origHome;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('截图落在 os.tmpdir() 下（与 homedir 不同根）也能生成视觉内容块', async () => {
    const png = path.join(process.env.KHY_SCREENSHOT_DIR, 'screen_1.png');
    makePng(png);
    const blocks = await convertScreenshot(png, { modelId: 'gpt-4o' });
    expect(blocks.length).toBe(2);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
  });

  test('home 目录下的 PNG 依然被接受（原行为不回归）', async () => {
    const png = path.join(os.homedir(), 'Pictures', 'shot.png');
    makePng(png);
    const blocks = await convertScreenshot(png, { modelId: 'gpt-4o' });
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });

  test('受管目录之外的任意路径被拒绝（安全红线不放松）', async () => {
    const outside = path.join(tmpRoot, 'elsewhere', 'secret.png');
    makePng(outside);
    const blocks = await convertScreenshot(outside, { modelId: 'gpt-4o' });
    expect(blocks).toEqual([]);
  });
});
