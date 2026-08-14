'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', {
    value,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

describe('claudeAdapter windows spawn compatibility', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.clearAllMocks();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    process.env = { ...originalEnv };
  });

  test('bridge mode launches Claude CLI via COMSPEC with /d /s /c on Windows', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.GATEWAY_CLAUDE_MODE = 'bridge';
    process.env.GATEWAY_CLAUDE_RETRY_TRANSIENT = 'false';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_API_KEY;

    const spawnSync = jest.fn(() => ({ status: 0, error: null }));
    const execFileSync = jest.fn();
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn(() => true);
      return child;
    });

    jest.doMock('child_process', () => ({
      spawn,
      spawnSync,
      execFileSync,
    }));
    jest.doMock('../src/services/apiKeyPool', () => ({
      init: jest.fn(),
      hasAvailableKeys: jest.fn(() => false),
    }));

    const adapter = require('../src/services/gateway/adapters/claudeAdapter');
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort('test-abort'), 20);
    abortTimer.unref?.();
    const result = await adapter.generate('hello', {
      timeoutMs: 800,
      abortSignal: controller.signal,
    });
    clearTimeout(abortTimer);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('cancelled');
    expect(spawn).toHaveBeenCalled();
    expect(spawn.mock.calls[0][0]).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(spawn.mock.calls[0][1].slice(0, 4)).toEqual(['/d', '/s', '/c', 'claude.cmd']);
  });

  test('bridge handshake timeout escalates to SIGKILL only after shutdown stays idle', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.GATEWAY_CLAUDE_MODE = 'bridge';
    process.env.GATEWAY_CLAUDE_RETRY_TRANSIENT = 'false';
    process.env.GATEWAY_CLAUDE_HANDSHAKE_TIMEOUT_MS = '40';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_API_KEY;

    const spawnSync = jest.fn(() => ({ status: 0, error: null }));
    const execFileSync = jest.fn();
    let child = null;
    const killSignals = [];
    const spawn = jest.fn(() => {
      child = new EventEmitter();
      child.pid = 43210;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn((signal) => {
        killSignals.push(signal);
        if (signal === 'SIGKILL') {
          child.emit('close', 1);
        }
        return true;
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      spawn,
      spawnSync,
      execFileSync,
    }));
    jest.doMock('../src/tools/platformUtils', () => {
      const real = jest.requireActual('../src/tools/platformUtils');
      return {
        ...real,
        isWin: true,
        safeKill: (target, signal = 'SIGTERM') => {
          if (target && typeof target.kill === 'function') target.kill(signal);
        },
      };
    });
    jest.doMock('../src/services/apiKeyPool', () => ({
      init: jest.fn(),
      hasAvailableKeys: jest.fn(() => false),
    }));

    const adapter = require('../src/services/gateway/adapters/claudeAdapter');
    const chunks = [];
    const resultPromise = adapter.generate('please respond in one line', {
      timeoutMs: 5000,
      onChunk: (chunk) => chunks.push(chunk),
    });

    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(String(result.error || '')).toContain('handshake timeout');
    expect(killSignals).toContain('SIGTERM');
    expect(killSignals).toContain('SIGKILL');

    const statusLines = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusLines.some(s => s.includes('handshake timeout'))).toBe(true);
    expect(statusLines.some(s => s.includes('forcing SIGKILL'))).toBe(true);
  }, 10000);

  test('bridge handshake timeout persists runtime diagnostics across reloads', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.GATEWAY_CLAUDE_MODE = 'bridge';
    process.env.GATEWAY_CLAUDE_RETRY_TRANSIENT = 'false';
    process.env.GATEWAY_CLAUDE_HANDSHAKE_TIMEOUT_MS = '40';
    const tempDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-claude-runtime-'));
    process.env.KHY_DATA_HOME = tempDataHome;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_API_KEY;

    const spawnSync = jest.fn(() => ({ status: 0, error: null }));
    const execFileSync = jest.fn();
    const spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.pid = 56789;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn((signal) => {
        if (signal === 'SIGKILL') child.emit('close', 1);
        return true;
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      spawn,
      spawnSync,
      execFileSync,
    }));
    jest.doMock('../src/tools/platformUtils', () => {
      const real = jest.requireActual('../src/tools/platformUtils');
      return {
        ...real,
        isWin: true,
        safeKill: (target, signal = 'SIGTERM') => {
          if (target && typeof target.kill === 'function') target.kill(signal);
        },
      };
    });
    jest.doMock('../src/services/apiKeyPool', () => ({
      init: jest.fn(),
      hasAvailableKeys: jest.fn(() => false),
    }));

    try {
      const adapter = require('../src/services/gateway/adapters/claudeAdapter');
      adapter.__test__.clearPersistedRuntimeDiagnostics();

      const result = await adapter.generate('hello', {
        timeoutMs: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.diagnostics).toMatchObject({
        trigger: 'bridge_handshake_timeout',
      });
      expect(adapter.getRuntimeDiagnostics()).toMatchObject({
        trigger: 'bridge_handshake_timeout',
      });

      adapter.destroy();
      expect(adapter.getRuntimeDiagnostics()).toEqual({
        adapterKey: 'claude',
        at: 0,
        requestId: '',
        healed: false,
        diagnosis: '',
        lastError: '',
        trigger: '',
        category: '',
        phase: '',
        summary: '',
      });

      jest.resetModules();
      const reloadedAdapter = require('../src/services/gateway/adapters/claudeAdapter');
      expect(reloadedAdapter.getRuntimeDiagnostics({ includePersisted: true })).toMatchObject({
        trigger: 'bridge_handshake_timeout',
        category: 'stall',
      });
      expect(reloadedAdapter.getRuntimeDiagnostics({
        includePersisted: true,
        preferCategory: 'stall',
      })).toMatchObject({
        trigger: 'bridge_handshake_timeout',
      });
      reloadedAdapter.__test__.clearPersistedRuntimeDiagnostics();
    } finally {
      delete process.env.KHY_DATA_HOME;
      fs.rmSync(tempDataHome, { recursive: true, force: true });
    }
  }, 10000);

  test('bridge abort cleanup escalates to SIGKILL after idle grace window', async () => {
    setPlatform('win32');
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    process.env.GATEWAY_CLAUDE_MODE = 'bridge';
    process.env.GATEWAY_CLAUDE_RETRY_TRANSIENT = 'false';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_API_KEY;

    const spawnSync = jest.fn(() => ({ status: 0, error: null }));
    const execFileSync = jest.fn();
    let child = null;
    const killSignals = [];
    const spawn = jest.fn(() => {
      child = new EventEmitter();
      child.pid = 54321;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = jest.fn((signal) => {
        killSignals.push(signal);
        if (signal === 'SIGKILL') {
          child.emit('close', 1);
        }
        return true;
      });
      return child;
    });

    jest.doMock('child_process', () => ({
      spawn,
      spawnSync,
      execFileSync,
    }));
    jest.doMock('../src/tools/platformUtils', () => {
      const real = jest.requireActual('../src/tools/platformUtils');
      return {
        ...real,
        isWin: true,
        safeKill: (target, signal = 'SIGTERM') => {
          if (target && typeof target.kill === 'function') target.kill(signal);
        },
      };
    });
    jest.doMock('../src/services/apiKeyPool', () => ({
      init: jest.fn(),
      hasAvailableKeys: jest.fn(() => false),
    }));

    const adapter = require('../src/services/gateway/adapters/claudeAdapter');
    const controller = new AbortController();
    const resultPromise = adapter.generate('hello', {
      timeoutMs: 800,
      abortSignal: controller.signal,
    });

    controller.abort('user-cancelled');
    const result = await resultPromise;
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('cancelled');
    expect(killSignals).toContain('SIGTERM');
    expect(killSignals).toContain('SIGKILL');
  }, 6000);
});
