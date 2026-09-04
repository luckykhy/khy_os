'use strict';

const {
  nodePlatformLabel,
  legacyPlatformLabel,
  resolvePlatformLabel,
  _PLATFORM_LABELS,
} = require('../../src/constants/nodePlatformLabel');

describe('nodePlatformLabel', () => {
  describe('nodePlatformLabel', () => {
    test('returns macOS for darwin', () => {
      expect(nodePlatformLabel('darwin')).toBe('macOS');
    });

    test('returns Windows for win32', () => {
      expect(nodePlatformLabel('win32')).toBe('Windows');
    });

    test('returns Linux for linux', () => {
      expect(nodePlatformLabel('linux')).toBe('Linux');
    });

    test('returns FreeBSD for freebsd', () => {
      expect(nodePlatformLabel('freebsd')).toBe('FreeBSD');
    });

    test('returns OpenBSD for openbsd', () => {
      expect(nodePlatformLabel('openbsd')).toBe('OpenBSD');
    });

    test('returns NetBSD for netbsd', () => {
      expect(nodePlatformLabel('netbsd')).toBe('NetBSD');
    });

    test('returns SunOS for sunos', () => {
      expect(nodePlatformLabel('sunos')).toBe('SunOS');
    });

    test('returns AIX for aix', () => {
      expect(nodePlatformLabel('aix')).toBe('AIX');
    });

    test('returns Android for android', () => {
      expect(nodePlatformLabel('android')).toBe('Android');
    });

    test('returns Haiku for haiku', () => {
      expect(nodePlatformLabel('haiku')).toBe('Haiku');
    });

    test('returns Cygwin for cygwin', () => {
      expect(nodePlatformLabel('cygwin')).toBe('Cygwin');
    });

    test('returns capitalized raw for unknown', () => {
      expect(nodePlatformLabel('unknownos')).toBe('Unknownos');
    });

    test('returns Unknown for empty', () => {
      expect(nodePlatformLabel('')).toBe('Unknown');
      expect(nodePlatformLabel(null)).toBe('Unknown');
      expect(nodePlatformLabel(undefined)).toBe('Unknown');
    });

    test('is case-insensitive', () => {
      expect(nodePlatformLabel('DARWIN')).toBe('macOS');
      expect(nodePlatformLabel('Win32')).toBe('Windows');
      expect(nodePlatformLabel('LINUX')).toBe('Linux');
    });

    test('trims whitespace', () => {
      expect(nodePlatformLabel('  darwin  ')).toBe('macOS');
    });
  });

  describe('legacyPlatformLabel', () => {
    test('returns macOS for darwin', () => {
      expect(legacyPlatformLabel('darwin')).toBe('macOS');
    });

    test('returns Windows for win32', () => {
      expect(legacyPlatformLabel('win32')).toBe('Windows');
    });

    test('returns Linux for everything else', () => {
      expect(legacyPlatformLabel('linux')).toBe('Linux');
      expect(legacyPlatformLabel('freebsd')).toBe('Linux');
      expect(legacyPlatformLabel('unknown')).toBe('Linux');
    });

    test('is case-insensitive', () => {
      expect(legacyPlatformLabel('DARWIN')).toBe('macOS');
      expect(legacyPlatformLabel('WIN32')).toBe('Windows');
    });
  });

  describe('resolvePlatformLabel', () => {
    test('returns adaptive label by default', () => {
      expect(resolvePlatformLabel('freebsd')).toBe('FreeBSD');
    });

    test('returns legacy label when disabled', () => {
      expect(resolvePlatformLabel('freebsd', { KHY_PLATFORM_LABEL_ADAPTIVE: '0' })).toBe('Linux');
    });

    test('returns adaptive label when enabled', () => {
      expect(resolvePlatformLabel('android', { KHY_PLATFORM_LABEL_ADAPTIVE: '1' })).toBe('Android');
    });
  });

  describe('_PLATFORM_LABELS', () => {
    test('contains all expected platforms', () => {
      expect(_PLATFORM_LABELS.darwin).toBe('macOS');
      expect(_PLATFORM_LABELS.win32).toBe('Windows');
      expect(_PLATFORM_LABELS.linux).toBe('Linux');
      expect(_PLATFORM_LABELS.freebsd).toBe('FreeBSD');
      expect(_PLATFORM_LABELS.openbsd).toBe('OpenBSD');
      expect(_PLATFORM_LABELS.netbsd).toBe('NetBSD');
      expect(_PLATFORM_LABELS.sunos).toBe('SunOS');
      expect(_PLATFORM_LABELS.aix).toBe('AIX');
      expect(_PLATFORM_LABELS.android).toBe('Android');
      expect(_PLATFORM_LABELS.haiku).toBe('Haiku');
      expect(_PLATFORM_LABELS.cygwin).toBe('Cygwin');
    });
  });
});
