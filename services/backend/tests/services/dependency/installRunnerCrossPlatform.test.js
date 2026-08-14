'use strict';

/**
 * installRunnerCrossPlatform.test.js — 依赖安装器跨平台兼容 + 包管理器缺失归因
 * （DESIGN-ARCH-027 增强）。全程零真实进程：仅验证纯函数归类与归因、注入桩透传。
 *
 * 覆盖：
 *   - _managerOf：argv 首词归一（剥 .cmd/.bat/.exe）。
 *   - _classifyExecError：ENOENT / win32「不是内部或外部命令·not recognized」/
 *     killed 超时 / 普通非零退出 四类稳定码。
 *   - managerMissingMessage：npm/npx 缺失 → 指向 nodejs.org，绝不静默。
 *   - runInstall：把 runner 回报的 manager-not-found + hint 原样透传给上层。
 *   - resolver.defaultEnv().cwd：指向含 package.json 的 backend 根（project 作用域
 *     安装落点正确，避免装到用户 CWD 导致 re-probe 解析不到）。
 *   - healingLoop.summarizeForAgent：manager-not-found 给精准归因而非笼统「检查网络」。
 */

const path = require('path');
const fs = require('fs');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const installRunner = require('../../../src/services/dependency/installRunner');
const resolver = require('../../../src/services/dependency/resolver');
const healing = require('../../../src/services/dependency/healingLoop');
const registry = require('../../../src/services/dependency/registry');

const { _classifyExecError, _managerOf, _buildExecInvocation } = installRunner._internal;

describe('installRunner._managerOf — argv 首词归一', () => {
  test('普通命令取首词', () => {
    assert.equal(_managerOf(['npm', 'install', 'cheerio']), 'npm');
  });
  test('win32 .cmd/.exe 垫片剥后缀', () => {
    assert.equal(_managerOf(['npm.cmd', 'install', 'x']), 'npm');
    assert.equal(_managerOf(['winget.exe', 'install']), 'winget');
  });
  test('空 argv 不抛', () => {
    assert.equal(_managerOf([]), '');
    assert.equal(_managerOf(undefined), '');
  });
});

describe('installRunner._classifyExecError — 稳定错误码', () => {
  test('ENOENT → manager-not-found', () => {
    assert.equal(_classifyExecError({ code: 'ENOENT' }, '', 'npm'), 'manager-not-found');
  });
  test('win32「不是内部或外部命令」→ manager-not-found', () => {
    const stderr = "'npm' 不是内部或外部命令，也不是可运行的程序";
    assert.equal(_classifyExecError(new Error('x'), stderr, 'npm'), 'manager-not-found');
  });
  test('英文 not recognized → manager-not-found', () => {
    const stderr = "'npm' is not recognized as an internal or external command";
    assert.equal(_classifyExecError(new Error('x'), stderr, 'npm'), 'manager-not-found');
  });
  test('killed（超时）→ timeout', () => {
    assert.equal(_classifyExecError({ killed: true }, '', 'npm'), 'timeout');
  });
  test('普通非零退出 → exit-nonzero', () => {
    assert.equal(_classifyExecError(new Error('E404 not found'), 'npm ERR! 404 package missing', 'npm'), 'exit-nonzero');
  });
  test('未提及该 manager 的「not found」不误判为缺失', () => {
    // 安装日志里 "package not found" 不应被当成 npm 自身缺失。
    assert.equal(_classifyExecError(new Error('x'), 'cheerio: package not found in registry', 'npm'), 'exit-nonzero');
  });
});

describe('installRunner.managerMissingMessage — 明确归因', () => {
  test('npm 缺失指向 Node.js 官网', () => {
    const msg = installRunner.managerMissingMessage('npm');
    assert.match(msg, /Node\.js/);
    assert.match(msg, /nodejs\.org/);
  });
  test('pip 缺失指向 Python 官网', () => {
    assert.match(installRunner.managerMissingMessage('pip'), /python\.org/);
  });
  test('未知 manager 也给可读兜底（不静默）', () => {
    assert.match(installRunner.managerMissingMessage('frobnicator'), /frobnicator/);
  });
});

describe('installRunner._buildExecInvocation — DEP0190-safe（无 shell:true + args 数组）', () => {
  test('win32：经 cmd.exe /d /s /c 调用，把原 argv 作为参数', () => {
    const inv = _buildExecInvocation(['npm', 'install', 'puppeteer'], 'win32');
    // 默认 cmd.exe（COMSPEC 缺省）；首词 npm 由 cmd.exe 解析 .cmd 垫片。
    assert.match(inv.exe, /cmd\.exe$/i);
    assert.deepEqual(inv.args, ['/d', '/s', '/c', 'npm', 'install', 'puppeteer']);
    // 关键红线：返回对象绝不携带 shell 选项（args 数组 + shell:true 才会触发 DEP0190）。
    assert.equal('shell' in inv, false);
  });
  test('POSIX：纯 execFile，可执行=首词、参数=其余，不引入 shell', () => {
    const inv = _buildExecInvocation(['npm', 'install', 'cheerio'], 'linux');
    assert.equal(inv.exe, 'npm');
    assert.deepEqual(inv.args, ['install', 'cheerio']);
    assert.equal('shell' in inv, false);
  });
});

describe('registry.puppeteer — followUp 拉取 Chromium（关闭虚报「已装」缺口）', () => {
  test('puppeteer.install.followUp === npx puppeteer browsers install chrome', () => {
    assert.deepEqual(
      registry.DEPENDENCIES.puppeteer.install.followUp,
      ['npx', 'puppeteer', 'browsers', 'install', 'chrome'],
    );
  });
  test('followUp 也会被 runInstall 串行执行（探针仅 require.resolve，需真实下载二进制）', async () => {
    const plan = resolver.buildInstallPlan('puppeteer', {
      platform: 'linux', searchExecutable: () => null, resolveNodeModule: () => false, checkPythonPackage: () => false,
    });
    const ran = [];
    const runner = async (argv) => { ran.push(argv.join(' ')); return { ok: true, code: 0, stdout: '', stderr: '' }; };
    const res = await installRunner.runInstall(plan, { runner });
    assert.equal(res.ok, true);
    assert.deepEqual(ran, ['npm install puppeteer', 'npx puppeteer browsers install chrome']);
  });
});

describe('runInstall — 透传 manager-not-found 归因', () => {
  test('runner 回报缺失 + hint → 原样透传', async () => {
    const plan = resolver.buildInstallPlan('cheerio', { platform: 'win32', searchExecutable: () => null, resolveNodeModule: () => false, checkPythonPackage: () => false });
    const runner = async () => ({ ok: false, code: null, stderr: "'npm' 不是内部或外部命令", error: 'manager-not-found', hint: installRunner.managerMissingMessage('npm') });
    const res = await installRunner.runInstall(plan, { runner });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'manager-not-found');
    assert.match(res.hint, /nodejs\.org/);
  });
});

describe('resolver.defaultEnv().cwd — project 作用域安装落点', () => {
  test('cwd 指向含 package.json 的 backend 根', () => {
    const env = resolver.defaultEnv();
    assert.ok(env.cwd, '应有 cwd');
    assert.ok(path.isAbsolute(env.cwd), 'cwd 是绝对路径');
    assert.ok(fs.existsSync(path.join(env.cwd, 'package.json')), 'cwd 下存在 package.json');
  });
});

describe('healingLoop.summarizeForAgent — 缺失包管理器精准归因', () => {
  test('manager-not-found → 携 hint，不退化为笼统提示', () => {
    const out = {
      healed: false,
      depId: 'cheerio',
      plan: { displayCommand: 'npm install cheerio', docsUrl: 'https://cheerio.js.org/' },
      installFailed: true,
      install: { ok: false, error: 'manager-not-found', hint: installRunner.managerMissingMessage('npm') },
    };
    const s = healing.summarizeForAgent(out);
    assert.equal(s.status, 'manager-not-found');
    assert.match(s.message, /nodejs\.org/);
  });
  test('普通安装失败仍走 install-failed', () => {
    const out = {
      healed: false, depId: 'cheerio',
      plan: { displayCommand: 'npm install cheerio' },
      installFailed: true,
      install: { ok: false, error: 'exit-nonzero', stderr: 'E404' },
    };
    assert.equal(healing.summarizeForAgent(out).status, 'install-failed');
  });
});
