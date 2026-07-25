'use strict';

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  generateRecap,
  formatRecap,
  toProtocolMessage,
} = require('../src/services/sessionRecapService');

describe('sessionRecapService', () => {
  // ── generateRecap ──

  describe('generateRecap()', () => {
    test('returns empty recap for null/empty messages', () => {
      const recap = generateRecap(null);
      expect(recap.turns).toBe(0);
      expect(recap.summary).toBe('Empty conversation.');

      const recap2 = generateRecap([]);
      expect(recap2.turns).toBe(0);
      expect(recap2.summary).toBe('Empty conversation.');
    });

    test('counts user turns correctly', () => {
      const messages = [
        { role: 'user', content: 'Hello, help me with a task' },
        { role: 'assistant', content: 'Sure, what do you need?' },
        { role: 'user', content: 'Fix the login page' },
        { role: 'assistant', content: 'I will fix the login page.' },
      ];
      const recap = generateRecap(messages);
      expect(recap.turns).toBe(2);
    });

    test('handles single user message', () => {
      const messages = [{ role: 'user', content: 'Quick question about Node.js' }];
      const recap = generateRecap(messages);
      expect(recap.turns).toBe(1);
      expect(recap.sections).toBeDefined();
    });
  });

  // ── Topic extraction ──

  describe('topic extraction', () => {
    test('extracts topics from user messages', () => {
      const messages = [
        { role: 'user', content: 'How do I configure Webpack for production?' },
        { role: 'assistant', content: 'Here is the config...' },
        { role: 'user', content: 'What about code splitting strategies?' },
        { role: 'assistant', content: 'You can use dynamic imports...' },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.topics.length).toBeGreaterThanOrEqual(2);
    });

    test('deduplicates similar topics', () => {
      const messages = [
        { role: 'user', content: 'Fix the login page' },
        { role: 'user', content: 'Fix the login page' },
      ];
      const recap = generateRecap(messages);
      // Should deduplicate
      expect(recap.sections.topics.length).toBe(1);
    });

    test('skips very short user messages as topics', () => {
      const messages = [{ role: 'user', content: 'hi' }];
      const recap = generateRecap(messages);
      expect(recap.sections.topics.length).toBe(0);
    });
  });

  // ── Decision extraction ──

  describe('decision extraction', () => {
    test('extracts decisions from assistant messages', () => {
      const messages = [
        { role: 'user', content: 'Fix the auth system' },
        { role: 'assistant', content: "I'll refactor the authentication middleware to use JWT tokens." },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.decisions.length).toBeGreaterThanOrEqual(1);
    });

    test('extracts "created/wrote/added" decisions', () => {
      const messages = [
        { role: 'assistant', content: 'I created a new configuration file for the database connection pooling.' },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.decisions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── File reference extraction ──

  describe('file reference extraction', () => {
    test('extracts file paths from messages', () => {
      const messages = [
        { role: 'user', content: 'Check `src/utils/logger.js` and `config/database.js`' },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.filesChanged).toContain('src/utils/logger.js');
      expect(recap.sections.filesChanged).toContain('config/database.js');
    });

    test('filters out URLs (http/www)', () => {
      const messages = [
        { role: 'user', content: 'See https://example.com/file.js and check www.google.com/page.html' },
      ];
      const recap = generateRecap(messages);
      // URLs should be filtered
      for (const f of recap.sections.filesChanged) {
        expect(f).not.toContain('http');
        expect(f).not.toContain('www.');
      }
    });

    test('filters out hidden files starting with dot', () => {
      const messages = [
        { role: 'user', content: 'Look at .env and .gitignore and src/main.js' },
      ];
      const recap = generateRecap(messages);
      for (const f of recap.sections.filesChanged) {
        expect(f).not.toMatch(/^\./);
      }
    });

    test('uses context.filesChanged when provided', () => {
      const messages = [
        { role: 'user', content: 'Fix the bug' },
        { role: 'assistant', content: 'Done.' },
      ];
      const recap = generateRecap(messages, { filesChanged: ['a.js', 'b.ts'] });
      expect(recap.sections.filesChanged).toEqual(['a.js', 'b.ts']);
    });
  });

  // ── Command extraction ──

  describe('command extraction', () => {
    test('extracts commands from code blocks in assistant messages', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Run this:\n```bash\nnpm install express\nnpm start\n```',
        },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.commandsRun).toContain('npm install express');
      expect(recap.sections.commandsRun).toContain('npm start');
    });

    test('strips leading $ from commands', () => {
      const messages = [
        {
          role: 'assistant',
          content: '```sh\n$ git status\n$ git add .\n```',
        },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.commandsRun).toContain('git status');
      expect(recap.sections.commandsRun).toContain('git add .');
    });

    test('skips comment lines in code blocks', () => {
      const messages = [
        {
          role: 'assistant',
          content: '```bash\n# This is a comment\necho hello\n```',
        },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.commandsRun).not.toContain('# This is a comment');
      expect(recap.sections.commandsRun).toContain('echo hello');
    });
  });

  // ── Open question extraction ──

  describe('open question extraction', () => {
    test('extracts questions from recent messages', () => {
      const messages = [
        { role: 'user', content: 'Should we use Redis or Memcached for the cache layer?' },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.openQuestions.length).toBeGreaterThanOrEqual(1);
    });

    test('skips rhetorical questions like "would you like"', () => {
      const messages = [
        { role: 'assistant', content: 'Would you like me to continue with this approach?' },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.openQuestions.length).toBe(0);
    });
  });

  // ── Key insight extraction ──

  describe('key insight extraction', () => {
    test('extracts insights with "important" keyword', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Important: the database connection must be closed before the process exits to avoid leaks.',
        },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.keyInsights.length).toBeGreaterThanOrEqual(1);
    });

    test('extracts "root cause" insights', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'The root cause was the missing index on the users table causing full table scans.',
        },
      ];
      const recap = generateRecap(messages);
      expect(recap.sections.keyInsights.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── formatRecap ──

  describe('formatRecap()', () => {
    test('output contains turn count', () => {
      const recap = generateRecap([
        { role: 'user', content: 'Fix the authentication flow' },
        { role: 'assistant', content: "I'll fix it by updating the middleware." },
      ]);
      const output = formatRecap(recap);
      expect(output).toContain('1 turns');
    });

    test('output contains Topics section when topics exist', () => {
      const recap = generateRecap([
        { role: 'user', content: 'Configure the database connection pool settings' },
        { role: 'assistant', content: 'Here are the settings...' },
      ]);
      const output = formatRecap(recap);
      expect(output).toContain('Topics:');
    });
  });

  // ── toProtocolMessage ──

  describe('toProtocolMessage()', () => {
    test('returns correct structure', () => {
      const recap = { turns: 5, summary: 'test', sections: {} };
      const msg = toProtocolMessage(recap);
      expect(msg.type).toBe('session_recap');
      expect(msg.recap).toBe(recap);
    });
  });
});
