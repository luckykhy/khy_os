'use strict';

const { detectInteractivePrompt, smartDecodeWinOutput } = require('../../src/utils/spawnWithIdleTimeout');

describe('spawnWithIdleTimeout helpers', () => {
  describe('detectInteractivePrompt', () => {
    test('returns false for empty input', () => {
      expect(detectInteractivePrompt('')).toBe(false);
    });

    test('detects y/n prompt', () => {
      expect(detectInteractivePrompt('Continue? (y/n)')).toBe(true);
    });

    test('detects [Y/n] prompt', () => {
      expect(detectInteractivePrompt('Overwrite? [Y/n]')).toBe(true);
    });

    test('detects password prompt', () => {
      expect(detectInteractivePrompt('Enter password:')).toBe(true);
    });

    test('detects "are you sure" prompt', () => {
      expect(detectInteractivePrompt('Are you sure?')).toBe(true);
    });

    test('returns false for non-prompt text', () => {
      expect(detectInteractivePrompt('Hello world')).toBe(false);
    });
  });

  describe('smartDecodeWinOutput', () => {
    test('returns empty for empty buffer', () => {
      expect(smartDecodeWinOutput(Buffer.from(''))).toBe('');
    });

    test('decodes valid UTF-8', () => {
      const buf = Buffer.from('hello world', 'utf8');
      expect(smartDecodeWinOutput(buf)).toBe('hello world');
    });

    test('handles buffer with content', () => {
      const buf = Buffer.from('test content here', 'utf8');
      expect(smartDecodeWinOutput(buf)).toBe('test content here');
    });
  });
});
