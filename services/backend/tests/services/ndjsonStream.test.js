'use strict';

/**
 * Tests for ndjsonStream.js — NDJSON streaming parser.
 * Uses collectNdjsonStream for convenience. Creates mock ReadableStream readers.
 */

const { Readable } = require('stream');
const { collectNdjsonStream, parseNdjsonNodeStream } = require('../../src/services/ndjsonStream');

async function collectNode(chunks, opts) {
  const items = [];
  for await (const item of parseNdjsonNodeStream(Readable.from(chunks), opts)) {
    items.push(item);
  }
  return items;
}

/**
 * Create a mock ReadableStreamDefaultReader from an array of strings.
 * Each string is encoded as a Uint8Array chunk.
 */
function createMockReader(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    read() {
      if (index >= chunks.length) {
        return Promise.resolve({ done: true, value: undefined });
      }
      const value = encoder.encode(chunks[index++]);
      return Promise.resolve({ done: false, value });
    },
    cancel() {},
    releaseLock() {},
  };
}

describe('collectNdjsonStream — basic parsing', () => {
  test('parses complete JSON lines', async () => {
    const reader = createMockReader([
      '{"a":1}\n{"b":2}\n',
    ]);
    const items = await collectNdjsonStream(reader);
    expect(items).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('handles chunks split across JSON boundaries', async () => {
    const reader = createMockReader([
      '{"x":',
      '1}\n{"y":2}\n',
    ]);
    const items = await collectNdjsonStream(reader);
    expect(items).toEqual([{ x: 1 }, { y: 2 }]);
  });

  test('flushes trailing partial JSON on stream end', async () => {
    const reader = createMockReader([
      '{"final":true}',  // no trailing newline
    ]);
    const items = await collectNdjsonStream(reader);
    expect(items).toEqual([{ final: true }]);
  });

  test('returns empty array for empty stream', async () => {
    const reader = createMockReader([]);
    const items = await collectNdjsonStream(reader);
    expect(items).toEqual([]);
  });
});

describe('collectNdjsonStream — resilience', () => {
  test('skips malformed lines and continues', async () => {
    const logger = { warn: jest.fn() };
    const reader = createMockReader([
      '{"good":1}\nNOT_JSON\n{"also_good":2}\n',
    ]);
    const items = await collectNdjsonStream(reader, { logger });
    expect(items).toEqual([{ good: 1 }, { also_good: 2 }]);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('skips empty lines', async () => {
    const reader = createMockReader([
      '\n\n{"a":1}\n\n\n{"b":2}\n\n',
    ]);
    const items = await collectNdjsonStream(reader);
    expect(items).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('handles malformed trailing data gracefully', async () => {
    const logger = { warn: jest.fn() };
    const reader = createMockReader([
      '{"ok":1}\nbroken_trailing',
    ]);
    const items = await collectNdjsonStream(reader, { logger });
    // First valid item parsed, trailing malformed data logged
    expect(items).toEqual([{ ok: 1 }]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('collectNdjsonStream — custom parser', () => {
  test('uses custom parse function', async () => {
    const reader = createMockReader([
      '{"val":42}\n',
    ]);
    const customParse = (s) => {
      const obj = JSON.parse(s);
      obj.custom = true;
      return obj;
    };
    const items = await collectNdjsonStream(reader, { parse: customParse });
    expect(items).toEqual([{ val: 42, custom: true }]);
  });
});

describe('parseNdjsonNodeStream — multibyte chunk boundaries', () => {
  test('does not corrupt a UTF-8 character split across two Buffer chunks', async () => {
    // {"msg":"你好"}\n — split the buffer in the MIDDLE of 你 (0xE4 0xBD 0xA0).
    const full = Buffer.from('{"msg":"你好"}\n', 'utf8');
    const splitAt = full.indexOf(0xe4) + 1; // after the first byte of 你
    const items = await collectNode([full.subarray(0, splitAt), full.subarray(splitAt)]);
    expect(items).toEqual([{ msg: '你好' }]);
  });

  test('handles a string-typed chunk path unchanged', async () => {
    const items = await collectNode(['{"a":1}\n', '{"b":2}\n']);
    expect(items).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('flushes trailing multibyte char with no final newline', async () => {
    const full = Buffer.from('{"emoji":"🚀"}', 'utf8'); // 🚀 is a 4-byte surrogate-pair char
    const splitAt = full.length - 2;
    const items = await collectNode([full.subarray(0, splitAt), full.subarray(splitAt)]);
    expect(items).toEqual([{ emoji: '🚀' }]);
  });
});

describe('collectNdjsonStream — onStatus callback', () => {
  test('calls onStatus with done when stream ends', async () => {
    const onStatus = jest.fn();
    const reader = createMockReader([
      '{"a":1}\n',
    ]);
    await collectNdjsonStream(reader, { onStatus });
    expect(onStatus).toHaveBeenCalledWith('done', expect.stringContaining('1'));
  });
});
