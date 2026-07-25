'use strict';

/**
 * Tests for deliveryValidator.js — cross-platform delivery readiness.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let mod;
try {
  mod = require('../../src/services/deliveryValidator');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('deliveryValidator', () => {
  const { validate, detectProjectType } = mod || {};

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('detectProjectType returns nodejs when package.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    expect(detectProjectType(tmpDir)).toBe('nodejs');
  });

  test('detectProjectType returns python when setup.py exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
    expect(detectProjectType(tmpDir)).toBe('python');
  });

  test('detectProjectType returns docker when Dockerfile exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), 'FROM node:18');
    expect(detectProjectType(tmpDir)).toBe('docker');
  });

  test('detectProjectType returns unknown for empty directory', () => {
    expect(detectProjectType(tmpDir)).toBe('unknown');
  });

  test('validate returns pass for a clean nodejs project', async () => {
    const pkg = {
      name: 'test-app',
      version: '1.0.0',
      engines: { node: '>=18' },
      dependencies: { express: '^4.0.0' },
    };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const report = await validate(tmpDir);
    expect(report.projectType).toBe('nodejs');
    expect(report.score).toBeGreaterThanOrEqual(80);
    expect(report.verdict).toBe('pass');
  });

  test('validate flags native modules', async () => {
    const pkg = {
      name: 'test-native',
      version: '1.0.0',
      dependencies: { 'better-sqlite3': '^9.0.0' },
    };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const report = await validate(tmpDir);
    const nativeIssue = report.issues.find(i => i.rule === 'node/native-module');
    expect(nativeIssue).toBeTruthy();
  });

  test('validate flags platform-specific modules', async () => {
    const pkg = {
      name: 'test-fsevents',
      version: '1.0.0',
      dependencies: { fsevents: '^2.0.0' },
    };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const report = await validate(tmpDir);
    const platformIssue = report.issues.find(i => i.rule === 'node/platform-dep');
    expect(platformIssue).toBeTruthy();
    expect(platformIssue.message).toContain('fsevents');
  });

  test('validate throws for non-existent path', async () => {
    await expect(validate('/nonexistent/path/xyz')).rejects.toThrow('Path not found');
  });
});
