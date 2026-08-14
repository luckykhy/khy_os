'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Integration: permissionStore.check() consults the learned approval ledger.
 * Uses a real temp KHY_DATA_HOME so the ledger persists; permissionStore stays
 * in 'normal' profile where a low-risk non-readonly tool would otherwise ask.
 */
describe('permissionStore × approvalLedger (learned layer)', () => {
  let tmp;
  let store;
  let ledger;

  function fresh() {
    jest.resetModules();
    store = require('../../src/services/permissionStore');
    ledger = require('../../src/services/approvalLedger');
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-permlearn-'));
    process.env.KHY_DATA_HOME = tmp;
    delete process.env.KHY_AUTO_APPROVE;
    delete process.env.KHY_AUTO_APPROVE_THRESHOLD;
    fresh();
  });

  afterEach(() => {
    delete process.env.KHY_DATA_HOME;
    delete process.env.KHY_AUTO_APPROVE;
    delete process.env.KHY_AUTO_APPROVE_THRESHOLD;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  test('low-risk tool asks until learned, then auto-approves when opted in', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    const opts = { risk: 'low', isReadOnly: false, isDestructive: false };
    expect(store.check('fmt', {}, opts)).toBe('ask');
    // simulate the user approving it three times (what toolCalling records)
    store.approve('fmt', 'once', { risk: 'low' });
    store.approve('fmt', 'once', { risk: 'low' });
    store.approve('fmt', 'once', { risk: 'low' });
    expect(store.check('fmt', {}, opts)).toBe('allow');
  });

  test('opt-out (default) keeps asking no matter the history', () => {
    const opts = { risk: 'low', isReadOnly: false, isDestructive: false };
    for (let i = 0; i < 5; i++) store.approve('fmt', 'once', { risk: 'low' });
    expect(store.check('fmt', {}, opts)).toBe('ask');
  });

  test('a denial in history prevents learned auto-approval', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    const opts = { risk: 'low', isReadOnly: false, isDestructive: false };
    for (let i = 0; i < 5; i++) store.approve('fmt', 'once', { risk: 'low' });
    store.deny('fmt', 'session', { risk: 'low' });
    fresh(); // clear session-only denial; ledger (denyCount=1) persists on disk
    expect(store.check('fmt', {}, opts)).toBe('ask');
  });
});
