'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

jest.mock('../../src/middleware/auth', () => ({
  authenticateToken: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

function composeUrl(scheme, host, port) {
  return `${scheme}://${host}:${port}`;
}

function getJson(app, pathname) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const req = http.get({
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close(() => {
            try {
              resolve({
                status: res.statusCode,
                body: JSON.parse(body),
              });
            } catch (err) {
              reject(err);
            }
          });
        });
      });
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
    });
  });
}

describe('aiGatewayAdmin model slots baseUrl', () => {
  const ORIGINAL_ENV = { ...process.env };
  let tempHome = null;
  let homedirSpy = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ai-gw-admin-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env = {
      ...ORIGINAL_ENV,
      KHY_DATA_HOME: path.join(tempHome, '.khy'),
    };
    // Scrub any inherited base-url overrides so the test exercises the
    // runtime-vs-settings precedence in isolation, not the host's real config.
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.RELAY_API_ENDPOINT;
    delete process.env.PROXY_SERVER_HOST;
    delete process.env.PROXY_SERVER_PORT;
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

  test('GET /model-slots prefers proxy runtime base over stale local Claude settings base', async () => {
    const dataHome = process.env.KHY_DATA_HOME;
    fs.mkdirSync(dataHome, { recursive: true });
    fs.writeFileSync(path.join(dataHome, 'proxy_server_runtime.json'), JSON.stringify({
      pid: 1234,
      host: 'localhost',
      port: 9443,
      httpPort: null,
      httpsPort: 9443,
      httpsEnabled: true,
      httpsOnly: true,
    }, null, 2), 'utf-8');

    const settingsDir = path.join(tempHome, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: composeUrl('http', '127.0.0.1', 9100),
      },
    }, null, 2), 'utf-8');

    const router = require('../../src/routes/aiGatewayAdmin');
    const app = express();
    app.use(express.json());
    app.use('/', router);

    const res = await getJson(app, '/model-slots');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.baseUrl).toBe(composeUrl('https', 'localhost', 9443));
  });
});
