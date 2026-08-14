'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDdH5lCs73FC3kE
HttfCsA3MJeb2GJE7dMZ04eCqMwsyFyaWlpzAtwehGdaUTvYsRKAlTRfSHzsHurJ
KmJZru1qTcJhRI0i/X7qNzgR4ytwqLFz2grvqAszzB+E+GzBVNqAabRKu6s+U2vl
oFXLqm8wJaHy24Y/Laz8oTnDRQ/2zy883ylzuGrWvqW4Da4fx20Thvhs+q9BO7Np
tasgwd9eY/I8ZlHLHIOmao+dDu4CLHt1/Z1yclpgLppgNKFUx6rfpZUjECSle0Gw
lKIiq6pMRLd1tIpCfpaytNV8oCcrSZ1hErRXvRo3mvlsiscocQZ60sqJRyLyTWOb
LokbHD39AgMBAAECggEAVkMR+G4DLaAEpUFeZgzdIIqh0mfPKkG3FT+qgSPVhvDh
A0wVNgHbGkKfySGgna+yXpwWUseGCF0lTbXtqTvvHYXZOzXRc2F+BePlyUCcfTYq
B957XrPpLttGPorlbmRqWychcPgWXVmQ4YMzhSDngFpl+8Z88B+i+OjyjkVebXL7
JWvmHTlp9aibHS9nXF+ALW4Uv73kZ6gIec/Oj2aeeEJnbaNgc/+23+P+XlANtQxf
oM0o7+examVLazbQlto7n89ZzOGf1kFb0OAVzJns2vRV27KpCDxErZ10nDllsNdz
RD9l5a+BF6BItsqUyNS3aQRoOdjHe0M+am5P4QedBwKBgQDl28pn34GodDJTljzG
e3MRiiy8HFPSQTHgDAFdLDA5QK4CTC0YYzFfbxamXQjUab7aGbJ4IgvPPtzTkrtA
P+ugwOMiJH5fRHUbZm57Rgglax7W8LkRP2TygndqsSsuHC89Yx93vRMdcZSrzvNI
lfpZwCR5a2c1kM7USVbYY2N/vwKBgQD2RX1RUNm4gZz1um+Bxp2jUO+iYqixt9CC
YvkvmTpFVeumkmrwOfYye9a4P3bAkBn+fZqv/Wkg72/jSOnQNdHGvdaGPL3U3EdC
Uajr0p+W383mFh8/SaEjuLO/8Hr04ZJw5aquKrvIbHlCnY3EFDaeVUKRhLggfL9u
1d9/VvHxQwKBgFCoWJUsi93lsEc+f+MSLKWp+9qighNUh0DcVZoxSFa+yJDL1EMr
g4a+f48vNEr9NFhqDgMzxzsZDvo7EfQQugk1xj4T2jhp2EIeJoShZXhj53V7ESXp
Pe4PNAI/WyyZ/UWoQ8GLmmqJkabcPuhooGngD6x/sL7OKpW5inzyG1cXAoGAHGar
KyON2E9qUJRto6PKLjl5SVrjZYtzSnYrkqezJqfgA1fDaWzlzbCmdJ0tDswPk1/c
5QrugtPaLXYNMOvkA22FPfnnUpMMzMMqHfguW3H4Bt7qP5w4Lyxv3mTXaUJSZx61
blyTR2vrGBmfbct++QeQI8QQj/6S/S9BFShrwo0CgYEAoaFCJWumDc4QwFo8SX5S
Bdl1WbJei7i46QerKMFzrtjJZ7EjIWgIn9U09pXB79o+0FD3QnZUo8usfQt6g8jY
NseX1Qy5CERmK4lrDEgXQA3Emje6iL0OzK1TA7eAr3DuHOk+Jl22uOoh1oQfeKH+
5zFmuNWi2N1vA+TagNLLQjk=
-----END PRIVATE KEY-----`;

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUR4Yn6hXWGR9vedWKquo/OB9lsfAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUxMjAzNDI0NloXDTI3MDUx
MjAzNDI0NlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA3R+ZQrO9xQt5BB7bXwrANzCXm9hiRO3TGdOHgqjMLMhc
mlpacwLcHoRnWlE72LESgJU0X0h87B7qySpiWa7tak3CYUSNIv1+6jc4EeMrcKix
c9oK76gLM8wfhPhswVTagGm0SrurPlNr5aBVy6pvMCWh8tuGPy2s/KE5w0UP9s8v
PN8pc7hq1r6luA2uH8dtE4b4bPqvQTuzabWrIMHfXmPyPGZRyxyDpmqPnQ7uAix7
df2dcnJaYC6aYDShVMeq36WVIxAkpXtBsJSiIquqTES3dbSKQn6WsrTVfKAnK0md
YRK0V70aN5r5bIrHKHEGetLKiUci8k1jmy6JGxw9/QIDAQABo1MwUTAdBgNVHQ4E
FgQUjMl+lDf0zaHuAb3OtZ2BHX0ouDkwHwYDVR0jBBgwFoAUjMl+lDf0zaHuAb3O
tZ2BHX0ouDkwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEArNYv
e2/6K0LUxHDnZRh7GIG7ibA1NXBwQTINuSMxFdP9FdhquYvvWMF6qfrqzmmPOeo7
qphURkyfdhTw3cwWRdUiIeVGUd6vr7vvUj/fGhWHXOVT7cwiO9fks6lfrQMmURK4
3B41VLgmgdbwKtp1zLE/vsnKYnyAcKZKUu1/lad/TWE0R7ciRFRt6NgOlkqgNhxe
t9lQSnDUXxSX4PSxnWEjNw29IKAyYzpXbGt14Vl9KvoNzdC/p6EB/t50SZnCetEm
v6CcI8Wgo+WrEQH+ak8zByvJ4b47cKP6nU84riYjZlrNHfKRs+ab8j+thpDCGwlD
/2Xs7UAOHZISceeRYA==
-----END CERTIFICATE-----`;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function requestHealth(protocol, port, token) {
  const client = protocol === 'https' ? https : http;
  return new Promise((resolve) => {
    const req = client.get({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      headers: { Authorization: `Bearer ${token}` },
      timeout: 2000,
      ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += String(chunk); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* ignore */ }
        resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, json });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, timeout: true });
    });
  });
}

describe('proxyServer HTTPS support', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;
  let proxy = null;
  let homedirSpy = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-test-'));
    homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    process.env.HOME = tempHome;
    process.env.KHY_DATA_HOME = path.join(tempHome, '.khy');
    process.env.PROXY_AUTH_TOKEN = 'khy-test-token';
    delete process.env.PROXY_ENABLE_HTTPS;
    delete process.env.PROXY_HTTPS_ONLY;
    delete process.env.PROXY_HTTPS_PORT;
    delete process.env.PROXY_TLS_CERT_FILE;
    delete process.env.PROXY_TLS_KEY_FILE;
    proxy = require('../src/services/gateway/proxyServer');
  });

  afterEach(async () => {
    if (proxy && typeof proxy.stop === 'function') {
      try { await proxy.stop(); } catch { /* ignore */ }
    }
    if (homedirSpy) {
      homedirSpy.mockRestore();
      homedirSpy = null;
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    proxy = null;
    tempHome = null;
  });

  test('starts dual HTTP+HTTPS and serves health on both', async () => {
    const httpPort = await getFreePort();
    const httpsPort = await getFreePort();
    const certFile = path.join(tempHome, 'server.crt');
    const keyFile = path.join(tempHome, 'server.key');
    fs.writeFileSync(certFile, TEST_CERT_PEM, 'utf8');
    fs.writeFileSync(keyFile, TEST_KEY_PEM, 'utf8');

    const started = await proxy.start({
      host: '127.0.0.1',
      port: httpPort,
      https: true,
      httpsPort,
      tlsCertFile: certFile,
      tlsKeyFile: keyFile,
    });

    expect(started.mode).toBe('dual');
    expect(started.http.enabled).toBe(true);
    expect(started.https.enabled).toBe(true);
    expect(started.https.port).toBe(httpsPort);

    const httpHealth = await requestHealth('http', httpPort, started.authToken);
    const httpsHealth = await requestHealth('https', httpsPort, started.authToken);

    expect(httpHealth.ok).toBe(true);
    expect(httpsHealth.ok).toBe(true);
    expect(httpHealth.json.runtime.mode).toBe('dual');
    expect(httpsHealth.json.runtime.mode).toBe('dual');
  });

  test('supports https-only mode with certificate files', async () => {
    const httpsPort = await getFreePort();
    const certFile = path.join(tempHome, 'server.crt');
    const keyFile = path.join(tempHome, 'server.key');
    fs.writeFileSync(certFile, TEST_CERT_PEM, 'utf8');
    fs.writeFileSync(keyFile, TEST_KEY_PEM, 'utf8');

    const started = await proxy.start({
      host: '127.0.0.1',
      port: httpsPort,
      httpsOnly: true,
      httpsPort,
      tlsCertFile: certFile,
      tlsKeyFile: keyFile,
    });

    expect(started.mode).toBe('https-only');
    expect(started.http.enabled).toBe(false);
    expect(started.https.enabled).toBe(true);

    const httpsHealth = await requestHealth('https', httpsPort, started.authToken);
    const httpHealth = await requestHealth('http', httpsPort, started.authToken);

    expect(httpsHealth.ok).toBe(true);
    expect(httpsHealth.json.runtime.mode).toBe('https-only');
    expect(httpHealth.ok).toBe(false);
  });

  test('auto-probes next port and persists actual runtime when requested port is occupied', async () => {
    const requestedPort = await getFreePort();
    const blocker = await holdPort(requestedPort);

    try {
      const started = await proxy.start({
        host: '127.0.0.1',
        port: requestedPort,
      });

      expect(started.mode).toBe('http-only');
      expect(started.port).not.toBe(requestedPort);
      expect(started.port).toBeGreaterThan(requestedPort);

      const health = await requestHealth('http', started.port, started.authToken);
      expect(health.ok).toBe(true);

      const runtimeFile = path.join(tempHome, '.khy', 'proxy_server_runtime.json');
      const legacyRuntimeFile = path.join(tempHome, '.khyquant', 'proxy_server_runtime.json');
      const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      const legacyRuntime = JSON.parse(fs.readFileSync(legacyRuntimeFile, 'utf8'));

      expect(runtime.httpPort).toBe(started.port);
      expect(runtime.port).toBe(started.port);
      expect(legacyRuntime.httpPort).toBe(started.port);
      expect(legacyRuntime.port).toBe(started.port);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
