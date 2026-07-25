'use strict';

// envInfoLines 叶子契约测试(node:test)。
// 核心:两条交互 /env 孪生(菜单 + 键入)对齐超集(平台/Node/工作目录/Shell/终端/版本/Git 分支),
// Git 分支空 → 省略行;门控关由 shell 侧决定回退。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  envInfoAlignEnabled,
  buildEnvInfoLines,
} = require('../../src/cli/envInfoLines');

test('envInfoAlignEnabled 默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(envInfoAlignEnabled({}), true);
  assert.strictEqual(envInfoAlignEnabled({ KHY_ENV_INFO_ALIGN: '' }), true);
  assert.strictEqual(envInfoAlignEnabled({ KHY_ENV_INFO_ALIGN: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      envInfoAlignEnabled({ KHY_ENV_INFO_ALIGN: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('全字段(含 gitBranch)→ 7 行超集,顺序固定', () => {
  const lines = buildEnvInfoLines({
    platform: 'linux', arch: 'x64', nodeVersion: 'v20.0.0',
    cwd: '/home/u/proj', shell: '/bin/bash', term: 'xterm-256color',
    version: '0.1.104', gitBranch: 'feat/x',
  });
  assert.deepStrictEqual(lines, [
    '    平台: linux x64',
    '    Node: v20.0.0',
    '    工作目录: /home/u/proj',
    '    Shell: /bin/bash',
    '    终端: xterm-256color',
    '    版本: 0.1.104',
    '    Git 分支: feat/x',
  ]);
});

test('gitBranch 空/空白/null → 省略 Git 分支行(6 行)', () => {
  for (const b of ['', '   ', null, undefined]) {
    const lines = buildEnvInfoLines({
      platform: 'linux', arch: 'x64', nodeVersion: 'v20.0.0',
      cwd: '/x', shell: '/bin/bash', term: 'xterm', version: '0.1.104', gitBranch: b,
    });
    assert.strictEqual(lines.length, 6, `gitBranch=${JSON.stringify(b)} 应 6 行`);
    assert.ok(!lines.some((l) => l.includes('Git 分支')), 'Git 分支行应省略');
  }
});

test('gitBranch 首尾空白被 trim', () => {
  const lines = buildEnvInfoLines({
    platform: 'linux', arch: 'x64', nodeVersion: 'v20', cwd: '/x',
    shell: '/bin/bash', term: 'xterm', version: '0.1', gitBranch: '  main  ',
  });
  assert.strictEqual(lines[lines.length - 1], '    Git 分支: main');
});

test('Shell / 终端 缺失 → N/A(沿用今日两孪生口径)', () => {
  const lines = buildEnvInfoLines({
    platform: 'linux', arch: 'x64', nodeVersion: 'v20', cwd: '/x',
    shell: undefined, term: undefined, version: '0.1', gitBranch: '',
  });
  assert.strictEqual(lines[3], '    Shell: N/A');
  assert.strictEqual(lines[4], '    终端: N/A');
});

test('坏输入(缺 values / 全空)不抛', () => {
  assert.doesNotThrow(() => buildEnvInfoLines());
  assert.doesNotThrow(() => buildEnvInfoLines(null));
  const lines = buildEnvInfoLines({});
  assert.strictEqual(lines.length, 6); // 无 gitBranch → 6 行
  assert.strictEqual(lines[3], '    Shell: N/A');
});
