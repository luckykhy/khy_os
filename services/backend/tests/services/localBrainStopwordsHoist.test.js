'use strict';

/**
 * localBrainStopwordsHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the two stopword Sets out of
 * _extractTopic / _extractEntities. They are now built once at module load
 * instead of per conversational turn (pushContext calls both every turn).
 * Behavior must be byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const ctx = require('../../src/services/localBrainSessionContext');
const { _extractTopic, _extractEntities } = ctx;

test('_extractTopic drops stopwords, keeps content words', () => {
  // 'the'/'is'/'a' are stopwords; 'kubernetes'/'cluster' survive.
  const topic = _extractTopic('what is the kubernetes cluster');
  assert.ok(!/\bthe\b/.test(topic));
  assert.ok(!/\bwhat\b/.test(topic));
  assert.ok(topic.includes('kubernetes'));
  assert.ok(topic.includes('cluster'));
});

test('_extractTopic filters space-separated stopword tokens (topic Set active)', () => {
  // Tokens are whitespace-split; a leading stopword token is dropped while the
  // content token survives — proves the hoisted _TOPIC_STOPWORDS is consulted.
  const topic = _extractTopic('please deploy kubernetes');
  assert.ok(!/\bplease\b/.test(topic));
  assert.ok(topic.includes('kubernetes'));
});

test('_extractEntities filters english stopwords from word entities', () => {
  const ents = _extractEntities('this database should migrate quickly');
  const words = ents.filter((e) => e.type === 'word').map((e) => e.value.toLowerCase());
  // 'this'/'should' are entity stopwords; 'database'/'migrate'/'quickly' are not.
  assert.ok(!words.includes('this'));
  assert.ok(!words.includes('should'));
  assert.ok(words.includes('database'));
});

test('repeated calls are stable (shared stopword Sets not corrupted)', () => {
  const a = _extractTopic('what is the redis cache');
  const b = _extractTopic('what is the redis cache');
  assert.strictEqual(a, b);
  const e1 = _extractEntities('this kafka broker').filter((e) => e.type === 'word').map((e) => e.value);
  const e2 = _extractEntities('this kafka broker').filter((e) => e.type === 'word').map((e) => e.value);
  assert.deepStrictEqual(e1, e2);
});

test('empty / falsy input is safe', () => {
  assert.strictEqual(_extractTopic(''), '');
  assert.strictEqual(_extractTopic(null), '');
  assert.deepStrictEqual(_extractEntities(''), []);
  assert.deepStrictEqual(_extractEntities(null), []);
});
