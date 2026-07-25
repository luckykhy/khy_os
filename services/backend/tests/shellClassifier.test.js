'use strict';

/**
 * shellClassifier — read-only classification of system diagnostic commands.
 *
 * Regression guard for the syscall-gateway over-classification fix: read-only
 * diagnostics (wmic ... get, systeminfo, tasklist, reg query, sc query,
 * systemctl status) must report read-only so the gateway treats them as L0/L1
 * instead of forcing the L2 "type YES" red-line gate. Their mutating forms
 * (wmic ... call create, reg add, sc create) must stay NON-read-only so the
 * critical red line is never weakened.
 */

const {
  isSearchOrReadCommand,
  getCommandTokens,
  READONLY_VERB_GATED,
} = require('../src/tools/shellClassifier');

const isReadOnly = (cmd) => {
  const { isSearch, isRead, isList } = isSearchOrReadCommand(cmd);
  return isSearch || isRead || isList;
};

describe('shellClassifier — read-only diagnostics (no mutating form)', () => {
  test.each([
    'systeminfo',
    'hostname',
    'whoami',
    'uname -a',
    'tasklist',
    'tasklist /v',
    'ps aux',
    'lsblk',
    'uptime',
    'nproc',
  ])('%s → read-only', (cmd) => {
    expect(isReadOnly(cmd)).toBe(true);
  });
});

describe('shellClassifier — verb-gated commands', () => {
  test.each([
    ['wmic OS get FreePhysicalMemory', true],
    ['wmic OS get FreePhysicalMemory,TotalVisibleMemorySize', true],
    ['wmic diskdrive get Model,Size,MediaType,Status', true],
    ['wmic process list brief', true],
    ['wmic process call create "calc.exe"', false],
    ['wmic process where name="x" delete', false],
    ['reg query HKLM\\Software', true],
    ['reg add HKLM\\Software /v X /d 1', false],
    ['reg delete HKLM\\Software /f', false],
    ['sc query', true],
    ['sc queryex spooler', true],
    ['sc create svc binPath= x', false],
    ['sc delete svc', false],
    ['systemctl status nginx', true],
    ['systemctl is-active nginx', true],
    ['systemctl start nginx', false],
    ['systemctl restart nginx', false],
  ])('%s → read-only=%s', (cmd, expected) => {
    expect(isReadOnly(cmd)).toBe(expected);
  });

  test('the verb-gated map covers the expected base commands', () => {
    expect([...READONLY_VERB_GATED.keys()].sort()).toEqual(
      ['reg', 'sc', 'systemctl', 'wmic'],
    );
  });

  test('getCommandTokens strips env/sudo prefixes and lowercases', () => {
    expect(getCommandTokens('sudo wmic OS get FreePhysicalMemory'))
      .toEqual(['wmic', 'os', 'get', 'freephysicalmemory']);
    expect(getCommandTokens('FOO=bar reg query HKLM'))
      .toEqual(['reg', 'query', 'hklm']);
  });
});

describe('shellClassifier — destructive ops stay non-read-only', () => {
  test.each([
    'rm -rf ./build',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sda1',
    'npm install -g something',
  ])('%s → NOT read-only', (cmd) => {
    expect(isReadOnly(cmd)).toBe(false);
  });

  test('a pipeline mixing a read with a write is NOT read-only', () => {
    expect(isReadOnly('systeminfo > out.txt')).toBe(false);
    expect(isReadOnly('wmic OS get FreePhysicalMemory && rm -rf x')).toBe(false);
    expect(isReadOnly('cat a | rm b')).toBe(false);
  });

  test('a pure read pipeline stays read-only', () => {
    expect(isReadOnly('cat a | grep b | sort')).toBe(true);
    expect(isReadOnly('wmic OS get FreePhysicalMemory | findstr 0')).toBe(false); // findstr not whitelisted
  });
});
