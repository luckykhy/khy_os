'use strict';

/**
 * deploy.ledger.test.js — durable deployment record store.
 *
 * Uses an in-memory fs map and a fixed clock so upsert/get/remove and the
 * live-process reconciliation in listReconciled are deterministic with zero
 * real I/O or process probing.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../src/services/deploy/deployLedger');

function makeDeps(overrides = {}) {
  const store = new Map();
  return {
    deps: {
      fs: {
        existsSync: (p) => store.has(p),
        readFileSync: (p) => {
          if (!store.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
          return store.get(p);
        },
        writeFileSync: (p, data) => { store.set(p, data); },
      },
      dir: () => '/data/deployments',
      now: () => '2026-06-19T00:00:00.000Z',
      isAlive: overrides.isAlive || (() => false),
    },
    store,
  };
}

describe('deployLedger', () => {
  test('empty ledger loads as []', () => {
    const { deps } = makeDeps();
    assert.deepEqual(ledger.load(deps), []);
  });

  test('upsert inserts then updates by name', () => {
    const { deps } = makeDeps();
    ledger.upsert({ name: 'app', target: '/srv/app', status: 'deployed' }, deps);
    let recs = ledger.load(deps);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, 'deployed');
    assert.equal(recs[0].updatedAt, '2026-06-19T00:00:00.000Z');

    ledger.upsert({ name: 'app', status: 'running', pid: 123 }, deps);
    recs = ledger.load(deps);
    assert.equal(recs.length, 1, 'same name should update, not duplicate');
    assert.equal(recs[0].status, 'running');
    assert.equal(recs[0].pid, 123);
    assert.equal(recs[0].target, '/srv/app', 'prior fields preserved on merge');
  });

  test('get returns record or null', () => {
    const { deps } = makeDeps();
    ledger.upsert({ name: 'a' }, deps);
    assert.equal(ledger.get('a', deps).name, 'a');
    assert.equal(ledger.get('missing', deps), null);
  });

  test('remove deletes by name', () => {
    const { deps } = makeDeps();
    ledger.upsert({ name: 'a' }, deps);
    ledger.upsert({ name: 'b' }, deps);
    assert.equal(ledger.remove('a', deps), true);
    assert.equal(ledger.remove('a', deps), false);
    assert.equal(ledger.load(deps).length, 1);
  });

  test('corrupt ledger heals to empty rather than throwing', () => {
    const { deps, store } = makeDeps();
    store.set('/data/deployments/ledger.json', '{not json');
    assert.deepEqual(ledger.load(deps), []);
  });

  test('listReconciled marks dead running pid as exited', () => {
    const { deps } = makeDeps({ isAlive: () => false });
    ledger.upsert({ name: 'a', status: 'running', pid: 999 }, deps);
    const recs = ledger.listReconciled(deps);
    assert.equal(recs[0].status, 'exited');
  });

  test('listReconciled keeps running status when pid alive', () => {
    const { deps } = makeDeps({ isAlive: () => true });
    ledger.upsert({ name: 'a', status: 'running', pid: 999 }, deps);
    const recs = ledger.listReconciled(deps);
    assert.equal(recs[0].status, 'running');
  });
});
