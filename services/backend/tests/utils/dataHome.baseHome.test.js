/**
 * Unit tests for dataHome ecosystem path ownership.
 *
 * Verifies the additive base (khyos) home resolver:
 *   - getBaseHome() resolves to ~/.khyos by default
 *   - KHYOS_HOME overrides it
 *   - base home stays physically separate from the app data home
 *
 * The base resolver is additive: it must not change the app data home, so a
 * running khyquant install keeps reading/writing its existing data.
 */

const os = require('os');
const path = require('path');

describe('dataHome — ecosystem base/app path isolation', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
    jest.resetModules();
  });

  test('getBaseHome() defaults to ~/.khyos', () => {
    delete process.env.KHYOS_HOME;
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(d.getBaseHome()).toBe(path.join(os.homedir(), '.khyos'));
  });

  test('KHYOS_HOME overrides the base home', () => {
    process.env.KHYOS_HOME = path.join(os.tmpdir(), 'khyos-base-test');
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(d.getBaseHome()).toBe(path.resolve(process.env.KHYOS_HOME));
  });

  test('getBaseDataDir() nests under the base home', () => {
    delete process.env.KHYOS_HOME;
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    expect(d.getBaseDataDir('data')).toBe(path.join(os.homedir(), '.khyos', 'data'));
  });

  test('base home is physically separate from the app data home (red line)', () => {
    delete process.env.KHYOS_HOME;
    jest.resetModules();
    const d = require('../../src/utils/dataHome');
    const base = d.getBaseHome();
    const app = d.getDataHome();
    expect(base).not.toBe(app);
    expect(base.startsWith(app + path.sep)).toBe(false);
    expect(app.startsWith(base + path.sep)).toBe(false);
  });
});
