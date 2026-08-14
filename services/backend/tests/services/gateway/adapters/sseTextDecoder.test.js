'use strict';

// Unit tests for _sseTextDecoder pure leaf — proves streamed multi-byte UTF-8
// sequences (Chinese 3-byte, emoji 4-byte) that straddle a chunk boundary are
// reassembled instead of being decoded into U+FFFD (◆) replacement chars.
// node:test (jest is broken under rtk — run with `node --test`).

const { test } = require('node:test');
const assert = require('node:assert');

const { createSseTextDecoder } = require('../../../../src/services/gateway/adapters/_sseTextDecoder');

const FFFD = '�';

test('naive chunk.toString() corrupts a split 3-byte char (demonstrates the bug)', () => {
  const buf = Buffer.from('说明求真实', 'utf8');
  // Split mid-character: 4 bytes = 「说」(3) + first byte of 「明」(1).
  const a = buf.subarray(0, 4);
  const b = buf.subarray(4);
  const naive = a.toString() + b.toString();
  assert.ok(naive.includes(FFFD), 'baseline: naive decode must produce U+FFFD (this is what we fix)');
});

test('createSseTextDecoder reassembles a 3-byte char split across two chunks', () => {
  const d = createSseTextDecoder();
  const buf = Buffer.from('说明求真实', 'utf8');
  let out = d.write(buf.subarray(0, 4));   // 「说」+ 1 byte of 「明」
  out += d.write(buf.subarray(4));         // remaining bytes
  out += d.end();
  assert.equal(out, '说明求真实');
  assert.ok(!out.includes(FFFD), 'no replacement chars');
});

test('reassembles across many tiny 1-byte chunks (worst case)', () => {
  const d = createSseTextDecoder();
  const buf = Buffer.from('如果有人下了 50 单 → 说明需求真实', 'utf8');
  let out = '';
  for (const byte of buf) out += d.write(Buffer.from([byte]));
  out += d.end();
  assert.equal(out, '如果有人下了 50 单 → 说明需求真实');
  assert.ok(!out.includes(FFFD));
});

test('reassembles a 4-byte emoji split across chunks', () => {
  const d = createSseTextDecoder();
  const buf = Buffer.from('a😀b', 'utf8'); // 😀 is 4 bytes
  let out = d.write(buf.subarray(0, 3));   // 'a' + 2 bytes of emoji
  out += d.write(buf.subarray(3));
  out += d.end();
  assert.equal(out, 'a😀b');
  assert.ok(!out.includes(FFFD));
});

test('whole-string chunk (no split) passes through unchanged', () => {
  const d = createSseTextDecoder();
  assert.equal(d.write(Buffer.from('完整的一行', 'utf8')) + d.end(), '完整的一行');
});

test('string input passes through verbatim (already decoded upstream)', () => {
  const d = createSseTextDecoder();
  assert.equal(d.write('data: {"x":1}\n'), 'data: {"x":1}\n');
});

test('null / undefined chunks are safe (empty string, no throw)', () => {
  const d = createSseTextDecoder();
  assert.doesNotThrow(() => d.write(null));
  assert.equal(d.write(null), '');
  assert.equal(d.write(undefined), '');
});

test('end() flushes an incomplete trailing sequence as U+FFFD (upstream truncation, unavoidable)', () => {
  const d = createSseTextDecoder();
  const buf = Buffer.from('说', 'utf8'); // 3 bytes
  const partial = d.write(buf.subarray(0, 2)); // only 2 of 3 bytes ever arrive
  assert.equal(partial, '', 'incomplete bytes are held, not emitted');
  const flushed = d.end();
  assert.ok(flushed.includes(FFFD), 'truncated tail surfaces as replacement char on flush');
});
