'use strict';

const core = require('../src/observability/slowRequestCore');

describe('slowRequestCore — 纯叶子(zero-IO, 确定性)', () => {
  describe('resolveConfig', () => {
    test('默认关闭,阈值取 serviceDefaults 的 3000ms', () => {
      const cfg = core.resolveConfig({});
      expect(cfg.enabled).toBe(false);
      expect(cfg.thresholdMs).toBe(3000);
      expect(cfg.sampleRate).toBe(1);
      expect(cfg.retentionDays).toBe(7);
    });

    test('env 覆盖生效,且 env 是注入的(不读 process.env)', () => {
      const cfg = core.resolveConfig({
        KHY_SLOW_REQUEST_ENABLED: '1',
        KHY_SLOW_REQUEST_THRESHOLD_MS: '500',
        KHY_SLOW_REQUEST_SAMPLE_RATE: '0.25',
        KHY_SLOW_REQUEST_RETENTION_DAYS: '3',
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.thresholdMs).toBe(500);
      expect(cfg.sampleRate).toBe(0.25);
      expect(cfg.retentionDays).toBe(3);
    });

    test('非法值退回默认,采样率夹到 [0,1],阈值不小于 1', () => {
      const cfg = core.resolveConfig({
        KHY_SLOW_REQUEST_THRESHOLD_MS: 'abc',
        KHY_SLOW_REQUEST_SAMPLE_RATE: '7',
        KHY_SLOW_REQUEST_MAX_ROUTES: '0',
      });
      expect(cfg.thresholdMs).toBe(3000);
      expect(cfg.sampleRate).toBe(1);
      expect(cfg.maxRoutes).toBe(1);

      expect(core.resolveConfig({ KHY_SLOW_REQUEST_SAMPLE_RATE: '-1' }).sampleRate).toBe(0);
      expect(core.resolveConfig({ KHY_SLOW_REQUEST_THRESHOLD_MS: '0' }).thresholdMs).toBe(1);
    });

    test('KHY_SLOW_REQUEST_ENABLED 认 0/false/off/no 为关', () => {
      for (const v of ['0', 'false', 'off', 'no', 'FALSE']) {
        expect(core.resolveConfig({ KHY_SLOW_REQUEST_ENABLED: v }).enabled).toBe(false);
      }
      for (const v of ['1', 'true', 'on', 'yes', 'ON']) {
        expect(core.resolveConfig({ KHY_SLOW_REQUEST_ENABLED: v }).enabled).toBe(true);
      }
    });
  });

  describe('isSlow', () => {
    test('阈值本身算慢(>=),低于阈值不算', () => {
      expect(core.isSlow(3000, 3000)).toBe(true);
      expect(core.isSlow(3001, 3000)).toBe(true);
      expect(core.isSlow(2999, 3000)).toBe(false);
    });

    test('非数值一律不算慢(可观测性不能因脏数据误报)', () => {
      expect(core.isSlow(NaN, 3000)).toBe(false);
      expect(core.isSlow(undefined, 3000)).toBe(false);
      expect(core.isSlow(5000, NaN)).toBe(false);
    });
  });

  describe('shouldSample — 确定性 token-bucket,不用 Math.random', () => {
    test('rate=1 每次都采', () => {
      const state = { acc: 0 };
      for (let i = 0; i < 10; i++) {
        expect(core.shouldSample(1, state)).toBe(true);
      }
    });

    test('rate=0 一次都不采', () => {
      const state = { acc: 0 };
      expect(core.shouldSample(0, state)).toBe(false);
      expect(core.shouldSample(0, state)).toBe(false);
    });

    test('rate=0.25 → 每 4 次恰好采 1 次(可复现)', () => {
      const state = { acc: 0 };
      const hits = [];
      for (let i = 0; i < 12; i++) {
        hits.push(core.shouldSample(0.25, state));
      }
      expect(hits.filter(Boolean).length).toBe(3);
      // 同一初始 state 重放得到同样的序列 —— 这正是不用随机数的意义。
      const replay = { acc: 0 };
      const again = [];
      for (let i = 0; i < 12; i++) {
        again.push(core.shouldSample(0.25, replay));
      }
      expect(again).toEqual(hits);
    });
  });

  describe('dayKey — 本地日(刻意不同于 eventLog 的 UTC 分片)', () => {
    test('返回本地时区的 YYYY-MM-DD', () => {
      const d = new Date(2026, 7, 16, 3, 30, 0); // 本地 2026-08-16 03:30
      expect(core.dayKey(d.getTime())).toBe('2026-08-16');
    });

    test('用本地日历字段,与 toISOString 的 UTC 切片解耦', () => {
      const d = new Date(2026, 0, 1, 0, 30, 0); // 本地元旦凌晨
      expect(core.dayKey(d.getTime())).toBe('2026-01-01');
    });
  });

  describe('buildRouteKey / selectRouteKey', () => {
    test('路由键 = 大写 METHOD + 空格 + 归一化路径', () => {
      expect(core.buildRouteKey('post', '/api/backtest/#path')).toBe('POST /api/backtest/#path');
      expect(core.buildRouteKey(null, null)).toBe('GET /');
    });

    test('已知路由原样返回', () => {
      const known = new Set(['GET /a', 'GET /b']);
      expect(core.selectRouteKey('GET /a', known, 2)).toBe('GET /a');
    });

    test('基数封顶后新路由落入 _other', () => {
      const known = new Set(['GET /a', 'GET /b']);
      expect(core.selectRouteKey('GET /c', known, 2)).toBe(core.OVERFLOW_ROUTE);
      expect(core.selectRouteKey('GET /c', known, 3)).toBe('GET /c');
    });
  });

  describe('buildRecord', () => {
    test('组装完整明细行,字段全部规整', () => {
      const now = new Date(2026, 7, 16, 10, 0, 0).getTime();
      const rec = core.buildRecord({
        now,
        method: 'post',
        path: '/api/backtest',
        durationMs: 8200.7,
        thresholdMs: 3000,
        statusCode: 200,
        requestId: 'req-1',
        traceId: 'trace-1',
      });
      expect(rec.method).toBe('POST');
      expect(rec.route).toBe('POST /api/backtest');
      expect(rec.durationMs).toBe(8201);
      expect(rec.statusCode).toBe('200');
      expect(rec.day).toBe('2026-08-16');
      expect(typeof rec.ts).toBe('string');
    });

    test('负数/超过一天的耗时被夹住(脏数据不能撑爆聚合)', () => {
      expect(core.buildRecord({ durationMs: -5 }).durationMs).toBe(0);
      expect(core.buildRecord({ durationMs: core.DAY_MS * 3 }).durationMs).toBe(core.DAY_MS);
    });
  });

  describe('mergeSummary', () => {
    test('累加 totalSlow 与 todayCount,记录 lastMs/maxMs', () => {
      const rec = core.emptyRouteRecord();
      core.mergeSummary(rec, { day: '2026-08-16', durationMs: 5000, ts: 't1', statusCode: '200' }, 256);
      core.mergeSummary(rec, { day: '2026-08-16', durationMs: 3000, ts: 't2', statusCode: '500' }, 256);
      expect(rec.totalSlow).toBe(2);
      expect(rec.todayCount).toBe(2);
      expect(rec.lastMs).toBe(3000);
      expect(rec.maxMs).toBe(5000);
      expect(rec.lastStatus).toBe('500');
    });

    test('跨日自动重置 todayCount,但 totalSlow 累计不断', () => {
      const rec = core.emptyRouteRecord();
      core.mergeSummary(rec, { day: '2026-08-15', durationMs: 4000 }, 256);
      core.mergeSummary(rec, { day: '2026-08-15', durationMs: 4000 }, 256);
      expect(rec.todayCount).toBe(2);
      core.mergeSummary(rec, { day: '2026-08-16', durationMs: 4000 }, 256);
      expect(rec.todayCount).toBe(1);
      expect(rec.totalSlow).toBe(3);
    });

    test('样本环有界,超出从头丢弃', () => {
      const rec = core.emptyRouteRecord();
      for (let i = 1; i <= 10; i++) {
        core.mergeSummary(rec, { day: 'd', durationMs: i * 100 }, 4);
      }
      expect(rec.samplesMs).toHaveLength(4);
      expect(rec.samplesMs).toEqual([700, 800, 900, 1000]);
      // maxMs 是历史最大值,不受样本环淘汰影响。
      expect(rec.maxMs).toBe(1000);
    });

    test('省略 maxSamples 时退回 SSOT 默认值,而不是塌缩成 1', () => {
      // 回归:早期实现是 `Number(undefined) || 1` → cap=1,样本环只剩最后一条,
      // p50/p95 全都退化成「最后一次的耗时」,而 totalSlow 看上去仍然正常 ——
      // 这种故障没有任何表面症状,只能靠这条测试守住。
      const rec = core.emptyRouteRecord();
      for (const ms of [4000, 5000, 6000, 12000]) {
        core.mergeSummary(rec, { day: 'd', durationMs: ms });
      }
      expect(rec.samplesMs).toEqual([4000, 5000, 6000, 12000]);
      expect(core.summarizeRoute('r', rec).p50).toBe(5000);
    });

    test('非法 maxSamples(0 / 负数 / NaN)同样退回默认值', () => {
      for (const bad of [0, -5, NaN, 'abc', null]) {
        const rec = core.emptyRouteRecord();
        core.mergeSummary(rec, { day: 'd', durationMs: 1000 }, bad);
        core.mergeSummary(rec, { day: 'd', durationMs: 2000 }, bad);
        expect(rec.samplesMs).toEqual([1000, 2000]);
      }
    });
  });

  describe('percentileNearestRank / summarizeRoute', () => {
    test('nearest-rank 分位', () => {
      const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      expect(core.percentileNearestRank(v, 50)).toBe(50);
      expect(core.percentileNearestRank(v, 95)).toBe(100);
      expect(core.percentileNearestRank([], 95)).toBe(0);
    });

    test('summarizeRoute 输出只读摘要', () => {
      const rec = core.emptyRouteRecord();
      for (const ms of [1000, 2000, 3000, 9000]) {
        core.mergeSummary(rec, { day: '2026-08-16', durationMs: ms, ts: 'x', statusCode: '200' }, 256);
      }
      const s = core.summarizeRoute('POST /api/backtest', rec);
      expect(s.route).toBe('POST /api/backtest');
      expect(s.totalSlow).toBe(4);
      expect(s.sampleCount).toBe(4);
      expect(s.p50).toBe(2000);
      expect(s.p95).toBe(9000);
      expect(s.maxMs).toBe(9000);
    });
  });

  describe('shouldAlert — 按路由去抖', () => {
    test('从未告警过 → 立即告警', () => {
      expect(core.shouldAlert(0, 1000, 60000)).toBe(true);
      expect(core.shouldAlert(null, 1000, 60000)).toBe(true);
    });

    test('冷却窗口内不重复告警,窗口外恢复', () => {
      expect(core.shouldAlert(1000, 30000, 60000)).toBe(false);
      expect(core.shouldAlert(1000, 61000, 60000)).toBe(true);
    });

    test('cooldown=0 → 每条都告警', () => {
      expect(core.shouldAlert(1000, 1001, 0)).toBe(true);
    });
  });

  describe('formatDuration / formatAlert — 规则 2「动作 + 目标 + 进度」', () => {
    test('秒级保留一位小数,毫秒级取整', () => {
      expect(core.formatDuration(8200)).toBe('8.2s');
      expect(core.formatDuration(850)).toBe('850ms');
      expect(core.formatDuration(3000)).toBe('3.0s');
    });

    test('告警文案含动作、目标与进度三要素', () => {
      const text = core.formatAlert({
        method: 'POST',
        path: '/api/backtest',
        durationMs: 8200,
        thresholdMs: 3000,
        todayCount: 4,
        statusCode: 200,
      });
      expect(text).toContain('慢请求'); // 动作
      expect(text).toContain('POST /api/backtest'); // 目标
      expect(text).toContain('8.2s'); // 进度:实际耗时
      expect(text).toContain('超阈值 3.0s'); // 进度:阈值
      expect(text).toMatch(/今日第 4 次/); // 进度:规则 2 认可的「第 n 次」信号
      expect(text).toContain('状态码 200');
    });

    test('没有状态码时不留空尾巴', () => {
      const text = core.formatAlert({ method: 'GET', path: '/x', durationMs: 4000, thresholdMs: 3000 });
      expect(text).not.toContain('状态码');
      expect(text).toMatch(/今日第 1 次$/);
    });
  });

  describe('分片文件名与保留期', () => {
    test('shardFileName / parseShardDay 往返', () => {
      expect(core.shardFileName('2026-08-16')).toBe('slow-2026-08-16.jsonl');
      expect(core.parseShardDay('slow-2026-08-16.jsonl')).toBe('2026-08-16');
    });

    test('只认严格格式,MonitorTool 的 mon-*.log 一律不匹配', () => {
      expect(core.parseShardDay('mon-task123.log')).toBeNull();
      expect(core.parseShardDay('slow-2026-8-16.jsonl')).toBeNull();
      expect(core.parseShardDay('slow-2026-08-16.jsonl.bak')).toBeNull();
      expect(core.parseShardDay('profiles')).toBeNull();
    });

    test('expiredShards 只返回超期的 slow-*.jsonl', () => {
      const names = [
        'slow-2026-08-16.jsonl',
        'slow-2026-08-15.jsonl',
        'slow-2026-08-10.jsonl', // 保留期含今天 → 7 天窗口是 08-10..08-16,恰好卡在边界内
        'slow-2026-08-09.jsonl',
        'slow-2026-08-01.jsonl',
        'mon-abc.log', // MonitorTool 的地盘
        'profiles',
      ];
      const expired = core.expiredShards(names, '2026-08-16', 7);
      expect(expired).toEqual(['slow-2026-08-01.jsonl', 'slow-2026-08-09.jsonl']);
      expect(expired).not.toContain('slow-2026-08-10.jsonl');
      expect(expired).not.toContain('mon-abc.log');
    });

    test('retentionDays 含今天:保留 1 天时只留今日分片', () => {
      const names = ['slow-2026-08-16.jsonl', 'slow-2026-08-15.jsonl'];
      expect(core.expiredShards(names, '2026-08-16', 1)).toEqual(['slow-2026-08-15.jsonl']);
    });

    test('非法 todayKey 不删任何文件(宁可不清理,不可误删)', () => {
      expect(core.expiredShards(['slow-2026-08-01.jsonl'], 'not-a-day', 7)).toEqual([]);
    });
  });
});
