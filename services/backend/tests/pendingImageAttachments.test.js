'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const attachments = require('../src/cli/tui/pendingImageAttachments');

const image = (base64) => ({ base64, mimeType: 'image/png' });

test('两张图片显示为图1和图2，并保留稳定 id', () => {
  let list = attachments.appendAttachment([], image('aaa'), 'img-a');
  list = attachments.appendAttachment(list, image('bbb'), 'img-b');

  assert.deepEqual(attachments.labels(list), [
    { id: 'img-a', label: '图1' },
    { id: 'img-b', label: '图2' },
  ]);
});

test('删除图2只移除对应载荷，图1仍可发送', () => {
  const original = [
    { id: 'img-a', ...image('aaa') },
    { id: 'img-b', ...image('bbb') },
  ];
  const remaining = attachments.removeAttachment(original, 'img-b');

  assert.deepEqual(attachments.labels(remaining), [{ id: 'img-a', label: '图1' }]);
  assert.deepEqual(attachments.toPayload(remaining), [image('aaa')]);
});

test('删除图1后原图2保留并重新显示为图1', () => {
  const original = [
    { id: 'img-a', ...image('aaa') },
    { id: 'img-b', ...image('bbb') },
  ];
  const remaining = attachments.removeAttachment(original, 'img-a');

  assert.deepEqual(attachments.labels(remaining), [{ id: 'img-b', label: '图1' }]);
  assert.deepEqual(attachments.toPayload(remaining), [image('bbb')]);
});

test('发送 payload 会剥离 UI id，删除末张保持前项', () => {
  const original = [
    { id: 'img-a', ...image('aaa') },
    { id: 'img-b', ...image('bbb') },
  ];
  const remaining = attachments.removeLastAttachment(original);

  assert.deepEqual(attachments.toPayload(remaining), [image('aaa')]);
  assert.equal(Object.hasOwn(attachments.toPayload(original)[0], 'id'), false);
});

test('无效图片、重复 id 和畸形输入 fail-soft', () => {
  const first = attachments.appendAttachment([], image('aaa'), 'img-a');
  assert.strictEqual(attachments.appendAttachment(first, image('bbb'), 'img-a'), first);
  assert.strictEqual(attachments.appendAttachment(first, {}, 'img-b'), first);
  assert.strictEqual(attachments.removeAttachment(first, 'missing'), first);
  assert.deepEqual(attachments.labels(null), []);
  assert.deepEqual(attachments.toPayload(null), []);
  assert.deepEqual(attachments.removeLastAttachment([]), []);
});
