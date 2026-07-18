'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('heartbeatService — declarative companion patrol (#9)', () => {
  let tmp;
  let hb;
  let agentFs;

  function fresh() {
    jest.resetModules();
    hb = require('../../src/services/heartbeatService');
    agentFs = require('../../src/services/agentFs/agentFsService');
  }

  function makeActiveCompanion(id, heartbeatMd) {
    agentFs.createAgent({ name: id, id, createdAt: '2026-06-09T00:00:00.000Z' });
    agentFs.setActiveAgent(id);
    if (heartbeatMd != null) {
      agentFs.writeAsset(id, agentFs.ASSET_FILES.heartbeat, heartbeatMd);
    }
  }

  const SEED_ALL_COMMENTED = [
    '# 心跳检查（HEARTBEAT.md）',
    '> 留空或只有注释则不发起检查。',
    '## 数据源',
    '# - 邮箱：检查来自关键联系人的未读邮件',
    '# - GitHub：检查被 @、PR 审查请求和失败的 CI',
    '## 判断标准',
    '# - 没有新增重要事项时保持安静',
  ].join('\n');

  const SEED_ONE_ACTIVE = [
    '# 心跳检查（HEARTBEAT.md）',
    '## 数据源',
    '- 邮箱：检查来自关键联系人的未读邮件',
    '# - GitHub：检查失败的 CI',
    '## 判断标准',
    '- 没有新增重要事项时保持安静',
  ].join('\n');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-heartbeat-'));
    process.env.KHY_DATA_HOME = tmp;
    delete process.env.KHY_HEARTBEAT;
    fresh();
  });

  afterEach(() => {
    delete process.env.KHY_DATA_HOME;
    delete process.env.KHY_HEARTBEAT;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  // ── parseChecklist ──────────────────────────────────────────────────────────

  test('all-commented seed template → disabled (silent by default)', () => {
    const r = hb.parseChecklist(SEED_ALL_COMMENTED);
    expect(r.enabled).toBe(false);
    expect(r.sources).toEqual([]);
    expect(r.criteria).toEqual([]);
  });

  test('uncommenting a bullet enables the checklist and parses sections', () => {
    const r = hb.parseChecklist(SEED_ONE_ACTIVE);
    expect(r.enabled).toBe(true);
    expect(r.sources).toEqual(['邮箱：检查来自关键联系人的未读邮件']);
    expect(r.criteria).toEqual(['没有新增重要事项时保持安静']);
  });

  test('empty / whitespace-only checklist → disabled', () => {
    expect(hb.parseChecklist('').enabled).toBe(false);
    expect(hb.parseChecklist('\n\n   \n').enabled).toBe(false);
  });

  // ── patrol: silent paths ────────────────────────────────────────────────────

  test('no active companion → silent', () => {
    const r = hb.patrol({ findings: [{ key: 'x', message: 'hi' }] });
    expect(r.status).toBe('silent');
    expect(r.reason).toBe('no-active-companion');
  });

  test('disabled checklist + findings → silent (no-checklist)', () => {
    makeActiveCompanion('alpha', SEED_ALL_COMMENTED);
    const r = hb.patrol({ findings: [{ key: 'unread', message: '3 emails' }] });
    expect(r.enabled).toBe(false);
    expect(r.status).toBe('silent');
    expect(r.reason).toBe('no-checklist');
    expect(r.notified).toEqual([]);
  });

  test('KHY_HEARTBEAT=off → always silent (disabled)', () => {
    process.env.KHY_HEARTBEAT = 'off';
    makeActiveCompanion('beta', SEED_ONE_ACTIVE);
    const r = hb.patrol({ findings: [{ key: 'ci', message: 'failed' }] });
    expect(r.status).toBe('silent');
    expect(r.reason).toBe('disabled');
  });

  // ── patrol: notify + 24h dedup ──────────────────────────────────────────────

  test('enabled + findings → notify; same event within 24h → suppressed; after window → notify again', () => {
    makeActiveCompanion('gamma', SEED_ONE_ACTIVE);
    const t0 = '2026-06-09T00:00:00.000Z';
    const t1 = new Date(Date.parse(t0) + 60 * 60 * 1000).toISOString();        // +1h (within window)
    const t2 = new Date(Date.parse(t0) + 25 * 60 * 60 * 1000).toISOString();   // +25h (past window)

    const finding = [{ key: 'ci-fail', message: 'CI red on main' }];

    const first = hb.patrol({ companionId: 'gamma', findings: finding, stamp: t0 });
    expect(first.status).toBe('notify');
    expect(first.notified).toHaveLength(1);

    const second = hb.patrol({ companionId: 'gamma', findings: finding, stamp: t1 });
    expect(second.status).toBe('silent');
    expect(second.suppressed).toHaveLength(1);
    expect(second.notified).toEqual([]);

    const third = hb.patrol({ companionId: 'gamma', findings: finding, stamp: t2 });
    expect(third.status).toBe('notify');
    expect(third.notified).toHaveLength(1);
  });

  test('distinct event keys notify independently', () => {
    makeActiveCompanion('delta', SEED_ONE_ACTIVE);
    const r = hb.patrol({
      companionId: 'delta',
      findings: [{ key: 'a' }, { key: 'b' }],
      stamp: '2026-06-09T00:00:00.000Z',
    });
    expect(r.status).toBe('notify');
    expect(r.notified).toHaveLength(2);
  });

  // ── dedup primitives ────────────────────────────────────────────────────────

  test('shouldNotify / recordEvent honor the dedup window', () => {
    const t0 = '2026-06-09T00:00:00.000Z';
    expect(hb.shouldNotify({ key: 'k', stamp: t0 })).toBe(true);
    hb.recordEvent({ key: 'k', stamp: t0 });
    expect(hb.shouldNotify({ key: 'k', stamp: t0 })).toBe(false);
    const past = new Date(Date.parse(t0) + 24 * 60 * 60 * 1000).toISOString();
    expect(hb.shouldNotify({ key: 'k', stamp: past })).toBe(true); // exactly at window edge
  });

  test('getEvents + reset', () => {
    hb.recordEvent({ key: 'k', stamp: '2026-06-09T00:00:00.000Z' });
    expect(Object.keys(hb.getEvents().events)).toContain('k');
    hb.reset();
    expect(Object.keys(hb.getEvents().events)).toEqual([]);
  });

  // ── safety invariant: never executes anything ───────────────────────────────

  test('module exposes no execute / run-tool capability (heartbeat never bypasses approval)', () => {
    const keys = Object.keys(hb);
    const forbidden = /execute|runtool|spawn|invoke|exec\b|shell|command/i;
    for (const k of keys) {
      expect(forbidden.test(k)).toBe(false);
    }
    // patrol returns plain reminder data only
    makeActiveCompanion('eps', SEED_ONE_ACTIVE);
    const r = hb.patrol({ companionId: 'eps', findings: [{ key: 'x' }], stamp: '2026-06-09T00:00:00.000Z' });
    expect(typeof r).toBe('object');
    expect(Array.isArray(r.notified)).toBe(true);
    expect(r).not.toHaveProperty('executed');
  });
});
