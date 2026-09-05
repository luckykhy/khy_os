'use strict';

const {
  streamUsageEnabled,
  applyStreamUsage,
} = require('../../../src/services/streamUsageOptions');

describe('streamUsageOptions', () => {
  describe('streamUsageEnabled', () => {
    test('returns true by default', () => {
      expect(streamUsageEnabled({})).toBe(true);
    });

    test('returns false when flag is off', () => {
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: '0' })).toBe(false);
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: 'false' })).toBe(false);
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: 'off' })).toBe(false);
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: 'FALSE' })).toBe(false);
    });
  });

  describe('applyStreamUsage', () => {
    test('adds stream_options when enabled', () => {
      const body = { stream: true, messages: [] };
      const result = applyStreamUsage(body, {});
      expect(result.stream_options).toEqual({ include_usage: true });
    });

    test('does not modify when disabled', () => {
      const body = { stream: true, messages: [] };
      const result = applyStreamUsage(body, { KHY_STREAM_USAGE: '0' });
      expect(result.stream_options).toBeUndefined();
    });

    test('preserves existing stream_options', () => {
      const body = { stream: true, stream_options: { some_field: 'value' } };
      const result = applyStreamUsage(body, {});
      expect(result.stream_options.some_field).toBe('value');
      expect(result.stream_options.include_usage).toBe(true);
    });

    test('returns non-object input as-is', () => {
      expect(applyStreamUsage(null, {})).toBeNull();
      expect(applyStreamUsage('string', {})).toBe('string');
    });

    test('does not overwrite existing include_usage', () => {
      const body = { stream_options: { include_usage: false } };
      const result = applyStreamUsage(body, {});
      expect(result.stream_options.include_usage).toBe(true);
    });
  });
});
