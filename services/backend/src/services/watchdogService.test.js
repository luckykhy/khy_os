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
    assert.strictEqual(startResult.enabled, true);
    assert.strictEqual(startResult.changed, true);

    const stopResult = watchdog.stop();
    assert.strictEqual(stopResult.enabled, false);
  });

  it('should return status', () => {
    watchdog.start();
    const status = watchdog.status();

    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.consecutiveFailures, 0);
    assert.strictEqual(status.consecutiveRestartFailures, 0);
    assert.strictEqual(status.abandoned, false);
  });

  it('should respect custom interval', () => {
    const result = watchdog.start({ intervalMs: 15000 });
    assert.strictEqual(result.intervalMs, 15000);
  });

  it('should normalize interval within bounds', () => {
    const result = watchdog.start({ intervalMs: 1000 });
    assert.strictEqual(result.intervalMs, 5000); // MIN_INTERVAL_MS
  });

  it('should reset state', () => {
    watchdog.start();
    watchdog.reset();

    const status = watchdog.status();
    assert.strictEqual(status.consecutiveFailures, 0);
    assert.strictEqual(status.consecutiveRestartFailures, 0);
  });

  it('should export constants', () => {
    assert.strictEqual(typeof watchdog.constants.DEFAULT_INTERVAL_MS, 'number');
    assert.strictEqual(watchdog.constants.HEARTBEAT_FAILURE_THRESHOLD, 3);
    assert.strictEqual(watchdog.constants.MAX_RESTART_ATTEMPTS, 5);
  });
});
