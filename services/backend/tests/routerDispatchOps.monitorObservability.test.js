'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * CLI 层测试:/monitor slow 与 /monitor profile。
 *
 * 这两条路径只做「读聚合 + 排版」,不该有任何写副作用,所以关注点是:
 * 未启用时给出可操作的提示而不是空白,有数据时把排行渲染出来,以及
 * profile capture 在未启用时绝不真的去开采样器。
 */
describe('routerDispatchOps —— /monitor slow 与 /monitor profile', () => {
  const originalEnv = { ...process.env };
  let tmpDir;
  let dispatch;
  let out;
  let logSpy;

  /** 极简 chalk 替身:所有着色函数都原样返回,方便断言纯文本。 */
  function makeChalk() {
    const id = (s) => String(s);
    const styles = ['cyan', 'gray', 'dim', 'green', 'yellow', 'red', 'bold', 'blue', 'magenta', 'white'];
    const build = () => {
      const fn = (s) => id(s);
      for (const k of styles) {
        Object.defineProperty(fn, k, { get: build, configurable: true });
      }
      return fn;
    };
    const root = build();
    for (const k of styles) {
      Object.defineProperty(root, k, { get: build, configurable: true });
    }
    return root;
  }

  function ctx(subCommand, args = []) {
    return {
      subCommand,
      args,
      options: {},
      rawCommandToken: '/monitor',
      parsed: {},
      context: {},
      printError: (m) => out.push(String(m)),
      printHelp: () => {},
      printInfo: (m) => out.push(String(m)),
      printTable: () => {},
      printSuccess: (m) => out.push(String(m)),
      printWarn: (m) => out.push(String(m)),
      withSpinner: async (_t, fn) => fn(),
      chalk: makeChalk(),
    };
  }

  const text = () => out.join('\n');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cli-obs-'));
    process.env.KHY_DATA_HOME = tmpDir;
    delete process.env.KHY_SLOW_REQUEST_ENABLED;
    delete process.env.KHY_PROFILING_ENABLED;
    jest.resetModules();
    dispatch = require('../src/cli/routerDispatchOps').dispatchOpsCommand;
    out = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...a) => out.push(a.join(' ')));
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = { ...originalEnv };
    jest.resetModules();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('/monitor slow', () => {
    test('未启用时说明现状并给出开启方法(而不是只说「无数据」)', async () => {
      expect(await dispatch('monitor', ctx('slow'))).toBe(true);
      expect(text()).toContain('慢请求排行');
      expect(text()).toContain('未启用');
      expect(text()).toContain('KHY_SLOW_REQUEST_ENABLED=1');
      expect(text()).toContain('暂无慢请求记录');
    });

    test('已启用时显示阈值、采样率、去抖与明细路径', async () => {
      process.env.KHY_SLOW_REQUEST_ENABLED = '1';
      process.env.KHY_SLOW_REQUEST_THRESHOLD_MS = '2500';
      expect(await dispatch('monitor', ctx('slow'))).toBe(true);
      expect(text()).toContain('已启用,阈值 2.5s');
      expect(text()).toContain('采样率:');
      expect(text()).toContain('告警去抖:');
      expect(text()).toMatch(/slow-\d{4}-\d{2}-\d{2}\.jsonl/);
    });

    test('有聚合数据时渲染排行,且按 p95 降序', async () => {
      process.env.KHY_SLOW_REQUEST_ENABLED = '1';
      const telemetry = require('../src/services/telemetryService');
      telemetry.reset();
      const row = (route, ms) => ({
        ts: new Date().toISOString(),
        day: require('../src/observability/slowRequestCore').dayKey(Date.now()),
        method: 'POST',
        path: route.split(' ')[1],
        route,
        durationMs: ms,
        thresholdMs: 3000,
        statusCode: '200',
      });
      telemetry.trackSlowRequest(row('POST /api/backtest', 8200));
      telemetry.trackSlowRequest(row('GET /api/health', 3100));

      expect(await dispatch('monitor', ctx('slow'))).toBe(true);
      const body = text();
      expect(body).toContain('POST /api/backtest');
      expect(body).toContain('8.2s');
      expect(body).toContain('GET /api/health');
      expect(body.indexOf('POST /api/backtest')).toBeLessThan(body.indexOf('GET /api/health'));
      expect(body).not.toContain('暂无慢请求记录');
    });
  });

  describe('/monitor profile', () => {
    test('list —— 没有 profile 时给出目录与空提示', async () => {
      expect(await dispatch('monitor', ctx('profile', ['list']))).toBe(true);
      expect(text()).toContain('已保存的 CPU profile');
      expect(text()).toContain('暂无 profile');
    });

    test('list —— 列出已落盘的 .cpuprofile 及大小', async () => {
      const cpuProfiler = require('../src/observability/cpuProfiler');
      const dir = cpuProfiler.getProfilesDir();
      fs.writeFileSync(path.join(dir, 'cpu-2026-08-16_10-00-00-cli.cpuprofile'), 'x'.repeat(2048));
      expect(await dispatch('monitor', ctx('profile', ['list']))).toBe(true);
      expect(text()).toContain('cpu-2026-08-16_10-00-00-cli.cpuprofile');
      expect(text()).toContain('2.0 KB');
    });

    test('lag —— 未启用时说明为什么没有数据', async () => {
      expect(await dispatch('monitor', ctx('profile', ['lag']))).toBe(true);
      expect(text()).toContain('事件循环延迟');
      expect(text()).toContain('KHY_PROFILING_ENABLED=1');
    });

    test('capture —— 未启用时直接拒绝,绝不真的开采样器', async () => {
      const cpuProfiler = require('../src/observability/cpuProfiler');
      const spy = jest.spyOn(cpuProfiler, 'captureProfile');
      expect(await dispatch('monitor', ctx('profile', ['capture']))).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(cpuProfiler.isActive()).toBe(false);
      expect(text()).toContain('KHY_PROFILING_ENABLED');
      spy.mockRestore();
    });

    test('capture —— 启用后真的采一次并落盘,文案含耗时与文件大小', async () => {
      process.env.KHY_PROFILING_ENABLED = '1';
      jest.resetModules();
      dispatch = require('../src/cli/routerDispatchOps').dispatchOpsCommand;
      const cpuProfiler = require('../src/observability/cpuProfiler');

      // 200ms 的短窗口:够验证「真的采到了」,又不至于拖慢测试。
      expect(await dispatch('monitor', ctx('profile', ['capture', '200']))).toBe(true);

      const body = text();
      expect(body).toContain('CPU 采样启动');
      expect(body).toContain(`pid ${process.pid}`);
      // F3:面向用户的结果文案必须点明数据不外传
      expect(body).toContain('不会外传');
      expect(cpuProfiler.isActive()).toBe(false);

      const files = fs.readdirSync(cpuProfiler.getProfilesDir());
      expect(files.filter((f) => f.endsWith('.cpuprofile'))).toHaveLength(1);
      // 与 MonitorTool 的 mon-*.log 命名彻底分开
      expect(files.every((f) => !f.startsWith('mon-'))).toBe(true);
    }, 20000);
  });
});
