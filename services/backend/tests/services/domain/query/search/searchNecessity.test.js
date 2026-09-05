'use strict';

const {
  isEnabled,
  assessSearchNeed,
  buildNecessityDirective,
  routeSearchNecessity,
} = require('../../src/services/domain/query/search/searchNecessity');

describe('searchNecessity', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_SEARCH_NECESSITY: '0' })).toBe(false);
      expect(isEnabled({ KHY_SEARCH_NECESSITY: 'false' })).toBe(false);
    });
  });

  describe('assessSearchNeed', () => {
    test('returns optional when disabled', () => {
      const result = assessSearchNeed('test', { env: { KHY_SEARCH_NECESSITY: '0' } });
      expect(result.need).toBe('optional');
    });

    test('returns optional for empty query', () => {
      const result = assessSearchNeed('', {});
      expect(result.need).toBe('optional');
    });

    test('returns required for explicit search', () => {
      const result = assessSearchNeed('搜索一下AI新闻', {});
      expect(result.need).toBe('required');
    });

    test('returns required for realtime queries', () => {
      const result = assessSearchNeed('今天股价', {});
      expect(result.need).toBe('required');
    });

    test('returns required for time-sensitive queries', () => {
      const result = assessSearchNeed('今天天气', {});
      expect(result.need).toBe('required');
    });

    test('returns skip for stable knowledge', () => {
      const result = assessSearchNeed('什么是AI', {});
      expect(result.need).toBe('skip');
    });

    test('returns skip for code tasks', () => {
      const result = assessSearchNeed('写一个函数', {});
      expect(result.need).toBe('skip');
    });

    test('returns skip for translation', () => {
      const result = assessSearchNeed('翻译成英文', {});
      expect(result.need).toBe('skip');
    });

    test('returns optional for undecided', () => {
      const result = assessSearchNeed('随便说点什么', {});
      expect(result.need).toBe('optional');
    });
  });

  describe('buildNecessityDirective', () => {
    test('returns empty when disabled', () => {
      const result = buildNecessityDirective({ directiveKind: 'required' }, { KHY_SEARCH_NECESSITY: '0' });
      expect(result).toBe('');
    });

    test('returns skip directive', () => {
      const result = buildNecessityDirective({ directiveKind: 'skip' }, {});
      expect(result).toContain('知识库');
    });

    test('returns required directive', () => {
      const result = buildNecessityDirective({ directiveKind: 'required', freshness: 'day' }, {});
      expect(result).toContain('时效');
    });

    test('returns empty for null kind', () => {
      const result = buildNecessityDirective({ directiveKind: null }, {});
      expect(result).toBe('');
    });
  });

  describe('routeSearchNecessity', () => {
    test('returns empty when disabled', () => {
      const result = routeSearchNecessity({ text: 'test', env: { KHY_SEARCH_NECESSITY: '0' } });
      expect(result.directive).toBe('');
    });

    test('returns empty for media', () => {
      const result = routeSearchNecessity({ text: 'test', hasMedia: true, env: {} });
      expect(result.directive).toBe('');
    });

    test('returns directive for search query', () => {
      const result = routeSearchNecessity({ text: '搜索AI新闻', env: {} });
      expect(result.directive).toBeDefined();
      expect(result.assessment).toBeDefined();
    });
  });
});
