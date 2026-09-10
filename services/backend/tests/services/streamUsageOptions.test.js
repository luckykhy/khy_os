'use strict';

const { streamUsageEnabled, applyStreamUsage } = require('../../src/services/streamUsageOptions');

jest.mock('../../src/services/flagRegistry', () => ({
  isRegistryEnabled: jest.fn(),
  isFlagEnabled: jest.fn()
}));

describe('streamUsageOptions', () => {
  const { isRegistryEnabled, isFlagEnabled } = require('../../src/services/flagRegistry');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('streamUsageEnabled', () => {
    test('returns true by default', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(streamUsageEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: '0' })).toBe(false);
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: 'false' })).toBe(false);
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: 'off' })).toBe(false);
      expect(streamUsageEnabled({ KHY_STREAM_USAGE: 'no' })).toBe(false);
    });

    test('delegates to flagRegistry when available', () => {
      isRegistryEnabled.mockReturnValue(true);
      isFlagEnabled.mockReturnValue(true);
      expect(streamUsageEnabled({})).toBe(true);
      expect(isFlagEnabled).toHaveBeenCalledWith('KHY_STREAM_USAGE', {});
    });
  });

  describe('applyStreamUsage', () => {
    test('adds stream_options when enabled', () => {
      isRegistryEnabled.mockReturnValue(false);
      const body = { stream: true, messages: [] };
      const result = applyStreamUsage(body, {});
      expect(result.stream_options).toEqual({ include_usage: true });
    });

    test('does not modify body when disabled', () => {
      isRegistryEnabled.mockReturnValue(false);
      const body = { stream: true, messages: [] };
      const result = applyStreamUsage(body, { KHY_STREAM_USAGE: '0' });
      expect(result.stream_options).toBeUndefined();
    });

    test('preserves existing stream_options', () => {
      isRegistryEnabled.mockReturnValue(false);
      const body = { stream: true, stream_options: { some_key: 'value' } };
      const result = applyStreamUsage(body, {});
      expect(result.stream_options).toEqual({ some_key: 'value', include_usage: true });
    });

    test('returns null/undefined input unchanged', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(applyStreamUsage(null, {})).toBeNull();
      expect(applyStreamUsage(undefined, {})).toBeUndefined();
    });

    test('returns non-object input unchanged', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(applyStreamUsage('string', {})).toBe('string');
      expect(applyStreamUsage(123, {})).toBe(123);
    });
  });
});
