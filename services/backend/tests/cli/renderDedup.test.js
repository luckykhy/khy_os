'use strict';

const { renderDedupEnabled, finalAlreadyStreamed } = require('./renderDedup');

describe('renderDedup', () => {
  describe('renderDedupEnabled', () => {
    it('returns true when env var is unset', () => {
      expect(renderDedupEnabled({})).toBe(true);
      expect(renderDedupEnabled(undefined)).toBe(true);
    });

    it('returns false for off values', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(renderDedupEnabled({ KHY_RENDER_DEDUP: v })).toBe(false);
      }
    });

    it('returns true for other values', () => {
      expect(renderDedupEnabled({ KHY_RENDER_DEDUP: '1' })).toBe(true);
    });
  });

  describe('finalAlreadyStreamed', () => {
    it('returns false when gate is off', () => {
      expect(finalAlreadyStreamed('hello', 'hello', { KHY_RENDER_DEDUP: '0' })).toBe(false);
    });

    it('returns false when finalText is empty', () => {
      expect(finalAlreadyStreamed('', 'hello', {})).toBe(false);
    });

    it('returns false when streamedText is empty', () => {
      expect(finalAlreadyStreamed('hello', '', {})).toBe(false);
    });

    it('returns true when final is suffix of streamed', () => {
      expect(finalAlreadyStreamed('world', 'hello world', {})).toBe(true);
    });

    it('returns false when final is not suffix of streamed', () => {
      expect(finalAlreadyStreamed('hello', 'world', {})).toBe(false);
    });

    it('normalizes whitespace before comparison', () => {
      expect(finalAlreadyStreamed('hello world', 'hello  world', {})).toBe(true);
      expect(finalAlreadyStreamed('hello\nworld', 'hello world', {})).toBe(true);
    });

    it('returns true for exact match', () => {
      expect(finalAlreadyStreamed('hello', 'hello', {})).toBe(true);
    });

    it('returns false when final is longer than streamed', () => {
      expect(finalAlreadyStreamed('hello world', 'hello', {})).toBe(false);
    });

    it('handles null/undefined inputs', () => {
      expect(finalAlreadyStreamed(null, 'hello', {})).toBe(false);
      expect(finalAlreadyStreamed('hello', null, {})).toBe(false);
      expect(finalAlreadyStreamed(undefined, undefined, {})).toBe(false);
    });
  });
});
