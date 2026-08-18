'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 薄壳层测试:真实落盘到临时 KHY_DATA_HOME,验证四条副作用链路
 * (聚合 / 明细 JSONL / 事件日志 / 告警)以及「默认零开销」与「永不抛」两条契约。
 */
describe('slowRequest 薄壳 — 落地到 .khy/monitor/', () => {
  const originalDataHome = process.env.KHY_DATA_HOME;
  let tmpDir;
  let slowRequest;
  let core;
  let telemetry;

  const ENABLED_ENV = {
    KHY_SLOW_REQUEST_ENABLED: '1',
    KHY_SLOW_REQUEST_THRESHOLD_MS: '3000',
  };

  function makeLogger() {
    const warns = [];
    return {
      warns,
      warn: (msg, meta) => warns.push({ msg, meta }),
      info: () => {},
      error: () => {},
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-slowreq-'));
    process.env.KHY_DATA_HOME = tmpDir;
    jest.resetModules();
    core = require('../src/observability/slowRequestCore');
    slowRequest = require('../src/observability/slowRequest');
    telemetry = require('../src/services/telemetryService');
    slowRequest._resetForTest();
    telemetry.reset();
  });

  afterEach(() => {
    try {
      slowRequest._resetForTest();
    } catch {
      /* ignore */
    }
    process.env.KHY_DATA_HOME = originalDataHome;
    jest.resetModules();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function cfg(overrides = {}) {
    return core.resolveConfig({ ...ENABLED_ENV, ...overrides });
  }

  function readShard(day) {
    const file = slowRequest.shardPath(day);
    if (!file || !fs.existsSync(file)) {
      return [];
    }
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  describe('F2 默认零开销', () => {
    test('未启用时 record() 直接返回 null,不写任何文件', () => {
      const r = slowRequest.record({
        method: 'POST',
        path: '/api/backtest',
        durationMs: 99999,
        config: core.resolveConfig({}), // 默认 = 关闭
      });
      expect(r).toBeNull();
      expect(slowRequest._state.buffer).toHaveLength(0);
      const monitorDir = slowRequest.getMonitorDir();
      const files = monitorDir && fs.existsSync(monitorDir) ? fs.readdirSync(monitorDir) : [];
      expect(files.filter((f) => f.startsWith('slow-'))).toHaveLength(0);
    });

    test('启用但未越阈值 → 不记录', () => {
      expect(
        slowRequest.record({ method: 'GET', path: '/api/x', durationMs: 100, config: cfg() })
      ).toBeNull();
      expect(slowRequest._state.buffer).toHaveLength(0);
    });

    test('采样率为 0 时即使越阈值也不记录', () => {
      const r = slowRequest.record({
        method: 'GET',
        path: '/api/x',
        durationMs: 9000,
        config: cfg({ KHY_SLOW_REQUEST_SAMPLE_RATE: '0' }),
      });
      expect(r).toBeNull();
    });
  });

  describe('四条副作用链路', () => {
    test('聚合 → telemetryService,明细 → JSONL,告警 → logger.warn', () => {
      const logger = makeLogger();
      const now = new Date(2026, 7, 16, 10, 0, 0).getTime();
      const r = slowRequest.record({
        method: 'POST',
        path: '/api/backtest',
        durationMs: 8200,
        statusCode: 200,
        requestId: 'req-1',
        logger,
        config: cfg(),
        now,
      });

      // 1. 聚合
      expect(r).not.toBeNull();
      expect(r.recorded).toBe(true);
      expect(r.summary.route).toBe('POST /api/backtest');
      expect(r.summary.totalSlow).toBe(1);
      expect(r.summary.todayCount).toBe(1);
      expect(telemetry.getSlowRequestSummary('POST /api/backtest').totalSlow).toBe(1);

      // 2. 明细(缓冲 → 显式 flush → 落盘)
      expect(slowRequest._state.buffer).toHaveLength(1);
      expect(slowRequest.flush()).toBe(1);
      const rows = readShard(core.dayKey(now));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        method: 'POST',
        path: '/api/backtest',
        route: 'POST /api/backtest',
        durationMs: 8200,
        thresholdMs: 3000,
        statusCode: '200',
        requestId: 'req-1',
        todayCount: 1,
      });

      // 4. 告警
      expect(r.alerted).toBe(true);
      expect(logger.warns).toHaveLength(1);
      expect(logger.warns[0].msg).toContain('慢请求 POST /api/backtest');
      expect(logger.warns[0].msg).toContain('8.2s');
      expect(logger.warns[0].msg).toContain('今日第 1 次');
      expect(logger.warns[0].meta.route).toBe('POST /api/backtest');
    });

    test('事件日志收到 perf.slow_request', () => {
      const eventLog = require('../src/observability/eventLog');
      const seen = [];
      const unsub = eventLog.subscribeAll((e) => seen.push(e));
      try {
        slowRequest.record({
          method: 'POST',
          path: '/api/backtest',
          durationMs: 9000,
          statusCode: 500,
          traceId: 'trace-abc',
          logger: makeLogger(),
          config: cfg(),
        });
      } finally {
        if (typeof unsub === 'function') unsub();
      }

      const slowEvents = seen.filter((e) => e && e.type === 'perf.slow_request');
      expect(slowEvents).toHaveLength(1);
      expect(slowEvents[0].payload).toMatchObject({
        method: 'POST',
        path: '/api/backtest',
        durationMs: 9000,
        thresholdMs: 3000,
        statusCode: '500',
        todayCount: 1,
      });
      expect(slowEvents[0].traceId).toBe('trace-abc');
    });
  });

  describe('告警去抖 —— 慢请求成批出现时不刷屏', () => {
    test('冷却窗口内只喊一次,但每条都进聚合与明细', () => {
      const logger = makeLogger();
      const base = new Date(2026, 7, 16, 10, 0, 0).getTime();
      const c = cfg({ KHY_SLOW_REQUEST_ALERT_COOLDOWN_MS: '60000' });
      for (let i = 0; i < 5; i++) {
        slowRequest.record({
          method: 'POST',
          path: '/api/backtest',
          durationMs: 8200,
          statusCode: 200,
          logger,
          config: c,
          now: base + i * 1000, // 5 秒内连打 5 条
        });
      }
      expect(logger.warns).toHaveLength(1); // 只喊一次
      expect(telemetry.getSlowRequestSummary('POST /api/backtest').totalSlow).toBe(5); // 但都记了
      expect(slowRequest._state.buffer).toHaveLength(5);
    });

    test('冷却窗口过后恢复告警,且计数继续累加', () => {
      const logger = makeLogger();
      const base = new Date(2026, 7, 16, 10, 0, 0).getTime();
      const c = cfg({ KHY_SLOW_REQUEST_ALERT_COOLDOWN_MS: '60000' });
      slowRequest.record({ method: 'POST', path: '/api/b', durationMs: 8200, logger, config: c, now: base });
      slowRequest.record({
        method: 'POST',
        path: '/api/b',
        durationMs: 8200,
        logger,
        config: c,
        now: base + 61000,
      });
      expect(logger.warns).toHaveLength(2);
      expect(logger.warns[1].msg).toContain('今日第 2 次');
    });

    test('不同路由各自独立去抖', () => {
      const logger = makeLogger();
      const now = new Date(2026, 7, 16, 10, 0, 0).getTime();
      const c = cfg({ KHY_SLOW_REQUEST_ALERT_COOLDOWN_MS: '60000' });
      slowRequest.record({ method: 'POST', path: '/api/a', durationMs: 8200, logger, config: c, now });
      slowRequest.record({ method: 'POST', path: '/api/b', durationMs: 8200, logger, config: c, now });
      expect(logger.warns).toHaveLength(2);
    });
  });

  describe('明细写盘', () => {
    test('缓冲到阈值自动 flush', () => {
      const c = cfg({ KHY_SLOW_REQUEST_ALERT_COOLDOWN_MS: '999999' });
      const now = new Date(2026, 7, 16, 10, 0, 0).getTime();
      for (let i = 0; i < slowRequest.FLUSH_RECORD_THRESHOLD; i++) {
        slowRequest.record({ method: 'GET', path: '/api/x', durationMs: 5000, config: c, now });
      }
      expect(slowRequest._state.buffer).toHaveLength(0); // 已自动冲刷
      expect(readShard(core.dayKey(now))).toHaveLength(slowRequest.FLUSH_RECORD_THRESHOLD);
    });

    test('跨日的记录分别写进各自的日分片', () => {
      const c = cfg({ KHY_SLOW_REQUEST_ALERT_COOLDOWN_MS: '0' });
      const d1 = new Date(2026, 7, 15, 10, 0, 0).getTime();
      const d2 = new Date(2026, 7, 16, 10, 0, 0).getTime();
      slowRequest.record({ method: 'GET', path: '/api/x', durationMs: 5000, config: c, now: d1 });
      slowRequest.record({ method: 'GET', path: '/api/x', durationMs: 5000, config: c, now: d2 });
      slowRequest.flush();
      expect(readShard('2026-08-15')).toHaveLength(1);
      expect(readShard('2026-08-16')).toHaveLength(1);
    });

    test('flush 空缓冲返回 0,不创建文件', () => {
      expect(slowRequest.flush()).toBe(0);
    });
  });

  describe('pruneShards —— 绝不误删 MonitorTool 的文件', () => {
    test('只删超期的 slow-*.jsonl,mon-*.log 与 profiles/ 原封不动', () => {
      const dir = slowRequest.getMonitorDir();
      expect(dir).toBeTruthy();
      fs.writeFileSync(path.join(dir, 'slow-2026-08-16.jsonl'), '{}\n');
      fs.writeFileSync(path.join(dir, 'slow-2026-01-01.jsonl'), '{}\n');
      fs.writeFileSync(path.join(dir, 'mon-task-42.log'), 'monitor tool output\n');
      fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'profiles', 'cpu-x.cpuprofile'), '{}');

      slowRequest._state.prunedDay = ''; // 允许本次清理
      const removed = slowRequest.pruneShards('2026-08-16', 7);

      expect(removed).toEqual(['slow-2026-01-01.jsonl']);
      expect(fs.existsSync(path.join(dir, 'slow-2026-08-16.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'mon-task-42.log'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'profiles', 'cpu-x.cpuprofile'))).toBe(true);
    });

    test('同一天内每个进程只清理一次', () => {
      slowRequest._state.prunedDay = '';
      slowRequest.pruneShards('2026-08-16', 7);
      const dir = slowRequest.getMonitorDir();
      fs.writeFileSync(path.join(dir, 'slow-2026-01-01.jsonl'), '{}\n');
      expect(slowRequest.pruneShards('2026-08-16', 7)).toEqual([]); // 当天已跑过
      expect(fs.existsSync(path.join(dir, 'slow-2026-01-01.jsonl'))).toBe(true);
    });
  });

  describe('契约:record() 永不抛异常', () => {
    test('logger 抛异常也不会冒泡到业务请求', () => {
      const badLogger = {
        warn: () => {
          throw new Error('logger exploded');
        },
      };
      expect(() =>
        slowRequest.record({
          method: 'GET',
          path: '/api/x',
          durationMs: 9000,
          logger: badLogger,
          config: cfg(),
        })
      ).not.toThrow();
    });

    test('参数全缺失也不抛', () => {
      expect(() => slowRequest.record()).not.toThrow();
      expect(() => slowRequest.record({})).not.toThrow();
    });
  });
});
