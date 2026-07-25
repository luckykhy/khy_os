'use strict';

// Unit tests for the model-agnostic text normalizer. Pure functions — no React,
// no I/O. Covers the two structural passes (streaming / final) used for small &
// unknown models and the minimal `sanitize` pass used for self-rendering models.

const { normalizeStreaming, normalizeFinal, sanitize } = require('../src/cli/modelTextNormalizer');

const fenceCount = (s) => (s.match(/```/g) || []).length;
const ZW = '​'; // zero-width space — must be stripped from visible prose

describe('modelTextNormalizer — empty / falsy inputs', () => {
  test('all entry points return "" for empty/null/undefined', () => {
    for (const v of ['', null, undefined]) {
      expect(normalizeStreaming(v)).toBe('');
      expect(normalizeFinal(v)).toBe('');
      expect(sanitize(v)).toBe('');
    }
  });
});

describe('normalizeFinal — sentinel & role-echo stripping', () => {
  test('strips ChatML pipe sentinels and the leading role echo', () => {
    expect(normalizeFinal('<|im_start|>assistant\nHello world<|im_end|>')).toBe('Hello world');
  });

  test('strips DeepSeek full-width pipe sentinels', () => {
    expect(normalizeFinal('<｜Assistant｜>答案')).toBe('答案');
  });

  test('strips Mistral/Llama instruction & system bracket markers', () => {
    // Only the marker tokens are removed; text between them is left intact
    // (the normalizer can't assume inner content is junk).
    const a = normalizeFinal('[INST]hi[/INST]Answer');
    expect(a).not.toMatch(/\[\/?INST\]/);
    expect(a).toBe('hiAnswer');
    const b = normalizeFinal('<<SYS>>x<</SYS>>Answer');
    expect(b).not.toMatch(/<<\/?SYS>>/);
    expect(b).toBe('xAnswer');
  });

  test('strips Gemma turn markers and leaked tool-call wrappers', () => {
    expect(normalizeFinal('<start_of_turn>Hi<end_of_turn>')).toBe('Hi');
    expect(normalizeFinal('<tool_call>Hi</tool_call>')).toBe('Hi');
  });
});

describe('normalizeFinal — reasoning, dedup, fences, edges', () => {
  test('drops a complete <think> block from the answer channel', () => {
    expect(normalizeFinal('<think>secret reasoning</think>The answer')).toBe('The answer');
  });

  test('drops an exactly-repeated paragraph', () => {
    expect(normalizeFinal('Hello\n\nHello')).toBe('Hello');
  });

  test('collapses 3+ blank lines to a single blank line', () => {
    expect(normalizeFinal('a\n\n\n\nb')).toBe('a\n\nb');
  });

  test('closes an unclosed code fence', () => {
    const out = normalizeFinal('```js\ncode here');
    expect(fenceCount(out) % 2).toBe(0);
    expect(out.trimEnd().endsWith('```')).toBe(true);
  });

  test('trims leading/trailing blank lines', () => {
    expect(normalizeFinal('\n\ntext\n\n')).toBe('text');
  });
});

describe('fenced code is protected from stripping', () => {
  test('a sentinel-looking string inside a fence is preserved verbatim', () => {
    const input = '```\n<|im_end|>\n```';
    const out = normalizeFinal(input);
    expect(out).toContain('<|im_end|>');
    expect(fenceCount(out)).toBe(2);
  });

  test('control bytes inside a fence survive sanitize', () => {
    expect(sanitize('```\na\x07b\n```')).toContain('\x07');
  });
});

describe('normalizeStreaming — prefix-stable behavior', () => {
  test('hides an unclosed <think> tail (chain-of-thought not in answer)', () => {
    expect(normalizeStreaming('<think>still thinking')).toBe('');
  });

  test('keeps the answer that precedes an open <think>', () => {
    expect(normalizeStreaming('Answer.\n<think>mid')).toMatch(/^Answer\./);
  });

  test('does NOT close fences or trim edges (avoids streaming flicker)', () => {
    // An odd fence count must remain odd mid-stream — closing it would make the
    // preview jump when the real closer arrives.
    const out = normalizeStreaming('```js\ncode');
    expect(fenceCount(out) % 2).toBe(1);
  });

  test('strips invisible control / zero-width characters', () => {
    expect(normalizeStreaming(`a${ZW}b\x07c`)).toBe('abc');
  });
});

describe('sanitize — minimal self-render pass', () => {
  test('strips only invisible bytes, KEEPS sentinels & structure', () => {
    // Proves the self-render path does not rewrite a strong model's output:
    // zero-width gone, but the (improbable) sentinel and spacing are untouched.
    expect(sanitize(`a${ZW}b<|im_end|>`)).toBe('ab<|im_end|>');
  });

  test('does not drop repeated paragraphs or close fences', () => {
    expect(sanitize('Hi\n\nHi')).toBe('Hi\n\nHi');
    expect(fenceCount(sanitize('```js\ncode')) % 2).toBe(1);
  });
});

describe('idempotency', () => {
  test('normalizeFinal is stable under a second application', () => {
    const messy = '<|im_start|>assistant\n<think>r</think>Result\n\n\n\nResult\n```js\nx';
    const once = normalizeFinal(messy);
    expect(normalizeFinal(once)).toBe(once);
  });
});
