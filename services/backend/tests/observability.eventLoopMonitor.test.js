'use strict';

/**
 * eventLoopMonitor 薄壳测试。
 *
 * 关键手法:直接注入一个假直方图到 _state,这样 _checkWindow 的告警/事件/
 * reset 逻辑可以在毫秒内被确定性地驱动,而不必真的等 30 秒的检查周期,
 * 也不必真的把事件循环卡住。
 */
describe('eventLoopMonitor 薄壳 — 事件循环延迟连续监测', () => {
  const originalEnv = { ...process.env };
  let monitor;

  const MS = 1e6; // 1ms = 1e6 ns

  function fakeHistogram(p99Ms, { p50Ms = 1, p95Ms = 2, maxMs = p99Ms } = {}) {
    return {
      resetCount: 0,
      enabled: true,
      min: 1 * MS,
      max: maxMs * MS,
      mean: p50Ms * MS,
      percentile(p) {
        if (p === 50) return p50Ms * MS;
        if (p === 95) return p95Ms * MS;
        if (p === 99) return p99Ms * MS;
        return 0;
      },
      reset() {
        this.resetCount += 1;
      },
      disable() {
        this.enabled = false;
      },
    };
  }

  function makeLogger() {
    const warns = [];
    const infos = [];
    return { warns, infos, warn: (m, meta) => warns.push({ m, meta }), info: (m) => infos.push(m) };
  }

  /** 把假直方图挂进已「运行中」的 monitor。 */
  function arm(hist, cfgOverrides = {}) {
    const profilerCore = require('../src/observability/profilerCore');
    monitor._state.histogram = hist;
    monitor._state.running = true;
    monitor._state.config = profilerCore.resolveConfig({
      KHY_PROFILING_ENABLED: '1',
      ...cfgOverrides,
    });
    monitor._state.windowStartedAt = Date.now() - 30000;
    monitor._state.alertCount = 0;
  }

  beforeEach(() => {
    jest.resetModules();
    monitor = require('../src/observability/eventLoopMonitor');
    monitor._resetForTest();
  });

  afterEach(() => {
    try {
      monitor._resetForTest();
    } catch {
      /* ignore */
    }
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe('F2 默认零开销', () => {
    test('未启用时 start() 返回 false,不创建直方图也不起定时器', () => {
      delete process.env.KHY_PROFILING_ENABLED;
      expect(monitor.start({ logger: makeLogger() })).toBe(false);
      expect(monitor.isRunning()).toBe(false);
      expect(monitor._state.histogram).toBeNull();
      expect(monitor._state.timer).toBeNull();
    });

    test('未运行时 snapshot() 返回 null,不抛', () => {
      expect(monitor.snapshot()).toBeNull();
    });

    test('stop() 幂等,未启动时调用也不抛', () => {
      expect(() => monitor.stop()).not.toThrow();
      expect(monitor.stop()).toBe(true);
    });
  });

  describe('启用后的生命周期', () => {
    test('start() 创建直方图 + unref 的定时器,并打印含参数的启动日志', () => {
      const logger = makeLogger();
      const started = monitor.start({
        logger,
        env: { KHY_PROFILING_ENABLED: '1', KHY_EVENTLOOP_CHECK_INTERVAL_MS: '60000' },
      });
      expect(started).toBe(true);
      expect(monitor.isRunning()).toBe(true);
      expect(monitor._state.histogram).toBeTruthy();
      expect(monitor._state.timer).toBeTruthy();
      // 规则 2:启动日志给出动作 + 参数,而不是一句「已启动」
      expect(logger.infos[0]).toContain('事件循环延迟监测已启动');
      expect(logger.infos[0]).toContain('告警阈值');
      monitor.stop();
      expect(monitor.isRunning()).toBe(false);
    });

    test('重复 start() 不会起第二个定时器', () => {
      const env = { KHY_PROFILING_ENABLED: '1' };
      expect(monitor.start({ env })).toBe(true);
      const firstTimer = monitor._state.timer;
      expect(monitor.start({ env })).toBe(false);
      expect(monitor._state.timer).toBe(firstTimer);
      monitor.stop();
    });

    test('运行中 snapshot() 返回毫秒摘要', () => {
      monitor.start({ env: { KHY_PROFILING_ENABLED: '1' } });
      const s = monitor.snapshot();
      expect(s).not.toBeNull();
      expect(typeof s.p99Ms).toBe('number');
      expect(typeof s.p50Ms).toBe('number');
      monitor.stop();
    });
  });

  describe('_checkWindow —— 越阈值才告警', () => {
    test('p99 低于阈值:不告警,但仍然 reset 直方图开启下一窗口', () => {
      const hist = fakeHistogram(50);
      arm(hist, { KHY_EVENTLOOP_LAG_THRESHOLD_MS: '200' });
      const logger = makeLogger();

      const result = monitor._checkWindow(logger);

      expect(logger.warns).toHaveLength(0);
      expect(hist.resetCount).toBe(1);
      expect(result.p99Ms).toBe(50);
      expect(monitor.lastSummary().p99Ms).toBe(50);
    });

    test('p99 越阈值:告警文案含 p99/阈值/窗口 + 「今日第 N 次」进度信号', () => {
      const hist = fakeHistogram(340, { p50Ms: 8 });
      arm(hist, { KHY_EVENTLOOP_LAG_THRESHOLD_MS: '200' });
      const logger = makeLogger();

      monitor._checkWindow(logger);

      expect(logger.warns).toHaveLength(1);
      const text = logger.warns[0].m;
      expect(text).toContain('事件循环阻塞');
      expect(text).toContain('p99 延迟 340ms');
      expect(text).toContain('超阈值 200ms');
      expect(text).toMatch(/今日第 1 次/);
      expect(logger.warns[0].meta).toMatchObject({ p99Ms: 340, thresholdMs: 200 });
    });

    test('连续越阈值时告警次数递增(规则 2 的进度信号)', () => {
      const hist = fakeHistogram(500);
      arm(hist, { KHY_EVENTLOOP_LAG_THRESHOLD_MS: '200' });
      const logger = makeLogger();

      monitor._checkWindow(logger);
      monitor._checkWindow(logger);
      monitor._checkWindow(logger);

      expect(logger.warns).toHaveLength(3);
      expect(logger.warns[0].m).toMatch(/今日第 1 次/);
      expect(logger.warns[2].m).toMatch(/今日第 3 次/);
      expect(hist.resetCount).toBe(3);
    });

    test('每个窗口结束都 reset —— 历史尖峰不会永久污染 max/p99', () => {
      const hist = fakeHistogram(900);
      arm(hist, { KHY_EVENTLOOP_LAG_THRESHOLD_MS: '200' });
      monitor._checkWindow(makeLogger());
      expect(hist.resetCount).toBe(1);
      // 尖峰过去后直方图读数回落,下一窗口就不该再告警。
      monitor._state.histogram = fakeHistogram(10);
      const logger = makeLogger();
      monitor._checkWindow(logger);
      expect(logger.warns).toHaveLength(0);
    });

    test('窗口结束后 windowStartedAt 推进', () => {
      const hist = fakeHistogram(10);
      arm(hist);
      const before = monitor._state.windowStartedAt;
      monitor._checkWindow(makeLogger());
      expect(monitor._state.windowStartedAt).toBeGreaterThan(before);
    });

    test('未运行时 _checkWindow 返回 null 而不是抛', () => {
      monitor._resetForTest();
      expect(monitor._checkWindow(makeLogger())).toBeNull();
    });

    test('logger 抛异常也不影响 reset 与摘要记录', () => {
      const hist = fakeHistogram(500);
      arm(hist, { KHY_EVENTLOOP_LAG_THRESHOLD_MS: '200' });
      const badLogger = {
        warn: () => {
          throw new Error('logger exploded');
        },
      };
      expect(() => monitor._checkWindow(badLogger)).not.toThrow();
      expect(hist.resetCount).toBe(1);
      expect(monitor.lastSummary().p99Ms).toBe(500);
    });
  });

  describe('事件日志', () => {
    test('越阈值时向 eventLog 追加 perf.eventloop_lag', () => {
      const eventLog = require('../src/observability/eventLog');
      const seen = [];
      const unsub = eventLog.subscribeAll((e) => seen.push(e));
      try {
        arm(fakeHistogram(400), { KHY_EVENTLOOP_LAG_THRESHOLD_MS: '200' });
        monitor._checkWindow(makeLogger());
      } finally {
        if (typeof unsub === 'function') unsub();
      }
      const lag = seen.filter((e) => e && e.type === 'perf.eventloop_lag');
      expect(lag).toHaveLength(1);
      expect(lag[0].payload).toMatchObject({ p99Ms: 400, thresholdMs: 200, alertCount: 1 });
    });

    test('未越阈值时不发事件(不制造噪声)', () => {
      const eventLog = require('../src/observability/eventLog');
      const seen = [];
      const unsub = eventLog.subscribeAll((e) => seen.push(e));
      try {
        arm(fakeHistogram(10), { KHY_EVENTLOOP_LAG_THRESHOLD_MS: '200' });
        monitor._checkWindow(makeLogger());
      } finally {
        if (typeof unsub === 'function') unsub();
      }
      expect(seen.filter((e) => e && e.type === 'perf.eventloop_lag')).toHaveLength(0);
    });
  });
});
