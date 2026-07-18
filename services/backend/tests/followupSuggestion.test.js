'use strict';

/**
 * Tests for the Follow-up Suggestion Service.
 */

const {
  generateFollowUpSuggestions,
  formatSuggestions,
  toProtocolMessage,
  _detectCategory,
  _extractPatternSuggestions,
} = require('../src/services/followupSuggestionService');

describe('followupSuggestionService', () => {

  describe('_detectCategory', () => {
    test('detects code generation from code blocks', () => {
      const text = 'Here is the implementation:\n```js\nfunction foo() { return 42; }\n```\nThis function returns 42.';
      expect(_detectCategory(text)).toBe('codeGenerated');
    });

    test('detects debugging from error mentions', () => {
      expect(_detectCategory('The error was: TypeError: undefined is not a function')).toBe('debugging');
    });

    test('detects file editing from write tool calls', () => {
      expect(_detectCategory('File updated', { toolCalls: [{ name: 'write_file' }] })).toBe('fileEdit');
    });

    test('detects explanation from explanation keywords', () => {
      expect(_detectCategory('This works because the event loop processes callbacks in order, therefore...')).toBe('explanation');
    });

    test('returns general for short text', () => {
      expect(_detectCategory('ok')).toBe('general');
    });
  });

  describe('_extractPatternSuggestions', () => {
    test('extracts suggestion from file:line references', () => {
      const result = _extractPatternSuggestions('Check src/main.js:42 for the issue');
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('src/main.js');
    });

    test('extracts suggestion from error messages', () => {
      const host = 'localhost';
      const port = 3000;
      const result = _extractPatternSuggestions(`Error: Connection refused to ${host}:${port}`);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('Fix');
    });

    test('returns empty for short text', () => {
      expect(_extractPatternSuggestions('ok')).toEqual([]);
    });

    test('limits to 2 pattern suggestions', () => {
      const text = 'Error: something broke\nTODO: fix this\nCheck test.spec.js:10\nFIXME: urgent';
      const result = _extractPatternSuggestions(text);
      expect(result.length).toBeLessThanOrEqual(2);
    });
  });

  describe('generateFollowUpSuggestions', () => {
    test('returns 1-3 suggestions for code response', async () => {
      const text = 'Here is the implementation:\n```python\ndef quicksort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[0]\n    return quicksort([x for x in arr[1:] if x < pivot]) + [pivot] + quicksort([x for x in arr[1:] if x >= pivot])\n```';
      const suggestions = await generateFollowUpSuggestions(text);
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions.length).toBeLessThanOrEqual(3);
    });

    test('returns empty for very short text', async () => {
      const suggestions = await generateFollowUpSuggestions('ok');
      expect(suggestions).toEqual([]);
    });

    test('returns context-appropriate suggestions for debugging', async () => {
      const text = 'The traceback shows:\nError: ENOENT: no such file or directory\nat Object.openSync (node:fs:603:3)\nat readFileSync (node:fs:471:35)';
      const suggestions = await generateFollowUpSuggestions(text);
      expect(suggestions.length).toBeGreaterThan(0);
    });

    test('accepts tool call context', async () => {
      const text = 'I have created the file at /tmp/test.js with the implementation.';
      const suggestions = await generateFollowUpSuggestions(text, {
        toolCalls: [{ name: 'write_file' }],
      });
      expect(suggestions.length).toBeGreaterThan(0);
    });

    test('never returns more than 3', async () => {
      const text = 'Error: big problem\nTODO: fix everything\nFIXME: urgent\nCheck src/main.js:42\nsrc/test.js:10\nperformance is slow\nSQL injection found';
      const suggestions = await generateFollowUpSuggestions(text);
      expect(suggestions.length).toBeLessThanOrEqual(3);
    });
  });

  describe('formatSuggestions', () => {
    test('returns empty string for no suggestions', () => {
      expect(formatSuggestions([])).toBe('');
      expect(formatSuggestions(null)).toBe('');
    });

    test('formats suggestions with numbering', () => {
      const result = formatSuggestions(['Run tests', 'Check logs']);
      expect(result).toContain('1.');
      expect(result).toContain('2.');
      expect(result).toContain('Run tests');
      expect(result).toContain('Suggestions');
    });
  });

  describe('toProtocolMessage', () => {
    test('creates protocol message', () => {
      const msg = toProtocolMessage(['Run tests'], 'req-123');
      expect(msg.type).toBe('suggestions');
      expect(msg.suggestions).toEqual(['Run tests']);
      expect(msg.requestId).toBe('req-123');
    });
  });
});
