'use strict';

/**
 * langHandler.test.js — `/lang` 薄壳的路由与门控单测(node:test,零磁盘)。
 *
 * 在 require lang.js **之前**改写 formatters 与 config 的导出以注入 spy
 * (lang.js 顶部 destructure formatters;handleConfig 为惰性 require,经
 * require.cache 注入)。锁定:
 *   - 无参 → 只读打印当前语言(不落盘、不调 handleConfig);
 *   - `/lang zh` → 归一通过 → 调 handleConfig('set',['language.preference','zh']);
 *   - `/lang klingon` → 归一失败 → 返回 false、绝不调 handleConfig;
 *   - 门控 KHY_LANG_COMMAND=off → 返回 false、绝不调 handleConfig(字节回退)。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const formatters = require('../../src/cli/formatters');
const infoLines = [];
const errLines = [];
formatters.printInfo = (m) => infoLines.push(String(m));
formatters.printError = (m) => errLines.push(String(m));
formatters.printSuccess = () => {};
formatters.printWarn = () => {};

// stub config.handleConfig via require.cache(lang.js 惰性 require('./config'))
const configPath = require.resolve('../../src/cli/handlers/config');
const configCalls = [];
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { handleConfig: async (sub, args) => { configCalls.push({ sub, args }); } },
};

const { handleLang } = require('../../src/cli/handlers/lang');

beforeEach(() => {
  infoLines.length = 0; errLines.length = 0; configCalls.length = 0;
  delete process.env.KHY_LANG_COMMAND;
  delete process.env.KHY_LANGUAGE;
});
afterEach(() => { delete process.env.KHY_LANG_COMMAND; delete process.env.KHY_LANGUAGE; });

describe('/lang 只读', () => {
  test('无参 → 打印当前语言(default/auto),不调 handleConfig', async () => {
    const ok = await handleLang('', [], {});
    assert.equal(ok, true);
    assert.equal(configCalls.length, 0);
    assert.ok(infoLines.some((l) => /当前输出语言/.test(l)));
  });

  test('KHY_LANGUAGE=Chinese 时无参 → 显示中文', async () => {
    process.env.KHY_LANGUAGE = 'Chinese';
    await handleLang('status', [], {});
    assert.ok(infoLines.some((l) => /中文/.test(l)));
    assert.equal(configCalls.length, 0);
  });
});

describe('/lang 设置', () => {
  test('zh → 调 handleConfig set language.preference zh', async () => {
    const ok = await handleLang('zh', [], {});
    assert.equal(ok, true);
    assert.equal(configCalls.length, 1);
    assert.equal(configCalls[0].sub, 'set');
    assert.deepEqual(configCalls[0].args, ['language.preference', 'zh']);
  });

  test('无法识别 → false,绝不调 handleConfig', async () => {
    const ok = await handleLang('klingon', [], {});
    assert.equal(ok, false);
    assert.equal(configCalls.length, 0);
    assert.ok(errLines.some((l) => /不支持/.test(l)));
  });
});

describe('门控 KHY_LANG_COMMAND=off → 字节回退', () => {
  test('设置也不接管,提示用 config set,返回 false', async () => {
    process.env.KHY_LANG_COMMAND = 'off';
    const ok = await handleLang('zh', [], {});
    assert.equal(ok, false);
    assert.equal(configCalls.length, 0, '门控关绝不落盘');
    assert.ok(infoLines.some((l) => /config set language\.preference/.test(l)));
  });
});
