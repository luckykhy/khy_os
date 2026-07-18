'use strict';

/**
 * market.js — `watch` / `rank` 命令单元测试。
 *
 * 验证「堆砌的功能无法实际使用」差评的一个具体修复:watch/rank 从「敬请期待」占位
 * 变成复用既有 marketDataService + userProfile 的真功能。
 *  - 纯函数核心:parseWatchArgs / quoteChangePct / rankQuotes / build*Rows / dedupeSymbols。
 *  - IO 处理器经注入 mock deps 全链路验证(无需联网):add/list/remove/clear、空态、fail-soft。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const market = require('../src/cli/handlers/market');

// 构造一个可注入的假依赖:内存自选列表 + 可编排的行情/失败。
function makeDeps({ favorites = [], topSymbols = [], quotes = {}, failFor = new Set() } = {}) {
  const favs = favorites.slice();
  const calls = { added: [], removed: [], fetched: [], printed: [] };
  const rec = (kind) => (...a) => calls.printed.push({ kind, args: a });
  return {
    calls,
    favs,
    deps: {
      marketDataService: {
        async getRealTimeQuote(sym) {
          calls.fetched.push(sym);
          if (failFor.has(sym)) throw new Error(`fail ${sym}`);
          if (quotes[sym]) return quotes[sym];
          throw new Error(`no quote ${sym}`);
        },
      },
      userProfile: {
        addFavoriteSymbol(s) { if (!favs.includes(s)) favs.push(s); calls.added.push(s); },
        removeFavoriteSymbol(s) { const i = favs.indexOf(s); if (i >= 0) favs.splice(i, 1); calls.removed.push(s); },
        getProfileSummary() { return { favoriteSymbols: favs.slice(), topSymbols: topSymbols.slice() }; },
      },
      formatters: {
        printQuote: rec('quote'),
        printTable: (headers, rows) => calls.printed.push({ kind: 'table', headers, rows }),
        printInfo: rec('info'),
        printSuccess: rec('success'),
        printError: rec('error'),
        withSpinner: async (_text, fn) => fn(),
      },
    },
  };
}

const Q = (symbol, name, current, preClose, volume = 0) =>
  ({ symbol, name, current, preClose, open: preClose, high: current, low: current, volume });

describe('parseWatchArgs', () => {
  test('空 → list', () => {
    assert.deepEqual(market.parseWatchArgs([]), { action: 'list', symbol: null });
  });
  test('单个代码 → add', () => {
    assert.deepEqual(market.parseWatchArgs(['sh600519']), { action: 'add', symbol: 'sh600519' });
  });
  test('rm/remove/移除 → remove', () => {
    assert.deepEqual(market.parseWatchArgs(['rm', 'sh600519']), { action: 'remove', symbol: 'sh600519' });
    assert.deepEqual(market.parseWatchArgs(['remove', 'x']), { action: 'remove', symbol: 'x' });
    assert.deepEqual(market.parseWatchArgs(['移除', 'x']), { action: 'remove', symbol: 'x' });
  });
  test('clear/清空 → clear', () => {
    assert.equal(market.parseWatchArgs(['clear']).action, 'clear');
    assert.equal(market.parseWatchArgs(['清空']).action, 'clear');
  });
});

describe('quoteChangePct / formatPct / formatPrice — 确定性、绝不 NaN', () => {
  test('正常涨跌幅', () => {
    assert.equal(market.quoteChangePct({ current: 110, preClose: 100 }), 10);
    assert.equal(market.quoteChangePct({ current: 95, preClose: 100 }), -5);
  });
  test('preClose 无效时退用 open', () => {
    assert.equal(market.quoteChangePct({ current: 110, preClose: 0, open: 100 }), 10);
  });
  test('全无效 → 0,绝不 NaN/Infinity', () => {
    assert.equal(market.quoteChangePct({ current: 110, preClose: 0, open: 0 }), 0);
    assert.equal(market.quoteChangePct({}), 0);
    assert.equal(market.quoteChangePct(null), 0);
  });
  test('formatPct 带符号', () => {
    assert.equal(market.formatPct(1.235), '+1.24%');
    assert.equal(market.formatPct(-0.5), '-0.50%');
    assert.equal(market.formatPct(0), '0.00%');
    assert.equal(market.formatPct(NaN), '0.00%');
  });
  test('formatPrice 无效 → -', () => {
    assert.equal(market.formatPrice(12.5), '¥12.50');
    assert.equal(market.formatPrice(undefined), '-');
  });
});

describe('rankQuotes — 排序确定性', () => {
  const quotes = [
    Q('a', 'A', 110, 100, 50),  // +10%
    Q('b', 'B', 90, 100, 300),  // -10%
    Q('c', 'C', 105, 100, 100), // +5%
    { symbol: 'bad', name: 'BAD', current: NaN, preClose: 100 }, // 过滤
  ];
  test('gainers 降序', () => {
    const r = market.rankQuotes(quotes, { by: 'gainers', limit: 10 });
    assert.deepEqual(r.map(q => q.symbol), ['a', 'c', 'b']);
  });
  test('losers 升序', () => {
    const r = market.rankQuotes(quotes, { by: 'losers', limit: 10 });
    assert.deepEqual(r.map(q => q.symbol), ['b', 'c', 'a']);
  });
  test('volume 降序', () => {
    const r = market.rankQuotes(quotes, { by: 'volume', limit: 10 });
    assert.deepEqual(r.map(q => q.symbol), ['b', 'c', 'a']);
  });
  test('limit 截断 + 过滤无效行情', () => {
    const r = market.rankQuotes(quotes, { by: 'gainers', limit: 2 });
    assert.equal(r.length, 2);
    assert.ok(!r.some(q => q.symbol === 'bad'));
  });
});

describe('dedupeSymbols — 去重保序', () => {
  test('合并多源去重', () => {
    assert.deepEqual(market.dedupeSymbols(['a', 'b'], ['b', 'c', '', null]), ['a', 'b', 'c']);
  });
});

describe('handleWatch — IO(注入 mock,无需联网)', () => {
  test('add:加入自选 + 显示行情 + 成功提示', async () => {
    const { deps, calls, favs } = makeDeps({ quotes: { sh1: Q('sh1', '茅台', 110, 100) } });
    await market.handleWatch(['sh1'], deps);
    assert.deepEqual(calls.added, ['sh1']);
    assert.ok(favs.includes('sh1'));
    assert.ok(calls.printed.some(p => p.kind === 'quote'));
    assert.ok(calls.printed.some(p => p.kind === 'success'));
  });

  test('add:行情失败仍加入自选 + 报错(fail-soft)', async () => {
    const { deps, calls, favs } = makeDeps({ failFor: new Set(['bad']) });
    await market.handleWatch(['bad'], deps);
    assert.ok(favs.includes('bad'));
    assert.ok(calls.printed.some(p => p.kind === 'error'));
    assert.ok(calls.printed.some(p => p.kind === 'success'));
  });

  test('list 空 → 提示用法', async () => {
    const { deps, calls } = makeDeps({ favorites: [] });
    await market.handleWatch([], deps);
    assert.ok(calls.printed.some(p => p.kind === 'info'));
    assert.ok(!calls.printed.some(p => p.kind === 'table'));
  });

  test('list:监控面板按涨跌幅降序成表,部分失败跳过', async () => {
    const { deps, calls } = makeDeps({
      favorites: ['a', 'b', 'down'],
      quotes: { a: Q('a', 'A', 105, 100), b: Q('b', 'B', 120, 100) },
      failFor: new Set(['down']),
    });
    await market.handleWatch([], deps);
    const table = calls.printed.find(p => p.kind === 'table');
    assert.ok(table, '应输出表格');
    // b(+20%)在 a(+5%)之前
    assert.deepEqual(table.rows.map(r => r[0]), ['b', 'a']);
    // 有跳过提示
    assert.ok(calls.printed.some(p => p.kind === 'info'));
  });

  test('list:全部失败 → 报错', async () => {
    const { deps, calls } = makeDeps({ favorites: ['x'], failFor: new Set(['x']) });
    await market.handleWatch([], deps);
    assert.ok(calls.printed.some(p => p.kind === 'error'));
  });

  test('remove:移出自选', async () => {
    const { deps, calls, favs } = makeDeps({ favorites: ['a', 'b'] });
    await market.handleWatch(['rm', 'a'], deps);
    assert.deepEqual(calls.removed, ['a']);
    assert.ok(!favs.includes('a'));
  });

  test('clear:清空自选', async () => {
    const { deps, favs } = makeDeps({ favorites: ['a', 'b', 'c'] });
    await market.handleWatch(['clear'], deps);
    assert.equal(favs.length, 0);
  });
});

describe('handleRank — IO(注入 mock)', () => {
  test('空 universe → 提示先加自选', async () => {
    const { deps, calls } = makeDeps({ favorites: [], topSymbols: [] });
    await market.handleRank([], deps);
    assert.ok(calls.printed.some(p => p.kind === 'info'));
    assert.ok(!calls.printed.some(p => p.kind === 'table'));
  });

  test('排出涨幅榜 + 跌幅榜(自选 ∪ 常用,去重)', async () => {
    const { deps, calls } = makeDeps({
      favorites: ['a', 'b'],
      topSymbols: ['b', 'c'], // b 重复,应去重
      quotes: {
        a: Q('a', 'A', 110, 100), // +10
        b: Q('b', 'B', 90, 100),  // -10
        c: Q('c', 'C', 105, 100), // +5
      },
    });
    await market.handleRank([], deps);
    const tables = calls.printed.filter(p => p.kind === 'table');
    assert.equal(tables.length, 2, '涨幅榜 + 跌幅榜两张表');
    // 涨幅榜首位 a,跌幅榜首位 b
    assert.equal(tables[0].rows[0][1], 'a');
    assert.equal(tables[1].rows[0][1], 'b');
    // 去重:只 fetch 了 a,b,c 三只
    assert.deepEqual(calls.fetched.sort(), ['a', 'b', 'c']);
  });

  test('全部失败 → 报错', async () => {
    const { deps, calls } = makeDeps({ favorites: ['x'], failFor: new Set(['x']) });
    await market.handleRank([], deps);
    assert.ok(calls.printed.some(p => p.kind === 'error'));
  });
});
