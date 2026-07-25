'use strict';

/**
 * toolCapabilityStore.test.js — 实测工具调用能力的持久缓存不变量。
 * 原子写往返 + TTL 过期返 null + 畸形不抛 + env 路径覆盖 + 仅 native/text 入库。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../../../src/services/gateway/toolCapabilityStore');

let tmpFile;
const PREV = {};
const ENV_KEYS = ['KHY_TOOL_CAP_FILE', 'KHY_TOOL_CAP_TTL_MS'];

beforeEach(() => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpFile = path.join(os.tmpdir(), `khy-toolcap-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  process.env.KHY_TOOL_CAP_FILE = tmpFile;
  delete process.env.KHY_TOOL_CAP_TTL_MS;
  store._resetCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  store._resetCache();
});

describe('recordVerdict / getVerdict — round trip', () => {
  test('persists native and reads back (even after cache reset = disk read)', () => {
    assert.equal(store.recordVerdict('agnes-2.0-flash', 'native', { source: 'probe', latencyMs: 123 }), true);
    assert.equal(store.getVerdict('agnes-2.0-flash'), 'native');
    store._resetCache();
    assert.equal(store.getVerdict('agnes-2.0-flash'), 'native'); // 从盘恢复
    assert.ok(fs.existsSync(tmpFile));
  });

  test('normalizes model key (case/space insensitive)', () => {
    store.recordVerdict('  Agnes-2.0-Flash ', 'text');
    assert.equal(store.getVerdict('agnes-2.0-flash'), 'text');
  });

  test('getRecord returns full record', () => {
    store.recordVerdict('m1', 'native', { source: 'passive', latencyMs: 50 });
    const rec = store.getRecord('m1');
    assert.equal(rec.verdict, 'native');
    assert.equal(rec.source, 'passive');
    assert.equal(rec.latencyMs, 50);
    assert.ok(Number.isFinite(rec.measuredAt));
  });

  test('unmeasured model → null', () => {
    assert.equal(store.getVerdict('never-seen'), null);
    assert.equal(store.getRecord('never-seen'), null);
  });
});

describe('input validation — only native/text recorded', () => {
  test('rejects unknown/invalid verdicts', () => {
    assert.equal(store.recordVerdict('m', 'unknown'), false);
    assert.equal(store.recordVerdict('m', 'maybe'), false);
    assert.equal(store.recordVerdict('m', null), false);
    assert.equal(store.getVerdict('m'), null);
  });
  test('rejects empty model', () => {
    assert.equal(store.recordVerdict('', 'native'), false);
    assert.equal(store.recordVerdict('   ', 'native'), false);
  });
});

describe('TTL — expired entries read as null', () => {
  test('expired TEXT record returns null (未确证有界 TTL)', () => {
    process.env.KHY_TOOL_CAP_TTL_MS = '1000';
    store.recordVerdict('m', 'text');
    assert.equal(store.getVerdict('m'), 'text');
    // 手动把 measuredAt 推到过去,模拟过期(直接改盘 + reset)
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    raw.entries.m.measuredAt = Date.now() - 5000;
    fs.writeFileSync(tmpFile, JSON.stringify(raw));
    store._resetCache();
    assert.equal(store.getVerdict('m'), null);
    assert.equal(store.getRecord('m'), null);
  });

  test('confirmed PASS (native) is sticky — old measuredAt still reads native (避免重复浪费)', () => {
    process.env.KHY_TOOL_CAP_TTL_MS = '1000';
    store.recordVerdict('p', 'native');
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    raw.entries.p.measuredAt = Date.now() - 365 * 24 * 3600 * 1000; // 一年前
    fs.writeFileSync(tmpFile, JSON.stringify(raw));
    store._resetCache();
    assert.equal(store.getVerdict('p'), 'native'); // sticky,不因 age 失效
  });
});

describe('listPassing — 通过的纳入数组', () => {
  test('returns only confirmed-native, fresh entries as an array', () => {
    store.recordVerdict('pass-a', 'native', { source: 'probe' });
    store.recordVerdict('pass-b', 'native', { source: 'passive' });
    store.recordVerdict('nope', 'text');
    const passing = store.listPassing();
    assert.ok(Array.isArray(passing));
    const models = passing.map(e => e.model).sort();
    assert.deepEqual(models, ['pass-a', 'pass-b']);
    for (const e of passing) assert.equal(e.verdict, 'native');
  });
  test('empty store → empty array', () => {
    assert.deepEqual(store.listPassing(), []);
  });
});

describe('listFresh', () => {
  test('lists only non-expired entries', () => {
    store.recordVerdict('a', 'native');
    store.recordVerdict('b', 'text');
    const fresh = store.listFresh();
    const models = fresh.map(e => e.model).sort();
    assert.deepEqual(models, ['a', 'b']);
  });
});

describe('robustness — never throws', () => {
  test('corrupt file → empty store, no throw', () => {
    fs.writeFileSync(tmpFile, 'NOT JSON {{{');
    store._resetCache();
    assert.doesNotThrow(() => store.getVerdict('x'));
    assert.equal(store.getVerdict('x'), null);
    // can still record after recovering from corruption
    assert.equal(store.recordVerdict('x', 'native'), true);
    assert.equal(store.getVerdict('x'), 'native');
  });
  test('junk inputs never throw', () => {
    for (const j of [null, undefined, 42, {}, []]) {
      assert.doesNotThrow(() => store.getVerdict(j));
      assert.doesNotThrow(() => store.recordVerdict(j, 'native'));
    }
  });
});
