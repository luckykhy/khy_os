'use strict';
/**
 * subagentContextSummary — pure-leaf unit tests (node:test).
 *
 * Covers the P0.3 parent-context-summary leaf: gate behaviour, text/path
 * extraction, deterministic summary building (recent user intent + file paths),
 * bounding (maxChars), and resolveSummary precedence (explicit > derived).
 * Deterministic: no IO, no clock — all inputs passed in.
 */
const leaf = require('../src/services/subagentContextSummary');

describe('Subagent Context Summary', () => {
  test('isEnabled: default-on; {0,false,off,no} turn it off', () => {
      expect(leaf.isEnabled({})).toBe(true);
      expect(leaf.isEnabled({ KHY_SUBAGENT_PARENT_SUMMARY: 'on' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(leaf.isEnabled({ KHY_SUBAGENT_PARENT_SUMMARY: v })).toBe(false);
      }
  });

  test('extractText: string / {text} / content-block array / garbage', () => {
      expect(leaf.extractText('hello')).toBe('hello');
      expect(leaf.extractText({ text: 'hi' })).toBe('hi');
      expect(leaf.extractText({ content: 'world' })).toBe('world');
      assert.equal(
        leaf.extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
        'a\nb',
      );
      expect(leaf.extractText(null)).toBe('');
      expect(leaf.extractText(42)).toBe('');
  });

  test('extractFilePaths: pulls dir/ext paths, dedupes, ignores prose', () => {
      const text = 'edit src/services/foo.js and ./bar.ts; also src/services/foo.js again. plain words here.';
      const paths = leaf.extractFilePaths(text);
      expect(paths).toContain('src/services/foo.js');
      expect(paths).toContain('./bar.ts');
      // dedupe: foo.js appears once
      expect(paths.filter(p => p === 'src/services/foo.js').length).toBe(1);
  });

  test('extractFilePaths: single-segment file with code extension', () => {
      const paths = leaf.extractFilePaths('open index.js then App.vue');
      expect(paths).toContain('index.js');
      expect(paths).toContain('App.vue');
  });

  test('buildContextSummary: gate off → empty string', () => {
      const conv = [{ role: 'user', content: 'do the thing in src/a.js' }];
      expect(leaf.buildContextSummary(conv, {}, { KHY_SUBAGENT_PARENT_SUMMARY: 'off' })).toBe('');
  });

  test('buildContextSummary: empty / non-array → empty string', () => {
      expect(leaf.buildContextSummary([], {}, {})).toBe('');
      expect(leaf.buildContextSummary(null, {}, {})).toBe('');
  });

  test('buildContextSummary: includes recent user intent (chronological) and file paths', () => {
      const conv = [
        { role: 'user', content: 'first ask about src/old.js' },
        { role: 'assistant', content: 'ok touching src/old.js' },
        { role: 'user', content: 'now refactor src/new.ts please' },
        { role: 'assistant', content: 'done with src/new.ts' },
      ];
      const block = leaf.buildContextSummary(conv, {}, {});
      expect(block.startsWith('[Parent Context Summary').toBeTruthy());
      expect(block).toContain('最近用户意图');
      // Two most recent user turns, in chronological order
      const firstIdx = block.indexOf('first ask');
      const nowIdx = block.indexOf('now refactor');
      expect(firstIdx !== -1 && nowIdx !== -1).toBeTruthy();
      expect(firstIdx < nowIdx).toBeTruthy();
      // File paths surfaced
      expect(block).toContain('src/new.ts');
  });

  test('buildContextSummary: respects KHY_SUBAGENT_SUMMARY_MAX_CHARS bound', () => {
      const big = 'x'.repeat(5000);
      const conv = [{ role: 'user', content: `please handle ${big} in src/a.js` }];
      const block = leaf.buildContextSummary(conv, {}, { KHY_SUBAGENT_SUMMARY_MAX_CHARS: '300' });
      expect(block.length <= 300).toBeTruthy();
  });

  test('buildContextSummary: no user text and no paths → empty', () => {
      const conv = [{ role: 'assistant', content: 'just prose with no file refs' }];
      expect(leaf.buildContextSummary(conv, {}, {})).toBe('');
  });

  test('resolveSummary: explicit summary wins, labelled as provided', () => {
      const conv = [{ role: 'user', content: 'derive from src/x.js' }];
      const out = leaf.resolveSummary('a hand-written brief', conv, {}, {});
      expect(out).toContain('父代理提供');
      expect(out).toContain('a hand-written brief');
      expect(!out.includes('src/x.js')).toBeTruthy();
  });

  test('resolveSummary: no explicit → derives from conversation', () => {
      const conv = [{ role: 'user', content: 'fix the bug in src/y.ts' }];
      const out = leaf.resolveSummary('', conv, {}, {});
      expect(out).toContain('src/y.ts');
  });

  test('resolveSummary: gate off → empty regardless of explicit', () => {
      expect(leaf.resolveSummary('explicit brief', [], {}, { KHY_SUBAGENT_PARENT_SUMMARY: 'off' })).toBe('');
  });

  test('resolveSummary: explicit summary clipped to max-chars bound', () => {
      const explicit = 'y'.repeat(5000);
      const out = leaf.resolveSummary(explicit, null, {}, { KHY_SUBAGENT_SUMMARY_MAX_CHARS: '250' });
      expect(out.length <= 250 + 40).toBeTruthy();
      expect(out.endsWith('…').toBeTruthy());
  });

});
