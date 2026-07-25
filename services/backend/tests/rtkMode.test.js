'use strict';

/**
 * rtkMode 纯叶子单测 —— RTK 省 token 模式的单一真源。
 *
 * 覆盖:门控({0,false,off,no} + 默认 on)、rtk rewrite 退出码协议(0/3 改写、
 * 1/2 回落、空/无变化回落、本地绝对路径二进制令牌替换)、buildGrepArgs 映射、
 * stripRtkMeta 去噪、parseGrepOutput 解析(头行跳过 / file:line:content / maxResults)、
 * parseGain 报表解析。spawn 经 __setSpawn 注入,纯确定性,不触真 rtk。
 *
 * node:test(非 jest)。运行:`node --test`。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const rtk = require('../src/services/rtkMode');

// 门控测试需要还原 env;集中保存/恢复相关键。
const ENV_KEYS = ['KHY_RTK_MODE', 'KHY_RTK_FILE_TOOLS', 'KHY_RTK_AUTO_INSTALL'];
let _savedEnv;

beforeEach(() => {
  _savedEnv = {};
  for (const k of ENV_KEYS) _savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  rtk.__clearSpawn();
  rtk.__clearCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (_savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = _savedEnv[k];
  }
  rtk.__clearSpawn();
  rtk.__clearCache();
});

describe('门控(默认 on,关 ∈ {0,false,off,no})', () => {
  test('默认开启', () => {
    assert.equal(rtk.modeEnabled(), true);
    assert.equal(rtk.fileToolsEnabled(), true);
    assert.equal(rtk.autoInstallEnabled(), true);
  });

  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    test(`KHY_RTK_MODE=${off} → 关`, () => {
      process.env.KHY_RTK_MODE = off;
      assert.equal(rtk.modeEnabled(), false);
      // 主开关关 → 子开关(文件工具)随之关
      assert.equal(rtk.fileToolsEnabled(), false);
    });
  }

  test('其它值视作开(如 1 / yes / 任意)', () => {
    process.env.KHY_RTK_MODE = '1';
    assert.equal(rtk.modeEnabled(), true);
    process.env.KHY_RTK_MODE = 'yes';
    assert.equal(rtk.modeEnabled(), true);
  });

  test('fileToolsEnabled 受 KHY_RTK_FILE_TOOLS 单独关(主开关仍开)', () => {
    process.env.KHY_RTK_FILE_TOOLS = 'off';
    assert.equal(rtk.modeEnabled(), true);
    assert.equal(rtk.fileToolsEnabled(), false);
  });

  test('autoInstallEnabled 独立于主开关', () => {
    process.env.KHY_RTK_AUTO_INSTALL = 'no';
    assert.equal(rtk.autoInstallEnabled(), false);
    assert.equal(rtk.modeEnabled(), true);
  });
});

describe('rewriteShellCommand 退出码协议', () => {
  function stubExit(code, stdout) {
    rtk.__setSpawn((file, args) => {
      assert.equal(args[0], 'rewrite');
      return { status: code, stdout: stdout == null ? '' : stdout, stderr: '' };
    });
  }

  test('exit 0(allow/rewritten)→ 采用 stdout', () => {
    stubExit(0, 'rtk ls -la\n');
    assert.deepEqual(rtk.rewriteShellCommand('ls -la'), { run: 'rtk ls -la', code: 0 });
  });

  test('exit 3(ask/rewritten)→ 采用 stdout', () => {
    stubExit(3, 'rtk git status');
    assert.deepEqual(rtk.rewriteShellCommand('git status'), { run: 'rtk git status', code: 3 });
  });

  test('exit 1(passthrough)→ null', () => {
    stubExit(1, '');
    assert.equal(rtk.rewriteShellCommand('echo hi'), null);
  });

  test('exit 2(deny)→ null(交回 khy 自身 gate)', () => {
    stubExit(2, '');
    assert.equal(rtk.rewriteShellCommand('rm -rf /'), null);
  });

  test('空 stdout 即便 exit 0 → null', () => {
    stubExit(0, '   \n');
    assert.equal(rtk.rewriteShellCommand('whatever'), null);
  });

  test('改写结果与原命令相同 → null(视作无改写)', () => {
    stubExit(0, 'ls -la');
    assert.equal(rtk.rewriteShellCommand('ls -la'), null);
  });

  test('剥离 stdout 中的 [rtk] 噪声后再判定', () => {
    stubExit(0, '[rtk] WARNING: untrusted project filters\nrtk find .\n');
    assert.deepEqual(rtk.rewriteShellCommand('find .'), { run: 'rtk find .', code: 0 });
  });

  test('本地绝对路径二进制:把首个 rtk 令牌替换为实际路径', () => {
    stubExit(0, 'rtk git status');
    const bin = '/home/u/.khy/bin/rtk';
    assert.deepEqual(rtk.rewriteShellCommand('git status', { bin }), {
      run: '/home/u/.khy/bin/rtk git status', code: 0,
    });
  });

  test('含空格的二进制路径加引号', () => {
    stubExit(0, 'rtk ls');
    const bin = '/home/My Apps/rtk';
    assert.deepEqual(rtk.rewriteShellCommand('ls', { bin }), {
      run: '"/home/My Apps/rtk" ls', code: 0,
    });
  });

  test('非字符串命令 → null', () => {
    assert.equal(rtk.rewriteShellCommand(null), null);
    assert.equal(rtk.rewriteShellCommand(undefined), null);
    assert.equal(rtk.rewriteShellCommand(123), null);
  });

  test('spawn 抛异常 → null(永不抛)', () => {
    rtk.__setSpawn(() => { throw new Error('boom'); });
    assert.equal(rtk.rewriteShellCommand('git status'), null);
  });

  test('spawn 返回 error 字段 → null', () => {
    rtk.__setSpawn(() => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }));
    assert.equal(rtk.rewriteShellCommand('git status'), null);
  });
});

describe('buildGrepArgs', () => {
  test('基本:pattern + 默认路径 .', () => {
    assert.deepEqual(rtk.buildGrepArgs({ pattern: 'foo' }), ['grep', 'foo', '.']);
  });
  test('带 path / 大小写不敏感 / glob', () => {
    assert.deepEqual(
      rtk.buildGrepArgs({ pattern: 'foo', path: 'src', case_insensitive: true, glob: '*.js' }),
      ['grep', 'foo', 'src', '-i', '--glob', '*.js']
    );
  });
  test('pattern 缺失 → 空串', () => {
    assert.deepEqual(rtk.buildGrepArgs({}), ['grep', '', '.']);
  });
});

describe('stripRtkMeta', () => {
  test('删除 [rtk] 前缀行,保留其余', () => {
    assert.equal(rtk.stripRtkMeta('a\n[rtk] warn\nb'), 'a\nb');
  });
  test('行首带空白的 [rtk] 也删', () => {
    assert.equal(rtk.stripRtkMeta('  [rtk] x\nkeep'), 'keep');
  });
  test('无 [rtk] 行原样返回', () => {
    assert.equal(rtk.stripRtkMeta('one\ntwo'), 'one\ntwo');
  });
  test('非字符串安全返回', () => {
    assert.equal(rtk.stripRtkMeta(null), '');
    assert.equal(rtk.stripRtkMeta(undefined), '');
  });
});

describe('parseGrepOutput', () => {
  test('解析 file:line:content,跳过头行', () => {
    const raw = [
      '2 matches in 1 files:',
      '',
      'src/a.js:12:const x = 1;',
      'src/a.js:34:function foo() {',
    ].join('\n');
    const cwd = '/repo';
    const m = rtk.parseGrepOutput(raw, { cwd });
    assert.equal(m.length, 2);
    assert.deepEqual(m[0], { file: 'src/a.js', line: 12, content: 'const x = 1;' });
    assert.deepEqual(m[1], { file: 'src/a.js', line: 34, content: 'function foo() {' });
  });

  test('剥离 [rtk] 噪声行', () => {
    const raw = '[rtk] WARNING: filters\nsrc/b.js:5:hit';
    const m = rtk.parseGrepOutput(raw, { cwd: '/repo' });
    assert.equal(m.length, 1);
    assert.equal(m[0].line, 5);
  });

  test('content 内含冒号不被截断', () => {
    const m = rtk.parseGrepOutput('a.js:7:http://x:8080/y', { cwd: '/repo' });
    assert.equal(m[0].content, 'http://x:8080/y');
  });

  test('maxResults 截断', () => {
    const raw = ['f:1:a', 'f:2:b', 'f:3:c'].join('\n');
    const m = rtk.parseGrepOutput(raw, { cwd: '/repo', maxResults: 2 });
    assert.equal(m.length, 2);
  });

  test('非匹配行被忽略', () => {
    assert.deepEqual(rtk.parseGrepOutput('garbage line\n\n', { cwd: '/repo' }), []);
  });

  test('绝对路径相对化到 cwd', () => {
    const m = rtk.parseGrepOutput('/repo/src/c.js:9:z', { cwd: '/repo' });
    assert.equal(m[0].file, path.join('src', 'c.js'));
  });
});

describe('parseGain', () => {
  const sample = [
    'RTK Token Savings (Global Scope)',
    '',
    'Total commands:    27805',
    'Input tokens:      44.7M',
    'Output tokens:     10.6M',
    'Tokens saved:      34.5M (77.1%)',
    '',
    'By Command',
    ' 1.  rtk read                   2094    7.6M   26.0%     0ms  ████',
    ' 2.  rtk grep                   6302  871.1K    7.8%     4ms  █',
  ].join('\n');

  test('解析总量字段', () => {
    const g = rtk.parseGain(sample);
    assert.equal(g.totalCommands, 27805);
    assert.equal(g.inputTokens, '44.7M');
    assert.equal(g.outputTokens, '10.6M');
    assert.equal(g.tokensSaved, '34.5M');
    assert.equal(g.savedPercent, 77.1);
  });

  test('解析分命令明细', () => {
    const g = rtk.parseGain(sample);
    assert.equal(g.perCommand.length, 2);
    assert.deepEqual(g.perCommand[0], {
      rank: 1, command: 'rtk read', count: 2094, saved: '7.6M', avgPercent: 26.0,
    });
    assert.equal(g.perCommand[1].command, 'rtk grep');
  });

  test('空输入安全返回结构', () => {
    const g = rtk.parseGain('');
    assert.equal(g.totalCommands, null);
    assert.deepEqual(g.perCommand, []);
  });
});

describe('localBinPath', () => {
  test('返回 .../bin/rtk(平台后缀)', () => {
    const p = rtk.localBinPath();
    assert.ok(p && /[\\/]bin[\\/]rtk(\.exe)?$/.test(p), `unexpected: ${p}`);
  });
});

describe('runGain(注入 spawn)', () => {
  test('成功 → { raw, stats }', () => {
    rtk.__setSpawn((file, args) => {
      assert.deepEqual(args, ['gain']);
      return { status: 0, stdout: 'Tokens saved:      1.0M (50.0%)', stderr: '' };
    });
    const r = rtk.runGain({ bin: 'rtk' });
    assert.equal(r.error, undefined);
    assert.equal(r.stats.savedPercent, 50.0);
  });

  test('--project 透传', () => {
    rtk.__setSpawn((file, args) => {
      assert.deepEqual(args, ['gain', '--project']);
      return { status: 0, stdout: '', stderr: '' };
    });
    rtk.runGain({ bin: 'rtk', project: true });
  });

  test('非零退出 → { error }', () => {
    rtk.__setSpawn(() => ({ status: 1, stdout: '', stderr: '[rtk] boom\nno data' }));
    const r = rtk.runGain({ bin: 'rtk' });
    assert.ok(r.error);
  });
});
