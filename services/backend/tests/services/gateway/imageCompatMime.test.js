'use strict';

/**
 * imageCompatMime.test.js — MIME canonicalization (jpg → jpeg, etc.).
 *
 * Strict vision APIs (Anthropic/Google) only accept IANA media types.
 * `image/jpg` is a non-standard label for the SAME bytes as `image/jpeg`;
 * normalization must relabel it so the request is not rejected.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  canonicalMime,
  normalizeImageItem,
  toAnthropicImageBlocks,
  toGoogleInlineData,
} = require('../../../src/services/gateway/adapters/_imageCompat');

const B64 = Buffer.from('jpeg-bytes').toString('base64');

test('canonicalMime: relabels non-standard aliases, leaves standard untouched', () => {
  assert.strictEqual(canonicalMime('image/jpg'), 'image/jpeg');
  assert.strictEqual(canonicalMime('IMAGE/JPG'), 'image/jpeg'); // case-insensitive
  assert.strictEqual(canonicalMime('image/pjpeg'), 'image/jpeg');
  assert.strictEqual(canonicalMime('image/x-png'), 'image/png');
  assert.strictEqual(canonicalMime('image/svg'), 'image/svg+xml');
  assert.strictEqual(canonicalMime('image/jpeg'), 'image/jpeg');
  assert.strictEqual(canonicalMime('image/png'), 'image/png');
  assert.strictEqual(canonicalMime(''), 'image/png'); // empty → default
});

test('normalizeImageItem: dataUrl image/jpg normalized to image/jpeg', () => {
  const norm = normalizeImageItem(`data:image/jpg;base64,${B64}`);
  assert.strictEqual(norm.mimeType, 'image/jpeg');
  assert.match(norm.dataUrl, /^data:image\/jpeg;base64,/);
});

test('normalizeImageItem: object {mimeType:"image/jpg"} normalized', () => {
  const norm = normalizeImageItem({ base64: B64, mimeType: 'image/jpg' });
  assert.strictEqual(norm.mimeType, 'image/jpeg');
});

test('toAnthropicImageBlocks: emits accepted media_type image/jpeg for jpg input', () => {
  const blocks = toAnthropicImageBlocks([`data:image/jpg;base64,${B64}`]);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].source.media_type, 'image/jpeg');
});

test('toGoogleInlineData: emits image/jpeg for jpg input', () => {
  const blocks = toGoogleInlineData([{ base64: B64, mimeType: 'image/jpg' }]);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].inlineData.mimeType, 'image/jpeg');
});
