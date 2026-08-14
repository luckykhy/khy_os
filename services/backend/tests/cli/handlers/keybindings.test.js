'use strict';

/**
 * keybindings.test.js — `/keybindings` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → printInfo 提示 + 返回 false;无参 → 打印全部分组;上下文名参 → 仅该组;
 * 自由查询参 → 过滤;无命中 → 友好提示 + true。经 require.cache 桩 formatters 捕获输出。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/keybindings');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');

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

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/keybindings');
}

beforeEach(() => {
  calls = { info: [], success: [], warn: [], error: [] };
  stubFormatters();
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete process.env.KHY_KEYBINDINGS;
});

describe('门控关 → 不接管', () => {
  test('KHY_KEYBINDINGS=0 → printInfo 提示 + 返回 false', async () => {
    process.env.KHY_KEYBINDINGS = '0';
    const { handleKeybindings } = freshHandler();
    const r = await handleKeybindings('', []);
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /\?/.test(m)));
  });
});

describe('无参 → 全部分组', () => {
  test('打印含多组标题与关键键位', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await handleKeybindings('', []);
    assert.equal(r, true);
    const all = calls.info.join('\n');
    assert.match(all, /【全局】/);
    assert.match(all, /【编辑】/);
    assert.match(all, /Shift \+ Tab/);
  });
});

describe('上下文名参 → 仅该组', () => {
  test('/keybindings vim → 只含 Vim 组', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await handleKeybindings('', ['vim']);
    assert.equal(r, true);
    const all = calls.info.join('\n');
    assert.match(all, /Vim 模式/);
    assert.doesNotMatch(all, /【全局】/);
  });
});

describe('自由查询参 → 过滤', () => {
  test('/keybindings ctrl → 仅含 ctrl 行', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await handleKeybindings('', ['ctrl']);
    assert.equal(r, true);
    const all = calls.info.join('\n');
    assert.match(all, /Ctrl/);
    assert.match(all, /过滤/);
  });
});

describe('无命中 → 友好提示', () => {
  test('/keybindings zzzz → 提示 + 返回 true', async () => {
    const { handleKeybindings } = freshHandler();
    const r = await handleKeybindings('', ['zzzz-nope']);
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /未找到/.test(m)));
  });
});
