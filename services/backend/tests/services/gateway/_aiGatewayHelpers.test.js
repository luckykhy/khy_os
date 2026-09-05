'use strict';

const {
  shouldUseFastFail,
  isRetryableResultErrorType,
  parsePositiveInt,
  parseNonNegativeInt,
  parseFloat01,
  sanitizeFailureMessage,
  normalizeAdapterSig,
  injectKhyProtocolSystem,
  injectKhyExpectedLanguageSystem,
  requestsExplicitEnglishOutput,
  requestsChineseOutput,
  resolveExpectedKhyLanguage,
  isLanguageCorrectionEnabled,
  looksLikeChineseScript,
  looksLikeEnglishScript,
  normalizeVisibleChunkText,
  normalizeLanguageAdapterKey,
  formatRouteAgeMs,
  adapterMayOverridePromptDownstream,
  getKhyProtocolPriorityRisk,
  KHY_PROTOCOL_PRIORITY_BLOCK,
} = require('../../../src/services/gateway/_aiGatewayHelpers');

// Mock retryWithBackoff
jest.mock('../../../src/services/retryWithBackoff', () => ({
  isRetryableError: jest.fn((type) => ['rate_limit', 'overloaded', 'timeout', 'network', 'server_error'].includes(type)),
}));

describe('_aiGatewayHelpers', () => {
  describe('shouldUseFastFail', () => {
    test('returns true for auth', () => {
      expect(shouldUseFastFail('auth')).toBe(true);
    });

    test('returns true for permission', () => {
      expect(shouldUseFastFail('permission')).toBe(true);
    });

    test('returns false for rate_limit', () => {
      expect(shouldUseFastFail('rate_limit')).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(shouldUseFastFail('AUTH')).toBe(true);
    });
  });

  describe('isRetryableResultErrorType', () => {
    test('returns true for retryable errors', () => {
      expect(isRetryableResultErrorType('rate_limit')).toBe(true);
      expect(isRetryableResultErrorType('timeout')).toBe(true);
    });

    test('returns false for non-retryable errors', () => {
      expect(isRetryableResultErrorType('auth')).toBe(false);
    });
  });

  describe('parsePositiveInt', () => {
    test('parses valid integer', () => {
      expect(parsePositiveInt('5', 1)).toBe(5);
    });

    test('returns fallback for invalid', () => {
      expect(parsePositiveInt('abc', 1)).toBe(1);
    });

    test('enforces min', () => {
      expect(parsePositiveInt('0', 1)).toBe(1);
    });

    test('enforces max', () => {
      expect(parsePositiveInt('20', 1, 1, 16)).toBe(16);
    });
  });

  describe('parseNonNegativeInt', () => {
    test('parses valid integer', () => {
      expect(parseNonNegativeInt('5', 0)).toBe(5);
    });

    test('returns fallback for negative', () => {
      expect(parseNonNegativeInt('-1', 0)).toBe(0);
    });

    test('allows zero', () => {
      expect(parseNonNegativeInt('0', 1)).toBe(0);
    });
  });

  describe('parseFloat01', () => {
    test('parses valid float', () => {
      expect(parseFloat01('0.5', 0)).toBe(0.5);
    });

    test('returns fallback for out of range', () => {
      expect(parseFloat01('2', 0.5)).toBe(0.5);
    });

    test('clamps to [0, 1]', () => {
      expect(parseFloat01('-0.1', 0)).toBe(0);
    });
  });

  describe('sanitizeFailureMessage', () => {
    test('trims whitespace', () => {
      expect(sanitizeFailureMessage('  error  ')).toBe('error');
    });

    test('returns unknown for empty', () => {
      expect(sanitizeFailureMessage('')).toBe('unknown error');
    });

    test('truncates long messages', () => {
      const long = 'a'.repeat(300);
      expect(sanitizeFailureMessage(long).length).toBeLessThanOrEqual(221);
    });
  });

  describe('normalizeAdapterSig', () => {
    test('normalizes localllm', () => {
      expect(normalizeAdapterSig('Local LLM')).toBe('localllm');
    });

    test('normalizes codex', () => {
      expect(normalizeAdapterSig('OpenAI Codex')).toBe('codex');
    });

    test('normalizes claude', () => {
      expect(normalizeAdapterSig('Anthropic Claude')).toBe('claude');
    });

    test('returns adapter for empty', () => {
      expect(normalizeAdapterSig('')).toBe('adapter');
    });
  });

  describe('injectKhyProtocolSystem', () => {
    test('returns protocol block for empty system', () => {
      expect(injectKhyProtocolSystem('')).toBe(KHY_PROTOCOL_PRIORITY_BLOCK);
    });

    test('prepends to existing system', () => {
      const result = injectKhyProtocolSystem('Existing prompt');
      expect(result).toContain('KHY Protocol Priority');
      expect(result).toContain('Existing prompt');
    });

    test('does not duplicate', () => {
      const result = injectKhyProtocolSystem(KHY_PROTOCOL_PRIORITY_BLOCK);
      expect(result).toBe(KHY_PROTOCOL_PRIORITY_BLOCK);
    });
  });

  describe('injectKhyExpectedLanguageSystem', () => {
    test('returns inherited for non-codex', () => {
      expect(injectKhyExpectedLanguageSystem('test', {}, {}, 'claude')).toBe('test');
    });

    test('injects for codex with Chinese', () => {
      const result = injectKhyExpectedLanguageSystem('', 'test', { language: 'zh' }, 'codex');
      expect(result).toContain('Simplified Chinese');
    });

    test('skips for explicit English', () => {
      const result = injectKhyExpectedLanguageSystem('test', '', { language: 'en' }, 'codex');
      expect(result).toBe('test');
    });
  });

  describe('requestsExplicitEnglishOutput', () => {
    test('returns true for en', () => {
      expect(requestsExplicitEnglishOutput('', { language: 'en' })).toBe(true);
    });

    test('returns false for zh', () => {
      expect(requestsExplicitEnglishOutput('', { language: 'zh' })).toBe(false);
    });
  });

  describe('requestsChineseOutput', () => {
    test('returns true for zh', () => {
      expect(requestsChineseOutput('', { language: 'zh' })).toBe(true);
    });

    test('returns true for chinese', () => {
      expect(requestsChineseOutput('', { language: 'chinese' })).toBe(true);
    });
  });

  describe('resolveExpectedKhyLanguage', () => {
    test('returns en for English', () => {
      expect(resolveExpectedKhyLanguage('', { language: 'en' })).toBe('en');
    });

    test('returns zh by default', () => {
      expect(resolveExpectedKhyLanguage('', {})).toBe('zh');
    });
  });

  describe('isLanguageCorrectionEnabled', () => {
    test('returns true for codex', () => {
      expect(isLanguageCorrectionEnabled('codex')).toBe(true);
    });

    test('returns false for unknown', () => {
      expect(isLanguageCorrectionEnabled('unknown')).toBe(false);
    });
  });

  describe('looksLikeChineseScript', () => {
    test('returns true for Chinese text', () => {
      expect(looksLikeChineseScript('你好世界')).toBe(true);
    });

    test('returns false for English text', () => {
      expect(looksLikeChineseScript('hello world')).toBe(false);
    });
  });

  describe('looksLikeEnglishScript', () => {
    test('returns true for English text', () => {
      expect(looksLikeEnglishScript('hello world')).toBe(true);
    });

    test('returns false for Chinese text', () => {
      expect(looksLikeEnglishScript('你好世界')).toBe(false);
    });
  });

  describe('normalizeVisibleChunkText', () => {
    test('returns string as-is', () => {
      expect(normalizeVisibleChunkText('text')).toBe('text');
    });

    test('extracts text from object', () => {
      expect(normalizeVisibleChunkText({ text: 'hello' })).toBe('hello');
    });

    test('returns empty for null', () => {
      expect(normalizeVisibleChunkText(null)).toBe('');
    });
  });

  describe('normalizeLanguageAdapterKey', () => {
    test('lowercases string', () => {
      expect(normalizeLanguageAdapterKey('CODEX')).toBe('codex');
    });

    test('extracts from object', () => {
      expect(normalizeLanguageAdapterKey({ adapterKey: 'claude' })).toBe('claude');
    });
  });

  describe('formatRouteAgeMs', () => {
    test('formats milliseconds', () => {
      expect(formatRouteAgeMs(500)).toBe('500ms');
    });

    test('formats seconds', () => {
      expect(formatRouteAgeMs(5000)).toBe('5s');
    });

    test('formats minutes', () => {
      expect(formatRouteAgeMs(60000)).toBe('1m');
    });

    test('returns empty for invalid', () => {
      expect(formatRouteAgeMs(-1)).toBe('');
    });
  });

  describe('adapterMayOverridePromptDownstream', () => {
    test('returns true for codex', () => {
      expect(adapterMayOverridePromptDownstream('codex')).toBe(true);
    });

    test('returns false for unknown', () => {
      expect(adapterMayOverridePromptDownstream('unknown')).toBe(false);
    });
  });

  describe('getKhyProtocolPriorityRisk', () => {
    test('returns high for codex', () => {
      expect(getKhyProtocolPriorityRisk('codex')).toBe('high');
    });

    test('returns low for claude', () => {
      expect(getKhyProtocolPriorityRisk('claude')).toBe('low');
    });

    test('returns unknown for null', () => {
      expect(getKhyProtocolPriorityRisk(null)).toBe('unknown');
    });
  });
});
