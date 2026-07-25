'use strict';

/**
 * deviceAppsPolicy.test.js — 设备应用管理器纯叶子决策层验收测试。
 *
 * 全程零 IO:平台探测由注入谓词提供,包管理器输出为内存字符串样本。
 * 覆盖:
 *   - detectPackageManager 平台优先级矩阵(win32→winget/choco/scoop、darwin→brew、
 *     linux→apt/dnf/pacman)+ 谓词缺失/未知平台/异常谓词的诚实降级
 *   - buildList/Uninstall/Install 命令为 argv 数组、浅拷贝、镜像原表
 *   - isSafeAppId 白名单字符集:接受真实 winget/apt/brew/pacman 标识、
 *     硬拒空白/元字符/前导 `-`/空/超长(防选项注入)
 *   - 不安全 appId → 命令构造器返回 null(拒绝而非 throw)
 *   - parseListOutput 各包管理器样本 → 结构化记录 + 未知解析器返回 []
 *   - classifyInstallSource:url / appId / invalid 三分类
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../../../src/services/deviceApps/deviceAppsPolicy');

// 谓词工厂:给定「已装 bin 集合」。
function hasExe(set) {
  const s = new Set(set);
  return (bin) => s.has(bin);
}

// ── detectPackageManager 矩阵 ────────────────────────────────────────

describe('detectPackageManager — 平台优先级矩阵', () => {
  test('win32 优先 winget', () => {
    const pm = policy.detectPackageManager('win32', hasExe(['winget', 'choco', 'scoop']));
    assert.equal(pm && pm.id, 'winget');
  });

  test('win32 无 winget 时退 choco', () => {
    const pm = policy.detectPackageManager('win32', hasExe(['choco', 'scoop']));
    assert.equal(pm && pm.id, 'choco');
  });

  test('win32 仅 scoop', () => {
    const pm = policy.detectPackageManager('win32', hasExe(['scoop']));
    assert.equal(pm && pm.id, 'scoop');
  });

  test('darwin → brew', () => {
    const pm = policy.detectPackageManager('darwin', hasExe(['brew']));
    assert.equal(pm && pm.id, 'brew');
  });

  test('linux 优先 apt(探测 apt-get)', () => {
    const pm = policy.detectPackageManager('linux', hasExe(['apt-get', 'dnf']));
    assert.equal(pm && pm.id, 'apt');
  });

  test('linux 无 apt 退 dnf', () => {
    const pm = policy.detectPackageManager('linux', hasExe(['dnf']));
    assert.equal(pm && pm.id, 'dnf');
  });

  test('linux 仅 pacman', () => {
    const pm = policy.detectPackageManager('linux', hasExe(['pacman']));
    assert.equal(pm && pm.id, 'pacman');
  });

  test('无任何可用包管理器 → null', () => {
    assert.equal(policy.detectPackageManager('linux', hasExe([])), null);
  });

  test('未知平台 → null', () => {
    assert.equal(policy.detectPackageManager('aix', hasExe(['apt-get'])), null);
  });

  test('谓词非函数 → null(不抛)', () => {
    assert.equal(policy.detectPackageManager('linux', null), null);
  });

  test('谓词抛异常被吞 → 跳过该 bin', () => {
    const throwing = (bin) => { if (bin === 'apt-get') throw new Error('boom'); return bin === 'pacman'; };
    const pm = policy.detectPackageManager('linux', throwing);
    assert.equal(pm && pm.id, 'pacman');
  });
});

// ── argv 命令构造 ────────────────────────────────────────────────────

describe('buildListCommand', () => {
  test('返回 argv 数组且为拷贝', () => {
    const pm = policy.PACKAGE_MANAGERS.apt;
    const argv = policy.buildListCommand(pm);
    assert.deepEqual(argv, ['dpkg', '-l']);
    argv.push('mutated');
    assert.deepEqual(pm.list, ['dpkg', '-l']); // 原表不受污染
  });
  test('pm 无效 → null', () => {
    assert.equal(policy.buildListCommand(null), null);
    assert.equal(policy.buildListCommand({}), null);
  });
});

describe('buildUninstallCommand', () => {
  test('winget 卸载 argv', () => {
    const argv = policy.buildUninstallCommand(policy.PACKAGE_MANAGERS.winget, 'Microsoft.VisualStudioCode');
    assert.deepEqual(argv, ['winget', 'uninstall', '--id', 'Microsoft.VisualStudioCode', '--exact', '--silent']);
  });
  test('apt 卸载 argv', () => {
    const argv = policy.buildUninstallCommand(policy.PACKAGE_MANAGERS.apt, 'python3-pip');
    assert.deepEqual(argv, ['apt-get', 'remove', '-y', 'python3-pip']);
  });
  test('不安全 appId → null(拒绝)', () => {
    assert.equal(policy.buildUninstallCommand(policy.PACKAGE_MANAGERS.apt, 'foo; rm -rf /'), null);
    assert.equal(policy.buildUninstallCommand(policy.PACKAGE_MANAGERS.apt, '-rf'), null);
  });
});

describe('buildInstallCommand', () => {
  test('brew 安装 argv', () => {
    const argv = policy.buildInstallCommand(policy.PACKAGE_MANAGERS.brew, 'gnu-tar');
    assert.deepEqual(argv, ['brew', 'install', 'gnu-tar']);
  });
  test('winget 安装带静默/同意标志', () => {
    const argv = policy.buildInstallCommand(policy.PACKAGE_MANAGERS.winget, 'Git.Git');
    assert.deepEqual(argv, ['winget', 'install', '--id', 'Git.Git', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements']);
  });
  test('不安全 appId → null', () => {
    assert.equal(policy.buildInstallCommand(policy.PACKAGE_MANAGERS.brew, 'a b'), null);
  });
});

// ── isSafeAppId 字符集守卫 ───────────────────────────────────────────

describe('isSafeAppId — 白名单', () => {
  const ok = [
    'Microsoft.VisualStudioCode', 'Git.Git', '7zip.7zip', // winget
    'python3-pip', 'g++', 'libssl-dev', 'base-devel',      // apt/pacman
    'python@3.12', 'gnu-tar',                              // brew
    'foo_bar', 'a', 'node:lts',
  ];
  for (const id of ok) {
    test(`接受 ${id}`, () => assert.equal(policy.isSafeAppId(id), true));
  }
  const bad = [
    '', '   ', '-rf', '--force', 'foo; rm -rf /', 'a b', 'foo|bar',
    'foo$(x)', 'foo`x`', 'foo&bar', 'foo>out', 'foo\nbar', 'foo"x', "foo'x",
    'a'.repeat(201), null, undefined, 42, {},
  ];
  for (const id of bad) {
    test(`拒绝 ${JSON.stringify(id)}`, () => assert.equal(policy.isSafeAppId(id), false));
  }
});

// ── 输出解析 ─────────────────────────────────────────────────────────

describe('parseListOutput', () => {
  test('dpkg', () => {
    const out = [
      'Desired=Unknown/Install/Remove/Purge/Hold',
      '| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend',
      '||/ Name           Version      Architecture Description',
      '+++-==============-============-============-=================================',
      'ii  python3-pip    22.0.2+dfsg  all          Python package installer',
      'ii  vim:amd64      2:8.2.3995   amd64        Vi IMproved',
      'rc  removed-pkg    1.0          all          leftover config',
    ].join('\n');
    const recs = policy.parseListOutput('dpkg', out);
    assert.deepEqual(recs, [
      { name: 'python3-pip', id: 'python3-pip', version: '22.0.2+dfsg' },
      { name: 'vim', id: 'vim', version: '2:8.2.3995' },
    ]); // rc(仅残留配置)不计为已安装
  });

  test('brew', () => {
    const recs = policy.parseListOutput('brew', 'git 2.39.0\nnode 20.5.0 20.4.0\n');
    assert.deepEqual(recs, [
      { name: 'git', id: 'git', version: '2.39.0' },
      { name: 'node', id: 'node', version: '20.5.0 20.4.0' },
    ]);
  });

  test('pacman', () => {
    const recs = policy.parseListOutput('pacman', 'bash 5.1.016-1\nvim 8.2.3-2\n');
    assert.deepEqual(recs, [
      { name: 'bash', id: 'bash', version: '5.1.016-1' },
      { name: 'vim', id: 'vim', version: '8.2.3-2' },
    ]);
  });

  test('choco pipe 分隔', () => {
    const recs = policy.parseListOutput('choco', 'git|2.39.0\nvscode|1.80.0\n2 packages installed.');
    assert.deepEqual(recs, [
      { name: 'git', id: 'git', version: '2.39.0' },
      { name: 'vscode', id: 'vscode', version: '1.80.0' },
    ]);
  });

  test('winget 按列偏移切', () => {
    // 真实 winget 把每列补齐到该列最宽值;用 padEnd 精确复现对齐(避免手数空格)。
    const nameW = 20, idW = 28, verW = 10, availW = 10;
    const col = (n, id, v, a, s) =>
      n.padEnd(nameW) + id.padEnd(idW) + v.padEnd(verW) + a.padEnd(availW) + s;
    const out = [
      col('Name', 'Id', 'Version', 'Available', 'Source'),
      '-'.repeat(nameW + idW + verW + availW + 6),
      col('Visual Studio Code', 'Microsoft.VisualStudioCode', '1.80.0', '', 'winget'),
      col('Git', 'Git.Git', '2.39.0', '', 'winget'),
    ].join('\n');
    const recs = policy.parseListOutput('winget', out);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].id, 'Microsoft.VisualStudioCode');
    assert.equal(recs[0].name, 'Visual Studio Code');
    assert.equal(recs[1].id, 'Git.Git');
    assert.equal(recs[1].version, '2.39.0');
  });

  test('未知解析器 → []', () => {
    assert.deepEqual(policy.parseListOutput('nope', 'x'), []);
  });

  test('空/垃圾输入不抛', () => {
    assert.deepEqual(policy.parseListOutput('dpkg', ''), []);
    assert.deepEqual(policy.parseListOutput('brew', null), []);
  });
});

// ── classifyInstallSource ────────────────────────────────────────────

describe('classifyInstallSource', () => {
  test('http/https → url', () => {
    assert.equal(policy.classifyInstallSource('https://example.com/app.exe'), 'url');
    assert.equal(policy.classifyInstallSource('http://example.com/x'), 'url');
  });
  test('安全标识 → appId', () => {
    assert.equal(policy.classifyInstallSource('Microsoft.VisualStudioCode'), 'appId');
  });
  test('危险/空 → invalid', () => {
    assert.equal(policy.classifyInstallSource('foo; rm'), 'invalid');
    assert.equal(policy.classifyInstallSource(''), 'invalid');
    assert.equal(policy.classifyInstallSource(null), 'invalid');
    assert.equal(policy.classifyInstallSource('ftp://x/y'), 'invalid');
  });
});
