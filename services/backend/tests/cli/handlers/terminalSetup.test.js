'use strict';

/**
 * terminalSetup.test.js — `/terminal-setup` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → printInfo 提示 + 返回 false(命令不接管);复用 detectTerminal() SSOT;
 * native → printSuccess;needs-setup → 打印路径/步骤/片段 + 诚实边界说明;unknown → printWarn;
 * detectTerminal 抛错 → fail-soft 按 unknown。经 require.cache 桩 formatters 捕获输出。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/terminalSetup');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const ADAPTIVE_PATH = require.resolve('../../../src/services/adaptiveConfig');

let calls;

function stubFormatters() {
  require.cache[FORMATTERS_PATH] = {
    id: FORMATTERS_PATH,
    filename: FORMATTERS_PATH,
    loaded: true,
    exports: {
      printInfo: (m) => calls.info.push(String(m)),
      printSuccess: (m) => calls.success.push(String(m)),
      printWarn: (m) => calls.warn.push(String(m)),
      printError: (m) => calls.error.push(String(m)),
    },
  };
}

function stubDetect(terminal) {
  require.cache[ADAPTIVE_PATH] = {
    id: ADAPTIVE_PATH,
    filename: ADAPTIVE_PATH,
    loaded: true,
    exports: {
      detectTerminal: () => terminal,
    },
  };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/terminalSetup');
}

beforeEach(() => {
  calls = { info: [], success: [], warn: [], error: [] };
  stubFormatters();
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[ADAPTIVE_PATH];
  delete process.env.KHY_TERMINAL_SETUP;
});

describe('门控关 → 不接管', () => {
  test('KHY_TERMINAL_SETUP=0 → printInfo 提示 + 返回 false', async () => {
    process.env.KHY_TERMINAL_SETUP = '0';
    const { handleTerminalSetup } = freshHandler();
    const r = await handleTerminalSetup('', []);
    assert.equal(r, false);
    assert.ok(calls.info.length >= 1);
  });
});

describe('native → printSuccess', () => {
  test('iTerm2 → success + 返回 true,不打印步骤', async () => {
    stubDetect({ name: 'iterm.app', isRemote: false });
    const { handleTerminalSetup } = freshHandler();
    const r = await handleTerminalSetup('', []);
    assert.equal(r, true);
    assert.ok(calls.success.length >= 1);
    assert.ok(calls.info.some((m) => /iTerm2/.test(m)));
  });
});

describe('needs-setup → 打印方案', () => {
  test('vscode → 打印配置文件路径 + 步骤 + 片段 + 诚实边界', async () => {
    stubDetect({ name: 'vscode', isRemote: false });
    const { handleTerminalSetup } = freshHandler();
    const r = await handleTerminalSetup('', []);
    assert.equal(r, true);
    const all = calls.info.join('\n');
    assert.match(all, /keybindings\.json/);
    assert.match(all, /sendSequence/);
    assert.match(all, /不会自动改写/);
  });
});

describe('unknown → printWarn', () => {
  test('未知终端 → warn + 返回 true', async () => {
    stubDetect({ name: 'some-weird-term', isRemote: false });
    const { handleTerminalSetup } = freshHandler();
    const r = await handleTerminalSetup('', []);
    assert.equal(r, true);
    assert.ok(calls.warn.length >= 1);
  });
});

describe('detectTerminal 抛错 → fail-soft', () => {
  test('检测抛错 → 按 unknown,不崩溃', async () => {
    require.cache[ADAPTIVE_PATH] = {
      id: ADAPTIVE_PATH,
      filename: ADAPTIVE_PATH,
      loaded: true,
      exports: {
        detectTerminal: () => { throw new Error('boom'); },
      },
    };
    const { handleTerminalSetup } = freshHandler();
    const r = await handleTerminalSetup('', []);
    assert.equal(r, true);
    assert.ok(calls.warn.length >= 1);
  });
});

// 占位:确保 path 被引用(避免 lint unused),与上面断言无关。
void path;
