'use strict';

const {
  isEnabled,
  computeCorrectedOrientations,
  buildOrientationNotice,
  FLAG,
} = require('./ocrOrientationNotice');

describe('ocrOrientationNotice', () => {
  describe('FLAG', () => {
    it('should be KHY_OCR_AUTO_ORIENT', () => {
      expect(FLAG).toBe('KHY_OCR_AUTO_ORIENT');
    });
  });

  describe('isEnabled', () => {
    it('returns true when flag is enabled', () => {
      expect(isEnabled({ KHY_OCR_AUTO_ORIENT: '1' })).toBe(true);
    });

    it('returns false when flag is disabled', () => {
      expect(isEnabled({ KHY_OCR_AUTO_ORIENT: '0' })).toBe(false);
    });

    it('returns true when env is null (uses process.env)', () => {
      expect(isEnabled(null)).toBe(true);
    });
  });

  describe('computeCorrectedOrientations', () => {
    it('returns empty array for non-array input', () => {
      expect(computeCorrectedOrientations(null)).toEqual([]);
      expect(computeCorrectedOrientations('string')).toEqual([]);
      expect(computeCorrectedOrientations({})).toEqual([]);
    });

    it('collects positive orientationCorrected values', () => {
      const details = [
        { orientationCorrected: 90 },
        { orientationCorrected: 180 },
        { orientationCorrected: 270 },
      ];
      expect(computeCorrectedOrientations(details)).toEqual([90, 180, 270]);
    });

    it('ignores zero and negative values', () => {
      const details = [
        { orientationCorrected: 0 },
        { orientationCorrected: -90 },
        { orientationCorrected: 90 },
      ];
      expect(computeCorrectedOrientations(details)).toEqual([90]);
    });

    it('deduplicates and sorts', () => {
      const details = [
        { orientationCorrected: 180 },
        { orientationCorrected: 90 },
        { orientationCorrected: 180 },
      ];
      expect(computeCorrectedOrientations(details)).toEqual([90, 180]);
    });

    it('ignores non-finite values', () => {
      const details = [
        { orientationCorrected: NaN },
        { orientationCorrected: Infinity },
        { orientationCorrected: 'abc' },
        { orientationCorrected: 90 },
      ];
      expect(computeCorrectedOrientations(details)).toEqual([90]);
    });

    it('ignores null/undefined entries', () => {
      const details = [null, undefined, { orientationCorrected: 90 }];
      expect(computeCorrectedOrientations(details)).toEqual([90]);
    });
  });

  describe('buildOrientationNotice', () => {
    it('returns null when flag is disabled', () => {
      expect(buildOrientationNotice({ corrected: [90], env: { KHY_OCR_AUTO_ORIENT: '0' } })).toBeNull();
    });

    it('returns null when corrected is empty', () => {
      expect(buildOrientationNotice({ corrected: [], env: { KHY_OCR_AUTO_ORIENT: '1' } })).toBeNull();
    });

    it('returns null when corrected is not an array', () => {
      expect(buildOrientationNotice({ corrected: null, env: { KHY_OCR_AUTO_ORIENT: '1' } })).toBeNull();
    });

    it('builds notice with single orientation', () => {
      const notice = buildOrientationNotice({ corrected: [90], env: { KHY_OCR_AUTO_ORIENT: '1' } });
      expect(notice).toContain('90°');
      expect(notice).toContain('方向不正');
      expect(notice).toContain('自动将其旋转校正');
    });

    it('builds notice with multiple orientations', () => {
      const notice = buildOrientationNotice({ corrected: [90, 180, 270], env: { KHY_OCR_AUTO_ORIENT: '1' } });
      expect(notice).toContain('90°');
      expect(notice).toContain('180°');
      expect(notice).toContain('270°');
    });
  });
});

