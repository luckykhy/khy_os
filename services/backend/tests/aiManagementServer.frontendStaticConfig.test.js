'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('aiManagementServer.configureFrontendStatic', () => {
  let server;
  let tempDir;

  beforeEach(() => {
    jest.resetModules();
    server = require('../src/services/aiManagementServer');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ai-static-'));
  });

  afterEach(() => {
    try {
      server.configureFrontendStatic({ distDir: '', entryPath: '/admin/ai-gateway' });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('enables static hosting when index.html exists', () => {
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<!doctype html><html></html>', 'utf8');
    const result = server.configureFrontendStatic({ distDir: tempDir, entryPath: 'admin/ai-gateway' });
    expect(result).toEqual({
      enabled: true,
      distDir: path.resolve(tempDir),
      entryPath: '/admin/ai-gateway',
    });
  });

  test('disables static hosting when index.html is missing', () => {
    const missingDir = path.join(tempDir, 'missing');
    fs.mkdirSync(missingDir, { recursive: true });
    const result = server.configureFrontendStatic({ distDir: missingDir, entryPath: '/admin/ai-gateway' });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('missing-index');
  });

  test('clears static hosting when distDir is empty', () => {
    const result = server.configureFrontendStatic({ distDir: '', entryPath: '/admin/ai-gateway' });
    expect(result).toEqual({
      enabled: false,
      reason: 'no-dist-dir',
    });
  });
});
