'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('telemetryService app run latency', () => {
  const originalDataHome = process.env.KHY_DATA_HOME;

  afterEach(() => {
    process.env.KHY_DATA_HOME = originalDataHome;
    jest.resetModules();
  });

  test('computes p50/p95 from successful samples', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-telemetry-'));
    process.env.KHY_DATA_HOME = tmpDir;
    jest.resetModules();

    const telemetry = require('../src/services/telemetryService');
    for (let i = 1; i <= 10; i++) {
      telemetry.trackAppRunLatency({
        app: 'weather',
        abi: 'numeric-v1',
        exportName: 'main',
        elapsedMs: i * 10,
        success: true,
      });
    }

    const summary = telemetry.getAppRunLatencySummary('weather');
    expect(summary.successCount).toBe(10);
    expect(summary.failureCount).toBe(0);
    expect(summary.p50).toBe(50);
    expect(summary.p95).toBe(100);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('tracks failures separately and excludes them from percentile samples', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-telemetry-'));
    process.env.KHY_DATA_HOME = tmpDir;
    jest.resetModules();

    const telemetry = require('../src/services/telemetryService');
    telemetry.trackAppRunLatency({ app: 'weather', elapsedMs: 20, success: true });
    telemetry.trackAppRunLatency({ app: 'weather', elapsedMs: 40, success: true });
    telemetry.trackAppRunLatency({ app: 'weather', elapsedMs: 500, success: false });

    const summary = telemetry.getAppRunLatencySummary('weather');
    expect(summary.count).toBe(3);
    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.p50).toBe(20);
    expect(summary.p95).toBe(40);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

});
