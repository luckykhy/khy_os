'use strict';

/**
 * performanceSampler.test.js — 系统负载采样器纯叶子单测(node:test)。
 *
 * 覆盖:两次 CPU 采样求差算占用 + 内存占用计算、5s TTL 缓存(命中零额外 os.cpus() 调用)、
 * os.cpus() 不可用/抛异常/超时 → 返回 null 优雅降级、totalDiff<=0 边界。
 * 用 t.mock.method 打桩 os,避免真实采样的时序不确定性。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');

const sampler = require('../../src/services/performanceSampler');

// 一份「一核」CPU times 快照工厂:idle/total 可控。
function cpuSnapshot(user, sys, idle) {
  return [{ model: 'x', speed: 1, times: { user, nice: 0, sys, idle, irq: 0 } }];
}

const GB = 1024 * 1024 * 1024;

test('导出契约', () => {
  assert.strictEqual(typeof sampler.sampleSystemLoad, 'function');
  assert.strictEqual(typeof sampler._clearCache, 'function');
  assert.strictEqual(typeof sampler.CACHE_TTL_MS, 'number');
});

test('两次采样求差:CPU/内存占用计算正确', async (t) => {
  sampler._clearCache();
  // 第一次 idle=100 total=200;第二次 idle=150 total=350 → idleDiff=50 totalDiff=150
  // cpuPercent = round((1 - 50/150)*100) = 67
  let call = 0;
  t.mock.method(os, 'cpus', () => {
    call += 1;
    return call === 1 ? cpuSnapshot(50, 50, 100) : cpuSnapshot(100, 100, 150);
  });
  // 内存:free=2GB total=8GB → memPercent=75, freeMemMB=2048
  t.mock.method(os, 'freemem', () => 2 * GB);
  t.mock.method(os, 'totalmem', () => 8 * GB);

  const r = await sampler.sampleSystemLoad({ intervalMs: 1, force: true });
  assert.ok(r, 'should return a snapshot');
  assert.strictEqual(r.cpuPercent, 67);
  assert.strictEqual(r.memPercent, 75);
  assert.strictEqual(r.freeMemMB, 2048);
  assert.strictEqual(r.totalMemMB, 8192);
  assert.strictEqual(r.cpuCount, 1);
  assert.ok(Number.isFinite(r.sampledAt));
});

test('TTL 缓存:5s 内重复调用命中缓存,不再调用 os.cpus()', async (t) => {
  sampler._clearCache();
  const m = t.mock.method(os, 'cpus', () => cpuSnapshot(10, 10, 80));
  t.mock.method(os, 'freemem', () => 4 * GB);
  t.mock.method(os, 'totalmem', () => 8 * GB);

  const first = await sampler.sampleSystemLoad({ intervalMs: 1 });
  assert.ok(first);
  const callsAfterFirst = m.mock.calls.length;
  assert.ok(callsAfterFirst >= 2, '首采应两次调用 os.cpus()');

  const second = await sampler.sampleSystemLoad({ intervalMs: 1 });
  assert.strictEqual(second, first, '缓存命中应返回同一对象');
  assert.strictEqual(m.mock.calls.length, callsAfterFirst, '缓存命中不应再调用 os.cpus()');
});

test('os.cpus() 不可用(空数组) → 返回 null', async (t) => {
  sampler._clearCache();
  t.mock.method(os, 'cpus', () => []);
  const r = await sampler.sampleSystemLoad({ intervalMs: 1, force: true });
  assert.strictEqual(r, null);
});

test('os.cpus() 抛异常 → 优雅降级返回 null', async (t) => {
  sampler._clearCache();
  t.mock.method(os, 'cpus', () => { throw new Error('boom'); });
  const r = await sampler.sampleSystemLoad({ intervalMs: 1, force: true });
  assert.strictEqual(r, null);
});

test('超时兜底:采样迟迟不返回 → null', async (t) => {
  sampler._clearCache();
  // 第一次正常,第二次前的 delay 用大 intervalMs,而 timeoutMs 很小 → 超时胜出返回 null。
  t.mock.method(os, 'cpus', () => cpuSnapshot(50, 50, 100));
  t.mock.method(os, 'freemem', () => 2 * GB);
  t.mock.method(os, 'totalmem', () => 8 * GB);
  const r = await sampler.sampleSystemLoad({ intervalMs: 500, timeoutMs: 5, force: true });
  assert.strictEqual(r, null);
});

test('totalDiff<=0 边界:CPU 占用按 0 处理,不抛/不 NaN', async (t) => {
  sampler._clearCache();
  // 两次 times 完全相同 → idleDiff=0 totalDiff=0 → cpuPercent=0
  t.mock.method(os, 'cpus', () => cpuSnapshot(50, 50, 100));
  t.mock.method(os, 'freemem', () => 4 * GB);
  t.mock.method(os, 'totalmem', () => 8 * GB);
  const r = await sampler.sampleSystemLoad({ intervalMs: 1, force: true });
  assert.ok(r);
  assert.strictEqual(r.cpuPercent, 0);
  assert.strictEqual(r.memPercent, 50);
});

test('绝不抛:畸形入参 fail-soft', async () => {
  sampler._clearCache();
  await assert.doesNotReject(() => sampler.sampleSystemLoad());
  await assert.doesNotReject(() => sampler.sampleSystemLoad(null));
});
