'use strict';

const {
  detectFreshness,
  normalizeWindow,
  resolveWindow,
  freshnessToEngineParam,
  windowToBochaFreshness,
  parseResultDate,
  applyRecencyRanking,
  WINDOW_DAYS,
} = require('../../src/services/domain/query/search/searchFreshness');

describe('searchFreshness', () => {
  describe('detectFreshness', () => {
    test('detects day signals', () => {
      expect(detectFreshness('今天天气')).toBe('day');
      expect(detectFreshness('今日新闻')).toBe('day');
      expect(detectFreshness('实时行情')).toBe('day');
    });

    test('detects week signals', () => {
      expect(detectFreshness('本周新闻')).toBe('week');
      expect(detectFreshness('近一周动态')).toBe('week');
    });

    test('detects month signals', () => {
      expect(detectFreshness('本月行情')).toBe('month');
      expect(detectFreshness('近一月')).toBe('month');
    });

    test('detects year signals', () => {
      expect(detectFreshness('今年新闻')).toBe('year');
    });

    test('returns null for non-temporal queries', () => {
      expect(detectFreshness('什么是AI')).toBeNull();
      expect(detectFreshness('')).toBeNull();
    });
  });

  describe('normalizeWindow', () => {
    test('accepts internal names', () => {
      expect(normalizeWindow('day')).toBe('day');
      expect(normalizeWindow('week')).toBe('week');
    });

    test('accepts single letters', () => {
      expect(normalizeWindow('d')).toBe('day');
      expect(normalizeWindow('w')).toBe('week');
      expect(normalizeWindow('m')).toBe('month');
      expect(normalizeWindow('y')).toBe('year');
    });

    test('accepts bocha format', () => {
      expect(normalizeWindow('oneday')).toBe('day');
      expect(normalizeWindow('oneweek')).toBe('week');
    });

    test('returns null for invalid', () => {
      expect(normalizeWindow('invalid')).toBeNull();
      expect(normalizeWindow('')).toBeNull();
    });
  });

  describe('resolveWindow', () => {
    test('prefers explicit window', () => {
      expect(resolveWindow('day', '本周新闻', {})).toBe('day');
    });

    test('falls back to auto detection', () => {
      expect(resolveWindow(undefined, '今天新闻', {})).toBe('day');
    });

    test('returns null when disabled', () => {
      expect(resolveWindow('day', 'test', { KHY_SEARCH_FRESHNESS: '0' })).toBeNull();
    });
  });

  describe('freshnessToEngineParam', () => {
    test('returns DuckDuckGo param', () => {
      expect(freshnessToEngineParam('day', 'duckduckgo')).toBe('df=d');
      expect(freshnessToEngineParam('week', 'duckduckgo')).toBe('df=w');
    });

    test('returns Bing param', () => {
      expect(freshnessToEngineParam('day', 'bing-cn')).toContain('qft=');
    });

    test('returns Sogou param', () => {
      expect(freshnessToEngineParam('day', 'sogou')).toBe('tsn=1');
    });

    test('returns empty for unknown engine', () => {
      expect(freshnessToEngineParam('day', 'unknown')).toBe('');
    });
  });

  describe('windowToBochaFreshness', () => {
    test('converts to bocha format', () => {
      expect(windowToBochaFreshness('day')).toBe('oneDay');
      expect(windowToBochaFreshness('week')).toBe('oneWeek');
    });

    test('returns noLimit for unknown', () => {
      expect(windowToBochaFreshness('unknown')).toBe('noLimit');
    });
  });

  describe('parseResultDate', () => {
    const NOW = 1700000000000; // Fixed timestamp for testing

    test('parses Chinese relative dates', () => {
      expect(parseResultDate('3小时前', NOW)).toBe(NOW - 3 * 60 * 60 * 1000);
      expect(parseResultDate('2天前', NOW)).toBe(NOW - 2 * 24 * 60 * 60 * 1000);
      expect(parseResultDate('昨天', NOW)).toBe(NOW - 24 * 60 * 60 * 1000);
    });

    test('parses English relative dates', () => {
      expect(parseResultDate('3 days ago', NOW)).toBe(NOW - 3 * 24 * 60 * 60 * 1000);
      expect(parseResultDate('an hour ago', NOW)).toBe(NOW - 60 * 60 * 1000);
    });

    test('parses absolute dates', () => {
      const result = parseResultDate('2024-01-15', NOW);
      expect(result).toBe(Date.UTC(2024, 0, 15));
    });

    test('returns null for empty', () => {
      expect(parseResultDate('', NOW)).toBeNull();
    });
  });

  describe('applyRecencyRanking', () => {
    const NOW = 1700000000000;

    test('returns empty for empty array', () => {
      expect(applyRecencyRanking([], 'day', NOW, {})).toEqual([]);
    });

    test('ranks by recency', () => {
      const results = [
        { title: 'Old', publishedDate: '2020-01-01' },
        { title: 'New', publishedDate: '2024-01-01' },
      ];
      const ranked = applyRecencyRanking(results, 'year', NOW, {});
      expect(ranked[0].title).toBe('New');
    });

    test('does not mutate input', () => {
      const results = [{ title: 'Test', publishedDate: '2024-01-01' }];
      applyRecencyRanking(results, 'day', NOW, {});
      expect(results[0]).toEqual({ title: 'Test', publishedDate: '2024-01-01' });
    });
  });

  describe('WINDOW_DAYS', () => {
    test('has correct values', () => {
      expect(WINDOW_DAYS.day).toBe(1);
      expect(WINDOW_DAYS.week).toBe(7);
      expect(WINDOW_DAYS.month).toBe(30);
      expect(WINDOW_DAYS.year).toBe(365);
    });
  });
});
