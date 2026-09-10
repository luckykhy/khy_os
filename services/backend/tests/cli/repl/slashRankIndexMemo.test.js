'use strict';

const { isEnabled, getRankIndex, OFF_VALUES } = require('./slashRankIndexMemo');

describe('slashRankIndexMemo', () => {
  describe('isEnabled', () => {
    it('returns true when env var is unset', () => {
      expect(isEnabled({})).toBe(true);
      expect(isEnabled(undefined)).toBe(true);
    });

    it('returns false for off values', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No', 'FALSE']) {
        expect(isEnabled({ KHY_SLASH_RANK_INDEX_MEMO: v })).toBe(false);
      }
    });

    it('returns true for other values', () => {
      expect(isEnabled({ KHY_SLASH_RANK_INDEX_MEMO: '1' })).toBe(true);
    });
  });

  describe('OFF_VALUES', () => {
    it('contains the four canonical off values', () => {
      expect(OFF_VALUES).toEqual(['0', 'false', 'off', 'no']);
    });
  });

  describe('getRankIndex', () => {
    it('calls computeFn when gate is off', () => {
      const computeFn = jest.fn(() => [{ sc: {}, cmdLower: 'a' }]);
      const arr = [];
      const result = getRankIndex(arr, computeFn, { KHY_SLASH_RANK_INDEX_MEMO: '0' });
      expect(computeFn).toHaveBeenCalled();
      expect(result).toEqual([{ sc: {}, cmdLower: 'a' }]);
    });

    it('calls computeFn when cmds is not an object', () => {
      const computeFn = jest.fn(() => []);
      const result = getRankIndex(null, computeFn, {});
      expect(computeFn).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('caches and returns same reference on second call', () => {
      const index = [{ sc: {}, cmdLower: 'a' }];
      const computeFn = jest.fn(() => index);
      const arr = [];
      const result1 = getRankIndex(arr, computeFn, {});
      const result2 = getRankIndex(arr, computeFn, {});
      expect(computeFn).toHaveBeenCalledTimes(1);
      expect(result1).toBe(result2);
    });

    it('rebuilds cache when array length changes', () => {
      const arr = [];
      const computeFn = jest.fn(() => []);
      getRankIndex(arr, computeFn, {});
      arr.push({});
      getRankIndex(arr, computeFn, {});
      expect(computeFn).toHaveBeenCalledTimes(2);
    });

    it('returns empty array when computeFn throws', () => {
      const computeFn = jest.fn(() => { throw new Error('fail'); });
      const arr = [];
      const result = getRankIndex(arr, computeFn, {});
      expect(result).toEqual([]);
    });
  });
});

