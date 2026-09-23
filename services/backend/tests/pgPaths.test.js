'use strict';
/**
 * pgPaths: single-source PG install discovery (the F12 fix for start-with-db.js
 * and server.js hardcoding C:/D: absolute PG paths, in violation of rule 1).
 */

const { discoverPgBasePaths, findPostgresInstall } = require('../src/utils/pgPaths');

const winExists = (drive, bases) => (p) => {
  const hasDrive = drive && (p === `${drive}:\\` || p.startsWith(`${drive}:\\`));
  const hasBase = bases.some((b) => p === b || p.startsWith(b));
  return hasDrive || hasBase;
};

describe('pgPaths discovery', () => {
  test('PG_HOME override wins outright (single explicit path)', () => {
    const paths = discoverPgBasePaths({
      platform: 'win32',
      env: { PG_HOME: 'C:\\PG' },
      fsExistsSync: () => true,
    });
    expect(paths).toEqual(['C:\\PG']);
  });

  test('non-Windows returns the static common locations', () => {
    const paths = discoverPgBasePaths({ platform: 'linux', env: {} });
    expect(paths).toContain('/usr/lib/postgresql');
    expect(paths).toContain('/usr/local/pgsql');
  });

  test('Windows scans accessible drives x versions (no hardcoded single path)', () => {
    const paths = discoverPgBasePaths({
      platform: 'win32',
      env: {},
      fsExistsSync: winExists('D', []),
    });
    // It must include the D: drive candidates for the known versions.
    expect(paths.some((p) => p.startsWith('D:\\Program Files\\PostgreSQL\\18'))).toBe(true);
    expect(paths.some((p) => p.startsWith('D:\\Program Files (x86)\\PostgreSQL\\14'))).toBe(true);
    // And it must not be a single fixed literal — it derives from the drive scan.
    expect(paths.length).toBeGreaterThan(1);
  });

  test('findPostgresInstall picks the first base with pg_ctl + data present', () => {
    const base = 'D:\\Program Files\\PostgreSQL\\17';
    const found = findPostgresInstall({
      platform: 'win32',
      env: { PG_HOME: base },
      fsExistsSync: (p) => p.startsWith(base),
    });
    expect(found).not.toBeNull();
    expect(found.basePath).toBe(base);
    expect(found.pgCtlPath).toContain('pg_ctl.exe');
    expect(found.pgDataPath).toContain('data');
  });
});
