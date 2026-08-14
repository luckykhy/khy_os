'use strict';

describe('gateway transport resilience', () => {
  const ORIGINAL_ENV = { ...process.env };
  let gateway;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    gateway = require('../../src/services/gateway/aiGateway');
    if (gateway._cleanupInterval) {
      clearInterval(gateway._cleanupInterval);
      gateway._cleanupInterval = null;
    }
    if (typeof gateway._clearAllCooldownSelfHealMidpointTimers === 'function') {
      gateway._clearAllCooldownSelfHealMidpointTimers();
    }
    gateway._adapterLastError = {};
    gateway._adapterFailures = {};
    gateway._cooldownSelfHealMeta = {};
    gateway._cooldownSelfHealInFlight = new Map();
    gateway._cooldownSelfHealMidpointTimers = new Map();
  });

  afterEach(async () => {
    if (gateway) {
      if (gateway._cleanupInterval) {
        clearInterval(gateway._cleanupInterval);
        gateway._cleanupInterval = null;
      }
      if (typeof gateway._clearAllCooldownSelfHealMidpointTimers === 'function') {
        gateway._clearAllCooldownSelfHealMidpointTimers();
      }
      if (typeof gateway.destroy === 'function') {
        try {
          await gateway.destroy();
        } catch {
          // best effort cleanup for timer resources
        }
      }
    }
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  test('classifies reconnects and queue stalls as transient errors', () => {
    const cliToolAdapter = require('../../src/services/gateway/adapters/cliToolAdapter');

    expect(gateway.classifyError(0, 'ERROR: Reconnecting')).toBe('network');
    expect(gateway.classifyError(0, 'channel closed')).toBe('network');
    expect(gateway.classifyError(0, 'failed to record rollout items')).toBe('network');
    expect(gateway.classifyError(0, 'adapter codex queue timeout')).toBe('timeout');
    // The cli adapter flags rollout/transport stalls as transient; the gateway
    // then promotes transient transport messages to 'network' for retry (see above).
    expect(cliToolAdapter.__test__.isTransientTransportMessage('failed to record rollout items')).toBe(true);
  });

  test('enforces relaxed idle timeout floors for codex and cli tools', () => {
    const codexAdapter = require('../../src/services/gateway/adapters/codexAdapter');
    const cliToolAdapter = require('../../src/services/gateway/adapters/cliToolAdapter');

    expect(codexAdapter.__test__.resolveExecIdleTimeoutMs({ timeoutMs: 45000 })).toBeGreaterThanOrEqual(180000);
    expect(codexAdapter.__test__.isReconnectChannelClosed('channel closed')).toBe(true);
    expect(cliToolAdapter.__test__.resolveToolIdleTimeoutMs({ cmd: 'codex' }, { timeoutMs: 45000 })).toBeGreaterThanOrEqual(180000);
    expect(cliToolAdapter.__test__.isTransientTransportMessage('failed to record rollout items')).toBe(true);
  });

  test('transient network failures do not open circuit breaker cooldown', async () => {
    const fakeHealthStore = {
      getFailureCount: jest.fn(async () => 2),
      incrFailure: jest.fn(async () => 3),
      recordLastError: jest.fn(async () => {}),
      setCooldown: jest.fn(async () => {}),
      resetHalfOpen: jest.fn(async () => {}),
      clearFailure: jest.fn(async () => {}),
    };

    gateway._healthStore = fakeHealthStore;
    gateway._healthBroadcaster = {
      recordRequestActivity: jest.fn(),
    };
    jest.spyOn(gateway, '_scheduleCooldownSelfHealMidpointTimer').mockImplementation(() => false);

    await gateway._recordAdapterFailure('codex', 'network', 'channel closed');

    expect(gateway._adapterLastError.codex.circuitOpen).toBe(false);
    expect(fakeHealthStore.recordLastError).toHaveBeenCalled();
    expect(fakeHealthStore.setCooldown).not.toHaveBeenCalled();
    expect(fakeHealthStore.resetHalfOpen).not.toHaveBeenCalled();
  });
});
