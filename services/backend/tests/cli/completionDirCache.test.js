'use strict';

/**
 * completionDirCache.test.js — @-mention 补全目录读缓存(gate KHY_COMPLETION_READDIR_CACHE）
 * 的纯叶子单测(node:test)。
 *
 * 关键不变量:
 *  - 门控关 → 每次都调 readdirFn(不缓存,逐字节回退今日);默认 on。
 *  - TTL 内同一 abs 命中 → readdirFn 只调一次;超 TTL → 再调。
 *  - readdirFn 抛错 → 原样冒泡、不写缓存(下次仍会重试)。
 *  - 命中返回同一 entries 引用;有界封顶逐出最旧。
 *
 * 运行:node --test services/backend/tests/cli/completionDirCache.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const dc = require('../../src/cli/tui/completionDirCache');

const ON = {};
const OFF = { KHY_COMPLETION_READDIR_CACHE: 'off' };

test('isEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(dc.isEnabled({}), true);
  assert.equal(dc.isEnabled({ KHY_COMPLETION_READDIR_CACHE: 'off' }), false);
  assert.equal(dc.isEnabled({ KHY_COMPLETION_READDIR_CACHE: '0' }), false);
  assert.equal(dc.isEnabled({ KHY_COMPLETION_READDIR_CACHE: 'false' }), false);
  assert.equal(dc.isEnabled({ KHY_COMPLETION_READDIR_CACHE: 'no' }), false);
  assert.equal(dc.isEnabled({ KHY_COMPLETION_READDIR_CACHE: 'on' }), true);
});

test('门控关:每次都调 readdirFn(不缓存)', () => {
  dc._clearCache();
  let calls = 0;
  const fn = () => { calls++; return [{ name: 'a' }]; };
  dc.readdirCached('/x', fn, { env: OFF });
  dc.readdirCached('/x', fn, { env: OFF });
  dc.readdirCached('/x', fn, { env: OFF });
  assert.equal(calls, 3, '门控关应每次直读');
});

test('门控开:TTL 内同一 abs 命中,readdirFn 只调一次;返回同一引用', () => {
  dc._clearCache();
  let calls = 0;
  const result = [{ name: 'a' }];
  const fn = () => { calls++; return result; };
  let t = 1000;
  const nowFn = () => t;
  const a = dc.readdirCached('/dir', fn, { env: ON, nowFn, ttlMs: 1500 });
  t = 1400; // 仍在 TTL 内
  const b = dc.readdirCached('/dir', fn, { env: ON, nowFn, ttlMs: 1500 });
  t = 1499;
  const c = dc.readdirCached('/dir', fn, { env: ON, nowFn, ttlMs: 1500 });
  assert.equal(calls, 1, '连续按键(同目录、TTL 内)应只读一次系统调用');
  assert.equal(a, result);
  assert.equal(b, result, '命中返回同一 entries 引用');
  assert.equal(c, result);
});

test('门控开:超 TTL 后再调 readdirFn', () => {
  dc._clearCache();
  let calls = 0;
  const fn = () => { calls++; return [{ name: String(calls) }]; };
  let t = 0;
  const nowFn = () => t;
  dc.readdirCached('/d', fn, { env: ON, nowFn, ttlMs: 1000 });
  t = 999;
  dc.readdirCached('/d', fn, { env: ON, nowFn, ttlMs: 1000 }); // 命中
  t = 1001;
  dc.readdirCached('/d', fn, { env: ON, nowFn, ttlMs: 1000 }); // 过期 → 重读
  assert.equal(calls, 2);
});

test('不同 abs 各自独立缓存', () => {
  dc._clearCache();
  let calls = 0;
  const fn = (p) => { calls++; return [{ name: p }]; };
  const nowFn = () => 500;
  dc.readdirCached('/a', fn, { env: ON, nowFn });
  dc.readdirCached('/b', fn, { env: ON, nowFn });
  dc.readdirCached('/a', fn, { env: ON, nowFn }); // /a 命中
  assert.equal(calls, 2, '/a 与 /b 各读一次,/a 第二次命中');
});

test('readdirFn 抛错:原样冒泡且不写缓存(下次重试)', () => {
  dc._clearCache();
  let calls = 0;
  const fn = () => { calls++; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  const nowFn = () => 100;
  assert.throws(() => dc.readdirCached('/missing', fn, { env: ON, nowFn }), /ENOENT/);
  // 未写缓存 → 第二次仍会真正调用(而非返回缓存的错误/空)。
  assert.throws(() => dc.readdirCached('/missing', fn, { env: ON, nowFn }), /ENOENT/);
  assert.equal(calls, 2, '抛错不缓存,每次都重试');
});

test('有界封顶:超过 MAX_ENTRIES 逐出最旧', () => {
  dc._clearCache();
  const fn = (p) => [{ name: p }];
  let t = 0;
  const nowFn = () => (t += 1); // 递增,保持 keys 插入序 = 时间序
  for (let i = 0; i < 70; i++) dc.readdirCached(`/dir${i}`, fn, { env: ON, nowFn });
  // 最旧的 /dir0 应已被逐出:再读会重新调用 fn(此处仅验证不抛、机制存活)。
  let calls = 0;
  const countFn = (p) => { calls++; return [{ name: p }]; };
  dc.readdirCached('/dir0', countFn, { env: ON, nowFn });
  assert.equal(calls, 1, '/dir0 已被逐出,重读触发一次真正调用');
});
