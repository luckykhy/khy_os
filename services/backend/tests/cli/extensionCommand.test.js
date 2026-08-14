'use strict';

/**
 * extensionCommand.test.js — 守护 `khy extension|ext` 命令的接线。
 *
 * 病灶:cli/handlers/extension.js 的 handleExtension 是完整实现(背后 services/
 * extensionMarketplace),但 cli/router.js 里没有任何 `extension`/`ext` 的 dispatch
 * case,且 commandSchema 的 ROUTER_COMMANDS 未注册该命令 —— `khy ext ...` 彻底不可达。
 *
 * 修复:在 commandSchema(SSOT)注册 extension/ext + 其子命令,并在 router 的 switch
 * 中新增 case 把单字符串 input 重组后交给 handleExtension。本测试断言命令已注册、
 * parseInput 正确归类,且 route 能真正打到 handler(用 jest.mock 拦截 handler,避免
 * 触碰真实 marketplace)。
 */

const {
  getRouterCommandNames,
  getRouterSubCommands,
  inferCategory,
  getCommandSchema,
  getBuiltinSlashCommands,
} = require('../../src/constants/commandSchema');

jest.mock('../../src/cli/handlers/extension', () => ({
  handleExtension: jest.fn(async () => {}),
}));
const { handleExtension: handleExtensionMock } = require('../../src/cli/handlers/extension');

describe('extension/ext command wiring', () => {
  test('commandSchema 注册了 extension 与 ext', () => {
    const names = getRouterCommandNames();
    expect(names).toContain('extension');
    expect(names).toContain('ext');
  });

  test('commandSchema 暴露 extension 子命令(供补全/校验)', () => {
    const subs = getRouterSubCommands();
    expect(subs.extension).toEqual(expect.arrayContaining(['list', 'search', 'install', 'new']));
    expect(subs.ext).toEqual(expect.arrayContaining(['list', 'search', 'install', 'new']));
  });

  test('parseInput 把 `ext search foo bar` 归类为 ext 命令', () => {
    const router = require('../../src/cli/router');
    const parsed = router.parseInput('ext search foo bar');
    expect(parsed.command).toBe('ext');
    expect(parsed.subCommand).toBe('search');
    expect(parsed.args).toEqual(['foo', 'bar']);
  });

  test('route(`ext search foo bar`) 把重组后的 input 交给 handleExtension', async () => {
    const router = require('../../src/cli/router');
    handleExtensionMock.mockClear();
    const parsed = router.parseInput('ext search foo bar');
    const ok = await router.route(parsed, {});
    expect(ok).toBe(true);
    expect(handleExtensionMock).toHaveBeenCalledTimes(1);
    // input 是「子命令 + 参数」拼回的单字符串
    expect(handleExtensionMock.mock.calls[0][0]).toBe('search foo bar');
  });

  // ── 集线器分类：接完线后,命令须被 CATEGORY_BY_COMMAND 归类,而非兜底落到 'system' ──
  test('集线器把 extension/ext 归类为 workflow(非兜底 system)', () => {
    expect(inferCategory('extension')).toBe('workflow');
    expect(inferCategory('ext')).toBe('workflow');
  });

  test('getCommandSchema 里 extension/ext 携带 workflow 类别', () => {
    const schema = getCommandSchema();
    const ext = schema.find((e) => e.name === 'ext');
    const extension = schema.find((e) => e.name === 'extension');
    expect(ext && ext.category).toBe('workflow');
    expect(extension && extension.category).toBe('workflow');
  });

  test('/ext 斜杠命令在集线器中以 workflow 类别 surface', () => {
    const slash = getBuiltinSlashCommands().find((s) => s.cmd === '/ext');
    expect(slash).toBeTruthy();
    expect(slash.category).toBe('workflow');
    expect(slash.route).toBe('ext list');
  });

  test('`extension` 长名同样可达 handler', async () => {
    const router = require('../../src/cli/router');
    handleExtensionMock.mockClear();
    const parsed = router.parseInput('extension list');
    const ok = await router.route(parsed, {});
    expect(ok).toBe(true);
    expect(handleExtensionMock).toHaveBeenCalledTimes(1);
    expect(handleExtensionMock.mock.calls[0][0]).toBe('list');
  });
});
