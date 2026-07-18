'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('chatLatencyAutoTuner', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('does not tune before minimum sample threshold', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ttft-tuner-'));
    process.env.KHY_DATA_HOME = tmpDir;
    process.env.KHY_RUNTIME_MODE = 'khy';
    process.env.KHY_CHAT_AUTOTUNE = 'true';
    process.env.KHY_CHAT_AUTOTUNE_MIN_SAMPLES = '6';
    process.env.KHY_PREFLIGHT_MAX_MS = '1800';

    const tuner = require('../../src/services/chatLatencyAutoTuner');
    tuner.__resetForTest();

    let last = null;
    for (let i = 0; i < 5; i++) {
      last = tuner.recordChatFirstTokenSample({
        profile: 'khy_chat_interactive',
        elapsedMs: 1500,
        success: true,
        hasFirstToken: true,
        adapter: 'codex',
      });
    }

    expect(last).toBeTruthy();
    expect(last.tuned).toBe(false);
    expect(last.reason).toMatch(/insufficient samples/i);
    expect(process.env.KHY_PREFLIGHT_MAX_MS).toBe('1800');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('switches to aggressive preset when TTFT is consistently fast', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ttft-tuner-'));
    process.env.KHY_DATA_HOME = tmpDir;
    process.env.KHY_RUNTIME_MODE = 'khy';
    process.env.KHY_CHAT_AUTOTUNE = 'true';
    process.env.KHY_CHAT_AUTOTUNE_MIN_SAMPLES = '6';
    process.env.KHY_CHAT_AUTOTUNE_MIN_INTERVAL_MS = '10000';

    const tuner = require('../../src/services/chatLatencyAutoTuner');
    tuner.__resetForTest();

    let last = null;
    const samples = [900, 1100, 1200, 1300, 1000, 1250];
    for (const ttft of samples) {
      last = tuner.recordChatFirstTokenSample({
        profile: 'khy_chat_interactive',
        elapsedMs: ttft,
        success: true,
        hasFirstToken: true,
        adapter: 'codex',
      });
    }

    expect(last).toBeTruthy();
    expect(last.tuned).toBe(true);
    expect(last.preset).toBe('aggressive');
    expect(Number(process.env.KHY_PREFLIGHT_MAX_MS)).toBe(1200);
    expect(Number(process.env.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS)).toBe(700);
    expect(Number(process.env.KHY_PREFLIGHT_MAX_CANDIDATES)).toBe(1);
    expect(Number(process.env.GATEWAY_RATE_LIMIT_MAX_WAIT_MS)).toBe(1800);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('switches to stable preset when recent failure rate is high', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ttft-tuner-'));
    process.env.KHY_DATA_HOME = tmpDir;
    process.env.KHY_RUNTIME_MODE = 'khy';
    process.env.KHY_CHAT_AUTOTUNE = 'true';
    process.env.KHY_CHAT_AUTOTUNE_MIN_SAMPLES = '6';
    process.env.KHY_CHAT_AUTOTUNE_MIN_INTERVAL_MS = '10000';

    const tuner = require('../../src/services/chatLatencyAutoTuner');
    tuner.__resetForTest();

    const samples = [
      { elapsedMs: 2600, success: true, hasFirstToken: true },
      { elapsedMs: 2800, success: true, hasFirstToken: true },
      { elapsedMs: 3000, success: true, hasFirstToken: true },
      { elapsedMs: 3200, success: true, hasFirstToken: true },
      { elapsedMs: 4500, success: false, hasFirstToken: false, errorType: 'cancelled' },
      { elapsedMs: 4700, success: false, hasFirstToken: false, errorType: 'process' },
    ];

    let last = null;
    for (const sample of samples) {
      last = tuner.recordChatFirstTokenSample({
        profile: 'khy_chat_interactive',
        adapter: 'claude',
        ...sample,
      });
    }

    expect(last).toBeTruthy();
    expect(last.tuned).toBe(true);
    expect(last.preset).toBe('stable');
    expect(Number(process.env.KHY_PREFLIGHT_MAX_MS)).toBe(2400);
    expect(Number(process.env.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS)).toBe(1200);
    expect(Number(process.env.KHY_PREFLIGHT_MAX_CANDIDATES)).toBe(2);
    expect(Number(process.env.GATEWAY_RATE_LIMIT_MAX_WAIT_MS)).toBe(3600);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('applies adaptive micro-fast override on ultra-fast stable quality samples', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ttft-tuner-'));
    process.env.KHY_DATA_HOME = tmpDir;
    process.env.KHY_RUNTIME_MODE = 'khy';
    process.env.KHY_CHAT_AUTOTUNE = 'true';
    process.env.KHY_CHAT_AUTOTUNE_ADAPTIVE = 'true';
    process.env.KHY_CHAT_AUTOTUNE_MIN_SAMPLES = '6';
    process.env.KHY_CHAT_AUTOTUNE_MIN_INTERVAL_MS = '10000';

    const tuner = require('../../src/services/chatLatencyAutoTuner');
    tuner.__resetForTest();

    let last = null;
    const samples = [620, 700, 740, 800, 680, 760];
    for (const ttft of samples) {
      last = tuner.recordChatFirstTokenSample({
        profile: 'khy_chat_interactive',
        elapsedMs: ttft,
        success: true,
        hasFirstToken: true,
        adapter: 'codex',
      });
    }

    expect(last).toBeTruthy();
    expect(last.tuned).toBe(true);
    expect(last.preset).toBe('aggressive');
    expect(String(last.reason || '')).toContain('micro-fast');
    expect(Number(process.env.KHY_PREFLIGHT_MAX_MS)).toBe(1020);
    expect(Number(process.env.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS)).toBe(610);
    expect(Number(process.env.GATEWAY_RATE_LIMIT_MAX_WAIT_MS)).toBe(1540);

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
