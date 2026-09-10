'use strict';

jest.mock('../flagRegistry', () => ({
  isFlagEnabled: jest.fn()
}));

const { isEnabled, buildUsageDisclosure } = require('../../../src/services/gateway/ocrUsageNotice');
const { isFlagEnabled } = require('../flagRegistry');

describe('ocrUsageNotice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('isEnabled delegates to flagRegistry', () => {
    isFlagEnabled.mockReturnValue(true);
    expect(isEnabled({})).toBe(true);
  });

  test('returns false on error', () => {
    isFlagEnabled.mockImplementation(() => { throw new Error('fail'); });
    expect(isEnabled({})).toBe(false);
  });

  test('buildUsageDisclosure returns null when disabled', () => {
    isFlagEnabled.mockReturnValue(false);
    expect(buildUsageDisclosure({ count: 1, env: {} })).toBeNull();
  });

  test('buildUsageDisclosure returns null for invalid count', () => {
    isFlagEnabled.mockReturnValue(true);
    expect(buildUsageDisclosure({ count: 0, env: {} })).toBeNull();
    expect(buildUsageDisclosure({ count: -1, env: {} })).toBeNull();
  });

  test('buildUsageDisclosure returns disclosure for valid count', () => {
    isFlagEnabled.mockReturnValue(true);
    const result = buildUsageDisclosure({ count: 1, env: {} });
    expect(result).toContain('OCR');
    expect(result).toContain('这张图片');
  });

  test('buildUsageDisclosure handles plural', () => {
    isFlagEnabled.mockReturnValue(true);
    const result = buildUsageDisclosure({ count: 3, env: {} });
    expect(result).toContain('这 3 张图片');
  });
});
