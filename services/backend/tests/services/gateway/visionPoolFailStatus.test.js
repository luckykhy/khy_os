'use strict';

jest.mock('../flagRegistry', () => ({
  isFlagEnabled: jest.fn(),
  isRegistryEnabled: jest.fn()
}));

const { isVisionPoolFailStatusHumanizeEnabled, buildVisionPoolFailStatus } = require('../../../src/services/gateway/visionPoolFailStatus');
const { isFlagEnabled, isRegistryEnabled } = require('../flagRegistry');

describe('visionPoolFailStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isVisionPoolFailStatusHumanizeEnabled', () => {
    test('delegates to flagRegistry when available', () => {
      isRegistryEnabled.mockReturnValue(true);
      isFlagEnabled.mockReturnValue(true);
      expect(isVisionPoolFailStatusHumanizeEnabled({})).toBe(true);
    });

    test('returns false for off values when registry disabled', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(isVisionPoolFailStatusHumanizeEnabled({ KHY_VISION_POOL_FAIL_STATUS_HUMANIZE: '0' })).toBe(false);
    });

    test('returns true by default when registry disabled', () => {
      isRegistryEnabled.mockReturnValue(false);
      expect(isVisionPoolFailStatusHumanizeEnabled({})).toBe(true);
    });
  });

  describe('buildVisionPoolFailStatus', () => {
    test('returns null when disabled', () => {
      isRegistryEnabled.mockReturnValue(false);
      const result = buildVisionPoolFailStatus({ poolName: 'vision-openai', ocrRescued: true, env: { KHY_VISION_POOL_FAIL_STATUS_HUMANIZE: '0' } });
      expect(result).toBeNull();
    });

    test('returns null when ocrRescued is not true', () => {
      isRegistryEnabled.mockReturnValue(false);
      const result = buildVisionPoolFailStatus({ poolName: 'vision-openai', ocrRescued: false, env: {} });
      expect(result).toBeNull();
    });

    test('returns null when poolName does not contain vision', () => {
      isRegistryEnabled.mockReturnValue(false);
      const result = buildVisionPoolFailStatus({ poolName: 'text-openai', ocrRescued: true, env: {} });
      expect(result).toBeNull();
    });

    test('returns humanized message for vision pool with OCR rescue', () => {
      isRegistryEnabled.mockReturnValue(false);
      const result = buildVisionPoolFailStatus({ poolName: 'vision-openai', ocrRescued: true, env: {} });
      expect(result).toBe('视觉通道当前不可用，已用本地 OCR 兜底');
    });
  });
});

