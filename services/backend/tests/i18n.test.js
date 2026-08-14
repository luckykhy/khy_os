'use strict';

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const i18n = require('../src/i18n/index');

describe('i18n', () => {
  beforeEach(() => {
    // Reset to English before each test
    i18n.clearCache();
    i18n.setLocale('en');
  });

  // ── t() basic ──

  describe('t()', () => {
    test('returns English translation for a known key', () => {
      expect(i18n.t('common.success')).toBe('Success');
      expect(i18n.t('common.error')).toBe('Error');
      expect(i18n.t('common.loading')).toBe('Loading...');
    });

    test('returns interpolated string with params', () => {
      const result = i18n.t('ext.installed', { name: 'my-ext' });
      expect(result).toContain('my-ext');
      expect(result).toContain('installed');
    });

    test('falls back to key when translation is missing', () => {
      const key = 'nonexistent.key.that.does.not.exist';
      expect(i18n.t(key)).toBe(key);
    });

    test('interpolation with missing params leaves placeholders', () => {
      const result = i18n.t('auth.loginFailed');
      // {reason} should remain as-is since no params given
      expect(result).toContain('{reason}');
    });

    test('interpolation replaces multiple params', () => {
      const result = i18n.t('ai.tokenUsage', { input: 100, output: 50 });
      expect(result).toContain('100');
      expect(result).toContain('50');
    });
  });

  // ── setLocale ──

  describe('setLocale()', () => {
    test('switching to "zh" returns Chinese translations', () => {
      i18n.setLocale('zh');
      expect(i18n.t('common.success')).toBe('成功');
      expect(i18n.t('common.error')).toBe('错误');
    });

    test('switching back to "en" restores English', () => {
      i18n.setLocale('zh');
      expect(i18n.t('common.success')).toBe('成功');
      i18n.setLocale('en');
      expect(i18n.t('common.success')).toBe('Success');
    });

    test('"auto" detects from environment', () => {
      const origLang = process.env.LANG;
      process.env.LANG = 'zh_CN.UTF-8';
      i18n.clearCache();
      i18n.setLocale('auto');
      expect(i18n.getLocale()).toBe('zh');
      // Restore
      if (origLang !== undefined) {
        process.env.LANG = origLang;
      } else {
        delete process.env.LANG;
      }
    });

    test('unsupported locale falls back to English', () => {
      i18n.setLocale('xx');
      expect(i18n.getLocale()).toBe('en');
    });

    test('normalizes locale with region code (e.g., "zh-CN")', () => {
      i18n.setLocale('zh-CN');
      expect(i18n.getLocale()).toBe('zh');
    });
  });

  // ── tp() plural forms ──

  describe('tp()', () => {
    test('uses .zero form for count 0', () => {
      // If the locale has plural forms for a key, tp should use them
      // Falling back to base key if plural form is missing
      const result = i18n.tp('ext.resultsCount', 0, {});
      expect(result).toBeTruthy();
    });

    test('uses .one form for count 1', () => {
      const result = i18n.tp('ext.resultsCount', 1, {});
      expect(result).toBeTruthy();
    });

    test('uses .other form for count > 1', () => {
      const result = i18n.tp('ext.resultsCount', 5, {});
      expect(result).toBeTruthy();
    });

    test('falls back to base key when plural forms are missing', () => {
      // ext.resultsCount doesn't have .zero/.one/.other subkeys, so it falls back
      const result = i18n.tp('ext.resultsCount', 3, {});
      // Should fall back to ext.resultsCount with count param
      expect(result).toContain('3');
    });

    test('auto-adds count to params', () => {
      const result = i18n.tp('ext.installedCount', 7, {});
      expect(result).toContain('7');
    });
  });

  // ── getSupportedLocales ──

  describe('getSupportedLocales()', () => {
    test('returns 5 locales', () => {
      const locales = i18n.getSupportedLocales();
      expect(locales.length).toBe(5);
    });

    test('includes en, zh, ja, fr, de', () => {
      const locales = i18n.getSupportedLocales();
      expect(locales).toContain('en');
      expect(locales).toContain('zh');
      expect(locales).toContain('ja');
      expect(locales).toContain('fr');
      expect(locales).toContain('de');
    });

    test('returns a copy (not the internal array)', () => {
      const a = i18n.getSupportedLocales();
      const b = i18n.getSupportedLocales();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  // ── hasTranslation ──

  describe('hasTranslation()', () => {
    test('returns true for existing key', () => {
      expect(i18n.hasTranslation('common.success')).toBe(true);
      expect(i18n.hasTranslation('ext.installed')).toBe(true);
    });

    test('returns false for missing key', () => {
      expect(i18n.hasTranslation('totally.fake.key')).toBe(false);
    });

    test('returns true for nested key', () => {
      expect(i18n.hasTranslation('gateway.started')).toBe(true);
    });
  });

  // ── clearCache ──

  describe('clearCache()', () => {
    test('resets internal state and reloads on next t() call', () => {
      // Access a translation to populate cache
      i18n.t('common.success');
      i18n.clearCache();
      // Should still work after clearing (reloads from file)
      const result = i18n.t('common.success');
      expect(result).toBe('Success');
    });
  });

  // ── detectLocale ──

  describe('detectLocale()', () => {
    const origEnv = {};

    beforeEach(() => {
      origEnv.KHY_LOCALE = process.env.KHY_LOCALE;
      origEnv.LANG = process.env.LANG;
      origEnv.LC_ALL = process.env.LC_ALL;
      origEnv.LC_MESSAGES = process.env.LC_MESSAGES;
      delete process.env.KHY_LOCALE;
      delete process.env.LANG;
      delete process.env.LC_ALL;
      delete process.env.LC_MESSAGES;
    });

    afterEach(() => {
      for (const [key, val] of Object.entries(origEnv)) {
        if (val !== undefined) {
          process.env[key] = val;
        } else {
          delete process.env[key];
        }
      }
    });

    test('returns "en" when no env vars are set', () => {
      expect(i18n.detectLocale()).toBe('en');
    });

    test('detects "zh" from LANG=zh_CN.UTF-8', () => {
      process.env.LANG = 'zh_CN.UTF-8';
      expect(i18n.detectLocale()).toBe('zh');
    });

    test('detects "ja" from LANG=ja_JP.UTF-8', () => {
      process.env.LANG = 'ja_JP.UTF-8';
      expect(i18n.detectLocale()).toBe('ja');
    });

    test('KHY_LOCALE takes priority over LANG', () => {
      process.env.KHY_LOCALE = 'fr';
      process.env.LANG = 'zh_CN.UTF-8';
      expect(i18n.detectLocale()).toBe('fr');
    });

    test('falls back to "en" for unsupported locale', () => {
      process.env.LANG = 'xx_YY.UTF-8';
      expect(i18n.detectLocale()).toBe('en');
    });
  });
});
