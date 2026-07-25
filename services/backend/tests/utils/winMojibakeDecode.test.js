'use strict';

/**
 * winMojibakeDecode.test.js — smartDecodeWinOutput (Windows「乱码」修复).
 *
 * Background: _forceWindowsUtf8 prepends `chcp 65001` and declares outputEncoding:'utf-8',
 * but chcp does NOT reliably transcode the piped output of cmd built-ins like `dir`,
 * so those bytes stay in the OEM code page (GBK/CP936). Decoding them as UTF-8 yields
 * U+FFFD mojibake ("������ D �еľ��� Data"). smartDecodeWinOutput recovers them.
 *
 * The OEM code page is injected here so the fallback is deterministic off-Windows
 * (on the real machine it defaults to getSystemEncoding(), e.g. 'gbk').
 */

const { test } = require('node:test');
const assert = require('node:assert');
const iconv = require('iconv-lite');

const { smartDecodeWinOutput } = require('../../src/utils/spawnWithIdleTimeout');

test('valid UTF-8 bytes pass through unchanged (fast path, no fallback)', () => {
  const buf = Buffer.from('已完成 ✓ done 中文', 'utf8');
  assert.equal(smartDecodeWinOutput(buf, 'gbk'), '已完成 ✓ done 中文');
});

test('GBK bytes that chcp failed to convert are recovered via OEM fallback', () => {
  const original = '驱动器 D 中的卷是 Data';
  const gbkBytes = iconv.encode(original, 'gbk');
  // Naive utf8 decode is mojibake (contains U+FFFD)…
  assert.ok(gbkBytes.toString('utf8').includes('�'));
  // …smart decode recovers the original Chinese.
  assert.equal(smartDecodeWinOutput(gbkBytes, 'gbk'), original);
});

test('Shift-JIS (Japanese Windows) bytes are recovered too', () => {
  const original = 'ドライブ D';
  const sjis = iconv.encode(original, 'shift_jis');
  assert.equal(smartDecodeWinOutput(sjis, 'shift_jis'), original);
});

test('empty / nullish input is safe', () => {
  assert.equal(smartDecodeWinOutput(Buffer.alloc(0), 'gbk'), '');
  assert.equal(smartDecodeWinOutput(null, 'gbk'), '');
  assert.equal(smartDecodeWinOutput(undefined), '');
});

test('does not "improve" genuinely broken bytes when OEM is no better', () => {
  // A lone 0xFF is invalid in both utf8 and gbk → keep the utf8 reading, never throw.
  const garbage = Buffer.from([0x41, 0xff, 0x42]); // "A?B"
  const out = smartDecodeWinOutput(garbage, 'gbk');
  assert.equal(typeof out, 'string');
  assert.ok(out.startsWith('A'));
});
