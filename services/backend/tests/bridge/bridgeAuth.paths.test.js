'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('bridgeAuth portable paths', () => {
  const oldEnv = { ...process.env };
  let tempRoot;
  let auth;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-bridge-paths-'));
    process.env.KHY_DATA_HOME = path.join(tempRoot, '.khy');
    delete process.env.KHY_APP_HOME;
    delete process.env.BRIDGE_DATA_DIR;
    jest.resetModules();
    auth = require('../../src/bridge/bridgeAuth');
  });

  afterEach(() => {
    process.env = { ...oldEnv };
    jest.resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('uses the unified application data home by default', () => {
    const paths = auth.resolveBridgePaths();
    expect(paths.dataDir).toBe(path.join(path.resolve(process.env.KHY_DATA_HOME), 'bridge'));
    expect(paths.dbPath).toBe(path.join(paths.dataDir, 'bridge-users.db'));
    expect(paths.secretPath).toBe(path.join(paths.dataDir, '.bridge_jwt_secret'));
  });

  test('explicit BRIDGE_DATA_DIR takes precedence', () => {
    const explicit = path.join(tempRoot, 'bridge state');
    const paths = auth.resolveBridgePaths({
      BRIDGE_DATA_DIR: explicit,
      KHY_DATA_HOME: path.join(tempRoot, 'ignored'),
    });
    expect(paths.dataDir).toBe(path.resolve(explicit));
  });

  test('portable deployment uses the project data home consistently', () => {
    delete process.env.KHY_DATA_HOME;
    delete process.env.KHYQUANT_DATA_HOME;
    process.env.KHY_PORTABLE_ROOT = tempRoot;
    process.env.KHY_PROJECT_DATA_HOME = path.join(tempRoot, 'portable project data');
    jest.resetModules();
    auth = require('../../src/bridge/bridgeAuth');

    expect(auth.resolveBridgeDataDir()).toBe(
      path.join(path.resolve(process.env.KHY_PROJECT_DATA_HOME), 'bridge')
    );
  });
});
