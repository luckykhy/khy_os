'use strict';

/**
 * subagentContextSummary — pure-leaf unit tests (node:test).
 *
 * Covers the P0.3 parent-context-summary leaf: gate behaviour, text/path
 * extraction, deterministic summary building (recent user intent + file paths),
 * bounding (maxChars), and resolveSummary precedence (explicit > derived).
 * Deterministic: no IO, no clock — all inputs passed in.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../src/services/subagentContextSummary');

test('isEnabled: default-on; {0,false,off,no} turn it off', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_SUBAGENT_PARENT_SUMMARY: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_SUBAGENT_PARENT_SUMMARY: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
});

test('extractText: string / {text} / content-block array / garbage', () => {
  assert.equal(leaf.extractText('hello'), 'hello');
  assert.equal(leaf.extractText({ text: 'hi' }), 'hi');
  assert.equal(leaf.extractText({ content: 'world' }), 'world');
  assert.equal(
    leaf.extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'a\nb',
  );
  assert.equal(leaf.extractText(null), '');
  assert.equal(leaf.extractText(42), '');
});

test('extractFilePaths: pulls dir/ext paths, dedupes, ignores prose', () => {
  const text = 'edit src/services/foo.js and ./bar.ts; also src/services/foo.js again. plain words here.';
  const paths = leaf.extractFilePaths(text);
  assert.ok(paths.includes('src/services/foo.js'));
  assert.ok(paths.includes('./bar.ts'));
  // dedupe: foo.js appears once
  assert.equal(paths.filter(p => p === 'src/services/foo.js').length, 1);
});

test('extractFilePaths: single-segment file with code extension', () => {
  const paths = leaf.extractFilePaths('open index.js then App.vue');
  assert.ok(paths.includes('index.js'));
  assert.ok(paths.includes('App.vue'));
});

test('buildContextSummary: gate off → empty string', () => {
  const conv = [{ role: 'user', content: 'do the thing in src/a.js' }];
  assert.equal(leaf.buildContextSummary(conv, {}, { KHY_SUBAGENT_PARENT_SUMMARY: 'off' }), '');
});

test('buildContextSummary: empty / non-array → empty string', () => {
  assert.equal(leaf.buildContextSummary([], {}, {}), '');
  assert.equal(leaf.buildContextSummary(null, {}, {}), '');
});

test('buildContextSummary: includes recent user intent (chronological) and file paths', () => {
  const conv = [
    { role: 'user', content: 'first ask about src/old.js' },
    { role: 'assistant', content: 'ok touching src/old.js' },
    { role: 'user', content: 'now refactor src/new.ts please' },
    { role: 'assistant', content: 'done with src/new.ts' },
  ];
  const block = leaf.buildContextSummary(conv, {}, {});
  assert.ok(block.startsWith('[Parent Context Summary'));
  assert.ok(block.includes('最近用户意图'));
  // Two most recent user turns, in chronological order
  const firstIdx = block.indexOf('first ask');
  const nowIdx = block.indexOf('now refactor');
  assert.ok(firstIdx !== -1 && nowIdx !== -1);
  assert.ok(firstIdx < nowIdx, 'user intents should be chronological');
  // File paths surfaced
  assert.ok(block.includes('src/new.ts'));
});

test('buildContextSummary: respects KHY_SUBAGENT_SUMMARY_MAX_CHARS bound', () => {
  const big = 'x'.repeat(5000);
  const conv = [{ role: 'user', content: `please handle ${big} in src/a.js` }];
  const block = leaf.buildContextSummary(conv, {}, { KHY_SUBAGENT_SUMMARY_MAX_CHARS: '300' });
  assert.ok(block.length <= 300, `expected <=300, got ${block.length}`);
});

test('buildContextSummary: no user text and no paths → empty', () => {
  const conv = [{ role: 'assistant', content: 'just prose with no file refs' }];
  assert.equal(leaf.buildContextSummary(conv, {}, {}), '');
});

test('resolveSummary: explicit summary wins, labelled as provided', () => {
  const conv = [{ role: 'user', content: 'derive from src/x.js' }];
  const out = leaf.resolveSummary('a hand-written brief', conv, {}, {});
  assert.ok(out.includes('父代理提供'));
  assert.ok(out.includes('a hand-written brief'));
  assert.ok(!out.includes('src/x.js'), 'explicit summary should not also auto-derive');
});

test('resolveSummary: no explicit → derives from conversation', () => {
  const conv = [{ role: 'user', content: 'fix the bug in src/y.ts' }];
  const out = leaf.resolveSummary('', conv, {}, {});
  assert.ok(out.includes('src/y.ts'));
});

test('resolveSummary: gate off → empty regardless of explicit', () => {
  assert.equal(leaf.resolveSummary('explicit brief', [], {}, { KHY_SUBAGENT_PARENT_SUMMARY: 'off' }), '');
});

test('resolveSummary: explicit summary clipped to max-chars bound', () => {
  const explicit = 'y'.repeat(5000);
  const out = leaf.resolveSummary(explicit, null, {}, { KHY_SUBAGENT_SUMMARY_MAX_CHARS: '250' });
  assert.ok(out.length <= 250 + 40, `expected bounded, got ${out.length}`);
  assert.ok(out.endsWith('…'));
});
