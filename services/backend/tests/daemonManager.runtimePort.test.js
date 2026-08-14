'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

describe('daemonManager runtime port discovery', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;
  let homedirSpy = null;

  function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  function mockHealthResponse() {
    const calls = [];
    const spy = jest.spyOn(http, 'get').mockImplementation((url, options, callback) => {
      calls.push(String(url));
      const req = new EventEmitter();
      req.destroy = jest.fn();
      process.nextTick(() => {
        const res = new EventEmitter();
        callback(res);
        res.emit('data', JSON.stringify({ status: 'ok' }));
        res.emit('end');
      });
      return req;
    });
    return { calls, spy };
  }

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-daemon-test-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env.HOME = tempHome;
    process.env.KHY_DATA_HOME = path.join(tempHome, '.khy');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (homedirSpy) {
      homedirSpy.mockRestore();
      homedirSpy = null;
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = null;
  });

  test('daemonStatus prefers runtime apiPort when runtime pid matches', async () => {
    const dm = require('../src/services/daemonManager');
    const dataHome = process.env.KHY_DATA_HOME;
    const pidFile = path.join(dataHome, 'daemon.pid');
    const runtimeFile = path.join(dataHome, 'ai_manage_runtime.json');
    const pid = 43210;

    writeJson(pidFile, {
      pid,
      port: 9090,
      startedAt: Date.now() - 5000,
      nodeVersion: process.version,
    });
    writeJson(runtimeFile, {
      pid,
      apiPort: 9093,
      updatedAt: Date.now(),
      source: 'test',
    });

    jest.spyOn(process, 'kill').mockImplementation(() => true);
    const { calls } = mockHealthResponse();

    const status = await dm.daemonStatus();
    const updatedPid = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));

    expect(status.running).toBe(true);
    expect(status.port).toBe(9093);
    expect(calls[0]).toContain(':9093/api/health');
    expect(updatedPid.port).toBe(9093);
  });

  test('daemonStatus ignores runtime apiPort from another pid', async () => {
    const dm = require('../src/services/daemonManager');
    const dataHome = process.env.KHY_DATA_HOME;
    const pidFile = path.join(dataHome, 'daemon.pid');
    const runtimeFile = path.join(dataHome, 'ai_manage_runtime.json');
    const pid = 54321;

    writeJson(pidFile, {
      pid,
      port: 9090,
      startedAt: Date.now() - 5000,
      nodeVersion: process.version,
    });
    writeJson(runtimeFile, {
      pid: pid + 1,
      apiPort: 9094,
      updatedAt: Date.now(),
      source: 'test',
    });

    jest.spyOn(process, 'kill').mockImplementation(() => true);
    const { calls } = mockHealthResponse();

    const status = await dm.daemonStatus();
    const updatedPid = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));

    expect(status.running).toBe(true);
    expect(status.port).toBe(9090);
    expect(calls[0]).toContain(':9090/api/health');
    expect(updatedPid.port).toBe(9090);
  });
});
