'use strict';

/**
 * Tests for the moaAggregation pure leaf (MoA — Mixture-of-Agents).
 * Runner: node --test (NOT jest).
 *
 * Covers the leaf contract: deterministic prompt assembly (each reference quoted
 * verbatim), jaccard-based de-duplication, count/length bounds, and never-throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReferences,
  buildAggregatorPrompt,
  _jaccardSimilarity,
} = require('../../src/services/moaAggregation');

test('buildAggregatorPrompt embeds the question and every reference verbatim', () => {
  const references = [
    { model: 'model-a', content: 'quicksort partitions around a pivot' },
    { model: 'model-b', content: 'use Lomuto partition scheme' },
  ];
  const out = buildAggregatorPrompt({ question: 'implement quicksort', references });

  assert.ok(out.includes('implement quicksort'), 'question present');
  assert.ok(out.includes('## 参考 1 — model-a'), 'labeled ref 1');
  assert.ok(out.includes('## 参考 2 — model-b'), 'labeled ref 2');
  assert.ok(out.includes('quicksort partitions around a pivot'), 'ref 1 verbatim');
  assert.ok(out.includes('use Lomuto partition scheme'), 'ref 2 verbatim');
  assert.ok(out.includes('# 你的合成答案'), 'synthesis footer present');
});

test('buildAggregatorPrompt is deterministic (identical input → byte-identical output)', () => {
  const params = {
    question: 'q',
    references: [{ model: 'm', content: 'c' }],
  };
  assert.equal(buildAggregatorPrompt(params), buildAggregatorPrompt(params));
});

test('buildAggregatorPrompt handles empty references and missing question', () => {
  const out = buildAggregatorPrompt({});
  assert.ok(out.includes('(未提供问题)'), 'placeholder question');
  assert.ok(out.includes('(没有可用的参考回答)'), 'placeholder references');
});

test('buildAggregatorPrompt appends a language directive when provided', () => {
  const out = buildAggregatorPrompt({ question: 'q', references: [], language: '中文' });
  assert.ok(out.includes('请用中文作答。'), 'language directive');
});

test('normalizeReferences drops failed and empty entries, preserving order', () => {
  const refs = normalizeReferences([
    { model: 'a', content: 'alpha answer' },
    { model: 'b', content: '', failed: false },
    { model: 'c', content: 'gamma answer', failed: true },
    { model: 'd', content: '   ' },
    { model: 'e', content: 'epsilon answer' },
  ]);
  assert.deepEqual(refs.map((r) => r.model), ['a', 'e']);
  assert.equal(refs[0].content, 'alpha answer');
});

test('normalizeReferences de-duplicates near-identical answers, keeping the richer one', () => {
  const shared = 'the capital of france is paris and it is a large european city';
  const refs = normalizeReferences([
    { model: 'a', content: shared },
    { model: 'b', content: `${shared} indeed` },
  ]);
  assert.equal(refs.length, 1, 'near-identical collapsed to one');
  assert.equal(refs[0].model, 'a', 'earliest label retained');
  assert.ok(refs[0].content.includes('indeed'), 'richer content wins the slot');
});

test('normalizeReferences keeps distinct answers', () => {
  const refs = normalizeReferences([
    { model: 'a', content: 'apples are red fruit' },
    { model: 'b', content: 'quantum entanglement links particles across distance' },
  ]);
  assert.equal(refs.length, 2);
});

test('normalizeReferences bounds the reference count', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    model: `m${i}`,
    content: `unique distinct answer number ${i} about topic ${i}`,
  }));
  const refs = normalizeReferences(many);
  assert.ok(refs.length <= 8, `count bounded, got ${refs.length}`);
});

test('normalizeReferences clamps over-long content with a truncation marker', () => {
  const huge = 'x'.repeat(9000);
  const refs = normalizeReferences([
    { model: 'a', content: huge },
    { model: 'b', content: 'short but distinct sibling answer' },
  ]);
  const clamped = refs.find((r) => r.model === 'a');
  assert.ok(clamped.content.length < huge.length, 'content clamped');
  assert.ok(clamped.content.includes('…[截断]…'), 'truncation marker present');
});

test('normalizeReferences never throws on garbage input', () => {
  assert.doesNotThrow(() => normalizeReferences(null));
  assert.doesNotThrow(() => normalizeReferences(undefined));
  assert.doesNotThrow(() => normalizeReferences('not an array'));
  assert.doesNotThrow(() => normalizeReferences([null, 42, 'str', {}, { content: 5 }]));
  assert.deepEqual(normalizeReferences(null), []);
});

test('_jaccardSimilarity boundary behavior', () => {
  assert.equal(_jaccardSimilarity('', ''), 1, 'both empty ⇒ identical');
  assert.equal(_jaccardSimilarity('a', ''), 0, 'one empty ⇒ 0');
  assert.equal(_jaccardSimilarity('a b c', 'a b c'), 1, 'identical ⇒ 1');
  const partial = _jaccardSimilarity('a b c d', 'a b x y');
  assert.ok(partial > 0 && partial < 1, 'partial overlap in (0,1)');
});
