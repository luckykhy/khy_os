'use strict';

/**
 * Tests for gateway/failoverOrderStore.js — user-defined failover order.
 *
 * Verifies env-override priority, file read/write roundtrip, dedup/normalize,
 * and silent fallback on a corrupt config file. Each test isolates state via a
 * fresh temp KHY_DATA_HOME and jest.resetModules so the dataHome cache is clean.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpHome;
const ORIG_ENV = { ...process.env };

function freshStore() {
  jest.resetModules();
  return require('../../src/services/gateway/failoverOrderStore');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-failover-'));
  process.env.KHY_DATA_HOME = tmpHome;
  delete process.env.GATEWAY_FAILOVER_ORDER;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('failoverOrderStore', () => {
  test('default: unset → disabled, empty order', () => {
    const store = freshStore();
    const result = store.getFailoverOrder();
    expect(result.enabled).toBe(false);
    expect(result.order).toEqual([]);
    expect(result.source).toBe('default');
  });

  test('env override takes priority and is normalized', () => {
    process.env.GATEWAY_FAILOVER_ORDER = ' Relay, KIRO ,relay,, ';
    const store = freshStore();
    const result = store.getFailoverOrder();
    expect(result.enabled).toBe(true);
    expect(result.order).toEqual(['relay', 'kiro']); // lowercased, deduped, trimmed
    expect(result.source).toBe('env');
  });

  test('set then get roundtrips via file', () => {
    const store = freshStore();
    const saved = store.setFailoverOrder(['kiro', 'relay', 'claude']);
    expect(saved.enabled).toBe(true);
    expect(saved.order).toEqual(['kiro', 'relay', 'claude']);

    const store2 = freshStore(); // fresh module, reads from disk
    const result = store2.getFailoverOrder();
    expect(result.enabled).toBe(true);
    expect(result.order).toEqual(['kiro', 'relay', 'claude']);
    expect(result.source).toBe('file');
  });

  test('env overrides file when both present', () => {
    const store = freshStore();
    store.setFailoverOrder(['kiro', 'relay']);
    process.env.GATEWAY_FAILOVER_ORDER = 'claude,codex';
    const store2 = freshStore();
    const result = store2.getFailoverOrder();
    expect(result.order).toEqual(['claude', 'codex']);
    expect(result.source).toBe('env');
  });

  test('clear removes the file and reverts to default', () => {
    const store = freshStore();
    store.setFailoverOrder(['kiro']);
    store.clearFailoverOrder();
    const result = store.getFailoverOrder();
    expect(result.enabled).toBe(false);
    expect(result.order).toEqual([]);
    expect(result.source).toBe('default');
  });

  test('corrupt config file falls back silently to default', () => {
    const store = freshStore();
    // Write garbage to the expected file path.
    const fp = path.join(tmpHome, 'gateway_failover.json');
    fs.writeFileSync(fp, '{ not valid json ', 'utf-8');
    const result = store.getFailoverOrder();
    expect(result.enabled).toBe(false);
    expect(result.order).toEqual([]);
    expect(result.source).toBe('default');
  });

  test('empty order disables even if file marks enabled', () => {
    const store = freshStore();
    const fp = path.join(tmpHome, 'gateway_failover.json');
    fs.writeFileSync(fp, JSON.stringify({ enabled: true, order: [] }), 'utf-8');
    const result = store.getFailoverOrder();
    expect(result.enabled).toBe(false);
    expect(result.order).toEqual([]);
  });

  test('_normalizeList dedups, trims, lowercases, drops empties', () => {
    const store = freshStore();
    expect(store._normalizeList([' A ', 'b', 'A', '', null, 'B'])).toEqual(['a', 'b']);
    expect(store._normalizeList('notarray')).toEqual([]);
  });
});
