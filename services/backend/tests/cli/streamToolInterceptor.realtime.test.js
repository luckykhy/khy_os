'use strict';

/**
 * streamToolInterceptor.realtime.test.js — real-time pass-through invariants.
 *
 * Goal "流式输出缓冲窒息（憋大招）": generated tokens must punch straight through
 * the stream interceptor instead of being parked in a fixed-size tail buffer.
 *
 * The interceptor still has to catch inline tool-call markers ("<tool_call>" /
 * "【调用") before they reach the user as visible text. The old code did this by
 * always withholding the last 12 chars of every flush (and the final 12 until
 * finalize), which needlessly held real answer text in the pipe. The rewrite
 * withholds ONLY a trailing PARTIAL-marker candidate (usually 0 chars).
 *
 * These node:test cases pin that behavior without jest/ink (the broader
 * preface/suppression matrix is covered by aiCli.toolPrefaceStreaming.test.js,
 * which runs under jest in CI).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../../src/cli/ai');
const { _partialToolMarkerTailLen, _createStreamToolInterceptor } = ai.__test__;

describe('_partialToolMarkerTailLen', () => {
  test('plain text withholds nothing', () => {
    assert.equal(_partialToolMarkerTailLen('hello world'), 0);
    assert.equal(_partialToolMarkerTailLen('答案是 42。'), 0);
    assert.equal(_partialToolMarkerTailLen(''), 0);
    assert.equal(_partialToolMarkerTailLen(null), 0);
  });

  test('withholds exactly the trailing partial XML marker', () => {
    assert.equal(_partialToolMarkerTailLen('done. <'), 1);
    assert.equal(_partialToolMarkerTailLen('ok <tool'), 5); // "<tool"
    assert.equal(_partialToolMarkerTailLen('ok <tool_cal'), 9); // "<tool_cal"
  });

  test('withholds exactly the trailing partial CJK marker', () => {
    assert.equal(_partialToolMarkerTailLen('看 【'), 1);
    assert.equal(_partialToolMarkerTailLen('看 【调'), 2);
  });

  test('a marker char NOT at the tail is not withheld', () => {
    assert.equal(_partialToolMarkerTailLen('a < b'), 0);
    assert.equal(_partialToolMarkerTailLen('1 【 2'), 0);
  });
});

describe('_createStreamToolInterceptor — real-time pass-through (default path)', () => {
  test('flushes the full chunk immediately, with no fixed tail held back', () => {
    const chunks = [];
    const it = _createStreamToolInterceptor((c) => chunks.push(c), {});
    it.onChunk({ type: 'text', text: '为什么程序员分不清万圣节和圣诞节' });
    // Entire text is visible right away — the old PASS_TAIL=12 would have held
    // the last 12 chars until finalize().
    assert.equal(chunks.map((c) => c.text).join(''), '为什么程序员分不清万圣节和圣诞节');
  });

  test('only a trailing partial marker is held, then released next chunk', () => {
    const chunks = [];
    const it = _createStreamToolInterceptor((c) => chunks.push(c), {});
    it.onChunk({ type: 'text', text: '答案是 <' });
    assert.equal(chunks.map((c) => c.text).join(''), '答案是 ', 'trailing "<" withheld');
    it.onChunk({ type: 'text', text: 'b 这不是工具调用' });
    assert.equal(chunks.map((c) => c.text).join(''), '答案是 <b 这不是工具调用', 'released once proven non-marker');
  });

  test('finalize releases a leftover partial-marker tail as plain text', () => {
    const chunks = [];
    const it = _createStreamToolInterceptor((c) => chunks.push(c), {});
    it.onChunk({ type: 'text', text: '比较 a < ' });
    it.onChunk({ type: 'text', text: 'b 还是 c <' });
    it.finalize();
    assert.equal(chunks.map((c) => c.text).join(''), '比较 a < b 还是 c <');
  });

  test('a real <tool_call> marker is still suppressed; preface streams as text', () => {
    const chunks = [];
    const it = _createStreamToolInterceptor((c) => chunks.push(c), {});
    it.onChunk({ type: 'text', text: 'I will read it.\n<tool_call>{"name":"Read"}</tool_call>' });
    assert.deepEqual(chunks, [{ type: 'text', text: 'I will read it.\n' }]);
    assert.equal(it.hasToolCall(), true);
  });
});
