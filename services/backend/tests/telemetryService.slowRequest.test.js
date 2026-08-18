'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('telemetryService — 慢请求聚合 + computeRollup 两种记录形状', () => {
  const originalDataHome = process.env.KHY_DATA_HOME;
  let tmpDir;
  let telemetry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-telemetry-slow-'));
    process.env.KHY_DATA_HOME = tmpDir;
    jest.resetModules();
    telemetry = require('../src/services/telemetryService');
    telemetry.reset();
  });

  afterEach(() => {
    process.env.KHY_DATA_HOME = originalDataHome;
    jest.resetModules();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function rec(overrides = {}) {
    return {
      ts: '2026-08-16T10:00:00.000Z',
      day: '2026-08-16',
      method: 'POST',
      path: '/api/backtest',
      route: 'POST /api/backtest',
      durationMs: 8200,
      thresholdMs: 3000,
      statusCode: '200',
      requestId: '',
      traceId: '',
      todayCount: 0,
      ...overrides,
    };
  }

  describe('trackSlowRequest / getSlowRequestSummary', () => {
    test('首条记录建立路由槽并返回 todayCount=1', () => {
      const s = telemetry.trackSlowRequest(rec());
      expect(s.route).toBe('POST /api/backtest');
      expect(s.totalSlow).toBe(1);
      expect(s.todayCount).toBe(1);
      expect(s.lastMs).toBe(8200);
    });

    test('同路由多条:累加并算出分位', () => {
      for (const ms of [4000, 5000, 6000, 12000]) {
        telemetry.trackSlowRequest(rec({ durationMs: ms }));
      }
      const s = telemetry.getSlowRequestSummary('POST /api/backtest');
      expect(s.totalSlow).toBe(4);
      expect(s.todayCount).toBe(4);
      expect(s.p50).toBe(5000);
      expect(s.p95).toBe(12000);
      expect(s.maxMs).toBe(12000);
      expect(s.lastMs).toBe(12000);
    });

    test('跨日 todayCount 归零,totalSlow 继续累计', () => {
      telemetry.trackSlowRequest(rec({ day: '2026-08-15' }));
      telemetry.trackSlowRequest(rec({ day: '2026-08-15' }));
      expect(telemetry.getSlowRequestSummary('POST /api/backtest').todayCount).toBe(2);
      telemetry.trackSlowRequest(rec({ day: '2026-08-16' }));
      const s = telemetry.getSlowRequestSummary('POST /api/backtest');
      expect(s.todayCount).toBe(1);
      expect(s.totalSlow).toBe(3);
    });

    test('未知路由返回空摘要而非 undefined', () => {
      const s = telemetry.getSlowRequestSummary('GET /nope');
      expect(s.totalSlow).toBe(0);
      expect(s.p95).toBe(0);
    });

    test('路由基数封顶后新路由归入 _other', () => {
      telemetry.trackSlowRequest(rec({ route: 'GET /a', path: '/a' }), { maxRoutes: 2 });
      telemetry.trackSlowRequest(rec({ route: 'GET /b', path: '/b' }), { maxRoutes: 2 });
      const s = telemetry.trackSlowRequest(rec({ route: 'GET /c', path: '/c' }), { maxRoutes: 2 });
      expect(s.route).toBe('_other');
      expect(telemetry.getSlowRequestSummary('GET /c').totalSlow).toBe(0);
      expect(telemetry.getSlowRequestSummary('_other').totalSlow).toBe(1);
    });
  });

  describe('getSlowRequestSummaries —— 按 p95 降序,最慢的排最前', () => {
    test('排序把最严重的路由放在最前面', () => {
      telemetry.trackSlowRequest(rec({ route: 'GET /fast', path: '/fast', durationMs: 3100 }));
      telemetry.trackSlowRequest(rec({ route: 'GET /slow', path: '/slow', durationMs: 30000 }));
      telemetry.trackSlowRequest(rec({ route: 'GET /mid', path: '/mid', durationMs: 9000 }));
      const list = telemetry.getSlowRequestSummaries();
      expect(list.map((s) => s.route)).toEqual(['GET /slow', 'GET /mid', 'GET /fast']);
    });

    test('无记录时返回空数组', () => {
      expect(telemetry.getSlowRequestSummaries()).toEqual([]);
    });
  });

  describe('告警去抖时间戳', () => {
    test('markSlowRequestAlerted / getSlowRequestLastAlertAt 往返', () => {
      telemetry.trackSlowRequest(rec());
      expect(telemetry.getSlowRequestLastAlertAt('POST /api/backtest')).toBe(0);
      telemetry.markSlowRequestAlerted('POST /api/backtest', 1234567);
      expect(telemetry.getSlowRequestLastAlertAt('POST /api/backtest')).toBe(1234567);
    });

    test('未知路由的 lastAlertAt 为 0(即「从未告警过」)', () => {
      expect(telemetry.getSlowRequestLastAlertAt('GET /nope')).toBe(0);
    });
  });

  describe('持久化', () => {
    test('flush 后 slow_requests.json 落盘并可被新实例读回', () => {
      telemetry.trackSlowRequest(rec({ durationMs: 7777 }));
      telemetry.__flushSlowRequestForTest();

      const file = path.join(tmpDir, 'telemetry', 'slow_requests.json');
      expect(fs.existsSync(file)).toBe(true);
      const store = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(store.version).toBe(1);
      expect(store.routes['POST /api/backtest'].totalSlow).toBe(1);

      // 新实例(同一 KHY_DATA_HOME)应当读回已有聚合。
      jest.resetModules();
      const reloaded = require('../src/services/telemetryService');
      expect(reloaded.getSlowRequestSummary('POST /api/backtest').totalSlow).toBe(1);
      expect(reloaded.getSlowRequestSummary('POST /api/backtest').lastMs).toBe(7777);
    });
  });

  describe('agents 计数 —— 成功/失败不再恒为 0', () => {
    test('trackAgentRun 同时累加 spawned / succeeded / failed', () => {
      telemetry.trackAgentRun({ agent: 'a', success: true, elapsedMs: 10 });
      telemetry.trackAgentRun({ agent: 'b', success: false, elapsedMs: 20 });
      telemetry.trackAgentRun({ agent: 'c', success: true, elapsedMs: 30 });
      const unified = telemetry.getUnifiedStats();
      expect(unified.agents).toEqual({ spawned: 3, succeeded: 2, failed: 1 });
    });
  });

  describe('computeRollup —— audit.jsonl 里有两种记录形状', () => {
    // (a) auditLog.logToolExecution 写的是 { timestamp, tool, result, elapsed, permission }
    // (b) telemetryService.recordAuditEvent 写的是 { ts, event, ... }
    // 只读 entry.ts 会让 (a) 的时间戳变成 NaN —— NaN 同时通过上下界比较,
    // 于是每条工具记录都被误归到 byType['unknown'],而 tools 桶永远是空的。
    function writeAudit(lines) {
      const dir = path.join(tmpDir, 'telemetry');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(tmpDir, 'audit.jsonl');
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
      return file;
    }

    test('工具执行记录(timestamp + tool)进 tools 桶,而不是 byType.unknown', () => {
      const now = Date.now();
      writeAudit([
        { timestamp: new Date(now - 1000).toISOString(), tool: 'Read', elapsed: 12, result: { success: true } },
        { timestamp: new Date(now - 900).toISOString(), tool: 'Read', elapsed: 8, result: { success: true } },
        { timestamp: new Date(now - 800).toISOString(), tool: 'Bash', elapsed: 500, result: { success: false } },
        { timestamp: new Date(now - 700).toISOString(), tool: 'Bash', elapsed: 5, permission: 'deny', result: { success: false } },
      ]);

      const rollup = telemetry.computeRollup({ sinceMs: now - 60000 });

      expect(rollup.tools.Read).toMatchObject({ calls: 2, successes: 2, failures: 0, totalMs: 20 });
      expect(rollup.tools.Bash).toMatchObject({ calls: 2, successes: 0, failures: 2, denied: 1 });
      expect(rollup.tools.Bash.totalMs).toBe(505);
      expect(rollup.audit.byType.unknown || 0).toBe(0);
    });

    test('审计事件记录(ts + event)进 audit.byType,不污染 tools 桶', () => {
      const now = Date.now();
      writeAudit([
        { ts: new Date(now - 1000).toISOString(), event: 'login' },
        { ts: new Date(now - 900).toISOString(), event: 'login' },
        { ts: new Date(now - 800).toISOString(), event: 'config_change' },
      ]);

      const rollup = telemetry.computeRollup({ sinceMs: now - 60000 });

      expect(rollup.audit.events).toBe(3);
      expect(rollup.audit.byType.login).toBe(2);
      expect(rollup.audit.byType.config_change).toBe(1);
      expect(Object.keys(rollup.tools)).toHaveLength(0);
    });

    test('两种形状混在同一个文件里也各归各位', () => {
      const now = Date.now();
      writeAudit([
        { timestamp: new Date(now - 1000).toISOString(), tool: 'Grep', elapsed: 3, result: { success: true } },
        { ts: new Date(now - 900).toISOString(), event: 'login' },
        { timestamp: new Date(now - 800).toISOString(), tool: 'Grep', elapsed: 7, result: { success: true } },
      ]);

      const rollup = telemetry.computeRollup({ sinceMs: now - 60000 });

      expect(rollup.tools.Grep).toMatchObject({ calls: 2, successes: 2, totalMs: 10 });
      expect(rollup.audit.events).toBe(1);
      expect(rollup.audit.byType.login).toBe(1);
    });

    test('时间窗口之外的记录被排除', () => {
      const now = Date.now();
      writeAudit([
        { timestamp: new Date(now - 10 * 60000).toISOString(), tool: 'Old', elapsed: 1, result: { success: true } },
        { timestamp: new Date(now - 1000).toISOString(), tool: 'New', elapsed: 1, result: { success: true } },
      ]);

      const rollup = telemetry.computeRollup({ sinceMs: now - 60000 });

      expect(rollup.tools.New).toBeDefined();
      expect(rollup.tools.Old).toBeUndefined();
    });

    test('时间戳无法解析的记录被单独计数,不再冒充某个时间窗内的事件', () => {
      const now = Date.now();
      writeAudit([
        { tool: 'NoTimestamp', elapsed: 1, result: { success: true } },
        { ts: 'not-a-date', event: 'weird' },
        { timestamp: new Date(now - 1000).toISOString(), tool: 'Good', elapsed: 1, result: { success: true } },
      ]);

      const rollup = telemetry.computeRollup({ sinceMs: now - 60000 });

      expect(rollup.audit.unparsedTs).toBe(2);
      expect(rollup.tools.NoTimestamp).toBeUndefined();
      expect(rollup.tools.Good).toBeDefined();
    });

    test('rollup 里的 agents 计数来自真实的成功/失败,而不是恒 0', () => {
      telemetry.trackAgentRun({ agent: 'a', success: true, elapsedMs: 10 });
      telemetry.trackAgentRun({ agent: 'b', success: false, elapsedMs: 20 });
      const now = Date.now();
      const rollup = telemetry.computeRollup({ sinceMs: now - 60000 });
      expect(rollup.agents).toEqual({ spawned: 2, succeeded: 1, failed: 1 });
    });
  });
});
