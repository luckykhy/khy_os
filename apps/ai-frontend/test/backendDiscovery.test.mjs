import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { resolveBackendTarget, DEFAULT_BACKEND_TARGET } from '../backendDiscovery.mjs';

// In-memory fs stub: maps absolute file path -> file contents (string).
function makeFs(files = {}) {
  return {
    readFileSync(file) {
      if (Object.prototype.hasOwnProperty.call(files, file)) return files[file];
      const err = new Error(`ENOENT: ${file}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

const HOME = '/home/tester';

test('explicit VITE_AI_PROXY_TARGET overrides everything', () => {
  const target = resolveBackendTarget(
    { VITE_AI_PROXY_TARGET: 'http://example:1234' },
    { fs: makeFs({}), homedir: HOME }
  );
  assert.strictEqual(target, 'http://example:1234');
});

test('VITE_AI_API_BASE_URL is honored as an explicit override', () => {
  const target = resolveBackendTarget(
    { VITE_AI_API_BASE_URL: 'http://api-base:5555' },
    { fs: makeFs({}), homedir: HOME }
  );
  assert.strictEqual(target, 'http://api-base:5555');
});

test('discovers apiPort from default ~/.khy runtime file (port drift)', () => {
  const runtimeFile = path.join(HOME, '.khy', 'ai_manage_runtime.json');
  const target = resolveBackendTarget(
    {},
    { fs: makeFs({ [runtimeFile]: JSON.stringify({ apiPort: 9137 }) }), homedir: HOME }
  );
  assert.strictEqual(target, 'http://127.0.0.1:9137');
});

test('KHY_DATA_HOME runtime file takes precedence over default home', () => {
  const customHome = '/data/khy';
  const customRuntime = path.join(customHome, 'ai_manage_runtime.json');
  const defaultRuntime = path.join(HOME, '.khy', 'ai_manage_runtime.json');
  const target = resolveBackendTarget(
    { KHY_DATA_HOME: customHome },
    {
      fs: makeFs({
        [customRuntime]: JSON.stringify({ apiPort: 7001 }),
        [defaultRuntime]: JSON.stringify({ apiPort: 9090 }),
      }),
      homedir: HOME,
    }
  );
  assert.strictEqual(target, 'http://127.0.0.1:7001');
});

test('pinned pointer dataHome is consulted before default home', () => {
  const pinnedHome = '/mnt/d/.khy';
  const pointerFile = path.join(HOME, '.khy', '.location.json');
  const pinnedRuntime = path.join(pinnedHome, 'ai_manage_runtime.json');
  const target = resolveBackendTarget(
    {},
    {
      fs: makeFs({
        [pointerFile]: JSON.stringify({ dataHome: pinnedHome }),
        [pinnedRuntime]: JSON.stringify({ apiPort: 8123 }),
      }),
      homedir: HOME,
    }
  );
  assert.strictEqual(target, 'http://127.0.0.1:8123');
});

test('falls back to legacy ~/.khyquant runtime file', () => {
  const legacyRuntime = path.join(HOME, '.khyquant', 'ai_manage_runtime.json');
  const target = resolveBackendTarget(
    {},
    { fs: makeFs({ [legacyRuntime]: JSON.stringify({ apiPort: 9099 }) }), homedir: HOME }
  );
  assert.strictEqual(target, 'http://127.0.0.1:9099');
});

test('env port hint used when no runtime file exists', () => {
  const target = resolveBackendTarget(
    { KHY_DAEMON_PORT: '9876' },
    { fs: makeFs({}), homedir: HOME }
  );
  assert.strictEqual(target, 'http://127.0.0.1:9876');
});

test('default target when nothing is discoverable', () => {
  const target = resolveBackendTarget({}, { fs: makeFs({}), homedir: HOME });
  assert.strictEqual(target, DEFAULT_BACKEND_TARGET);
});

test('corrupt/invalid apiPort is ignored, falls through to default', () => {
  const runtimeFile = path.join(HOME, '.khy', 'ai_manage_runtime.json');
  const target = resolveBackendTarget(
    {},
    { fs: makeFs({ [runtimeFile]: '{ not json' }), homedir: HOME }
  );
  assert.strictEqual(target, DEFAULT_BACKEND_TARGET);
});

test('out-of-range apiPort is rejected', () => {
  const runtimeFile = path.join(HOME, '.khy', 'ai_manage_runtime.json');
  const target = resolveBackendTarget(
    {},
    { fs: makeFs({ [runtimeFile]: JSON.stringify({ apiPort: 99999 }) }), homedir: HOME }
  );
  assert.strictEqual(target, DEFAULT_BACKEND_TARGET);
});
