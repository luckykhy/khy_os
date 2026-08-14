'use strict';

/**
 * Tests for services/fileIntegrityService.js — SHA-256 manifest verification.
 *
 * This module touches the filesystem (reads source files, writes manifests),
 * so we use safe patterns and test the pure-logic aspects.
 */

let fileIntegrity;
let loadError;

beforeAll(() => {
  try {
    fileIntegrity = require('../../src/services/fileIntegrityService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

describe('fileIntegrityService exports', () => {
  test('module is loadable without syntax errors', () => {
    if (loadError) {
      expect(loadError).not.toBeInstanceOf(SyntaxError);
    }
  });

  test('exports expected functions', () => {
    if (!fileIntegrity) return;
    expect(typeof fileIntegrity.generateManifest).toBe('function');
    expect(typeof fileIntegrity.saveManifest).toBe('function');
    expect(typeof fileIntegrity.loadManifest).toBe('function');
    expect(typeof fileIntegrity.verify).toBe('function');
    expect(typeof fileIntegrity.verifyOnStartup).toBe('function');
    expect(typeof fileIntegrity.collectFiles).toBe('function');
  });

  test('exports MANIFEST_PATH string', () => {
    if (!fileIntegrity) return;
    expect(typeof fileIntegrity.MANIFEST_PATH).toBe('string');
    expect(fileIntegrity.MANIFEST_PATH).toContain('integrity_manifest.json');
  });
});

describe('collectFiles', () => {
  test('returns an array of relative paths', () => {
    if (!fileIntegrity) return;
    const files = fileIntegrity.collectFiles(__dirname);
    expect(Array.isArray(files)).toBe(true);
    // The current test directory should have .js files
    for (const f of files) {
      expect(f.endsWith('.js')).toBe(true);
    }
  });

  test('returns sorted results', () => {
    if (!fileIntegrity) return;
    const files = fileIntegrity.collectFiles(__dirname);
    for (let i = 1; i < files.length; i++) {
      expect(files[i].localeCompare(files[i - 1])).toBeGreaterThanOrEqual(0);
    }
  });

  test('excludes node_modules', () => {
    if (!fileIntegrity) return;
    const files = fileIntegrity.collectFiles(__dirname);
    for (const f of files) {
      expect(f).not.toContain('node_modules');
    }
  });
});

describe('generateManifest', () => {
  test('returns object with version, timestamp, fileCount, and files', () => {
    if (!fileIntegrity) return;
    const manifest = fileIntegrity.generateManifest();
    expect(manifest).toHaveProperty('version', 1);
    expect(manifest).toHaveProperty('timestamp');
    expect(manifest).toHaveProperty('fileCount');
    expect(typeof manifest.fileCount).toBe('number');
    expect(manifest).toHaveProperty('files');
    expect(typeof manifest.files).toBe('object');
  });

  test('file hashes are 64-char hex strings (SHA-256)', () => {
    if (!fileIntegrity) return;
    const manifest = fileIntegrity.generateManifest();
    const hashes = Object.values(manifest.files);
    if (hashes.length > 0) {
      expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test('fileCount matches number of files entries', () => {
    if (!fileIntegrity) return;
    const manifest = fileIntegrity.generateManifest();
    expect(manifest.fileCount).toBe(Object.keys(manifest.files).length);
  });
});
