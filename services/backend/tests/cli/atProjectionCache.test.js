'use strict';

/**
 * atProjectionCache + atPicker split-helper 单测 — 经典 REPL `@` 文件选择器已排序投影短 TTL 缓存。
 *
 * 覆盖:
 *  - atProjectionCache:门控 CANON · (dir, TTL) 命中同引用 buildFn 只跑一次 · TTL 过后重算 ·
 *    门控关每次现算 · 不同 dir 分槽 · buildFn 抛→[] · 空/非字符串 dir 回退 · 有界封顶 · _clearCache。
 *  - atPicker.buildAtProjection / applyAtFilter:拆分后与整体 listAtEntries 逐字节一致 ·
 *    projection 注入路径跳过 readdir · applyAtFilter 大小写不敏感子串 · 剥掉内部 _lower 字段。
 *  - LIVE wiring:repl.js 确实经 completionDirCache + atProjectionCache + applyAtFilter 组合。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = require('../../src/cli/repl/atProjectionCache');
const atPicker = require('../../src/cli/repl/atPicker');

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atproj-'));
  fs.writeFileSync(path.join(dir, 'alpha.js'), '');
  fs.writeFileSync(path.join(dir, 'Beta.txt'), '');
  fs.writeFileSync(path.join(dir, '.hidden'), '');
  fs.writeFileSync(path.join(dir, '.env.example'), '');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, '.claude'));
  return dir;
}

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(cache.isEnabled({}), true);
  assert.equal(cache.isEnabled({ KHY_AT_PROJECTION_CACHE: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(cache.isEnabled({ KHY_AT_PROJECTION_CACHE: off }), false, `off=${off}`);
  }
  assert.deepEqual(cache.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('getProjection: hit within TTL → same reference, buildFn once', () => {
  cache._clearCache();
  let calls = 0;
  const build = () => { calls++; return [{ name: 'a', display: 'a', isDir: false, _lower: 'a' }]; };
  let clock = 1000; const now = () => clock;
  const a = cache.getProjection('/dir', build, { env: {}, nowFn: now, ttlMs: 500 });
  clock = 1400;
  const b = cache.getProjection('/dir', build, { env: {}, nowFn: now, ttlMs: 500 });
  assert.strictEqual(a, b, 'same projection reference within TTL');
  assert.equal(calls, 1, 'buildFn not re-run within TTL');
});

test('getProjection: TTL expiry → rebuild', () => {
  cache._clearCache();
  let calls = 0;
  const build = () => { calls++; return [{ name: 'x' + calls }]; };
  let clock = 1000; const now = () => clock;
  cache.getProjection('/dir', build, { env: {}, nowFn: now, ttlMs: 500 });
  clock = 1600;
  cache.getProjection('/dir', build, { env: {}, nowFn: now, ttlMs: 500 });
  assert.equal(calls, 2, 'rebuild after TTL');
});

test('getProjection: gate off → buildFn every call', () => {
  cache._clearCache();
  let calls = 0;
  const build = () => { calls++; return []; };
  const off = { KHY_AT_PROJECTION_CACHE: 'off' };
  cache.getProjection('/dir', build, { env: off, nowFn: () => 1000, ttlMs: 500 });
  cache.getProjection('/dir', build, { env: off, nowFn: () => 1000, ttlMs: 500 });
  assert.equal(calls, 2, 'no caching when gated off');
});

test('getProjection: distinct dirs cached separately', () => {
  cache._clearCache();
  let calls = 0;
  const build = () => { calls++; return [{ name: 'n' }]; };
  const now = () => 1000;
  const r1 = cache.getProjection('/d1', build, { env: {}, nowFn: now });
  const r2 = cache.getProjection('/d2', build, { env: {}, nowFn: now });
  assert.equal(calls, 2);
  assert.notStrictEqual(r1, r2);
  assert.strictEqual(cache.getProjection('/d1', build, { env: {}, nowFn: now }), r1);
  assert.equal(calls, 2, '/d1 re-hit does not rebuild');
});

test('getProjection: buildFn throws → [] not throw', () => {
  cache._clearCache();
  const out = cache.getProjection('/dir', () => { throw new Error('boom'); }, { env: {}, nowFn: () => 1000 });
  assert.deepEqual(out, []);
});

test('getProjection: empty/non-string dir → fresh compute (no cache)', () => {
  cache._clearCache();
  let calls = 0;
  const build = () => { calls++; return [{ name: 'n' }]; };
  cache.getProjection('', build, { env: {} });
  cache.getProjection(null, build, { env: {} });
  cache.getProjection(undefined, build, { env: {} });
  assert.equal(calls, 3, 'no caching for empty/non-string dir');
});

test('getProjection: bounded cache eviction (>64 dirs)', () => {
  cache._clearCache();
  const build = () => [];
  const now = () => 1000;
  for (let i = 0; i < 70; i++) cache.getProjection('/dir' + i, build, { env: {}, nowFn: now, ttlMs: 999999 });
  // oldest evicted: /dir0 should rebuild (miss)
  let rebuilt = 0;
  cache.getProjection('/dir0', () => { rebuilt++; return []; }, { env: {}, nowFn: now, ttlMs: 999999 });
  assert.equal(rebuilt, 1, '/dir0 was evicted → rebuilt');
});

test('atPicker: buildAtProjection + applyAtFilter == listAtEntries byte-identical', () => {
  const dir = mkTmp();
  const whole = atPicker.listAtEntries(dir, 'a');
  const proj = atPicker.buildAtProjection(dir);
  const split = atPicker.applyAtFilter(proj, 'a');
  assert.deepStrictEqual(split, whole, 'split path === whole path');
  // no filter case too
  assert.deepStrictEqual(
    atPicker.applyAtFilter(atPicker.buildAtProjection(dir)),
    atPicker.listAtEntries(dir),
  );
});

test('atPicker: applyAtFilter strips internal _lower field', () => {
  const dir = mkTmp();
  const out = atPicker.applyAtFilter(atPicker.buildAtProjection(dir), 'beta');
  assert.deepStrictEqual(out, [{ name: 'Beta.txt', display: 'Beta.txt', isDir: false }]);
  assert.ok(!('_lower' in out[0]), 'no _lower leaked to output');
});

test('atPicker: listAtEntries accepts injected projection (skips readdir)', () => {
  const proj = [
    { name: 'zed', display: 'zed', isDir: false, _lower: 'zed' },
    { name: 'App', display: 'App', isDir: false, _lower: 'app' },
  ];
  // dir intentionally bogus — must NOT be read because projection supplied
  const out = atPicker.listAtEntries('/nonexistent-xyz', 'a', { projection: proj });
  assert.deepStrictEqual(out, [{ name: 'App', display: 'App', isDir: false }]);
});

test('LIVE wiring: repl._listAtEntries composes completionDirCache + atProjectionCache + applyAtFilter', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/repl.js'), 'utf8');
  assert.ok(/require\(['"]\.\/repl\/atProjectionCache['"]\)/.test(src), 'requires atProjectionCache');
  assert.ok(/require\(['"]\.\.\/cli\/tui\/completionDirCache['"]\)/.test(src), 'requires completionDirCache');
  assert.ok(/getProjection\(/.test(src), 'calls getProjection');
  assert.ok(/_applyAtFilter\(projection,\s*filter\)/.test(src), 'applies filter per keystroke');
  assert.ok(/_buildAtProjection\(/.test(src), 'builds projection via extracted helper');
});
