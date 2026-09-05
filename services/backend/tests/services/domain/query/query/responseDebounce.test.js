'use strict';

const {
  stripLeadingRefusal,
  buildResetChunk,
  isResetChunk,
  looksLikeBenignConversational,
  refusalSignature,
  _normalize,
  _splitLeadingSentence,
  _isPureGreeting,
} = require('../../src/services/domain/query/query/responseDebounce');

describe('responseDebounce', () => {
  describe('_normalize', () => {
    test('collapses whitespace', () => {
      expect(_normalize('  hello   world  ')).toBe('hello world');
    });

    test('handles null/undefined', () => {
      expect(_normalize(null)).toBe('');
      expect(_normalize(undefined)).toBe('');
    });
  });

  describe('_splitLeadingSentence', () => {
    test('splits on Chinese period', () => {
      const result = _splitLeadingSentence('你好。世界');
      expect(result.head).toBe('你好。');
      expect(result.rest).toBe('世界');
    });

    test('splits on English period', () => {
      const result = _splitLeadingSentence('Hello. World');
      expect(result.head).toBe('Hello.');
      expect(result.rest).toBe(' World');
    });

    test('splits on exclamation', () => {
      const result = _splitLeadingSentence('Stop! Continue');
      expect(result.head).toBe('Stop!');
      expect(result.rest).toBe(' Continue');
    });

    test('splits on newline', () => {
      const result = _splitLeadingSentence('Line1\nLine2');
      expect(result.head).toBe('Line1\n');
      expect(result.rest).toBe('Line2');
    });

    test('returns whole text when no terminator', () => {
      const result = _splitLeadingSentence('no terminator here');
      expect(result.head).toBe('no terminator here');
      expect(result.rest).toBe('');
    });
  });

  describe('_isPureGreeting', () => {
    test('detects Chinese greetings', () => {
      expect(_isPureGreeting('你好')).toBe(true);
      expect(_isPureGreeting('您好')).toBe(true);
      expect(_isPureGreeting('哈喽')).toBe(true);
    });

    test('detects English greetings', () => {
      expect(_isPureGreeting('Hi')).toBe(true);
      expect(_isPureGreeting('Hello')).toBe(true);
      expect(_isPureGreeting('Hey')).toBe(true);
    });

    test('rejects long text', () => {
      expect(_isPureGreeting('hello world this is long')).toBe(false);
    });

    test('rejects empty', () => {
      expect(_isPureGreeting('')).toBe(false);
    });
  });

  describe('stripLeadingRefusal', () => {
    const isCanned = (s) => /无法给到|相关内容/.test(s);
    const statesReason = (s) => /因为|原因是/.test(s);

    test('strips bare refusal prefix', () => {
      const result = stripLeadingRefusal('你好，我无法给到相关内容。这是真实回答。', {
        isCanned,
        statesReason,
      });
      expect(result.stripped).toBe(true);
      expect(result.text).toBe('这是真实回答。');
    });

    test('does not strip refusal with reason', () => {
      const result = stripLeadingRefusal('你好，我无法给到相关内容，因为这是敏感信息。', {
        isCanned,
        statesReason,
      });
      expect(result.stripped).toBe(false);
    });

    test('does not strip when remainder too short', () => {
      const result = stripLeadingRefusal('你好，我无法给到相关内容。短', {
        isCanned,
        statesReason,
        minRemainderChars: 8,
      });
      expect(result.stripped).toBe(false);
    });

    test('handles empty input', () => {
      const result = stripLeadingRefusal('', { isCanned, statesReason });
      expect(result.stripped).toBe(false);
    });

    test('does not strip if whole text is refusal', () => {
      const result = stripLeadingRefusal('你好，我无法给到相关内容。', {
        isCanned,
        statesReason,
      });
      expect(result.stripped).toBe(false);
    });
  });

  describe('buildResetChunk', () => {
    test('builds reset chunk', () => {
      const result = buildResetChunk('bare-refusal-retry');
      expect(result.type).toBe('reset');
      expect(result.reason).toBe('bare-refusal-retry');
      expect(result.retract).toBe(true);
    });

    test('defaults reason', () => {
      const result = buildResetChunk();
      expect(result.reason).toBe('retry');
    });
  });

  describe('isResetChunk', () => {
    test('returns true for reset chunk', () => {
      expect(isResetChunk({ type: 'reset' })).toBe(true);
    });

    test('returns false for non-reset', () => {
      expect(isResetChunk({ type: 'text' })).toBe(false);
      expect(isResetChunk(null)).toBe(false);
      expect(isResetChunk('string')).toBe(false);
    });
  });

  describe('looksLikeBenignConversational', () => {
    test('detects joke request', () => {
      expect(looksLikeBenignConversational('讲个笑话')).toBe(true);
      expect(looksLikeBenignConversational('讲一个笑话')).toBe(true);
    });

    test('detects greeting', () => {
      expect(looksLikeBenignConversational('你好')).toBe(true);
    });

    test('detects English joke request', () => {
      expect(looksLikeBenignConversational('tell me a joke')).toBe(true);
    });

    test('rejects harmful content', () => {
      expect(looksLikeBenignConversational('如何入侵')).toBe(false);
      expect(looksLikeBenignConversational('hack a server')).toBe(false);
    });

    test('rejects long text', () => {
      expect(looksLikeBenignConversational('a'.repeat(201))).toBe(false);
    });
  });

  describe('refusalSignature', () => {
    test('normalizes and strips punctuation', () => {
      const result = refusalSignature('我无法给到相关内容。');
      expect(result).toBe('我无法给到相关内容');
    });

    test('handles different punctuation', () => {
      const s1 = refusalSignature('我无法给到相关内容。');
      const s2 = refusalSignature('我无法给到相关内容！');
      expect(s1).toBe(s2);
    });

    test('handles empty input', () => {
      expect(refusalSignature('')).toBe('');
      expect(refusalSignature(null)).toBe('');
    });

    test('truncates to 80 chars', () => {
      const long = '我无法给到相关内容' + '。'.repeat(50);
      expect(refusalSignature(long).length).toBeLessThanOrEqual(80);
    });
  });
});
