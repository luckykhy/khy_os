'use strict';

const {
  VOLATILE_SECTION_IDS,
  isReorderEnabled,
  isOnDemandRelocationEnabled,
  partitionDynamicSections,
} = require('../../src/constants/promptCacheOrder');

describe('promptCacheOrder', () => {
  describe('VOLATILE_SECTION_IDS', () => {
    test('contains expected section ids', () => {
      expect(VOLATILE_SECTION_IDS).toContain('task_memory');
      expect(VOLATILE_SECTION_IDS).toContain('env_info');
      expect(VOLATILE_SECTION_IDS).toContain('mcp_instructions');
      expect(VOLATILE_SECTION_IDS).toContain('git_status');
      expect(VOLATILE_SECTION_IDS).toContain('project_structure');
    });
  });

  describe('isReorderEnabled', () => {
    test('returns true by default', () => {
      expect(isReorderEnabled({})).toBe(true);
    });

    test('returns false when disabled', () => {
      expect(isReorderEnabled({ KHY_PROMPT_CACHE_ORDER: '0' })).toBe(false);
      expect(isReorderEnabled({ KHY_PROMPT_CACHE_ORDER: 'false' })).toBe(false);
    });
  });

  describe('isOnDemandRelocationEnabled', () => {
    test('returns true by default', () => {
      expect(isOnDemandRelocationEnabled({})).toBe(true);
    });

    test('returns false when disabled', () => {
      expect(isOnDemandRelocationEnabled({ KHY_ONDEMAND_OUT_OF_PREFIX: '0' })).toBe(false);
    });
  });

  describe('partitionDynamicSections', () => {
    const sections = [
      { id: 'scope_minimization' },
      { id: 'task_memory' },
      { id: 'planning_verification' },
      { id: 'env_info' },
      { id: 'error_handling_fallback' },
    ];

    test('partitions into stable and volatile', () => {
      const result = partitionDynamicSections(sections, {});
      expect(result.stableSections).toHaveLength(3);
      expect(result.volatileSections).toHaveLength(2);
      expect(result.stableSections.map(s => s.id)).toEqual([
        'scope_minimization',
        'planning_verification',
        'error_handling_fallback',
      ]);
      expect(result.volatileSections.map(s => s.id)).toEqual(['task_memory', 'env_info']);
    });

    test('returns passthrough when disabled', () => {
      const result = partitionDynamicSections(sections, { KHY_PROMPT_CACHE_ORDER: '0' });
      expect(result.stableSections).toBe(sections);
      expect(result.volatileSections).toEqual([]);
    });

    test('returns passthrough for non-array', () => {
      const result = partitionDynamicSections(null, {});
      expect(result.stableSections).toBeNull();
      expect(result.volatileSections).toEqual([]);
    });

    test('returns passthrough when no volatile sections', () => {
      const onlyStable = [{ id: 'scope_minimization' }, { id: 'planning_verification' }];
      const result = partitionDynamicSections(onlyStable, {});
      expect(result.stableSections).toBe(onlyStable);
      expect(result.volatileSections).toEqual([]);
    });

    test('preserves order within groups', () => {
      const ordered = [
        { id: 'task_memory' },
        { id: 'scope_minimization' },
        { id: 'env_info' },
        { id: 'planning_verification' },
        { id: 'git_status' },
      ];
      const result = partitionDynamicSections(ordered, {});
      expect(result.volatileSections.map(s => s.id)).toEqual(['task_memory', 'env_info', 'git_status']);
      expect(result.stableSections.map(s => s.id)).toEqual(['scope_minimization', 'planning_verification']);
    });
  });
});
