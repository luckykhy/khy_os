'use strict';

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/services/localMemoryRecall');

test('isEnabled: default-on, falsy-off, KHY_DISABLE_MEMORY overrides', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled({ KHY_MEMORY_RECALL_TOOL: 'true' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_MEMORY_RECALL_TOOL: 'off' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_MEMORY_RECALL_TOOL: '0' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_MEMORY_RECALL_TOOL: 'no' }), false);
  // memory master-switch wins even if recall flag is on
  assert.strictEqual(leaf.isEnabled({ KHY_MEMORY_RECALL_TOOL: 'true', KHY_DISABLE_MEMORY: '1' }), false);
  assert.strictEqual(leaf.isEnabled({ KHY_DISABLE_MEMORY: 'true' }), false);
});

test('normalizeLimit: clamps to [1, MAX_LIMIT], invalid -> default', () => {
  assert.strictEqual(leaf.normalizeLimit(undefined), leaf.DEFAULT_LIMIT);
  assert.strictEqual(leaf.normalizeLimit(null), leaf.DEFAULT_LIMIT);
  assert.strictEqual(leaf.normalizeLimit('abc'), leaf.DEFAULT_LIMIT);
  assert.strictEqual(leaf.normalizeLimit(0), leaf.DEFAULT_LIMIT);
  assert.strictEqual(leaf.normalizeLimit(-5), leaf.DEFAULT_LIMIT);
  assert.strictEqual(leaf.normalizeLimit(3), 3);
  assert.strictEqual(leaf.normalizeLimit(1000), leaf.MAX_LIMIT);
  assert.strictEqual(leaf.normalizeLimit(2.9), 2);
});

test('shapeRelevant: maps fields, truncates body, keeps score', () => {
  const long = 'x'.repeat(leaf.DEFAULT_BODY_CHARS + 50);
  const out = leaf.shapeRelevant([
    { filename: 'a.md', frontmatter: { name: 'alpha', description: 'd1', metadata: { type: 'project' } }, body: long, score: 4.2 },
    { filename: 'b.md', frontmatter: { name: 'beta', type: 'user', description: 'd2' }, body: 'short', score: 1 },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].filename, 'a.md');
  assert.strictEqual(out[0].name, 'alpha');
  assert.strictEqual(out[0].type, 'project'); // from metadata.type fallback
  assert.strictEqual(out[0].score, 4.2);
  assert.ok(out[0].body.length <= leaf.DEFAULT_BODY_CHARS + 1); // +1 for ellipsis
  assert.ok(out[0].body.endsWith('…'));
  assert.strictEqual(out[1].type, 'user'); // direct type
  assert.strictEqual(out[1].body, 'short'); // no truncation
});

test('shapeRelevant: non-array / junk -> [] (fail-soft)', () => {
  assert.deepStrictEqual(leaf.shapeRelevant(null), []);
  assert.deepStrictEqual(leaf.shapeRelevant(undefined), []);
  assert.deepStrictEqual(leaf.shapeRelevant('nope'), []);
  assert.deepStrictEqual(leaf.shapeRelevant([null, 1, 'x']), []);
});

test('shapeRelevant: custom bodyChars honored', () => {
  const out = leaf.shapeRelevant([{ filename: 'a', frontmatter: {}, body: 'abcdefghij', score: 0 }], { bodyChars: 4 });
  assert.strictEqual(out[0].body, 'abcd…');
});

test('shapeSearch: maps fields, caps matches', () => {
  const matches = Array.from({ length: 12 }, (_, i) => `line ${i}`);
  const out = leaf.shapeSearch([
    { filename: 'a.md', frontmatter: { name: 'alpha', description: 'd', type: 'reference' }, matches },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'alpha');
  assert.strictEqual(out[0].type, 'reference');
  assert.strictEqual(out[0].matches.length, 5); // default cap
});

test('shapeSearch: non-array -> [] and missing matches -> []', () => {
  assert.deepStrictEqual(leaf.shapeSearch(null), []);
  const out = leaf.shapeSearch([{ filename: 'a', frontmatter: {} }]);
  assert.deepStrictEqual(out[0].matches, []);
});

test('buildRecallSummary: empty vs non-empty', () => {
  assert.match(leaf.buildRecallSummary('foo', []), /没有.*foo/);
  assert.match(leaf.buildRecallSummary('foo', [{}, {}]), /召回 2 条.*foo/);
  // fail-soft on junk shaped
  assert.match(leaf.buildRecallSummary('bar', null), /没有/);
});

test('determinism: same input -> deep-equal output', () => {
  const input = [{ filename: 'a', frontmatter: { name: 'n', description: 'd' }, body: 'b', score: 1 }];
  assert.deepStrictEqual(leaf.shapeRelevant(input), leaf.shapeRelevant(input));
});
