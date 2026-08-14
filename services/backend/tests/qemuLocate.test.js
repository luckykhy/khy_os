'use strict';

/**
 * 离线确定性单测:纯叶子 qemuLocate(PATH 缺失时在常见安装位置自动定位已装 QEMU)。
 *
 * 全部 IO(存在性检查 exists、目录枚举 readdir)依赖注入,零真实 fs、零网络。覆盖:
 * 门控默认开/关值、exe 名随平台、Windows 目录派生 + 去重、locateSystemQemu 命中
 * (Program Files / winget 包扫描)、未命中、门控关字节回退、坏输入 fail-soft。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const LEAF_PATH = path.resolve(
  __dirname, '..', '..', '..',
  'platform', 'packages', 'shared', 'src', 'runtime', 'khyos', 'qemuLocate',
);
const {
  autolocateEnabled,
  qemuExeName,
  windowsQemuSearchDirs,
  unixQemuSearchDirs,
  locateSystemQemu,
  DEFAULT_QEMU_EXE,
  WINGET_QEMU_PREFIX,
} = require(LEAF_PATH);

const NEVER = () => false;
const NO_DIRS = () => [];

describe('qemuLocate.autolocateEnabled', () => {
  test('默认开(未设/空串/1)', () => {
    assert.equal(autolocateEnabled(undefined), true);
    assert.equal(autolocateEnabled({}), true);
    assert.equal(autolocateEnabled({ KHY_QEMU_AUTOLOCATE: '' }), true);
    assert.equal(autolocateEnabled({ KHY_QEMU_AUTOLOCATE: '1' }), true);
  });

  test('关值 {0,false,no,off}(大小写/空白无关)', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF', 'False', '  off  ']) {
      assert.equal(autolocateEnabled({ KHY_QEMU_AUTOLOCATE: v }), false, v);
    }
  });
});

describe('qemuLocate.qemuExeName', () => {
  test('Windows 带 .exe,其余不带', () => {
    assert.equal(qemuExeName('win32'), `${DEFAULT_QEMU_EXE}.exe`);
    assert.equal(qemuExeName('linux'), DEFAULT_QEMU_EXE);
    assert.equal(qemuExeName('darwin'), DEFAULT_QEMU_EXE);
    assert.equal(qemuExeName(undefined), DEFAULT_QEMU_EXE);
  });
});

describe('qemuLocate.windowsQemuSearchDirs', () => {
  test('从环境变量派生 + 去重(保序)', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      ProgramW6432: 'C:\\Program Files', // 与 ProgramFiles 同 → 去重
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      SystemDrive: 'C:',
    };
    const dirs = windowsQemuSearchDirs(env);
    assert.ok(dirs.includes(path.join('C:\\Program Files', 'qemu')));
    assert.ok(dirs.includes(path.join('C:\\Program Files (x86)', 'qemu')));
    assert.ok(dirs.includes(path.join('C:\\Users\\u\\AppData\\Local', 'Programs', 'qemu')));
    // 去重:无重复项。
    assert.equal(dirs.length, new Set(dirs).size);
  });

  test('坏输入 fail-soft(返回数组,绝不抛)', () => {
    assert.ok(Array.isArray(windowsQemuSearchDirs(undefined)));
    assert.ok(Array.isArray(windowsQemuSearchDirs(null)));
    assert.ok(Array.isArray(windowsQemuSearchDirs({})));
  });
});

describe('qemuLocate.unixQemuSearchDirs', () => {
  test('含常见 Homebrew / 本地位置', () => {
    const dirs = unixQemuSearchDirs();
    assert.ok(dirs.includes('/usr/local/bin'));
    assert.ok(dirs.includes('/opt/homebrew/bin'));
  });
});

describe('qemuLocate.locateSystemQemu', () => {
  test('Windows: 命中 C:\\Program Files\\qemu', () => {
    const env = { ProgramFiles: 'C:\\Program Files', SystemDrive: 'C:' };
    const target = path.join('C:\\Program Files', 'qemu', 'qemu-system-x86_64.exe');
    const found = locateSystemQemu({
      platform: 'win32', env,
      exists: (p) => p === target,
      readdir: NO_DIRS,
    });
    assert.equal(found, target);
  });

  test('Windows: winget 包目录扫描命中', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const pkg = `${WINGET_QEMU_PREFIX}_Microsoft.Winget.Source_x`;
    const base = path.join('C:\\Users\\u\\AppData\\Local', 'Microsoft', 'WinGet', 'Packages');
    const target = path.join(base, pkg, 'qemu-system-x86_64.exe');
    const found = locateSystemQemu({
      platform: 'win32', env,
      exists: (p) => p === target,
      readdir: (d) => (d === base ? [pkg, 'SomethingElse'] : (() => { throw new Error('ENOENT'); })()),
    });
    assert.equal(found, target);
  });

  test('未命中 → null', () => {
    const found = locateSystemQemu({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: NEVER,
      readdir: NO_DIRS,
    });
    assert.equal(found, null);
  });

  test('门控关 → null(字节回退今日只探 PATH)', () => {
    const found = locateSystemQemu({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', KHY_QEMU_AUTOLOCATE: '0' },
      exists: () => true, // 即便什么都"存在"也不定位
      readdir: NO_DIRS,
    });
    assert.equal(found, null);
  });

  test('Unix: 命中 /usr/local/bin', () => {
    const target = path.join('/usr/local/bin', 'qemu-system-x86_64');
    const found = locateSystemQemu({
      platform: 'linux', env: {},
      exists: (p) => p === target,
      readdir: NO_DIRS,
    });
    assert.equal(found, target);
  });

  test('exists 抛错 → 单候选跳过,不影响其余(fail-soft)', () => {
    const target = path.join('/usr/bin', 'qemu-system-x86_64');
    const found = locateSystemQemu({
      platform: 'linux', env: {},
      exists: (p) => {
        if (p === target) return true;
        throw new Error('EACCES'); // 其余候选抛错
      },
      readdir: NO_DIRS,
    });
    assert.equal(found, target);
  });

  test('无 exists 注入 → null(不可无 IO 定位)', () => {
    assert.equal(locateSystemQemu({ platform: 'win32', env: {} }), null);
    assert.equal(locateSystemQemu(undefined), null);
    assert.equal(locateSystemQemu({}), null);
  });
});
