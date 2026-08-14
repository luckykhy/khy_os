/**
 * imageDetect.test.js — unit tests for image_detect tool.
 *
 * The aiGateway is mocked so no real model is called. A small temp PNG fixture
 * is written so the FS validation passes. Tests assert: schema, mode prompt
 * routing, success passthrough of model content, vision-unavailable failure,
 * and input validation (missing file, unsupported format).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const mockGenerate = jest.fn();
jest.mock('../../src/services/gateway/aiGateway', () => ({
  generate: (...args) => mockGenerate(...args),
}));

const imageDetect = require('../../src/tools/imageDetect');

// Minimal valid PNG (1x1 transparent) header bytes.
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082',
  'hex'
);

describe('image_detect tool', () => {
  let tmpDir;
  let imgPath;

  beforeEach(() => {
    mockGenerate.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgdet-'));
    imgPath = path.join(tmpDir, 'pic.png');
    fs.writeFileSync(imgPath, PNG_1x1);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('schema requires imagePath and exposes read-only metadata', () => {
    expect(imageDetect.name).toBe('image_detect');
    expect(imageDetect.category).toBe('analysis');
    expect(imageDetect.isReadOnly()).toBe(true);
    expect(imageDetect.isConcurrencySafe()).toBe(true);

    const missing = imageDetect.validate({});
    expect(missing.valid).toBe(false);

    const ok = imageDetect.validate({ imagePath: '/tmp/x.png', mode: 'objects' });
    expect(ok.valid).toBe(true);

    const badMode = imageDetect.validate({ imagePath: '/tmp/x.png', mode: 'nope' });
    expect(badMode.valid).toBe(false);
  });

  test('default mode is objects and passes image to gateway', async () => {
    mockGenerate.mockResolvedValue({ success: true, content: '| Object | Count |\n| cat | 1 |', model: 'claude-vision' });

    const res = await imageDetect.execute({ imagePath: imgPath });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [prompt, opts] = mockGenerate.mock.calls[0];
    expect(prompt).toMatch(/detect and list all distinct objects/i);
    expect(Array.isArray(opts.images)).toBe(true);
    expect(opts.images[0].mimeType).toBe('image/png');
    expect(typeof opts.images[0].base64).toBe('string');

    expect(res.success).toBe(true);
    expect(res.content).toContain('cat');
    expect(res.meta.mode).toBe('objects');
    expect(res.meta.model).toBe('claude-vision');
  });

  test('mode=scene uses scene prompt', async () => {
    mockGenerate.mockResolvedValue({ success: true, content: 'A street scene.', provider: 'qwen' });

    const res = await imageDetect.execute({ imagePath: imgPath, mode: 'scene' });

    const [prompt] = mockGenerate.mock.calls[0];
    expect(prompt).toMatch(/describe this image/i);
    expect(res.meta.mode).toBe('scene');
    expect(res.meta.model).toBe('qwen');
  });

  test('query is appended to the prompt', async () => {
    mockGenerate.mockResolvedValue({ success: true, content: '3 red cars', model: 'm' });

    await imageDetect.execute({ imagePath: imgPath, query: 'how many cars are red?' });

    const [prompt] = mockGenerate.mock.calls[0];
    expect(prompt).toContain('how many cars are red?');
  });

  test('vision-unavailable failure surfaces a helpful message', async () => {
    mockGenerate.mockResolvedValue({ success: false, content: 'no vision adapter' });

    const res = await imageDetect.execute({ imagePath: imgPath });

    expect(res.success).toBe(false);
    expect(res.content).toMatch(/vision-capable/i);
  });

  test('gateway throwing is caught', async () => {
    mockGenerate.mockRejectedValue(new Error('boom'));

    const res = await imageDetect.execute({ imagePath: imgPath });

    expect(res.success).toBe(false);
    expect(res.content).toContain('boom');
  });

  test('missing file fails before calling the model', async () => {
    const res = await imageDetect.execute({ imagePath: path.join(tmpDir, 'nope.png') });
    expect(res.success).toBe(false);
    expect(res.content).toContain('not found');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test('unsupported format fails before calling the model', async () => {
    const txt = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(txt, 'hello');
    const res = await imageDetect.execute({ imagePath: txt });
    expect(res.success).toBe(false);
    expect(res.content).toContain('Unsupported');
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
