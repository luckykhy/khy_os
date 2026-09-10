'use strict';

const {
  EXCLUDE_DIRS,
  EXCLUDE_FILES,
  PROTECTED_TARGET_DIRS,
  DEP_LOCK_FILES,
  CRITICAL_ENTRY_FILES,
  MANIFEST_FILE,
} = require('./portableSyncRules');

describe('portableSyncRules', () => {
  it('should export EXCLUDE_DIRS as array', () => {
    expect(Array.isArray(EXCLUDE_DIRS)).toBe(true);
    expect(EXCLUDE_DIRS.length).toBeGreaterThan(0);
    expect(EXCLUDE_DIRS).toContain('.git');
    expect(EXCLUDE_DIRS).toContain('node_modules');
    expect(EXCLUDE_DIRS).toContain('.khy');
  });

  it('should export EXCLUDE_FILES as array', () => {
    expect(Array.isArray(EXCLUDE_FILES)).toBe(true);
    expect(EXCLUDE_FILES).toContain('*.db');
    expect(EXCLUDE_FILES).toContain('_debug.log');
  });

  it('should export PROTECTED_TARGET_DIRS as array', () => {
    expect(Array.isArray(PROTECTED_TARGET_DIRS)).toBe(true);
    expect(PROTECTED_TARGET_DIRS).toContain('.khyquant-data');
    expect(PROTECTED_TARGET_DIRS).toContain('.env');
  });

  it('should export DEP_LOCK_FILES as array', () => {
    expect(Array.isArray(DEP_LOCK_FILES)).toBe(true);
    expect(DEP_LOCK_FILES).toContain('services/backend/package-lock.json');
  });

  it('should export CRITICAL_ENTRY_FILES as array', () => {
    expect(Array.isArray(CRITICAL_ENTRY_FILES)).toBe(true);
    expect(CRITICAL_ENTRY_FILES).toContain('services/backend/bin/khy.js');
    expect(CRITICAL_ENTRY_FILES).toContain('services/backend/src/cli/router.js');
  });

  it('should export MANIFEST_FILE as string', () => {
    expect(MANIFEST_FILE).toBe('.sync-manifest.json');
  });
});

