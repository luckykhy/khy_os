'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { contentToText, flattenContent } = require('../src/services/contentBlockUtils');

test('contentToText: image block degrades to a placeholder, never silently dropped', () => {
  const content = [
    { type: 'text', text: 'Look at this:' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ];
  const out = contentToText(content);
  assert.match(out, /Look at this:/);
  assert.match(out, /\[image: image\/png\]/);
});

test('contentToText: OpenAI image_url block also degrades to a placeholder', () => {
  const content = [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }];
  const out = contentToText(content);
  assert.strictEqual(out, '[image]');
});

test('contentToText: image-only content yields the placeholder (not empty string)', () => {
  const content = [{ type: 'image', source: { media_type: 'image/jpeg' } }];
  assert.strictEqual(contentToText(content), '[image: image/jpeg]');
});

test('flattenContent: same degradation behavior (alias of contentToText)', () => {
  const content = [
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'data:image/webp;base64,AA' } },
  ];
  assert.strictEqual(flattenContent(content), 'hi\n[image: image/webp]');
});

test('contentToText: text-only path is byte-for-byte unchanged (zero regression)', () => {
  assert.strictEqual(contentToText('plain'), 'plain');
  assert.strictEqual(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.strictEqual(contentToText(null), '');
});
