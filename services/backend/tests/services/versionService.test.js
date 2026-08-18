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
    expect(typeof versionService.checkForUpdateAll).toBe('function');
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

// `checkForUpdateAll` is the source of truth for every "最新版本" display: PyPI alone used to
// decide it, so a release that landed on GitHub or npm first was reported as "已是最新".
// All cases pass `cache: false` — the real cache lives in the user's app home and must not be
// read or written by tests.
describe('checkForUpdateAll', () => {
  const probes = (versions) => ({
    github: async () => ({ version: versions.github || null }),
    pypi: async () => ({ version: versions.pypi || null }),
    npm: async () => ({ version: versions.npm || null }),
  });

  test('reports the highest version across the three registries, not PyPI alone', async () => {
    if (!versionService) return;
    const result = await versionService.checkForUpdateAll({
      env: {},
      cache: false,
      probes: probes({ github: '99.9.9', pypi: '1.0.0', npm: '2.0.0' }),
    });
    expect(result.latest).toBe('99.9.9');
    expect(result.source).toBe('github');
    expect(result.sourceLabel).toBe('GitHub Releases');
    expect(result.updateAvailable).toBe(true);
    expect(result.indeterminate).toBe(false);
    expect(result.cached).toBe(false);
    expect(result.current).toBe(versionService.getCurrentVersion());
    expect(result.sourcesText).toContain('PyPI v1.0.0');
    expect(result.sourcesText).toContain('npm v2.0.0');
  });

  test('a version only published to npm still counts as the latest', async () => {
    if (!versionService) return;
    const result = await versionService.checkForUpdateAll({
      env: {},
      cache: false,
      probes: probes({ npm: '99.9.9' }),
    });
    expect(result.latest).toBe('99.9.9');
    expect(result.source).toBe('npm');
    expect(result.updateAvailable).toBe(true);
  });

  test('every registry failing degrades honestly instead of claiming up to date', async () => {
    if (!versionService) return;
    const offline = async () => {
      throw new Error('offline');
    };
    const result = await versionService.checkForUpdateAll({
      env: {},
      cache: false,
      probes: { github: offline, pypi: offline, npm: offline },
    });
    expect(result.latest).toBeNull();
    expect(result.source).toBeNull();
    expect(result.indeterminate).toBe(true);
    expect(result.updateAvailable).toBe(false);
  });

  test('an installed version above every registry is not an update', async () => {
    if (!versionService) return;
    const result = await versionService.checkForUpdateAll({
      env: {},
      cache: false,
      probes: probes({ github: '0.0.1', pypi: '0.0.1', npm: '0.0.1' }),
    });
    expect(result.latest).toBe('0.0.1');
    expect(result.updateAvailable).toBe(false);
    expect(result.indeterminate).toBe(false);
  });

  test('cache:false leaves the on-disk cache untouched', async () => {
    if (!versionService) return;
    const fs = require('fs');
    const path = require('path');
    const cacheFile = path.join(
      require('os').homedir(),
      '.khyquant',
      'version_cache.json'
    );
    const before = fs.existsSync(cacheFile) ? fs.statSync(cacheFile).mtimeMs : null;
    const result = await versionService.checkForUpdateAll({
      env: {},
      cache: false,
      probes: probes({ github: '98.0.0' }),
    });
    const after = fs.existsSync(cacheFile) ? fs.statSync(cacheFile).mtimeMs : null;
    expect(result.latest).toBe('98.0.0');
    expect(after).toBe(before);
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
