'use strict';

const test = require('node:test');
const assert = require('node:assert');

const wsh = require('../../src/bootstrap/windowsSpawnHardening');

// ── 门控(CANON 4 词)──────────────────────────────────────────────────────────
test('isEnabled: CANON gating', () => {
  assert.strictEqual(wsh.isEnabled({}), true);
  assert.strictEqual(wsh.isEnabled({ KHY_WINDOWS_SPAWN_HIDE: 'off' }), false);
  assert.strictEqual(wsh.isEnabled({ KHY_WINDOWS_SPAWN_HIDE: '0' }), false);
  assert.strictEqual(wsh.isEnabled({ KHY_WINDOWS_SPAWN_HIDE: 'no' }), false);
  assert.strictEqual(wsh.isEnabled({ KHY_WINDOWS_SPAWN_HIDE: 'false' }), false);
  assert.strictEqual(wsh.isEnabled({ KHY_WINDOWS_SPAWN_HIDE: 'disable' }), true); // EXTENDED → 开
});

// ── injectWindowsHide:六方法所有签名形态 ──────────────────────────────────────
test('injectWindowsHide: mutates existing options object', () => {
  const args = ['git', ['status'], { stdio: 'pipe' }];
  wsh.injectWindowsHide(args);
  assert.strictEqual(args[2].windowsHide, true);
  assert.strictEqual(args[2].stdio, 'pipe'); // 保留原字段
});

test('injectWindowsHide: respects explicit windowsHide:false', () => {
  const args = ['x', { windowsHide: false }];
  wsh.injectWindowsHide(args);
  assert.strictEqual(args[1].windowsHide, false); // 不覆盖显式设置
});

test('injectWindowsHide: spawn(cmd, args) — no options → appends one', () => {
  const args = ['node', ['-v']];
  wsh.injectWindowsHide(args);
  assert.strictEqual(args.length, 3);
  assert.deepStrictEqual(args[2], { windowsHide: true });
});

test('injectWindowsHide: spawn(cmd) only → appends options', () => {
  const args = ['node'];
  wsh.injectWindowsHide(args);
  assert.deepStrictEqual(args, ['node', { windowsHide: true }]);
});

test('injectWindowsHide: exec(cmd, cb) → inserts options BEFORE callback', () => {
  const cb = () => {};
  const args = ['ls', cb];
  wsh.injectWindowsHide(args);
  assert.strictEqual(args.length, 3);
  assert.deepStrictEqual(args[1], { windowsHide: true });
  assert.strictEqual(args[2], cb); // 回调仍在末尾
});

test('injectWindowsHide: execFile(file, args, cb) → options before cb', () => {
  const cb = () => {};
  const args = ['git', ['log'], cb];
  wsh.injectWindowsHide(args);
  assert.strictEqual(args.length, 4);
  assert.deepStrictEqual(args[2], { windowsHide: true });
  assert.strictEqual(args[3], cb);
});

test('injectWindowsHide: exec(cmd, options, cb) → mutates existing options', () => {
  const cb = () => {};
  const opts = { cwd: '/tmp' };
  const args = ['ls', opts, cb];
  wsh.injectWindowsHide(args);
  assert.strictEqual(args.length, 3);
  assert.strictEqual(args[1].windowsHide, true);
  assert.strictEqual(args[1].cwd, '/tmp');
  assert.strictEqual(args[2], cb);
});

test('injectWindowsHide: array (spawn args) is NOT mistaken for options', () => {
  const args = ['git', ['a', 'b', 'c']];
  wsh.injectWindowsHide(args);
  // 数组不是 options → 追加一个 options 对象,原数组不变
  assert.deepStrictEqual(args[1], ['a', 'b', 'c']);
  assert.deepStrictEqual(args[2], { windowsHide: true });
});

test('injectWindowsHide: never throws on frozen options (leaves as-is)', () => {
  const frozen = Object.freeze({ stdio: 'pipe' });
  const args = ['x', frozen];
  assert.doesNotThrow(() => wsh.injectWindowsHide(args));
  assert.strictEqual(args[1].windowsHide, undefined); // 冻结 → 放弃注入,不抛
});

test('injectWindowsHide: non-array input returned untouched', () => {
  assert.strictEqual(wsh.injectWindowsHide('nope'), 'nope');
  assert.strictEqual(wsh.injectWindowsHide(null), null);
});

// ── installWindowsSpawnHardening:平台/门控/幂等/实际包装 ────────────────────────
function _fakeCp() {
  const calls = {};
  const cp = {};
  for (const m of wsh._PATCH_METHODS) {
    calls[m] = [];
    cp[m] = function (...a) { calls[m].push(a); return `orig:${m}`; };
  }
  return { cp, calls };
}

test('install: no-op on non-win32 (Linux/mac byte-identical)', () => {
  const { cp } = _fakeCp();
  const origSpawn = cp.spawn;
  const res = wsh.installWindowsSpawnHardening({ platform: 'linux', childProcess: cp, env: {} });
  assert.strictEqual(res.installed, false);
  assert.strictEqual(res.reason, 'not-win32');
  assert.strictEqual(cp.spawn, origSpawn); // 引用不变
});

test('install: no-op when gate off', () => {
  const { cp } = _fakeCp();
  const origSpawn = cp.spawn;
  const res = wsh.installWindowsSpawnHardening({
    platform: 'win32', childProcess: cp, env: { KHY_WINDOWS_SPAWN_HIDE: 'off' },
  });
  assert.strictEqual(res.installed, false);
  assert.strictEqual(res.reason, 'disabled');
  assert.strictEqual(cp.spawn, origSpawn);
});

test('install: win32 + on → wraps all methods and injects windowsHide', () => {
  const { cp, calls } = _fakeCp();
  const res = wsh.installWindowsSpawnHardening({ platform: 'win32', childProcess: cp, env: {} });
  assert.strictEqual(res.installed, true);
  assert.ok(res.methods.includes('spawn'));
  assert.ok(res.methods.includes('execSync'));

  // 调用被包装后的 spawnSync:未带 options → 注入 windowsHide
  const out = cp.spawnSync('git', ['status'], { stdio: 'pipe' });
  assert.strictEqual(out, 'orig:spawnSync'); // 仍返回原函数结果
  assert.strictEqual(calls.spawnSync[0][2].windowsHide, true);

  // execSync('git ...') 无 options → 追加 options 对象
  cp.execSync('git rev-parse HEAD');
  assert.deepStrictEqual(calls.execSync[0][1], { windowsHide: true });
});

test('install: idempotent (second install is a no-op)', () => {
  const { cp } = _fakeCp();
  const first = wsh.installWindowsSpawnHardening({ platform: 'win32', childProcess: cp, env: {} });
  const wrapped = cp.spawn;
  const second = wsh.installWindowsSpawnHardening({ platform: 'win32', childProcess: cp, env: {} });
  assert.strictEqual(first.installed, true);
  assert.strictEqual(second.installed, false);
  assert.strictEqual(second.reason, 'already');
  assert.strictEqual(cp.spawn, wrapped); // 未二次包装
});

test('install: wrapped fn keeps a handle to the original', () => {
  const { cp } = _fakeCp();
  const orig = cp.exec;
  wsh.installWindowsSpawnHardening({ platform: 'win32', childProcess: cp, env: {} });
  assert.strictEqual(cp.exec.__khyOrig, orig);
});
