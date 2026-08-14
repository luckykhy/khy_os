'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('approvalLedger — learned auto-approval', () => {
  let tmp;
  let ledger;

  function fresh() {
    jest.resetModules();
    ledger = require('../../src/services/approvalLedger');
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ledger-'));
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

  test('disabled by default → never auto-approves even with many approvals', () => {
    for (let i = 0; i < 10; i++) ledger.record({ key: 'grep', decision: 'allow', risk: 'safe' });
    expect(ledger.shouldAutoApprove({ key: 'grep', risk: 'safe' })).toBe(false);
  });

  test('enabled + safe + threshold reached + no denials → auto-approves', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    for (let i = 0; i < 3; i++) ledger.record({ key: 'grep', decision: 'allow', risk: 'safe' });
    expect(ledger.shouldAutoApprove({ key: 'grep', risk: 'safe' })).toBe(true);
  });

  test('below threshold → not yet', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    ledger.record({ key: 'grep', decision: 'allow', risk: 'low' });
    ledger.record({ key: 'grep', decision: 'allow', risk: 'low' });
    expect(ledger.shouldAutoApprove({ key: 'grep', risk: 'low' })).toBe(false);
  });

  test('a single denial resets accumulated trust', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    for (let i = 0; i < 5; i++) ledger.record({ key: 'grep', decision: 'allow', risk: 'safe' });
    ledger.record({ key: 'grep', decision: 'deny', risk: 'safe' });
    expect(ledger.shouldAutoApprove({ key: 'grep', risk: 'safe' })).toBe(false);
    const e = ledger.getLedger().entries.grep;
    expect(e.allowCount).toBe(0);
    expect(e.denyCount).toBe(1);
  });

  test('medium/high/critical risk never auto-approves regardless of count', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    for (const risk of ['medium', 'high', 'critical']) {
      for (let i = 0; i < 10; i++) ledger.record({ key: `t-${risk}`, decision: 'allow', risk });
      expect(ledger.shouldAutoApprove({ key: `t-${risk}`, risk })).toBe(false);
    }
  });

  test('destructive ops never auto-approve even if low risk', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    for (let i = 0; i < 5; i++) ledger.record({ key: 'edit', decision: 'allow', risk: 'low' });
    expect(ledger.shouldAutoApprove({ key: 'edit', risk: 'low', isDestructive: true })).toBe(false);
    expect(ledger.shouldAutoApprove({ key: 'edit', risk: 'low', isDestructive: false })).toBe(true);
  });

  test('custom threshold via env', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    process.env.KHY_AUTO_APPROVE_THRESHOLD = '2';
    fresh();
    ledger.record({ key: 'grep', decision: 'allow', risk: 'safe' });
    expect(ledger.shouldAutoApprove({ key: 'grep', risk: 'safe' })).toBe(false);
    ledger.record({ key: 'grep', decision: 'allow', risk: 'safe' });
    expect(ledger.shouldAutoApprove({ key: 'grep', risk: 'safe' })).toBe(true);
  });

  test('record accumulates counts and persists across reloads', () => {
    ledger.record({ key: 'ls', decision: 'allow', risk: 'safe' });
    ledger.record({ key: 'ls', decision: 'allow', risk: 'safe' });
    fresh(); // reload from disk
    const e = ledger.getLedger().entries.ls;
    expect(e.allowCount).toBe(2);
    expect(e.lastRisk).toBe('safe');
    expect(typeof e.firstSeen).toBe('string');
  });

  test('getLedger reports enabled/threshold and per-entry eligibility', () => {
    process.env.KHY_AUTO_APPROVE = 'on';
    for (let i = 0; i < 3; i++) ledger.record({ key: 'grep', decision: 'allow', risk: 'safe' });
    const l = ledger.getLedger();
    expect(l.enabled).toBe(true);
    expect(l.threshold).toBe(3);
    expect(l.entries.grep.autoEligible).toBe(true);
  });

  test('reset clears the ledger', () => {
    ledger.record({ key: 'grep', decision: 'allow', risk: 'safe' });
    ledger.reset();
    expect(Object.keys(ledger.getLedger().entries)).toHaveLength(0);
  });

  test('ignores invalid records', () => {
    ledger.record({ key: '', decision: 'allow' });
    ledger.record({ key: 'x', decision: 'maybe' });
    expect(Object.keys(ledger.getLedger().entries)).toHaveLength(0);
  });
});
