'use strict';

const observability = require('../../src/observability/index');

describe('observability index', () => {
  test('module is defined', () => {
    expect(observability).toBeDefined();
  });

  test('exports createMetrics', () => {
    expect(observability.createMetrics).toBeDefined();
    expect(typeof observability.createMetrics).toBe('function');
  });

  test('exports normalizePath', () => {
    expect(observability.normalizePath).toBeDefined();
    expect(typeof observability.normalizePath).toBe('function');
  });

  test('exports initializeOpenTelemetry', () => {
    expect(observability.initializeOpenTelemetry).toBeDefined();
    expect(typeof observability.initializeOpenTelemetry).toBe('function');
  });

  test('exports shutdownOpenTelemetry', () => {
    expect(observability.shutdownOpenTelemetry).toBeDefined();
    expect(typeof observability.shutdownOpenTelemetry).toBe('function');
  });

  test('exports getOpenTelemetryStatus', () => {
    expect(observability.getOpenTelemetryStatus).toBeDefined();
    expect(typeof observability.getOpenTelemetryStatus).toBe('function');
  });

  test('exports slowRequest', () => {
    expect(observability.slowRequest).toBeDefined();
  });

  test('exports slowRequestCore', () => {
    expect(observability.slowRequestCore).toBeDefined();
  });

  test('exports eventLoopMonitor', () => {
    expect(observability.eventLoopMonitor).toBeDefined();
  });

  test('exports cpuProfiler', () => {
    expect(observability.cpuProfiler).toBeDefined();
  });

  test('exports profilerCore', () => {
    expect(observability.profilerCore).toBeDefined();
  });

  test('all expected exports are present', () => {
    const expectedExports = [
      'createMetrics',
      'normalizePath',
      'initializeOpenTelemetry',
      'shutdownOpenTelemetry',
      'getOpenTelemetryStatus',
      'slowRequest',
      'slowRequestCore',
      'eventLoopMonitor',
      'cpuProfiler',
      'profilerCore',
    ];
    expectedExports.forEach((exp) => {
      expect(observability).toHaveProperty(exp);
    });
  });
});

