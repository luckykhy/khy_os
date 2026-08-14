'use strict';

/**
 * cliToolAdapterImages.test.js — CLI 桥接图片接力。
 *
 * 钉死「前端上传图片 → CLI 工具桥（Claude Code 等）能拿到图片」这条线：
 *   网关把 options.images（dataUrl 字符串）传给只收文本 prompt 的 CLI 适配器，
 *   适配器必须把每张图落地为临时文件、在 prompt 里给出绝对路径（供 Read 工具读取），
 *   并在调用结束后清理临时目录。否则图片被静默丢弃，模型如实回「未收到图片」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const {
  _decodeImageEntry,
  _materializeImages,
  _cleanupImageDir,
  _buildImagePromptBlock,
} = require('../../../src/services/gateway/adapters/cliToolAdapter').__test__;

const PNG_DATAURL = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
const JPG_DATAURL = 'data:image/jpeg;base64,' + Buffer.from('fake-jpg-bytes').toString('base64');

test('decode: dataUrl → buffer + correct extension', () => {
  const png = _decodeImageEntry(PNG_DATAURL);
  assert.strictEqual(png.ext, '.png');
  assert.strictEqual(png.buf.toString(), 'fake-png-bytes');

  const jpg = _decodeImageEntry(JPG_DATAURL);
  assert.strictEqual(jpg.ext, '.jpg');
});

test('decode: object form {data,mediaType} and bare base64', () => {
  const obj = _decodeImageEntry({ data: Buffer.from('x').toString('base64'), mediaType: 'image/webp' });
  assert.strictEqual(obj.ext, '.webp');
  const bare = _decodeImageEntry(Buffer.from('y').toString('base64'));
  assert.strictEqual(bare.ext, '.png'); // unknown mime → png default
  assert.strictEqual(bare.buf.toString(), 'y');
});

test('decode: garbage / empty → null (never throws)', () => {
  assert.strictEqual(_decodeImageEntry(''), null);
  assert.strictEqual(_decodeImageEntry('data:image/png;base64,'), null);
  assert.strictEqual(_decodeImageEntry(null), null);
  assert.strictEqual(_decodeImageEntry(123), null);
});

test('materialize: writes real files then cleanup removes them', () => {
  const mat = _materializeImages([PNG_DATAURL, JPG_DATAURL]);
  assert.ok(mat && mat.paths.length === 2, 'two files materialized');
  for (const p of mat.paths) {
    assert.ok(fs.existsSync(p), `file exists: ${p}`);
  }
  assert.ok(mat.paths[0].endsWith('.png'));
  assert.ok(mat.paths[1].endsWith('.jpg'));

  _cleanupImageDir(mat.dir);
  for (const p of mat.paths) {
    assert.ok(!fs.existsSync(p), `file removed: ${p}`);
  }
  assert.ok(!fs.existsSync(mat.dir), 'temp dir removed');
});

test('materialize: empty / undefined → null (no temp dir)', () => {
  assert.strictEqual(_materializeImages([]), null);
  assert.strictEqual(_materializeImages(undefined), null);
  assert.strictEqual(_materializeImages('not-an-array'), null);
});

test('materialize: all-garbage entries → null and no leaked dir', () => {
  assert.strictEqual(_materializeImages(['', null, 'data:image/png;base64,']), null);
});

test('prompt block: references every path and forbids "no image" reply', () => {
  const block = _buildImagePromptBlock(['/tmp/a.png', '/tmp/b.jpg']);
  assert.match(block, /\/tmp\/a\.png/);
  assert.match(block, /\/tmp\/b\.jpg/);
  assert.match(block, /Read/);
  assert.match(block, /未收到图片/);
  assert.match(block, /2 张图片/);
});

test('generate: image path block reaches the tool prompt; temp dir cleaned after', async () => {
  // True end-to-end through generate(): swap detected tools for a real `cat`
  // that echoes its stdin prompt back as "content". Whatever generate() feeds
  // the subprocess is exactly what we get back — so the echoed content must
  // contain the materialized image path block, proving images reach the bridge.
  const mod = require('../../../src/services/gateway/adapters/cliToolAdapter');
  const TOOLS = mod.TOOLS;
  const original = TOOLS.slice();

  TOOLS.length = 0;
  TOOLS.push({
    name: 'EchoCat',
    cmd: 'cat',
    buildArgs: () => [],
    useStdin: true,
    streaming: false,
    priority: 1,
    supportsImageFiles: true, // vision-capable tool → receives the image block
  });
  mod.detect(true); // refresh detection cache against the stubbed TOOLS

  try {
    const res = await mod.generate('看一下这张图', { images: [PNG_DATAURL] });
    assert.strictEqual(res.success, true);
    const echoed = String(res.content || '');
    // The image prompt block (with Read instruction + path) round-tripped through cat.
    assert.match(echoed, /【图片附件】/);
    assert.match(echoed, /Read/);
    const m = echoed.match(/(\/.*khy-cli-img-[^\s]+image-1-[0-9a-f]+\.png)/);
    assert.ok(m, 'echoed content includes the materialized image path');
    // generate() cleans up the temp dir in its finally → the file is gone now.
    assert.ok(!fs.existsSync(m[1]), 'temp image file removed after generate()');
  } finally {
    TOOLS.length = 0; TOOLS.push(...original);
    mod.detect(true);
  }
});

test('generate: tool WITHOUT supportsImageFiles gets no image block (gating)', async () => {
  // Codex/Aider lack file-vision: they must NOT receive the "Read these files"
  // directive, only the plain prompt. EchoCat here omits supportsImageFiles.
  const mod = require('../../../src/services/gateway/adapters/cliToolAdapter');
  const TOOLS = mod.TOOLS;
  const original = TOOLS.slice();
  TOOLS.length = 0;
  TOOLS.push({ name: 'EchoCat', cmd: 'cat', buildArgs: () => [], useStdin: true, streaming: false, priority: 1 });
  mod.detect(true);
  try {
    const res = await mod.generate('看一下这张图', { images: [PNG_DATAURL] });
    assert.strictEqual(res.success, true);
    const echoed = String(res.content || '');
    assert.doesNotMatch(echoed, /【图片附件】/);
    assert.doesNotMatch(echoed, /khy-cli-img-/);
    assert.match(echoed, /看一下这张图/); // plain prompt still passes through
  } finally {
    TOOLS.length = 0; TOOLS.push(...original);
    mod.detect(true);
  }
});

test('TOOLS: only Claude Code declares supportsImageFiles', () => {
  const mod = require('../../../src/services/gateway/adapters/cliToolAdapter');
  const capable = mod.TOOLS.filter(t => t.supportsImageFiles);
  assert.strictEqual(capable.length, 1);
  assert.strictEqual(capable[0].name, 'Claude Code');
});

test('generate: no images → no image block, normal prompt passes through', async () => {
  const mod = require('../../../src/services/gateway/adapters/cliToolAdapter');
  const TOOLS = mod.TOOLS;
  const original = TOOLS.slice();
  TOOLS.length = 0;
  TOOLS.push({ name: 'EchoCat', cmd: 'cat', buildArgs: () => [], useStdin: true, streaming: false, priority: 1 });
  mod.detect(true);
  try {
    const res = await mod.generate('只是文字提问', {});
    assert.strictEqual(res.success, true);
    assert.doesNotMatch(String(res.content || ''), /【图片附件】/);
    assert.match(String(res.content || ''), /只是文字提问/);
  } finally {
    TOOLS.length = 0; TOOLS.push(...original);
    mod.detect(true);
  }
});
