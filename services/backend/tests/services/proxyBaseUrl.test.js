'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function composeUrl(scheme, host, port) {
  return `${scheme}://${host}:${port}`;
}

describe('proxyBaseUrl resolver', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempHome = null;
  let homedirSpy = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-base-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env = {
      ...ORIGINAL_ENV,
      KHY_DATA_HOME: path.join(tempHome, '.khy'),
    };
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

  test('uses runtime HTTPS base when configured Claude base is stale local loopback', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'proxy_server_runtime.json'), JSON.stringify({
      pid: 4321,
      host: 'localhost',
      port: 9443,
      httpPort: null,
      httpsPort: 9443,
      httpsEnabled: true,
      httpsOnly: true,
    }, null, 2), 'utf-8');

    const { resolveAnthropicBaseUrl } = require('../../src/utils/proxyBaseUrl');
    const baseUrl = resolveAnthropicBaseUrl({
      processEnv: {},
      settingsEnv: { ANTHROPIC_BASE_URL: composeUrl('http', '127.0.0.1', 9100) },
    });

    expect(baseUrl).toBe(composeUrl('https', 'localhost', 9443));
  });

  test('keeps external Claude base when runtime proxy exists', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'proxy_server_runtime.json'), JSON.stringify({
      pid: 4321,
      host: 'localhost',
      port: 9443,
      httpPort: null,
      httpsPort: 9443,
      httpsEnabled: true,
      httpsOnly: true,
    }, null, 2), 'utf-8');

    const { resolveAnthropicBaseUrl } = require('../../src/utils/proxyBaseUrl');
    const baseUrl = resolveAnthropicBaseUrl({
      processEnv: {},
      settingsEnv: { ANTHROPIC_BASE_URL: 'https://api.example.com' },
    });

    expect(baseUrl).toBe('https://api.example.com');
  });

  test('builds OpenAI proxy base from runtime endpoint for CLI hints', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'proxy_server_runtime.json'), JSON.stringify({
      pid: 4321,
      host: 'localhost',
      port: 9443,
      httpPort: null,
      httpsPort: 9443,
      httpsEnabled: true,
      httpsOnly: true,
    }, null, 2), 'utf-8');

    const { resolveLocalProxyOpenAiBaseUrl } = require('../../src/utils/proxyBaseUrl');
    const baseUrl = resolveLocalProxyOpenAiBaseUrl({});

    expect(baseUrl).toBe(`${composeUrl('https', 'localhost', 9443)}/v1`);
  });
});
