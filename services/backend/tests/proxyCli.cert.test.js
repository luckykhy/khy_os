'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('proxy CLI cert helpers', () => {
  const originalEnv = { ...process.env };
  let tempHome = null;

  function mockOsHome(homeDir) {
    jest.doMock('os', () => {
      const actual = jest.requireActual('os');
      return { ...actual, homedir: () => homeDir };
    });
  }

  afterEach(() => {
    jest.resetModules();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    tempHome = null;
  });

  test('auto-generates default cert/key when https enabled and no tls files provided', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-cli-cert-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    const spawnSync = jest.fn((cmd, args) => {
      if (cmd !== 'openssl') return { status: 1, stderr: 'unknown binary' };
      if (args[0] === 'version') return { status: 0, stdout: 'OpenSSL 3.0.0' };
      if (args[0] === 'req') {
        const outPath = args[args.indexOf('-out') + 1];
        const keyPath = args[args.indexOf('-keyout') + 1];
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(outPath, 'CERT', 'utf8');
        fs.writeFileSync(keyPath, 'KEY', 'utf8');
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stderr: 'unexpected args' };
    });

    jest.doMock('child_process', () => ({
      spawn: jest.fn(),
      spawnSync,
    }));

    const handler = require('../src/cli/handlers/proxy');
    const result = handler.__test__.ensureHttpsTlsOptions({ https: true }, { quiet: true });
    const certFile = result.options['tls-cert'];
    const keyFile = result.options['tls-key'];

    expect(certFile).toBe(path.join(tempHome, '.khyquant', 'proxy_certs', 'localhost.crt'));
    expect(keyFile).toBe(path.join(tempHome, '.khyquant', 'proxy_certs', 'localhost.key'));
    expect(fs.existsSync(certFile)).toBe(true);
    expect(fs.existsSync(keyFile)).toBe(true);

    const reqCalls = spawnSync.mock.calls.filter(([, args]) => args && args[0] === 'req');
    expect(reqCalls.length).toBe(1);
  });

  test('reuses existing cert/key without invoking openssl req', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-cli-cert-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    const certFile = path.join(tempHome, '.khyquant', 'proxy_certs', 'localhost.crt');
    const keyFile = path.join(tempHome, '.khyquant', 'proxy_certs', 'localhost.key');
    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.writeFileSync(certFile, 'CERT', 'utf8');
    fs.writeFileSync(keyFile, 'KEY', 'utf8');

    const spawnSync = jest.fn(() => ({ status: 0, stdout: 'OpenSSL 3.0.0' }));
    jest.doMock('child_process', () => ({
      spawn: jest.fn(),
      spawnSync,
    }));

    const handler = require('../src/cli/handlers/proxy');
    const result = handler.__test__.ensureHttpsTlsOptions({ https: true }, { quiet: true });

    expect(result.certInfo.generated).toBe(false);
    const reqCalls = spawnSync.mock.calls.filter(([, args]) => args && args[0] === 'req');
    expect(reqCalls.length).toBe(0);
  });

  test('throws when tls-cert/tls-key are incomplete', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-cli-cert-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    jest.doMock('child_process', () => ({
      spawn: jest.fn(),
      spawnSync: jest.fn(),
    }));

    const handler = require('../src/cli/handlers/proxy');
    expect(() => handler.__test__.ensureHttpsTlsOptions({
      https: true,
      'tls-cert': '/tmp/server.crt',
    })).toThrow(/同时提供 --tls-cert 与 --tls-key/);
  });

  test('throws when openssl is unavailable and cert files are absent', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-proxy-cli-cert-'));
    process.env.HOME = tempHome;
    mockOsHome(tempHome);

    jest.doMock('child_process', () => ({
      spawn: jest.fn(),
      spawnSync: jest.fn(() => ({ status: 1, stderr: 'not found' })),
    }));

    const handler = require('../src/cli/handlers/proxy');
    expect(() => handler.__test__.ensureHttpsTlsOptions({ https: true }, { quiet: true }))
      .toThrow(/未检测到 openssl/);
  });
});
