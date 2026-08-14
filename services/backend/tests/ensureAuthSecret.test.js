'use strict';

/**
 * ensureJwtSecret(): single source of truth for the JWT signing secret.
 *
 * Covers the three resolution paths (env / file / generated) plus persistence,
 * using a throwaway env file pointed at by KHY_ENV_FILE so the real
 * gatewayEnvFile writer runs against a temp file (no repo .env is touched).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = '../src/bootstrap/ensureAuthSecret';

function freshRequire() {
  delete require.cache[require.resolve(MODULE_PATH)];
  delete require.cache[require.resolve('../src/services/gatewayEnvFile')];
  return require(MODULE_PATH);
}

describe('ensureJwtSecret', () => {
  let tmpDir;
  let envFile;
  const savedEnv = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-jwt-secret-'));
    envFile = path.join(tmpDir, '.env');
    for (const k of ['JWT_SECRET', 'KHY_ENV_FILE', 'KHYQUANT_ROOT']) savedEnv[k] = process.env[k];
    process.env.KHY_ENV_FILE = envFile;
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    for (const k of ['JWT_SECRET', 'KHY_ENV_FILE', 'KHYQUANT_ROOT']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('uses an already-set strong process.env value as-is (source: env)', () => {
    const existing = 'a'.repeat(40);
    process.env.JWT_SECRET = existing;
    const { ensureJwtSecret } = freshRequire();
    const out = ensureJwtSecret();
    expect(out.source).toBe('env');
    expect(out.secret).toBe(existing);
    // Nothing written to disk when env already has it.
    expect(fs.existsSync(envFile)).toBe(false);
  });

  test('loads the secret from the canonical .env file when env is empty (source: file)', () => {
    const fileSecret = 'b'.repeat(48);
    fs.writeFileSync(envFile, `SOME_OTHER=1\nJWT_SECRET=${fileSecret}\n`);
    const { ensureJwtSecret } = freshRequire();
    const out = ensureJwtSecret();
    expect(out.source).toBe('file');
    expect(out.secret).toBe(fileSecret);
    expect(process.env.JWT_SECRET).toBe(fileSecret);
  });

  test('generates + persists a strong secret when missing everywhere (source: generated)', () => {
    const logs = [];
    const { ensureJwtSecret } = freshRequire();
    const out = ensureJwtSecret({ log: (m) => logs.push(m) });

    expect(out.source).toBe('generated');
    expect(out.secret).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
    expect(process.env.JWT_SECRET).toBe(out.secret);

    // Persisted to the canonical env file so it survives restarts.
    const written = fs.readFileSync(envFile, 'utf-8');
    expect(written).toContain(`JWT_SECRET=${out.secret}`);

    // State transparency: operator was told once.
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/JWT_SECRET/);
  });

  test('a weak (too-short) existing secret is replaced, not trusted', () => {
    process.env.JWT_SECRET = 'short';
    const { ensureJwtSecret } = freshRequire();
    const out = ensureJwtSecret();
    expect(out.source).toBe('generated');
    expect(out.secret.length).toBeGreaterThanOrEqual(32);
    expect(out.secret).not.toBe('short');
  });

  test('second call after generation reads the persisted value (stable across restarts)', () => {
    const { ensureJwtSecret } = freshRequire();
    const first = ensureJwtSecret();
    expect(first.source).toBe('generated');

    // Simulate a fresh process: clear env, reload module, keep the same file.
    delete process.env.JWT_SECRET;
    const { ensureJwtSecret: again } = freshRequire();
    const second = again();
    expect(second.source).toBe('file');
    expect(second.secret).toBe(first.secret);
  });
});
