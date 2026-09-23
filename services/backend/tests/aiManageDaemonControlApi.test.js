'use strict';
/**
 * ai-manage-daemon control surface <-> aiManageDaemonLifecycle agreement.
 *
 * The daemon publishes a control API (token-gated) and a runtime file; the
 * lifecycle module probes that API (`probeControl`) and posts `/shutdown`
 * (`requestShutdown`). Two real defects are pinned here:
 *
 *   1. SHUTDOWN HEADER MISMATCH (RED until F4): the daemon authenticates on
 *      `x-khy-token`. The lifecycle's `probeControl` correctly sends that, but
 *      its `requestShutdown` sends `X-Control-Token` — which the daemon never
 *      reads — so a lifecycle-initiated shutdown always 401s and silently
 *      fails (the daemon can only be reaped by idle timeout, never told to
 *      stop). These tests pin that BOTH probe and shutdown succeed against the
 *      real control server; only the shutdown half is red today.
 *
 *   2. RUNTIME-PATH PARITY (RED until F5): the daemon writes its runtime file
 *      to `getDataHome()` (portable-aware), but the lifecycle resolves
 *      `KHY_DATA_HOME || ~/.khy`. In a portable install without KHY_DATA_HOME
 *      exported, the two point at different files, so the lifecycle cannot see
 *      a running daemon at all. This test pins that both must agree on
 *      `getDataHome()/ai_manage_runtime.json`.
 *
 * Safety: os.homedir + process.exit mocked; runtime files land in temp dirs.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let daemon;
let lifecycle;
let dataHome;
let tempHome;
let exitSpy;

function requireLifecycleFresh() {
  delete require.cache[require.resolve('../src/services/aiManageDaemonLifecycle')];
  return require('../src/services/aiManageDaemonLifecycle');
}

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-daemon-ctl-'));
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  daemon = require('../scripts/ai-manage-daemon');
  lifecycle = requireLifecycleFresh();
  dataHome = require('../src/utils/dataHome');
});

afterAll(() => {
  exitSpy.mockRestore();
  jest.restoreAllMocks();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('control API token agreement (lifecycle probes the daemon)', () => {
  let controlPort;
  let controlToken;

  beforeAll(async () => {
    // Bring up the daemon's real control server and publish its runtime file.
    daemon._resetForTests();
    daemon.createControlServer();
    await daemon.listenControlServer();
    controlPort = daemon.getState().controlPort;
    daemon.writeRuntime({});
    const rtFile = path.join(process.env.KHY_DATA_HOME, 'ai_manage_runtime.json');
    controlToken = JSON.parse(fs.readFileSync(rtFile, 'utf-8')).controlToken;
  });

  afterAll(async () => {
    // Tear the control server down cleanly.
    try {
      await daemon.shutdown('test-cleanup');
    } catch {
      /* already shutting down */
    }
  });

  test('probeControl succeeds against a running daemon (no 401)', async () => {
    const result = await lifecycle.probeControl({ controlPort, controlToken });
    expect(result.ok).toBe(true);
  });

  test('requestShutdown cleanly stops the daemon (no 401)', async () => {
    // Point the lifecycle's runtime-file lookup at the daemon's published file.
    const rtFile = path.join(process.env.KHY_DATA_HOME, 'ai_manage_runtime.json');
    process.env.KHY_DAEMON_RUNTIME_FILE = rtFile;
    lifecycle = requireLifecycleFresh();
    const result = await lifecycle.requestShutdown();
    delete process.env.KHY_DAEMON_RUNTIME_FILE;
    expect(result.ok).toBe(true);
  });
});

describe('runtime-file path parity (portable install)', () => {
  test('the lifecycle resolves the same runtime file the daemon writes', () => {
    // Simulate a fresh, portable CLI process: portable markers set, but the
    // KHY_DATA_HOME env var has NOT been exported (it is the exact situation
    // where the bug bites — lifecycle falls back to ~/.khy, daemon uses
    // the portable project data home).
    const portableRoot = fs.mkdtempSync(path.join(tempHome, 'portable-'));
    const projectData = path.join(portableRoot, 'projdata');
    fs.mkdirSync(path.join(portableRoot, '.khy'), { recursive: true });
    fs.writeFileSync(path.join(portableRoot, '.portable'), '');

    const saved = {
      KHY_PORTABLE_ROOT: process.env.KHY_PORTABLE_ROOT,
      KHY_PROJECT_DATA_HOME: process.env.KHY_PROJECT_DATA_HOME,
      KHY_DATA_HOME: process.env.KHY_DATA_HOME,
      KHY_DAEMON_RUNTIME_FILE: process.env.KHY_DAEMON_RUNTIME_FILE,
    };
    process.env.KHY_PORTABLE_ROOT = portableRoot;
    process.env.KHY_PROJECT_DATA_HOME = projectData;
    delete process.env.KHY_DATA_HOME;
    delete process.env.KHY_DAEMON_RUNTIME_FILE;
    dataHome._resetStorageCaches();

    try {
      lifecycle = requireLifecycleFresh();
      // The daemon's location of truth is getDataHome()/ai_manage_runtime.json.
      // Call getDataHome() first (its portable branch caches + exports
      // KHY_DATA_HOME), remember the resolved home, then DELETE the env var to
      // model a fresh CLI process that has NOT yet exported it — that is the
      // exact situation where the bug bites.
      const resolvedDataHome = dataHome.getDataHome();
      const expected = path.join(resolvedDataHome, 'ai_manage_runtime.json');
      delete process.env.KHY_DATA_HOME;
      expect(lifecycle._runtimeFile()).toBe(expected);
    } finally {
      process.env.KHY_PORTABLE_ROOT = saved.KHY_PORTABLE_ROOT;
      process.env.KHY_PROJECT_DATA_HOME = saved.KHY_PROJECT_DATA_HOME;
      if (saved.KHY_DATA_HOME) process.env.KHY_DATA_HOME = saved.KHY_DATA_HOME;
      else delete process.env.KHY_DATA_HOME;
      if (saved.KHY_DAEMON_RUNTIME_FILE) process.env.KHY_DAEMON_RUNTIME_FILE = saved.KHY_DAEMON_RUNTIME_FILE;
      else delete process.env.KHY_DAEMON_RUNTIME_FILE;
      dataHome._resetStorageCaches();
      lifecycle = requireLifecycleFresh();
    }
  });
});
