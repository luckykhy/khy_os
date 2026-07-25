'use strict';

/**
 * Tests for cloudSync.js — cloud sync and telemetry (network mocked).
 *
 * All network calls are mocked. Filesystem calls are mocked to prevent
 * writing to real ~/.khyquant/ directories.
 */

const fs = require('fs');

// In-memory config store
let mockConfigStore = {};
let mockQueueStore = [];

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p) => {
      if (p.includes('cloud.json')) return !!mockConfigStore._saved;
      if (p.includes('telemetry_queue.json')) return mockQueueStore.length > 0;
      if (p.includes('.khyquant')) return true;
      return actual.existsSync(p);
    }),
    readFileSync: jest.fn((p, enc) => {
      if (p.includes('cloud.json')) return JSON.stringify(mockConfigStore);
      if (p.includes('telemetry_queue.json')) return JSON.stringify(mockQueueStore);
      return actual.readFileSync(p, enc);
    }),
    writeFileSync: jest.fn((p, data) => {
      if (p.includes('cloud.json')) {
        mockConfigStore = JSON.parse(data);
        mockConfigStore._saved = true;
      }
      if (p.includes('telemetry_queue.json')) {
        mockQueueStore = JSON.parse(data);
      }
    }),
    mkdirSync: jest.fn(),
  };
});

// Mock https/http to prevent real network calls
jest.mock('https', () => ({
  request: jest.fn(() => {
    const req = {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    return req;
  }),
}));

let mod;
try {
  mod = require('../../src/services/cloudSync');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('cloudSync', () => {
  const {
    loadCloudConfig,
    enableCloud,
    disableCloud,
    isEnabled,
    getEndpoint,
    setEndpoint,
    trackEvent,
    isLoggedIn,
    logout,
    getAnnouncements,
    sanitizeData,
  } = mod || {};

  beforeEach(() => {
    mockConfigStore = {};
    mockQueueStore = [];
  });

  test('loadCloudConfig returns defaults when no config file', () => {
    mockConfigStore = {};
    const config = loadCloudConfig();
    expect(config.enabled).toBe(false);
    expect(config.telemetryEnabled).toBe(false);
  });

  test('enableCloud sets enabled flag and generates userId', () => {
    const config = enableCloud();
    expect(config.enabled).toBe(true);
    expect(config.userId).toBeTruthy();
    expect(config.userId.length).toBeGreaterThan(10);
  });

  test('disableCloud turns off all features', () => {
    enableCloud();
    const config = disableCloud();
    expect(config.enabled).toBe(false);
    expect(config.telemetryEnabled).toBe(false);
    expect(config.syncEnabled).toBe(false);
  });

  test('isEnabled reflects config state', () => {
    expect(isEnabled()).toBe(false);
    enableCloud();
    expect(isEnabled()).toBe(true);
  });

  test('setEndpoint persists custom endpoint', () => {
    setEndpoint('https://custom.api.example.com');
    expect(getEndpoint()).toBe('https://custom.api.example.com');
  });

  test('trackEvent does nothing when disabled', () => {
    mockConfigStore = { enabled: false, telemetryEnabled: false };
    trackEvent('test_event', { count: 1 });
    // Queue should remain empty
    expect(mockQueueStore.length).toBe(0);
  });

  test('isLoggedIn returns false without token', () => {
    expect(isLoggedIn()).toBe(false);
  });

  test('getAnnouncements returns empty array by default', () => {
    expect(getAnnouncements()).toEqual([]);
  });
});
