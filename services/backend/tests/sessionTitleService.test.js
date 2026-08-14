'use strict';

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  generateTitle,
  generateTitleAI,
  _extractFromPatterns,
  _extractKeywords,
} = require('../src/services/sessionTitleService');

describe('sessionTitleService', () => {
  // ── generateTitle ──

  describe('generateTitle()', () => {
    test('returns "New Conversation" for null/undefined/empty input', () => {
      expect(generateTitle(null)).toBe('New Conversation');
      expect(generateTitle(undefined)).toBe('New Conversation');
      expect(generateTitle('')).toBe('New Conversation');
    });

    test('returns "New Conversation" for non-string input', () => {
      expect(generateTitle(123)).toBe('New Conversation');
      expect(generateTitle({})).toBe('New Conversation');
    });

    test('returns short input directly when <= 50 chars and >= 3 chars', () => {
      expect(generateTitle('Setup Docker for CI')).toBe('Setup Docker for CI');
    });

    test('truncates long first line with ellipsis', () => {
      const longMsg = 'A'.repeat(100);
      const title = generateTitle(longMsg);
      expect(title.length).toBeLessThanOrEqual(50);
      expect(title).toMatch(/\.\.\.$/);
    });

    test('uses first line only for multi-line input', () => {
      const msg = 'Short title here\nThis is additional context that should be ignored.';
      expect(generateTitle(msg)).toBe('Short title here');
    });

    test('matches "fix" pattern', () => {
      const title = generateTitle('fix the memory leak in worker threads');
      expect(title.toLowerCase()).toContain('fix');
    });

    test('matches "add/implement/create" pattern', () => {
      const title = generateTitle('add support for WebSocket reconnection logic');
      expect(title.toLowerCase()).toContain('add');
    });

    test('matches "how to" pattern', () => {
      const title = generateTitle('how to configure nginx reverse proxy');
      expect(title.toLowerCase()).toContain('how to');
    });

    test('matches "explain" pattern', () => {
      const title = generateTitle('explain the difference between TCP and UDP protocols');
      expect(title.toLowerCase()).toContain('explain');
    });

    test('matches "remove/delete" pattern', () => {
      const title = generateTitle('remove deprecated API endpoints from the codebase');
      expect(title.toLowerCase()).toContain('remove');
    });

    test('matches "test/review" pattern', () => {
      const title = generateTitle('test the authentication middleware for edge cases');
      expect(title.toLowerCase()).toContain('test');
    });

    test('matches Chinese patterns', () => {
      const title = generateTitle('修复用户登录后跳转错误的问题');
      expect(title).toContain('修复');
    });

    test('uses keyword extraction when no pattern matches', () => {
      const msg = 'The database connection pool configuration needs attention due to recent outages happening every night repeatedly';
      const title = generateTitle(msg);
      expect(title).toBeTruthy();
      expect(title.length).toBeLessThanOrEqual(50);
    });

    test('cleans trailing punctuation', () => {
      const title = generateTitle('Hello world!!!');
      expect(title).not.toMatch(/!+$/);
    });
  });

  // ── _extractFromPatterns ──

  describe('_extractFromPatterns()', () => {
    test('returns null for text that matches no pattern', () => {
      expect(_extractFromPatterns('random gibberish text here')).toBeNull();
    });

    test('returns a title for matching pattern', () => {
      const result = _extractFromPatterns('fix the broken build pipeline');
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    test('truncates if extracted pattern > 50 chars', () => {
      const result = _extractFromPatterns('add a comprehensive integration test suite for all API endpoints in the project');
      if (result) {
        expect(result.length).toBeLessThanOrEqual(50);
      }
    });

    test('returns null for empty string', () => {
      expect(_extractFromPatterns('')).toBeNull();
    });
  });

  // ── _extractKeywords ──

  describe('_extractKeywords()', () => {
    test('filters out stop words', () => {
      const result = _extractKeywords('the quick brown fox jumps over the lazy dog');
      expect(result).toBeTruthy();
      // Stop words like "the" and "over" should be filtered
      expect(result.toLowerCase()).not.toMatch(/\bthe\b/);
    });

    test('returns null for empty input', () => {
      expect(_extractKeywords('')).toBeNull();
    });

    test('returns null for input with only stop words', () => {
      expect(_extractKeywords('the a an is are was to of in')).toBeNull();
    });

    test('capitalizes first letter', () => {
      const result = _extractKeywords('database migration strategy');
      expect(result).toBeTruthy();
      expect(result[0]).toBe(result[0].toUpperCase());
    });

    test('takes at most 5 keywords', () => {
      const result = _extractKeywords(
        'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
      );
      expect(result).toBeTruthy();
      const words = result.split(' ');
      expect(words.length).toBeLessThanOrEqual(5);
    });
  });

  // ── generateTitleAI ──

  describe('generateTitleAI()', () => {
    test('returns AI-generated title when AI module succeeds', async () => {
      const mockAI = {
        gateway: {
          query: jest.fn().mockResolvedValue('Docker CI Setup'),
        },
      };
      const title = await generateTitleAI('Setup Docker for CI', 'Here is how...', mockAI);
      expect(title).toBe('Docker CI Setup');
      expect(mockAI.gateway.query).toHaveBeenCalled();
    });

    test('falls back to heuristic when AI returns empty string', async () => {
      const mockAI = {
        gateway: {
          query: jest.fn().mockResolvedValue(''),
        },
      };
      const title = await generateTitleAI('fix the login bug', '', mockAI);
      // Should fall back to heuristic
      expect(title).toBeTruthy();
      expect(title.toLowerCase()).toContain('fix');
    });

    test('falls back to heuristic when AI throws an error', async () => {
      const mockAI = {
        gateway: {
          query: jest.fn().mockRejectedValue(new Error('AI unavailable')),
        },
      };
      const title = await generateTitleAI('add user authentication', '', mockAI);
      expect(title).toBeTruthy();
      expect(title.length).toBeGreaterThan(0);
    });

    test('uses chat() method when query() is unavailable', async () => {
      const mockAI = {
        gateway: {
          chat: jest.fn().mockResolvedValue({ content: 'Auth Flow Fix' }),
        },
      };
      const title = await generateTitleAI('fix auth flow', 'Done.', mockAI);
      expect(title).toBe('Auth Flow Fix');
      expect(mockAI.gateway.chat).toHaveBeenCalled();
    });

    test('strips surrounding quotes from AI result', async () => {
      const mockAI = {
        gateway: {
          query: jest.fn().mockResolvedValue('"Quoted Title"'),
        },
      };
      const title = await generateTitleAI('some message', '', mockAI);
      expect(title).toBe('Quoted Title');
    });
  });
});
