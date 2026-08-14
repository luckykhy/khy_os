'use strict';

const { posixPathToWindows, windowsPathToPosix } = require('../../src/utils/pathCompat');

describe('pathCompat windows path conversion', () => {
  test('converts WSL mount path to Windows path', () => {
    expect(posixPathToWindows('/mnt/c/Users/Alice/Desktop/demo.txt'))
      .toBe('C:\\Users\\Alice\\Desktop\\demo.txt');
  });

  test('converts Git Bash style drive path to Windows path', () => {
    expect(posixPathToWindows('/d/workspace/project'))
      .toBe('D:\\workspace\\project');
  });

  test('converts Cygwin style drive path to Windows path', () => {
    expect(posixPathToWindows('/cygdrive/e/tools/bin'))
      .toBe('E:\\tools\\bin');
  });

  test('converts Windows drive path to POSIX path', () => {
    expect(windowsPathToPosix('C:\\Users\\Alice\\Desktop\\demo.txt'))
      .toBe('/c/Users/Alice/Desktop/demo.txt');
  });
});
