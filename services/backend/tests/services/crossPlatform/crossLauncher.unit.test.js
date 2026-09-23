'use strict';

/**
 * crossLauncher.unit.test.js — Unit tests for the cross-platform launcher.
 *
 * Covers: getPortableRoot resolution, startPlatform error paths, startMultiple
 * orchestration, getPlatformStatus structure, and isPortInUse. Spawning real
 * processes is exercised only in smoke form; failure paths (unknown platform,
 * missing directory) are the primary target.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

describe('crossLauncher', () => {
  let launcher;

  beforeEach(() => {
    jest.resetModules();
    launcher = require('../../../src/services/crossPlatform/crossLauncher');
  });

  // ── getPortableRoot ──────────────────────────────────────────────

  describe('getPortableRoot', () => {
    const OLD_ENV = { ...process.env };

    afterEach(() => {
      // Restore env vars.
      for (const key of Object.keys(process.env)) {
        if (!(key in OLD_ENV)) delete process.env[key];
      }
      Object.assign(process.env, OLD_ENV);
    });

    test('returns KHY_OS_DIR when set', () => {
      process.env.KHY_OS_DIR = '/custom/root';
      jest.resetModules();
      const l = require('../../../src/services/crossPlatform/crossLauncher');
      expect(l.getPortableRoot()).toBe(path.resolve('/custom/root'));
    });

    test('returns KHY_PORTABLE_ROOT when KHY_OS_DIR is absent', () => {
      delete process.env.KHY_OS_DIR;
      process.env.KHY_PORTABLE_ROOT = '/portable/root';
      jest.resetModules();
      const l = require('../../../src/services/crossPlatform/crossLauncher');
      expect(l.getPortableRoot()).toBe(path.resolve('/portable/root'));
    });

    test('walks up from module to find khy.bat or .portable marker', () => {
      // No env vars set — should fall back to walking up or the default.
      delete process.env.KHY_OS_DIR;
      delete process.env.KHY_PORTABLE_ROOT;
      delete process.env.KHYQUANT_PORTABLE_ROOT;
      jest.resetModules();
      const l = require('../../../src/services/crossPlatform/crossLauncher');
      const root = l.getPortableRoot();
      expect(typeof root).toBe('string');
      expect(root.length).toBeGreaterThan(0);
    });
  });

  // ── startPlatform ────────────────────────────────────────────────

  describe('startPlatform', () => {
    test('returns failure for unknown platform', async () => {
      const result = await launcher.startPlatform('unknown-platform');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Unknown platform/);
    });

    test('returns failure when cwd directory does not exist', async () => {
      // Override env so getPortableRoot returns a non-existent path.
      const OLD_ENV = { ...process.env };
      process.env.KHY_OS_DIR = path.join(os.tmpdir(), 'khy-nonexistent-' + Date.now());
      jest.resetModules();
      const l = require('../../../src/services/crossPlatform/crossLauncher');
      const result = await l.startPlatform('backend');
      // Restore env.
      for (const key of Object.keys(process.env)) {
        if (!(key in OLD_ENV)) delete process.env[key];
      }
      Object.assign(process.env, OLD_ENV);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Directory not found/);
    });
  });

  // ── startMultiple ───────────────────────────────────────────────

  describe('startMultiple', () => {
    test('runs all platforms and returns per-platform results', async () => {
      const results = await launcher.startMultiple(['unknown-1', 'unknown-2']);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ platform: 'unknown-1', success: false });
      expect(results[1]).toMatchObject({ platform: 'unknown-2', success: false });
    });
  });

  // ── getPlatformStatus ────────────────────────────────────────────

  describe('getPlatformStatus', () => {
    test('returns a structure with backend, web, desktop, mobile keys', () => {
      const status = launcher.getPlatformStatus();
      expect(status).toHaveProperty('backend');
      expect(status).toHaveProperty('web');
      expect(status).toHaveProperty('desktop');
      expect(status).toHaveProperty('mobile');
    });

    test('backend entry has port and url', () => {
      const status = launcher.getPlatformStatus();
      expect(status.backend).toHaveProperty('port');
      expect(status.backend).toHaveProperty('url');
      expect(status.backend.url).toMatch(/^http:\/\//);
    });

    test('desktop entry has note instead of running/port', () => {
      const status = launcher.getPlatformStatus();
      expect(status.desktop).toHaveProperty('note');
    });
  });

  // ── isPortInUse ──────────────────────────────────────────────────

  describe('isPortInUse', () => {
    test('returns false for a port that nothing is listening on', async () => {
      // Use a very high port that's almost certainly free.
      const result = await launcher.isPortInUse(59999);
      expect(result).toBe(false);
    });
  });
});
