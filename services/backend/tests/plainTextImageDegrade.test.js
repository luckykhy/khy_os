'use strict';

const test = require('node:test');
const assert = require('node:assert');

const mod = require('../src/services/gateway/plainTextImageDegrade');

test('isImageBlock: recognizes Anthropic and OpenAI image shapes', () => {
  assert.strictEqual(mod.isImageBlock({ type: 'image', source: { media_type: 'image/png' } }), true);
  assert.strictEqual(mod.isImageBlock({ type: 'image_url', image_url: { url: 'http://x/y.png' } }), true);
  assert.strictEqual(mod.isImageBlock({ type: 'text', text: 'hi' }), false);
  assert.strictEqual(mod.isImageBlock({ type: 'tool_use' }), false);
  assert.strictEqual(mod.isImageBlock(null), false);
  assert.strictEqual(mod.isImageBlock('image'), false);
});

test('extractImageMime: from Anthropic source.media_type', () => {
  assert.strictEqual(
    mod.extractImageMime({ type: 'image', source: { type: 'base64', media_type: 'image/JPEG', data: 'x' } }),
    'image/jpeg'
  );
});

test('extractImageMime: from OpenAI data URL', () => {
  assert.strictEqual(
    mod.extractImageMime({ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } }),
    'image/webp'
  );
});

test('extractImageMime: empty when only an http url (no embedded mime)', () => {
  assert.strictEqual(mod.extractImageMime({ type: 'image_url', image_url: { url: 'https://x/y.png' } }), '');
  assert.strictEqual(mod.extractImageMime({ type: 'image' }), '');
});

test('describeImagePlaceholder: bare placeholder without mime, typed with mime', () => {
  assert.strictEqual(mod.describeImagePlaceholder({ type: 'image_url', image_url: { url: 'https://x/y' } }), '[image]');
  assert.strictEqual(
    mod.describeImagePlaceholder({ type: 'image', source: { media_type: 'image/png' } }),
    '[image: image/png]'
  );
  assert.strictEqual(mod.IMAGE_PLACEHOLDER, '[image]');
});

test('countImageBlocks: counts only image blocks in a content array', () => {
  const content = [
    { type: 'text', text: 'a' },
    { type: 'image', source: { media_type: 'image/png' } },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } },
    { type: 'tool_use', id: '1', name: 'x' },
  ];
  assert.strictEqual(mod.countImageBlocks(content), 2);
  assert.strictEqual(mod.countImageBlocks('plain string'), 0);
  assert.strictEqual(mod.countImageBlocks(null), 0);
});

test('countImagesInMessages: sums across messages', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image', source: { media_type: 'image/png' } }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
  ];
  assert.strictEqual(mod.countImagesInMessages(messages), 2);
  assert.strictEqual(mod.countImagesInMessages(null), 0);
});

test('buildTextModelImageNotice: produces a Chinese notice for positive counts', () => {
  const notice = mod.buildTextModelImageNotice(2);
  assert.match(notice, /2 张图片/);
  assert.match(notice, /不支持视觉/);
  assert.ok(notice.startsWith('\n\n['));
});

test('buildTextModelImageNotice: empty for zero / invalid counts', () => {
  assert.strictEqual(mod.buildTextModelImageNotice(0), '');
  assert.strictEqual(mod.buildTextModelImageNotice(-3), '');
  assert.strictEqual(mod.buildTextModelImageNotice(NaN), '');
  assert.strictEqual(mod.buildTextModelImageNotice(undefined), '');
});
