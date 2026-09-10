'use strict';
/**
 * localBrainStopwordsHoist.test.js �?Ch2「不要每轮重建可复用结构�?
 *
 * Verifies the pure module-const hoist of the two stopword Sets out of
 * _extractTopic / _extractEntities. They are now built once at module load
 * instead of per conversational turn (pushContext calls both every turn).
 * Behavior must be byte-identical.
 */
const ctx = require('../../src/services/localBrainSessionContext');
const { _extractTopic, _extractEntities } = ctx;

describe('Local Brain Stopwords Hoist', () => {
  test('_extractTopic drops stopwords, keeps content words', () => {
      // 'the'/'is'/'a' are stopwords; 'kubernetes'/'cluster' survive.
      const topic = _extractTopic('what is the kubernetes cluster');
      expect(!/\bthe\b/.test(topic).toBeTruthy());
      expect(!/\bwhat\b/.test(topic).toBeTruthy());
      expect(topic).toContain('kubernetes');
      expect(topic).toContain('cluster');
  });

  test('_extractTopic filters space-separated stopword tokens (topic Set active)', () => {
      // Tokens are whitespace-split; a leading stopword token is dropped while the
      // content token survives �?proves the hoisted _TOPIC_STOPWORDS is consulted.
      const topic = _extractTopic('please deploy kubernetes');
      expect(!/\bplease\b/.test(topic).toBeTruthy());
      expect(topic).toContain('kubernetes');
  });

  test('_extractEntities filters english stopwords from word entities', () => {
      const ents = _extractEntities('this database should migrate quickly');
      const words = ents.filter((e) => e.type === 'word').map((e) => e.value.toLowerCase());
      // 'this'/'should' are entity stopwords; 'database'/'migrate'/'quickly' are not.
      expect(!words).toContain('this');
      expect(!words).toContain('should');
      expect(words).toContain('database');
  });

  test('repeated calls are stable (shared stopword Sets not corrupted)', () => {
      const a = _extractTopic('what is the redis cache');
      const b = _extractTopic('what is the redis cache');
      expect(a).toBe(b);
      const e1 = _extractEntities('this kafka broker').filter((e) => e.type === 'word').map((e) => e.value);
      const e2 = _extractEntities('this kafka broker').filter((e) => e.type === 'word').map((e) => e.value);
      expect(e1).toEqual(e2);
  });

  test('empty / falsy input is safe', () => {
      expect(_extractTopic('')).toBe('');
      expect(_extractTopic(null)).toBe('');
      expect(_extractEntities('')).toEqual([]);
      expect(_extractEntities(null)).toEqual([]);
  });

});

