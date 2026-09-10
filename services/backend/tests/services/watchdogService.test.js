'use strict';

/**
 * Watchdog Service Tests
 */

const assert = require('assert');
const watchdog = require('./watchdogService');

describe('watchdogService', () => {
  afterEach(() => {
    watchdog.stop();
    watchdog.reset();
  });

  it('should start and stop watchdog', () => {
    const startResult = watchdog.start();
    expect(startResult.enabled).toBe(true);
    expect(startResult.changed).toBe(true);

    const stopResult = watchdog.stop();
    expect(stopResult.enabled).toBe(false);
  });

  it('should return status', () => {
    watchdog.start();
    const status = watchdog.status();

    expect(status.enabled).toBe(true);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.consecutiveRestartFailures).toBe(0);
    expect(status.abandoned).toBe(false);
  });

  it('should respect custom interval', () => {
    const result = watchdog.start({ intervalMs: 15000 });
    expect(result.intervalMs).toBe(15000);
  });

  it('should normalize interval within bounds', () => {
    const result = watchdog.start({ intervalMs: 1000 });
    expect(result.intervalMs).toBe(5000); // MIN_INTERVAL_MS
  });

  it('should reset state', () => {
    watchdog.start();
    watchdog.reset();

    const status = watchdog.status();
    expect(status.consecutiveFailures).toBe(0);
    expect(status.consecutiveRestartFailures).toBe(0);
  });

  it('should export constants', () => {
    expect(typeof watchdog.constants.DEFAULT_INTERVAL_MS).toBe('number');
    expect(watchdog.constants.HEARTBEAT_FAILURE_THRESHOLD).toBe(3);
    expect(watchdog.constants.MAX_RESTART_ATTEMPTS).toBe(5);
  });
});

