'use strict';

const observability = require('../../src/observability/index');

describe('observability/index', () => {
  test('exports createMetrics', () => {
    expect(observability).toHaveProperty('createMetrics');
  });

  test('exports normalizePath', () => {
    expect(observability).toHaveProperty('normalizePath');
  });

  test('exports initializeOpenTelemetry', () => {
    expect(observability).toHaveProperty('initializeOpenTelemetry');
  });

  test('exports shutdownOpenTelemetry', () => {
    expect(observability).toHaveProperty('shutdownOpenTelemetry');
  });

  test('exports getOpenTelemetryStatus', () => {
    expect(observability).toHaveProperty('getOpenTelemetryStatus');
  });

  test('exports slowRequest', () => {
    expect(observability).toHaveProperty('slowRequest');
  });

  test('exports slowRequestCore', () => {
    expect(observability).toHaveProperty('slowRequestCore');
  });

  test('exports eventLoopMonitor', () => {
    expect(observability).toHaveProperty('eventLoopMonitor');
  });

  test('exports cpuProfiler', () => {
    expect(observability).toHaveProperty('cpuProfiler');
  });

  test('exports profilerCore', () => {
    expect(observability).toHaveProperty('profilerCore');
  });

  test('has exactly 10 exports', () => {
    expect(Object.keys(observability).length).toBe(10);
  });
});
