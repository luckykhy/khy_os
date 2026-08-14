'use strict';

/**
 * deviceAppsDownloader.test.js — 下载器进度折算与字节格式化验收(纯逻辑部分)。
 *
 * 沙盒无法真实网络下载,故聚焦确定性核心:
 *   - computeProgress:已知/未知总量、越界封顶、0/负/NaN 归零、百分比四舍五入与钳制
 *   - formatBytes:B/KB/MB/GB 边界
 *   - downloadWithProgress:注入桩验 SSRF 先行校验 + 字节累计回调 + 返回形状
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const dl = require('../../../src/services/deviceApps/deviceAppsDownloader');

describe('computeProgress', () => {
  test('已知总量:半程 50%', () => {
    assert.deepEqual(dl.computeProgress(50, 100), { downloaded: 50, total: 100, percent: 50, known: true });
  });
  test('完成 100%', () => {
    assert.deepEqual(dl.computeProgress(100, 100), { downloaded: 100, total: 100, percent: 100, known: true });
  });
  test('越界封顶到 total', () => {
    assert.deepEqual(dl.computeProgress(120, 100), { downloaded: 100, total: 100, percent: 100, known: true });
  });
  test('未知总量(content-length 缺失)→ known:false, percent:0', () => {
    assert.deepEqual(dl.computeProgress(1234, 0), { downloaded: 1234, total: 0, percent: 0, known: false });
  });
  test('负/NaN 归零', () => {
    assert.deepEqual(dl.computeProgress(-5, 100), { downloaded: 0, total: 100, percent: 0, known: true });
    assert.deepEqual(dl.computeProgress(NaN, NaN), { downloaded: 0, total: 0, percent: 0, known: false });
  });
  test('百分比四舍五入', () => {
    assert.equal(dl.computeProgress(1, 3).percent, 33);
    assert.equal(dl.computeProgress(2, 3).percent, 67);
  });
});

describe('formatBytes', () => {
  test('B', () => assert.equal(dl.formatBytes(512), '512 B'));
  test('KB', () => assert.equal(dl.formatBytes(2048), '2.0 KB'));
  test('MB', () => assert.equal(dl.formatBytes(5 * 1024 * 1024), '5.0 MB'));
  test('GB', () => assert.equal(dl.formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB'));
  test('0/负 → 0 B', () => {
    assert.equal(dl.formatBytes(0), '0 B');
    assert.equal(dl.formatBytes(-1), '0 B');
  });
});

describe('downloadWithProgress — 注入桩', () => {
  // 构造一个可控的 stream 桩(EventEmitter 形态)+ writable 桩 + axios/fs 注入。
  function makeStubs({ chunks, total, redirectHost }) {
    const { EventEmitter } = require('events');
    const dataStream = new EventEmitter();
    dataStream.pipe = () => dataStream; // pipe 返回自身即可
    const ws = new EventEmitter();
    ws.destroy = () => {};
    let validated = null;
    const fakeAxios = async (cfg) => {
      // 触发 beforeRedirect(如提供 redirectHost)以验证封锁检查接线。
      if (redirectHost && typeof cfg.beforeRedirect === 'function') {
        cfg.beforeRedirect({ hostname: redirectHost });
      }
      // 异步喂 chunk 后触发 ws finish。
      setImmediate(() => {
        for (const c of chunks) dataStream.emit('data', Buffer.from(c));
        ws.emit('finish');
      });
      return { headers: { 'content-length': String(total) }, data: dataStream };
    };
    const fakeFs = { createWriteStream: () => ws };
    const fakeValidate = async (u) => { validated = u; };
    return { fakeAxios, fakeFs, fakeValidate, get validatedUrl() { return validated; } };
  }

  test('SSRF 校验先行 + 字节累计 + 返回形状', async () => {
    const stubs = makeStubs({ chunks: ['abcd', 'efghij'], total: 10 });
    const seen = [];
    const res = await dl.downloadWithProgress('https://example.com/app.bin', '/tmp/app.bin',
      (p) => seen.push(p),
      { axios: stubs.fakeAxios, fs: stubs.fakeFs, validateUrl: stubs.fakeValidate, throttleMs: 0 });
    assert.equal(stubs.validatedUrl, 'https://example.com/app.bin'); // 下载前已 SSRF 校验
    assert.deepEqual(res, { bytes: 10, total: 10, path: '/tmp/app.bin' });
    // 末帧必发,且为 100%。
    assert.ok(seen.length >= 1);
    assert.deepEqual(seen[seen.length - 1], { downloaded: 10, total: 10, percent: 100, known: true });
  });

  test('beforeRedirect 封锁私网重定向目标 → 抛错', async () => {
    const stubs = makeStubs({ chunks: ['x'], total: 1, redirectHost: '127.0.0.1' });
    await assert.rejects(
      dl.downloadWithProgress('https://example.com/x', '/tmp/x',
        () => {},
        { axios: stubs.fakeAxios, fs: stubs.fakeFs, validateUrl: stubs.fakeValidate, throttleMs: 0 }),
      /Blocked redirect target/);
  });
});
