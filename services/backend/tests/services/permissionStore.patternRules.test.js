'use strict';

/**
 * Integration tests for permissionStore pattern rules (storePatternRules).
 *
 * Covers:
 *   - gate off (default): check() byte-compatible with legacy behavior even
 *     when storePatternRules exist on disk; APIs are explicit no-ops
 *   - gate on: allow/deny pattern matching in check(); deny > allow
 *   - old permissions.json without the field → backward compatible
 *   - approvePattern / denyPattern / listPatternRules; forever persistence
 *
 * Hermetic isolation: KHY_APP_HOME + KHY_DATA_HOME are redirected to a fresh
 * temp directory per test (never touches the real ~/.khy / ~/.khyquant), and
 * jest.resetModules() gives every test a fresh module instance.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ORIG_ENV = { ...process.env };

let tmpDir;

function writePermissionsFile(extra = {}) {
  const data = {
    profile: 'normal',
    rules: {},
    version: 2,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(path.join(tmpDir, 'permissions.json'), JSON.stringify(data, null, 2));
}

function readPermissionsFile() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'permissions.json'), 'utf-8'));
}

function loadStore() {
  return require('../../src/services/permissionStore');
}

function enableGate() {
  process.env.KHY_PERMISSION_PATTERN_RULES = '1';
}

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIG_ENV };
  delete process.env.KHY_PERMISSION_PATTERN_RULES;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-permstore-test-'));
  // Redirect every data home the store (and its best-effort deps) touch.
  process.env.KHY_APP_HOME = tmpDir;
  process.env.KHY_DATA_HOME = tmpDir;
  // Seed a permissions.json so _load() never falls into legacy migration
  // (which would read the real ~/.khyquant/tool_permissions.json).
  writePermissionsFile();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('gate off (default) — byte-compatible legacy behavior', () => {
  test('check() ignores storePatternRules present on disk', () => {
    writePermissionsFile({
      storePatternRules: [
        { toolName: 'Bash', pattern: 'npm run *', decision: 'allow', scope: 'forever', since: 'x' },
        { toolName: 'Bash', pattern: 'git *', decision: 'deny', scope: 'forever', since: 'x' },
      ],
    });
    const store = loadStore();
    // Same result as a store with NO pattern rules at all.
    expect(store.check('Bash', { command: 'npm run build' })).toBe('ask');
    expect(store.check('Bash', { command: 'git push' })).toBe('ask');
  });

  test('check() with patternRules on disk equals check() without them', () => {
    const store1 = loadStore();
    const baseline = store1.check('Bash', { command: 'npm run build' });

    jest.resetModules();
    writePermissionsFile({
      storePatternRules: [
        { toolName: 'Bash', pattern: 'npm run *', decision: 'deny', scope: 'forever', since: 'x' },
      ],
    });
    const store2 = loadStore();
    expect(store2.check('Bash', { command: 'npm run build' })).toBe(baseline);
  });

  test('approvePattern / denyPattern are explicit no-ops', () => {
    const store = loadStore();
    expect(store.approvePattern('Bash', 'npm run *', 'forever')).toEqual({ ok: false, disabled: true });
    expect(store.denyPattern('Bash', 'git *', 'forever')).toEqual({ ok: false, disabled: true });
    // Nothing persisted.
    expect(readPermissionsFile().storePatternRules).toBeUndefined();
  });

  test('listPatternRules returns empty array', () => {
    writePermissionsFile({
      storePatternRules: [
        { toolName: 'Bash', pattern: 'npm run *', decision: 'allow', scope: 'forever', since: 'x' },
      ],
    });
    const store = loadStore();
    expect(store.listPatternRules()).toEqual([]);
  });
});

describe('gate on — pattern matching in check()', () => {
  test('allow pattern rule allows matching command prefixes', () => {
    enableGate();
    const store = loadStore();
    expect(store.approvePattern('Bash', 'npm run *', 'session').ok).toBe(true);
    expect(store.check('Bash', { command: 'npm run build' })).toBe('allow');
    expect(store.check('Bash', { command: 'npm run dev' })).toBe('allow');
    // Non-matching command falls through to the default decision.
    expect(store.check('Bash', { command: 'npm install' })).toBe('ask');
  });

  test('compound command never generalized by an allow pattern (fail-closed)', () => {
    enableGate();
    const store = loadStore();
    store.approvePattern('Bash', 'npm run *', 'session');
    expect(store.check('Bash', { command: 'npm run build && rm -rf /' })).toBe('ask');
  });

  test('deny takes priority over allow (fail-closed)', () => {
    enableGate();
    const store = loadStore();
    store.approvePattern('Bash', 'npm *', 'session');
    store.denyPattern('Bash', 'npm run *', 'session');
    // Both rules match — deny wins.
    expect(store.check('Bash', { command: 'npm run build' })).toBe('deny');
    // Only the allow rule matches.
    expect(store.check('Bash', { command: 'npm install' })).toBe('allow');
  });

  test('pattern rules never override exact forever rules (evaluated after them)', () => {
    enableGate();
    const store = loadStore();
    store.deny('Bash', 'forever');
    store.approvePattern('Bash', 'npm run *', 'session');
    expect(store.check('Bash', { command: 'npm run build' })).toBe('deny');
  });

  test('old permissions.json without the field is backward compatible', () => {
    enableGate();
    // beforeEach seeded a file WITHOUT storePatternRules.
    const store = loadStore();
    expect(store.listPatternRules()).toEqual([]);
    expect(store.check('Bash', { command: 'npm run build' })).toBe('ask');
  });
});

describe('gate on — approvePattern / denyPattern / listPatternRules', () => {
  test('session scope stays in memory (not persisted)', () => {
    enableGate();
    const store = loadStore();
    expect(store.approvePattern('Bash', 'npm run *', 'session').ok).toBe(true);
    expect(store.listPatternRules()).toHaveLength(1);
    expect(readPermissionsFile().storePatternRules).toBeUndefined();
  });

  test('forever scope persists to storePatternRules and survives reload', () => {
    enableGate();
    const store = loadStore();
    expect(store.approvePattern('Bash', 'npm run *', 'forever').ok).toBe(true);

    const onDisk = readPermissionsFile();
    expect(Array.isArray(onDisk.storePatternRules)).toBe(true);
    expect(onDisk.storePatternRules).toHaveLength(1);
    expect(onDisk.storePatternRules[0]).toMatchObject({
      toolName: 'Bash',
      pattern: 'npm run *',
      decision: 'allow',
      scope: 'forever',
    });

    // Fresh module instance re-reads from disk.
    jest.resetModules();
    const reloaded = loadStore();
    expect(reloaded.listPatternRules()).toHaveLength(1);
    expect(reloaded.check('Bash', { command: 'npm run build' })).toBe('allow');
  });

  test('invalid inputs are rejected', () => {
    enableGate();
    const store = loadStore();
    expect(store.approvePattern('', 'npm run *', 'session').ok).toBe(false);
    expect(store.approvePattern('Bash', '', 'session').ok).toBe(false);
    expect(store.approvePattern('Bash', 'npm run *', 'once').ok).toBe(false);
  });

  test('same (toolName, pattern) is replaced, not duplicated', () => {
    enableGate();
    const store = loadStore();
    store.approvePattern('Bash', 'npm run *', 'session');
    store.denyPattern('Bash', 'npm run *', 'session');
    const rules = store.listPatternRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].decision).toBe('deny');
  });

  test('listPatternRules returns copies (mutation-safe)', () => {
    enableGate();
    const store = loadStore();
    store.approvePattern('Bash', 'npm run *', 'session');
    const rules = store.listPatternRules();
    rules[0].decision = 'deny';
    expect(store.listPatternRules()[0].decision).toBe('allow');
  });

  test('reset() clears pattern rules', () => {
    enableGate();
    const store = loadStore();
    store.approvePattern('Bash', 'npm run *', 'forever');
    store.reset();
    expect(store.listPatternRules()).toEqual([]);
    expect(readPermissionsFile().storePatternRules).toBeUndefined();
  });
});
