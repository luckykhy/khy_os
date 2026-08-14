'use strict';

/**
 * chatStateIsolation.test.js — pure-module regression for DESIGN-ARCH-046.
 *
 * Pins the keystone invariant: a failed / fallback model turn is isolated in
 * the request sandbox and NEVER persisted into session history. Constructs the
 * exact exception shapes the loop emits (network/timeout error turn, empty_reply
 * with E01) and asserts history is rolled back to the pre-turn snapshot, while a
 * real answer is persisted and trimmed exactly as before.
 *
 * Zero network, zero process — operates directly on a plain messages array.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const iso = require('../../../src/services/chatStateIsolation');

describe('chatStateIsolation.isErrorTurn', () => {
  test('flags results carrying errorType or error_code', () => {
    assert.equal(iso.isErrorTurn({ errorType: 'network' }), true);
    assert.equal(iso.isErrorTurn({ errorType: 'timeout' }), true);
    assert.equal(iso.isErrorTurn({ errorType: 'empty_reply', error_code: 'E01' }), true);
    assert.equal(iso.isErrorTurn({ error_code: 'E07' }), true);
  });

  test('a clean answer is not an error turn', () => {
    assert.equal(iso.isErrorTurn({ finalResponse: '正常回答' }), false);
    assert.equal(iso.isErrorTurn({}), false);
    assert.equal(iso.isErrorTurn(null), false);
    assert.equal(iso.isErrorTurn('x'), false);
  });
});

describe('chatStateIsolation.commitTurn — success path (unchanged behavior)', () => {
  test('persists a real answer and preserves prior history', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, // this turn's user message at index 2
    ];
    const r = iso.commitTurn(messages, {
      reply: 'a2',
      finalResult: { finalResponse: 'a2' },
      maxHistory: 50,
      historyMark: 2,
    });
    assert.deepEqual(r, { persisted: true, rolledBack: false });
    assert.equal(messages.length, 4);
    assert.deepEqual(messages[3], { role: 'assistant', content: 'a2' });
  });

  test('trims to maxHistory in place (same array reference)', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const ref = messages;
    iso.commitTurn(messages, {
      reply: 'a2',
      finalResult: { finalResponse: 'a2' },
      maxHistory: 2,
      historyMark: 2,
    });
    assert.equal(ref, messages, 'must mutate in place, not reassign');
    assert.equal(messages.length, 2);
    // Newest kept: the user q2 + assistant a2.
    assert.deepEqual(messages[0], { role: 'user', content: 'q2' });
    assert.deepEqual(messages[1], { role: 'assistant', content: 'a2' });
  });

  test('empty reply on a non-error turn is a no-op (never pushes empty assistant)', () => {
    const messages = [{ role: 'user', content: 'q1' }];
    const r = iso.commitTurn(messages, {
      reply: '',
      finalResult: { finalResponse: '' },
      maxHistory: 50,
      historyMark: 1,
    });
    assert.deepEqual(r, { persisted: false, rolledBack: false });
    assert.equal(messages.length, 1);
  });
});

describe('chatStateIsolation.commitTurn — error path (the keystone fix)', () => {
  test('network error turn rolls back to pre-turn snapshot (drops this turn user msg)', () => {
    const messages = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, // failed turn's user message
    ];
    const r = iso.commitTurn(messages, {
      reply: '抱歉，网络连接出现问题，无法完成请求。请检查网络连接后重试。',
      finalResult: { errorType: 'network', stopped: true },
      maxHistory: 50,
      historyMark: 2,
    });
    assert.deepEqual(r, { persisted: false, rolledBack: true });
    assert.equal(messages.length, 2, 'failed turn leaves zero trace');
    assert.deepEqual(messages[messages.length - 1], { role: 'assistant', content: 'a1' });
  });

  test('empty_reply (E01) fallback is never committed to history', () => {
    const messages = [{ role: 'user', content: 'q1' }];
    const r = iso.commitTurn(messages, {
      reply: '抱歉，AI 未能生成有效回复。这可能是模型暂时不可用，请稍后重试。',
      finalResult: { errorType: 'empty_reply', error_code: 'E01' },
      maxHistory: 50,
      historyMark: 0,
    });
    assert.deepEqual(r, { persisted: false, rolledBack: true });
    assert.equal(messages.length, 0, 'history reset to clean state');
  });

  test('REPRO: one error must NOT pollute subsequent normal turns (no "复读")', () => {
    // Symptom: after one exception, every later request repeats the canned line.
    // With isolation the canned line never enters history, so turn 2 starts clean.
    const messages = [];
    const REFUSE = '抱歉，我无法回答这个问题。';

    // Turn 1: user asks, model call fails (timeout). User msg pushed at idx 0.
    messages.push({ role: 'user', content: '帮我写个函数' });
    iso.commitTurn(messages, {
      reply: REFUSE,
      finalResult: { errorType: 'timeout', stopped: true },
      maxHistory: 50,
      historyMark: 0,
    });
    assert.equal(messages.length, 0, 'failed turn cleaned up');

    // Turn 2: a normal request — history carries NO canned refusal to mimic.
    messages.push({ role: 'user', content: '继续' });
    iso.commitTurn(messages, {
      reply: 'function add(a, b) { return a + b; }',
      finalResult: { finalResponse: 'function add(a, b) { return a + b; }' },
      maxHistory: 50,
      historyMark: 0,
    });
    const canned = messages.filter((m) => m.content === REFUSE);
    assert.equal(canned.length, 0, 'no canned refusal ever entered history');
    assert.match(messages[messages.length - 1].content, /function add/);
  });

  test('defensive: bad historyMark does not crash and still avoids persisting fallback', () => {
    const messages = [{ role: 'user', content: 'q1' }];
    const r = iso.commitTurn(messages, {
      reply: 'fallback',
      finalResult: { errorType: 'network' },
      maxHistory: 50,
      historyMark: 999, // out of range
    });
    assert.deepEqual(r, { persisted: false, rolledBack: false });
    // Worst case: it does not roll back, but it NEVER pushes the fallback.
    assert.equal(messages.length, 1);
    assert.equal(messages.some((m) => m.content === 'fallback'), false);
  });

  test('non-array messages is a safe no-op', () => {
    assert.deepEqual(iso.commitTurn(null, { reply: 'x' }), { persisted: false, rolledBack: false });
  });
});
