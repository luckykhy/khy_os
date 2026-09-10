'use strict';

const {
  isEnabled,
  computeUpscaledFactors,
  buildResolutionNotice,
  FLAG,
} = require('./ocrResolutionNotice');

describe('ocrResolutionNotice', () => {
  describe('FLAG', () => {
    it('should be KHY_OCR_UPSCALE', () => {
      expect(FLAG).toBe('KHY_OCR_UPSCALE');
    });
  });

  describe('isEnabled', () => {
    it('returns true when flag is enabled', () => {
      expect(isEnabled({ KHY_OCR_UPSCALE: '1' })).toBe(true);
    });

    it('returns false when flag is disabled', () => {
      expect(isEnabled({ KHY_OCR_UPSCALE: '0' })).toBe(false);
    });

    it('returns true when env is null (uses process.env)', () => {
      expect(isEnabled(null)).toBe(true);
    });
  });

  describe('computeUpscaledFactors', () => {
    it('returns empty array for non-array input', () => {
      expect(computeUpscaledFactors(null)).toEqual([]);
      expect(computeUpscaledFactors('string')).toEqual([]);
      expect(computeUpscaledFactors({})).toEqual([]);
    });

    it('collects upscaledFactor values > 1', () => {
      const details = [
        { upscaledFactor: 2 },
        { upscaledFactor: 3 },
        { upscaledFactor: 4 },
      ];
      expect(computeUpscaledFactors(details)).toEqual([2, 3, 4]);
    });

    it('ignores values <= 1', () => {
      const details = [
        { upscaledFactor: 1 },
        { upscaledFactor: 0 },
        { upscaledFactor: -2 },
        { upscaledFactor: 2 },
      ];
      expect(computeUpscaledFactors(details)).toEqual([2]);
    });

    it('deduplicates and sorts', () => {
      const details = [
        { upscaledFactor: 4 },
        { upscaledFactor: 2 },
        { upscaledFactor: 4 },
      ];
      expect(computeUpscaledFactors(details)).toEqual([2, 4]);
    });

    it('ignores non-finite values', () => {
      const details = [
        { upscaledFactor: NaN },
        { upscaledFactor: Infinity },
        { upscaledFactor: 'abc' },
        { upscaledFactor: 2 },
      ];
      expect(computeUpscaledFactors(details)).toEqual([2]);
    });

    it('ignores null/undefined entries', () => {
      const details = [null, undefined, { upscaledFactor: 2 }];
      expect(computeUpscaledFactors(details)).toEqual([2]);
    });
  });

  describe('buildResolutionNotice', () => {
    it('returns null when flag is disabled', () => {
      expect(buildResolutionNotice({ upscaled: [2], env: { KHY_OCR_UPSCALE: '0' } })).toBeNull();
    });

    it('returns null when upscaled is empty', () => {
      expect(buildResolutionNotice({ upscaled: [], env: { KHY_OCR_UPSCALE: '1' } })).toBeNull();
    });

    it('returns null when upscaled is not an array', () => {
      expect(buildResolutionNotice({ upscaled: null, env: { KHY_OCR_UPSCALE: '1' } })).toBeNull();
    });

    it('builds notice with single factor', () => {
      const notice = buildResolutionNotice({ upscaled: [2], env: { KHY_OCR_UPSCALE: '1' } });
      expect(notice).toContain('2×');
      expect(notice).toContain('分辨率较�?);
      expect(notice).toContain('自动放大');
    });

    it('builds notice with multiple factors', () => {
      const notice = buildResolutionNotice({ upscaled: [2, 3, 4], env: { KHY_OCR_UPSCALE: '1' } });
      expect(notice).toContain('2×');
      expect(notice).toContain('3×');
      expect(notice).toContain('4×');
    });
  });
});

