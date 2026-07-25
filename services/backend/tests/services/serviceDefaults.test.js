'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function composeLocalUrl(port) {
  return `http://localhost:${port}`;
}

describe('serviceDefaults AI backend discovery', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempHome = null;
  let homedirSpy = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-service-defaults-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env = {
      ...ORIGINAL_ENV,
      KHY_DATA_HOME: path.join(tempHome, '.khy'),
    };
    delete process.env.AI_BACKEND_URL;
    delete process.env.KHY_DAEMON_PORT;
    delete process.env.AI_MGMT_PORT;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    if (homedirSpy) {
      homedirSpy.mockRestore();
      homedirSpy = null;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = null;
  });

  test('discovers AI backend URL from primary runtime file', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 19090,
    }, null, 2), 'utf-8');

    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl()).toBe(composeLocalUrl(19090));
    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(19090));
  });

  test('falls back to legacy runtime file when primary runtime is missing', () => {
    const legacyDataHome = path.join(tempHome, '.khyquant');
    fs.mkdirSync(legacyDataHome, { recursive: true });
    fs.writeFileSync(path.join(legacyDataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 29090,
    }, null, 2), 'utf-8');

    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl()).toBe(composeLocalUrl(29090));
    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(29090));
  });

  test('AI_BACKEND_URL getter reflects runtime discovered after module load', () => {
    const serviceDefaults = require('../../src/constants/serviceDefaults');
    const dataHome = process.env.KHY_DATA_HOME;

    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(9090));

    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 19091,
    }, null, 2), 'utf-8');

    expect(serviceDefaults.AI_BACKEND_URL).toBe(composeLocalUrl(19091));
    expect(serviceDefaults.getAiBackendUrl()).toBe(composeLocalUrl(19091));
  });

  test('prefers explicit AI_BACKEND_URL over runtime discovery', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 19090,
    }, null, 2), 'utf-8');

    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl({
      ...process.env,
      AI_BACKEND_URL: 'https://api.example.com',
    })).toBe('https://api.example.com');
  });

  test('falls back to daemon port env when runtime files are absent', () => {
    const serviceDefaults = require('../../src/constants/serviceDefaults');

    expect(serviceDefaults.getAiBackendUrl({
      ...process.env,
      KHY_DAEMON_PORT: '39090',
    })).toBe(composeLocalUrl(39090));
  });
});

describe('serviceDefaults cloud endpoint single source of truth', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('exposes the production cloud endpoint and derived defaults', () => {
    delete process.env.KHY_CLOUD_ENDPOINT;
    delete process.env.KHY_TELEMETRY_ENDPOINT;
    jest.resetModules();
    const sd = require('../../src/constants/serviceDefaults');
    expect(sd.CLOUD_DEFAULT_ENDPOINT).toBe('https://api.khyquant.top');
    expect(sd.CLOUD_FALLBACK_ENDPOINTS).toContain('https://api.khyquant.top');
    expect(sd.TELEMETRY_DEFAULT_ENDPOINT).toBe('https://api.khyquant.top/telemetry');
    expect(sd.CLOUD_DEFAULT_HOST).toBe('khyquant.top');
  });

  test('KHY_CLOUD_ENDPOINT overrides the endpoint and its derivations', () => {
    process.env.KHY_CLOUD_ENDPOINT = 'https://api.self-hosted.example';
    delete process.env.KHY_TELEMETRY_ENDPOINT;
    jest.resetModules();
    const sd = require('../../src/constants/serviceDefaults');
    expect(sd.CLOUD_DEFAULT_ENDPOINT).toBe('https://api.self-hosted.example');
    expect(sd.CLOUD_FALLBACK_ENDPOINTS[0]).toBe('https://api.self-hosted.example');
    expect(sd.TELEMETRY_DEFAULT_ENDPOINT).toBe('https://api.self-hosted.example/telemetry');
    expect(sd.CLOUD_DEFAULT_HOST).toBe('self-hosted.example');
  });

  test('AI backend default port is the single source mirrored by the frontend', () => {
    delete process.env.KHY_DAEMON_PORT;
    jest.resetModules();
    const sd = require('../../src/constants/serviceDefaults');
    expect(sd.AI_BACKEND_DEFAULT_PORT).toBe(9090);
    expect(sd.AI_BACKEND_DEFAULT_URL).toBe('http://localhost:9090');
  });
});
