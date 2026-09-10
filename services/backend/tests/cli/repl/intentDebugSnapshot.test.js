'use strict';
const {
  trimIntentDebugItem,
  normalizeIntentDebugList,
  buildIntentAssuranceDebugSnapshot,
} = require('./intentDebugSnapshot');
// ── trimIntentDebugItem ─────────────────────────────────────────────────────
// ── normalizeIntentDebugList ─────────────────────────────────────────────────
// ── buildIntentAssuranceDebugSnapshot ────────────────────────────────────────

describe('Intent Debug Snapshot', () => {
  test('trimIntentDebugItem: trims and collapses whitespace', () => {
      expect(trimIntentDebugItem('  hello   world  ')).toBe('hello world');
      expect(trimIntentDebugItem('foo\n\nbar')).toBe('foo bar');
  });

  test('trimIntentDebugItem: returns empty for empty/whitespace input', () => {
      expect(trimIntentDebugItem('')).toBe('');
      expect(trimIntentDebugItem('   ')).toBe('');
      expect(trimIntentDebugItem('\n\n')).toBe('');
  });

  test('trimIntentDebugItem: returns unchanged when within maxLen', () => {
      const text = 'short text';
      expect(trimIntentDebugItem(text)).toBe('short text');
  });

  test('trimIntentDebugItem: truncates long text with ellipsis', () => {
      const long = 'a'.repeat(200);
      const result = trimIntentDebugItem(long, 100);
      expect(result.endsWith('�?).toBeTruthy());
      expect(result.length <= 101).toBeTruthy(); // 100 chars + ellipsis
  });

  test('trimIntentDebugItem: keeps at least 16 leading chars when truncating', () => {
      const long = 'a'.repeat(200);
      const result = trimIntentDebugItem(long, 100);
      expect(result.length >= 17).toBeTruthy(); // 16 chars + ellipsis
  });

  test('trimIntentDebugItem: defaults to maxLen 100', () => {
      const long = 'a'.repeat(150);
      const result = trimIntentDebugItem(long);
      expect(result.length <= 101).toBeTruthy();
  });

  test('trimIntentDebugItem: null/undefined �?empty string', () => {
      expect(trimIntentDebugItem(null)).toBe('');
      expect(trimIntentDebugItem(undefined)).toBe('');
  });

  test('normalizeIntentDebugList: trims each item and drops empties', () => {
      const result = normalizeIntentDebugList(['  foo  ', '  ', 'bar', null]);
      expect(result).toEqual(['foo', 'bar']);
  });

  test('normalizeIntentDebugList: caps to limit entries', () => {
      const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const result = normalizeIntentDebugList(items, 3);
      expect(result).toEqual(['a', 'b', 'c']);
  });

  test('normalizeIntentDebugList: default limit is 6', () => {
      const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const result = normalizeIntentDebugList(items);
      expect(result.length).toBe(6);
  });

  test('normalizeIntentDebugList: non-array �?empty array', () => {
      expect(normalizeIntentDebugList(null)).toBe([]);
      expect(normalizeIntentDebugList('string')).toBe([]);
      expect(normalizeIntentDebugList(123)).toBe([]);
  });

  test('normalizeIntentDebugList: empty array �?empty array', () => {
      expect(normalizeIntentDebugList([])).toBe([]);
  });

  test('buildIntentAssuranceDebugSnapshot: builds full snapshot', () => {
      const payload = {
        source: 'test',
        shouldInject: true,
        requestClass: 'code_fix',
        primaryObjective: 'Fix the login bug',
        summary: 'Login fix summary',
        constraints: ['constraint1', 'constraint2'],
        detailAnchors: ['anchor1', 'anchor2', 'anchor3'],
        tailDetails: ['tail1'],
      };
      const result = buildIntentAssuranceDebugSnapshot(payload);
      expect(result.source).toBe('test');
      expect(result.shouldInject).toBe(true);
      expect(result.requestClass).toBe('code_fix');
      expect(result.primaryObjective).toBe('Fix the login bug');
      expect(result.summary).toBe('Login fix summary');
      expect(result.constraints).toEqual(['constraint1', 'constraint2']);
      expect(result.detailAnchors).toEqual(['anchor1', 'anchor2', 'anchor3']);
      expect(result.tailDetails).toEqual(['tail1']);
      expect(result.constraintCount).toBe(2);
      expect(result.detailCount).toBe(3);
      expect(result.tailDetailCount).toBe(1);
  });

  test('buildIntentAssuranceDebugSnapshot: falls back to message if no primaryObjective/summary', () => {
      const payload = { message: 'fallback message' };
      const result = buildIntentAssuranceDebugSnapshot(payload);
      expect(result.primaryObjective).toBe('fallback message');
      expect(result.summary).toBe('fallback message');
  });

  test('buildIntentAssuranceDebugSnapshot: uses primaryObjective for summary fallback', () => {
      const payload = { primaryObjective: 'Main goal' };
      const result = buildIntentAssuranceDebugSnapshot(payload);
      expect(result.primaryObjective).toBe('Main goal');
      expect(result.summary).toBe('Main goal');
  });

  test('buildIntentAssuranceDebugSnapshot: non-object �?null', () => {
      expect(buildIntentAssuranceDebugSnapshot(null)).toBe(null);
      expect(buildIntentAssuranceDebugSnapshot('string')).toBe(null);
      expect(buildIntentAssuranceDebugSnapshot(123)).toBe(null);
  });

  test('buildIntentAssuranceDebugSnapshot: defaults shouldInject to true', () => {
      const result = buildIntentAssuranceDebugSnapshot({});
      expect(result.shouldInject).toBe(true);
  });

  test('buildIntentAssuranceDebugSnapshot: counts use max of list length and explicit count', () => {
      const payload = {
        constraints: ['a', 'b'],
        constraintCount: 10,
      };
      const result = buildIntentAssuranceDebugSnapshot(payload);
      expect(result.constraintCount).toBe(10); // max(2, 10) = 10
  });

  test('buildIntentAssuranceDebugSnapshot: empty strings for missing fields', () => {
      const result = buildIntentAssuranceDebugSnapshot({});
      expect(result.primaryObjective).toBe('');
      expect(result.summary).toBe('');
      expect(result.requestClass).toBe('');
  });

});

