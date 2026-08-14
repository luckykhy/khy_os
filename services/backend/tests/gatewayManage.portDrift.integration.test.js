'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function createChalk() {
  const fn = (value) => String(value || '');
  fn.bold = fn;
  fn.cyan = fn;
  fn.gray = fn;
  fn.yellow = fn;
  fn.green = fn;
  fn.red = fn;
  fn.dim = fn;
  fn.magenta = fn;
  fn.white = fn;
  return fn;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function listenBusyServer(port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => res.end('busy'));
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function readRuntime(dataHome) {
  const filePath = path.join(dataHome, 'ai_manage_runtime.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function stopRuntimeProcess(dataHome) {
  const runtime = readRuntime(dataHome);
  const pid = Number(runtime && runtime.pid);
  if (!pid) return;

  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  await wait(400);
  try { process.kill(pid, 0); } catch { return; }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  await wait(200);
}

describe('gateway manage port drift integration', () => {
  jest.setTimeout(30000);

  const ORIGINAL_ENV = { ...process.env };
  const chalk = createChalk();
  let tempHome = null;
  let dataHome = null;
  let busyServer = null;
  let printSuccess = null;
  let printError = null;
  let printInfo = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-manage-it-'));
    dataHome = path.join(tempHome, '.khy');
    process.env = {
      ...ORIGINAL_ENV,
      HOME: tempHome,
      KHY_DATA_HOME: dataHome,
    };

    printSuccess = jest.fn();
    printError = jest.fn();
    printInfo = jest.fn();

    jest.doMock('chalk', () => {
      const mocked = createChalk();
      return mocked;
    });
    jest.doMock('../src/cli/formatters', () => ({
      printSuccess,
      printError,
      printInfo,
      printTable: jest.fn(),
      ICON_GATEWAY: '*',
      stripAnsi: (s) => String(s || ''),
      displayWidth: (s) => String(s || '').length,
      padToWidth: (s, width) => {
        const text = String(s || '');
        const safeWidth = Math.max(0, Number(width) || 0);
        return text.length >= safeWidth ? text : `${text}${' '.repeat(safeWidth - text.length)}`;
      },
      truncateToWidth: (s, width) => {
        const text = String(s || '');
        const safeWidth = Math.max(0, Number(width) || 0);
        return text.length > safeWidth ? text.slice(0, safeWidth) : text;
      },
      safeTerminalString: (s) => String(s || ''),
    }));
    jest.doMock('../src/services/cliAuthService', () => ({
      checkSession: jest.fn(() => ({ loggedIn: false })),
      getSessionAuthToken: jest.fn(() => ''),
    }));
  });

  afterEach(async () => {
    await closeServer(busyServer);
    busyServer = null;
    await stopRuntimeProcess(dataHome);

    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
    jest.resetModules();

    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = null;
    dataHome = null;
  });

  test('start and status display the actual runtime port when the requested port is occupied', async () => {
    busyServer = await listenBusyServer(0);
    const requestedPort = busyServer.address().port;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const handler = require('../src/cli/handlers/gateway');

    try {
      await handler.handleGatewayManage(['start'], {
        daemon: true,
        'no-frontend': true,
        'api-port': requestedPort,
        'wait-ms': 3000,
      });

      const runtime = readRuntime(dataHome);
      expect(runtime).toBeTruthy();
      expect(runtime.apiPort).toBeGreaterThan(0);
      expect(runtime.apiPort).not.toBe(requestedPort);

      const startOutput = logSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n');
      expect(startOutput).toContain(`http://127.0.0.1:${runtime.apiPort}/api/health`);
      expect(startOutput).toContain('推荐入口: API 直管（当前无可用前端）');
      expect(startOutput).toContain('保活直链: 未生成（前端未就绪）');
      expect(startOutput).not.toContain('khy_manage_ctl=');
      expect(startOutput).not.toContain('登录提示:');

      logSpy.mockClear();
      printInfo.mockClear();
      printSuccess.mockClear();

      await handler.handleGatewayManage(['status'], {});

      const statusOutput = logSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n');
      expect(statusOutput).toContain(`http://127.0.0.1:${runtime.apiPort}/api/health`);
      expect(statusOutput).not.toContain(`http://127.0.0.1:${requestedPort}/api/health`);
      expect(statusOutput).toContain('推荐入口: API 直管（当前无可用前端）');
      expect(statusOutput).toContain('保活直链: 未生成（前端未就绪）');
      expect(statusOutput).not.toContain('khy_manage_ctl=');
      expect(statusOutput).not.toContain('登录提示:');

      await handler.handleGatewayManage(['stop'], {});
      expect(printSuccess).toHaveBeenCalledWith('AI 管理会话已停止，端口已释放');
      expect(readRuntime(dataHome)).toBe(null);
    } finally {
      logSpy.mockRestore();
    }
  });
});
