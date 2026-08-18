'use strict';

const core = require('../src/observability/profilerCore');

/** 造一个假的 monitorEventLoopDelay 直方图(读数单位是纳秒)。 */
function fakeHistogram({ min, max, mean, p50, p95, p99 }) {
  return {
    min,
    max,
    mean,
    percentile(p) {
      if (p === 50) return p50;
      if (p === 95) return p95;
      if (p === 99) return p99;
      return 0;
    },
  };
}

const MS = 1e6; // 1ms = 1e6 ns

describe('profilerCore — 纯叶子(zero-IO, 确定性)', () => {
  describe('resolveConfig', () => {
    test('默认关闭,默认窗口 10s、采样间隔 1000μs', () => {
      const cfg = core.resolveConfig({});
      expect(cfg.enabled).toBe(false);
      expect(cfg.durationMs).toBe(10000);
      expect(cfg.maxDurationMs).toBe(120000);
      expect(cfg.sampleIntervalUs).toBe(1000);
      expect(cfg.resolutionMs).toBe(20);
      expect(cfg.checkIntervalMs).toBe(30000);
      expect(cfg.lagThresholdMs).toBe(200);
    });

    test('env 覆盖生效(env 注入,不读 process.env)', () => {
      const cfg = core.resolveConfig({
        KHY_PROFILING_ENABLED: 'true',
        KHY_PROFILING_DURATION_MS: '5000',
        KHY_EVENTLOOP_LAG_THRESHOLD_MS: '50',
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.durationMs).toBe(5000);
      expect(cfg.lagThresholdMs).toBe(50);
    });

    test('默认时长不会超过上限', () => {
      const cfg = core.resolveConfig({
        KHY_PROFILING_DURATION_MS: '999999',
        KHY_PROFILING_MAX_DURATION_MS: '20000',
      });
      expect(cfg.durationMs).toBe(20000);
    });

    test('检查周期有下限,避免配出高频空转', () => {
      expect(core.resolveConfig({ KHY_EVENTLOOP_CHECK_INTERVAL_MS: '1' }).checkIntervalMs).toBe(1000);
    });
  });

  describe('clampDuration', () => {
    const cfg = core.resolveConfig({ KHY_PROFILING_MAX_DURATION_MS: '60000' });

    test('合法值原样(取整)', () => {
      expect(core.clampDuration(5000, cfg)).toBe(5000);
      expect(core.clampDuration(5000.6, cfg)).toBe(5001);
    });

    test('超上限夹到 max,低于 100ms 抬到 100ms', () => {
      expect(core.clampDuration(999999, cfg)).toBe(60000);
      expect(core.clampDuration(10, cfg)).toBe(100);
    });

    test('非法/缺省退回配置默认时长', () => {
      expect(core.clampDuration(undefined, cfg)).toBe(cfg.durationMs);
      expect(core.clampDuration(NaN, cfg)).toBe(cfg.durationMs);
      expect(core.clampDuration(-1, cfg)).toBe(cfg.durationMs);
    });
  });

  describe('timestampSlug / buildProfileId', () => {
    test('时间戳片段不含冒号与点(Windows 文件名安全)', () => {
      const slug = core.timestampSlug(Date.UTC(2026, 7, 16, 10, 0, 0));
      expect(slug).not.toMatch(/[:.]/);
      expect(slug).toBe('2026-08-16T10-00-00-000Z');
    });

    test('profile id 用 cpu- 前缀,刻意避开 MonitorTool 的 mon-*', () => {
      const id = core.buildProfileId(Date.UTC(2026, 7, 16));
      expect(id.startsWith('cpu-')).toBe(true);
      expect(id.startsWith('mon-')).toBe(false);
    });
  });

  describe('buildProfileMeta', () => {
    test('组装完整元数据,缺省字段安全归零', () => {
      const meta = core.buildProfileMeta({
        now: Date.UTC(2026, 7, 16, 10, 0, 0),
        profileId: 'cpu-x',
        trigger: 'cli',
        requestedDurationMs: 10000,
        elapsedMs: 10042,
        sampleIntervalUs: 1000,
        sampleCount: 9876,
        nodeCount: 543,
        pid: 4242,
        nodeVersion: 'v24.0.0',
        uptimeSeconds: 120.5,
        memoryUsage: { heapUsed: 50 * 1024 * 1024 },
        cpuUsage: { user: 1000, system: 200 },
      });
      expect(meta.profileId).toBe('cpu-x');
      expect(meta.trigger).toBe('cli');
      expect(meta.elapsedMs).toBe(10042);
      expect(meta.memoryUsage.heapUsed).toBe(50 * 1024 * 1024);
      expect(meta.memoryUsage.rss).toBe(0);
      expect(meta.cpuUsage.userUs).toBe(1000);
      expect(meta.timestamp).toBe('2026-08-16T10:00:00.000Z');
    });

    test('全空输入也不抛,产出结构完整的对象', () => {
      const meta = core.buildProfileMeta();
      expect(meta.profileId).toBe('');
      expect(meta.trigger).toBe('manual');
      expect(meta.memoryUsage).toEqual({ heapUsed: 0, heapTotal: 0, external: 0, rss: 0 });
    });
  });

  describe('summarizeProfile', () => {
    test('数出节点数与样本数', () => {
      expect(core.summarizeProfile({ nodes: [1, 2, 3], samples: [1, 1, 2] })).toEqual({
        nodeCount: 3,
        sampleCount: 3,
      });
    });

    test('残缺 profile 归零而非抛异常', () => {
      expect(core.summarizeProfile(null)).toEqual({ nodeCount: 0, sampleCount: 0 });
      expect(core.summarizeProfile({})).toEqual({ nodeCount: 0, sampleCount: 0 });
    });
  });

  describe('summarizeLag — 纳秒 → 毫秒', () => {
    test('直方图读数按 1e6 换算并保留两位小数', () => {
      const s = core.summarizeLag(
        fakeHistogram({ min: 1 * MS, max: 340 * MS, mean: 12.345 * MS, p50: 8 * MS, p95: 120 * MS, p99: 340 * MS })
      );
      expect(s.minMs).toBe(1);
      expect(s.maxMs).toBe(340);
      expect(s.meanMs).toBe(12.35);
      expect(s.p50Ms).toBe(8);
      expect(s.p95Ms).toBe(120);
      expect(s.p99Ms).toBe(340);
    });

    test('无直方图 → 全零摘要(不抛)', () => {
      expect(core.summarizeLag(null)).toEqual({
        minMs: 0,
        maxMs: 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
      });
    });

    test('直方图未记录任何样本时的哨兵值不会变成负数或 Infinity', () => {
      const s = core.summarizeLag(
        fakeHistogram({ min: Infinity, max: 0, mean: NaN, p50: 0, p95: 0, p99: 0 })
      );
      expect(s.minMs).toBe(0);
      expect(s.meanMs).toBe(0);
      expect(Number.isFinite(s.minMs)).toBe(true);
    });
  });

  describe('isLagOverThreshold — 用 p99,不用均值', () => {
    test('p99 达到阈值即告警', () => {
      expect(core.isLagOverThreshold({ p99Ms: 200 }, 200)).toBe(true);
      expect(core.isLagOverThreshold({ p99Ms: 201 }, 200)).toBe(true);
      expect(core.isLagOverThreshold({ p99Ms: 199 }, 200)).toBe(false);
    });

    test('均值很低但 p99 很高仍然告警(偶发长阻塞不能被抹平)', () => {
      expect(core.isLagOverThreshold({ meanMs: 3, p50Ms: 2, p99Ms: 900 }, 200)).toBe(true);
    });

    test('脏数据不误报', () => {
      expect(core.isLagOverThreshold({}, 200)).toBe(false);
      expect(core.isLagOverThreshold(null, 200)).toBe(false);
    });
  });

  describe('文案 — 规则 2「动作 + 目标 + 进度」', () => {
    test('formatLagAlert 含动作、指标与窗口', () => {
      const text = core.formatLagAlert({ p99Ms: 340, p50Ms: 8 }, 200, 30000);
      expect(text).toContain('事件循环阻塞'); // 动作
      expect(text).toContain('p99 延迟 340ms'); // 进度:实测
      expect(text).toContain('超阈值 200ms'); // 进度:阈值
      expect(text).toContain('采样窗口 30s'); // 进度:窗口
    });

    test('formatResult 给出两个文件路径与打开方式', () => {
      const text = core.formatResult({
        profilePath: 'C:\\x\\cpu-1.cpuprofile',
        metaPath: 'C:\\x\\cpu-1.json',
        meta: {
          sampleCount: 9876,
          nodeCount: 543,
          elapsedMs: 10042,
          sampleIntervalUs: 1000,
          memoryUsage: { heapUsed: 52428800 },
        },
      });
      expect(text).toContain('cpu-1.cpuprofile');
      expect(text).toContain('cpu-1.json');
      expect(text).toContain('9876');
      expect(text).toContain('10.0s');
      expect(text).toContain('50.0 MB');
      expect(text).toContain('不会外传'); // F3 隐私红线在文案里明示
    });

    test('formatDisabled 告诉用户开关在哪,而不是干巴巴一句「未启用」', () => {
      const text = core.formatDisabled();
      expect(text).toContain('KHY_PROFILING_ENABLED');
      expect(text).toContain('serviceDefaults.js');
    });

    test('formatError 带上原因', () => {
      expect(core.formatError('boom')).toContain('boom');
      expect(core.formatError(null)).toContain('unknown error');
    });
  });
});
