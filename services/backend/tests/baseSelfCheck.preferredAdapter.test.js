'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('base self-check preferred adapter validation', () => {
  let tmpDir;
  let envPath;
  let oldEnvFile;
  let oldSyncRoot;
  let oldPreferredAdapter;
  let oldAutoRepair;
  let oldThreatEvery;
  let oldDoctorEvery;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-selfcheck-'));
    envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, 'GATEWAY_PREFERRED_ADAPTER=codex\nGATEWAY_PREFERRED_MODEL=gpt-4o\n', 'utf-8');

    oldEnvFile = process.env.KHY_ENV_FILE;
    oldSyncRoot = process.env.KHY_ENV_SYNC_ROOT;
    oldPreferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
    oldAutoRepair = process.env.KHY_SELF_CHECK_AUTO_REPAIR_PREFERRED;
    oldThreatEvery = process.env.KHY_SELF_CHECK_THREAT_SCAN_EVERY;
    oldDoctorEvery = process.env.KHY_SELF_CHECK_PLUGIN_DOCTOR_EVERY;

    process.env.KHY_ENV_FILE = envPath;
    process.env.KHY_ENV_SYNC_ROOT = 'false';
    process.env.KHY_SELF_CHECK_THREAT_SCAN_EVERY = '999999';
    process.env.KHY_SELF_CHECK_PLUGIN_DOCTOR_EVERY = '999999';
  });

  afterEach(() => {
    if (oldEnvFile === undefined) delete process.env.KHY_ENV_FILE;
    else process.env.KHY_ENV_FILE = oldEnvFile;
    if (oldSyncRoot === undefined) delete process.env.KHY_ENV_SYNC_ROOT;
    else process.env.KHY_ENV_SYNC_ROOT = oldSyncRoot;
    if (oldPreferredAdapter === undefined) delete process.env.GATEWAY_PREFERRED_ADAPTER;
    else process.env.GATEWAY_PREFERRED_ADAPTER = oldPreferredAdapter;
    if (oldAutoRepair === undefined) delete process.env.KHY_SELF_CHECK_AUTO_REPAIR_PREFERRED;
    else process.env.KHY_SELF_CHECK_AUTO_REPAIR_PREFERRED = oldAutoRepair;
    if (oldThreatEvery === undefined) delete process.env.KHY_SELF_CHECK_THREAT_SCAN_EVERY;
    else process.env.KHY_SELF_CHECK_THREAT_SCAN_EVERY = oldThreatEvery;
    if (oldDoctorEvery === undefined) delete process.env.KHY_SELF_CHECK_PLUGIN_DOCTOR_EVERY;
    else process.env.KHY_SELF_CHECK_PLUGIN_DOCTOR_EVERY = oldDoctorEvery;

    jest.resetModules();
    jest.restoreAllMocks();

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function mockCommonServices() {
    jest.doMock('../src/services/resourceGuard', () => ({
      systemHealthCheck: () => ({
        healthy: true,
        memPercent: 12,
        loadPercent: 8,
        warnings: [],
      }),
      withTimeout: async (promise) => await promise,
    }));

    jest.doMock('../src/services/securityGuardService', () => ({
      checkProcessIntegrity: () => ({ clean: true, suspicious: [], childCount: 0 }),
      scanForThreats: () => ({ clean: true, threats: [] }),
    }));

    jest.doMock('../src/services/serviceRegistry', () => ({
      healthCheck: async () => ([
        { name: 'aiGateway', healthy: true, latency: 2 },
      ]),
    }));

    jest.doMock('../src/plugin-loader', () => ({
      getAllPlugins: () => [],
      discoverPlugins: () => [],
    }));
  }

  test('detects invalid preferred adapter and auto-repairs to available adapter', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = '__missing__';
    process.env.KHY_SELF_CHECK_AUTO_REPAIR_PREFERRED = 'true';

    mockCommonServices();
    const refreshAdapters = jest.fn(async () => {});
    jest.doMock('../src/services/gateway/aiGateway', () => ({
      _initialized: true,
      init: jest.fn(async () => {}),
      refreshAdapters,
      getStatus: () => ([
        { type: 'relay_api', enabled: true, available: true, detail: 'ok' },
      ]),
    }));

    const selfCheck = require('../src/services/baseSelfCheckService');
    const report = await selfCheck.runOnce({
      trigger: 'test',
      forceThreatScan: false,
      forcePluginDoctor: false,
    });

    expect(report.issues.some(i => String(i.message).includes('已自动修复为: relay_api'))).toBe(true);
    expect(Array.isArray(report.repairs)).toBe(true);
    expect(report.repairs.some(r => r.to === 'relay_api')).toBe(true);
    expect(report.checks.gateway).toMatchObject({
      healthy: true,
      autoRepaired: true,
      repairedTo: 'relay_api',
      configured: '__missing__',
    });
    expect(process.env.GATEWAY_PREFERRED_ADAPTER).toBe('relay_api');
    const envContent = fs.readFileSync(envPath, 'utf-8');
    expect(envContent).toContain('GATEWAY_PREFERRED_ADAPTER=relay_api');
    expect(envContent).not.toContain('GATEWAY_PREFERRED_MODEL=');
    expect(refreshAdapters).toHaveBeenCalled();
  });

  test('reports invalid preferred adapter when auto-repair disabled', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = '__missing__';
    process.env.KHY_SELF_CHECK_AUTO_REPAIR_PREFERRED = 'false';

    mockCommonServices();
    jest.doMock('../src/services/gateway/aiGateway', () => ({
      _initialized: true,
      init: jest.fn(async () => {}),
      refreshAdapters: jest.fn(async () => {}),
      getStatus: () => ([
        { type: 'relay_api', enabled: true, available: true, detail: 'ok' },
      ]),
    }));

    const selfCheck = require('../src/services/baseSelfCheckService');
    const report = await selfCheck.runOnce({
      trigger: 'test',
      forceThreatScan: false,
      forcePluginDoctor: false,
    });

    expect(report.issues.some(i => String(i.message).includes('首选通道配置无效'))).toBe(true);
    expect(report.checks.gateway).toMatchObject({
      healthy: false,
      autoRepaired: false,
      configured: '__missing__',
    });
    expect(report.repairs || []).toHaveLength(0);
    expect(process.env.GATEWAY_PREFERRED_ADAPTER).toBe('__missing__');
    const envContent = fs.readFileSync(envPath, 'utf-8');
    expect(envContent).toContain('GATEWAY_PREFERRED_ADAPTER=codex');
  });
});

