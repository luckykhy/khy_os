'use strict';

/**
 * Internationalization (i18n) Framework.
 *
 * Provides `t(key, params)` function for translating UI strings.
 * Supports locale detection, fallback chain, and plural rules.
 *
 * Usage:
 *   const { t, setLocale, getLocale } = require('./i18n');
 *   t('ext.installed', { name: 'my-ext' })  → "Extension "my-ext" installed"
 *   setLocale('zh');
 *   t('ext.installed', { name: 'my-ext' })  → "扩展 "my-ext" 已安装"
 *
 * @module i18n
 */

const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

// ── Locale Loading ──

const LOCALES_DIR = path.join(__dirname, 'locales');
const SUPPORTED_LOCALES = ['en', 'zh', 'ja', 'fr', 'de'];
const DEFAULT_LOCALE = 'en';

/**
 * Loaded locale data.
 * @type {Map<string, object>}
 */
const _localeData = new Map();

/**
 * Current active locale.
 */
let _currentLocale = DEFAULT_LOCALE;

/**
 * Load a locale file.
 * @param {string} locale
 * @returns {object}
 */
function _loadLocale(locale) {
  if (_localeData.has(locale)) return _localeData.get(locale);

  const filePath = path.join(LOCALES_DIR, `${locale}.json`);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      _localeData.set(locale, data);
      return data;
    }
  } catch (err) {
    log.debug(`Failed to load locale "${locale}":`, err.message);
  }

  _localeData.set(locale, {});
  return {};
}

// ── Locale Detection ──

/**
 * Auto-detect locale from environment.
 * Priority: KHY_LOCALE env → LANG env → LC_ALL → default
 * @returns {string}
 */
function detectLocale() {
  const envLocale = process.env.KHY_LOCALE
    || process.env.LANG
    || process.env.LC_ALL
    || process.env.LC_MESSAGES
    || '';

  // Extract language code: "zh_CN.UTF-8" → "zh"
  const lang = envLocale.split(/[_.@]/)[0].toLowerCase();

  if (lang && SUPPORTED_LOCALES.includes(lang)) return lang;

  // Try 2-letter prefix match
  for (const supported of SUPPORTED_LOCALES) {
    if (lang.startsWith(supported)) return supported;
  }

  return DEFAULT_LOCALE;
}

// ── Core Translation Function ──

/**
 * Translate a key with optional parameter interpolation.
 *
 * Key format: "section.subsection.key" (dot-separated)
 * Params: { name: 'value' } → replaces {name} in string
 *
 * Fallback chain: currentLocale → 'en' → key itself
 *
 * @param {string} key - Dot-separated translation key
 * @param {object} [params] - Interpolation parameters
 * @returns {string}
 */
function t(key, params) {
  // Try current locale
  let value = _resolve(key, _currentLocale);

  // Fallback to English
  if (value === undefined && _currentLocale !== 'en') {
    value = _resolve(key, 'en');
  }

  // Fallback to key itself
  if (value === undefined) return _interpolate(key, params);

  return _interpolate(value, params);
}

/**
 * Translate with plural support.
 *
 * @param {string} key - Base key (will append .zero/.one/.other)
 * @param {number} count
 * @param {object} [params] - Additional params (count is auto-added)
 * @returns {string}
 */
function tp(key, count, params) {
  const fullParams = { count, ...params };
  const pluralKey = count === 0 ? `${key}.zero` : count === 1 ? `${key}.one` : `${key}.other`;

  // Try plural form first, fallback to base key
  let value = _resolve(pluralKey, _currentLocale);
  if (value === undefined && _currentLocale !== 'en') {
    value = _resolve(pluralKey, 'en');
  }
  if (value === undefined) {
    return t(key, fullParams);
  }

  return _interpolate(value, fullParams);
}

/**
 * Resolve a dot-path key from locale data.
 * @param {string} key
 * @param {string} locale
 * @returns {string|undefined}
 */
function _resolve(key, locale) {
  const data = _loadLocale(locale);
  const parts = key.split('.');
  let current = data;

  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }

  return typeof current === 'string' ? current : undefined;
}

/**
 * Interpolate parameters into a string.
 * Replaces {name} with params.name.
 * @param {string} str
 * @param {object} [params]
 * @returns {string}
 */
function _interpolate(str, params) {
  if (!params || typeof str !== 'string') return str;
  return str.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? String(params[key]) : match;
  });
}

// ── Locale Management ──

/**
 * Set the active locale.
 * @param {string} locale - Locale code ('en', 'zh', 'ja', 'fr', 'de') or 'auto'
 */
function setLocale(locale) {
  if (locale === 'auto') {
    _currentLocale = detectLocale();
  } else {
    const normalized = locale.toLowerCase().split(/[_-]/)[0];
    _currentLocale = SUPPORTED_LOCALES.includes(normalized) ? normalized : DEFAULT_LOCALE;
  }
  _loadLocale(_currentLocale);
  log.debug(`Locale set to: ${_currentLocale}`);
}

/**
 * Get the current locale.
 * @returns {string}
 */
function getLocale() {
  return _currentLocale;
}

/**
 * Get list of supported locales.
 * @returns {string[]}
 */
function getSupportedLocales() {
  return [...SUPPORTED_LOCALES];
}

/**
 * Check if a key has a translation in the current locale.
 * @param {string} key
 * @returns {boolean}
 */
function hasTranslation(key) {
  return _resolve(key, _currentLocale) !== undefined;
}

/**
 * Load all locale files upfront.
 */
function preloadAll() {
  for (const locale of SUPPORTED_LOCALES) {
    _loadLocale(locale);
  }
}

/**
 * Clear locale cache (for testing/reloading).
 */
function clearCache() {
  _localeData.clear();
}

// Initialize with auto-detection
setLocale('auto');

module.exports = {
  t,
  tp,
  setLocale,
  getLocale,
  detectLocale,
  getSupportedLocales,
  hasTranslation,
  preloadAll,
  clearCache,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
};
