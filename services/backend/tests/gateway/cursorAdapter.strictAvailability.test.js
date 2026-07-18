'use strict';

/**
 * Cursor adapter strict-availability tests (representative IDE adapter).
 *
 * All four IDE adapters (cursor/windsurf/trae/kiro) funnel availability through
 * the same shared classifier; cursor stands in for the family here. Validates
 * the install x login gate wiring at the adapter boundary:
 *   - installed + native login   -> available
 *   - clean machine (no token)   -> NOT available, "未检测到 Cursor 安装"
 *   - installed + no native login-> NOT available, "未检测到登录态"
 *
 * Note: a token read from Cursor's OWN storage is authoritative proof of
 * install+login, so a native token short-circuits to available by design.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_ACCESS_TOKEN = `eyJhbGciOiJ${'a'.repeat(48)}.${'b'.repeat(48)}.${'c'.repeat(24)}`;

describe('cursor adapter strict availability', () => {
  const originalEnv = { ...process.env };
  let tempDir = null;

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
  });

  function loadCursor({ installed, nativeToken }) {
    jest.resetModules();

    // Control local-install detection deterministically.
    jest.doMock('../../src/services/gateway/adapters/ideDetector', () => ({
      findInstallation: jest.fn((name) => (name === 'cursor' && installed ? '/fake/Cursor' : null)),
      findDataPath: jest.fn(() => null),
    }));

    // Provide (or withhold) a native token via a real storage.json the adapter reads.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cursor-strict-'));
    const storagePath = path.join(tempDir, 'storage.json');
    const payload = nativeToken ? { cursorAuth: { accessToken: VALID_ACCESS_TOKEN } } : {};
    fs.writeFileSync(storagePath, JSON.stringify(payload), 'utf8');
    process.env.CURSOR_STORAGE_PATHS = storagePath;
    // Steer DB lookups away from any real machine token.
    process.env.CURSOR_DB_PATHS = path.join(tempDir, 'absent.vscdb');
    // Strict default: imported credentials must not count.
    delete process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS;

    return require('../../src/services/gateway/adapters/cursorAdapter');
  }

  test('installed + native login -> available', () => {
    const cursor = loadCursor({ installed: true, nativeToken: true });
    expect(cursor.detect(true)).toBe(true);
    expect(cursor.getStatus().available).toBe(true);
  });

  test('clean machine (not installed, no token) -> not available', () => {
    const cursor = loadCursor({ installed: false, nativeToken: false });
    expect(cursor.detect(true)).toBe(false);
    const status = cursor.getStatus();
    expect(status.available).toBe(false);
    expect(status.detail).toContain('未检测到 Cursor 安装');
  });

  test('installed but not logged in -> not available (login gate)', () => {
    const cursor = loadCursor({ installed: true, nativeToken: false });
    expect(cursor.detect(true)).toBe(false);
    const status = cursor.getStatus();
    expect(status.available).toBe(false);
    expect(status.detail).toContain('未检测到登录态');
  });

  test('a native token is authoritative proof of install (short-circuits to available)', () => {
    // Even if ideDetector cannot see the install, a token in Cursor's own
    // storage means Cursor is installed and logged in.
    const cursor = loadCursor({ installed: false, nativeToken: true });
    expect(cursor.detect(true)).toBe(true);
    expect(cursor.getStatus().available).toBe(true);
  });
});
