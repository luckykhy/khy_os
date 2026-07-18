'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function composeUrl(host, port) {
  return `http://${host}:${port}`;
}

describe('gateway manage API display discovery', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempHome = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-manage-'));
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
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = null;
  });

  test('prefers live runtime apiPort over env fallback', () => {
    process.env.KHY_DAEMON_PORT = '29090';

    const handler = require('../src/cli/handlers/gateway');

    expect(handler.__test__._resolveAiManageApiBaseUrl({ apiPort: 19090 }, {}))
      .toBe(composeUrl('127.0.0.1', 19090));
  });

  test('falls back to discovered local runtime and ignores external AI_BACKEND_URL', () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'ai_manage_runtime.json'), JSON.stringify({
      apiPort: 39090,
    }, null, 2), 'utf-8');
    process.env.AI_BACKEND_URL = 'https://api.example.com';

    const handler = require('../src/cli/handlers/gateway');

    expect(handler.__test__._resolveAiManageApiBaseUrl({}, {}))
      .toBe(composeUrl('localhost', 39090));
  });

  test('falls back to daemon env port when runtime is absent', () => {
    process.env.KHY_DAEMON_PORT = '49090';

    const handler = require('../src/cli/handlers/gateway');

    expect(handler.__test__._resolveAiManageApiBaseUrl({}, {}))
      .toBe(composeUrl('localhost', 49090));
  });
});
