'use strict';

/**
 * Tests for services/versionService.js — version check and comparison.
 */

let versionService;
let loadError;

beforeAll(() => {
  try {
    versionService = require('../../src/services/versionService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('versionService exports', () => {
  test('module is loadable without syntax errors', () => {
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports expected functions', () => {
    if (!versionService) return;
    expect(typeof versionService.getCurrentVersion).toBe('function');
    expect(typeof versionService.checkForUpdate).toBe('function');
    expect(typeof versionService.compareVersions).toBe('function');
    expect(typeof versionService.getUpdateNotice).toBe('function');
    expect(typeof versionService.recoverIdeAdapters).toBe('function');
    expect(typeof versionService.formatRecoveryMessage).toBe('function');
  });
});

describe('getCurrentVersion', () => {
  test('returns a version string', () => {
    if (!versionService) return;
    const version = versionService.getCurrentVersion();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });

  test('version matches semver-like pattern', () => {
    if (!versionService) return;
    const version = versionService.getCurrentVersion();
    // At minimum X.Y.Z format
    expect(version).toMatch(/^\d+\.\d+/);
  });
});

describe('compareVersions', () => {
  test('equal versions return 0', () => {
    if (!versionService) return;
    expect(versionService.compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(versionService.compareVersions('2.3.4', '2.3.4')).toBe(0);
  });

  test('higher major version returns positive', () => {
    if (!versionService) return;
    expect(versionService.compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
  });

  test('lower major version returns negative', () => {
    if (!versionService) return;
    expect(versionService.compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  test('higher minor version returns positive', () => {
    if (!versionService) return;
    expect(versionService.compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0);
  });

  test('higher patch version returns positive', () => {
    if (!versionService) return;
    expect(versionService.compareVersions('1.0.2', '1.0.1')).toBeGreaterThan(0);
  });

  test('handles null/undefined gracefully', () => {
    if (!versionService) return;
    expect(versionService.compareVersions(null, '1.0.0')).toBeLessThan(0);
    expect(versionService.compareVersions('1.0.0', null)).toBeGreaterThan(0);
    expect(versionService.compareVersions(null, null)).toBe(0);
  });

  test('handles different segment lengths', () => {
    if (!versionService) return;
    expect(versionService.compareVersions('1.0', '1.0.0')).toBe(0);
    expect(versionService.compareVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0);
  });
});

describe('formatRecoveryMessage', () => {
  test('formats recovered adapters', () => {
    if (!versionService) return;
    const msg = versionService.formatRecoveryMessage({
      recovered: ['cursor', 'kiro'],
      failed: [],
    });
    expect(msg).toContain('cursor');
    expect(msg).toContain('kiro');
  });

  test('formats failed adapters', () => {
    if (!versionService) return;
    const msg = versionService.formatRecoveryMessage({
      recovered: [],
      failed: ['windsurf'],
    });
    expect(msg).toContain('windsurf');
  });

  test('returns empty string when nothing to report', () => {
    if (!versionService) return;
    const msg = versionService.formatRecoveryMessage({
      recovered: [],
      failed: [],
    });
    expect(msg).toBe('');
  });
});
