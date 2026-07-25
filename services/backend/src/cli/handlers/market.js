'use strict';

/**
 * market.js — `watch`(自选监控)与 `rank`(行情排行)两条 CLI 命令的真实现。
 *
 * 背景(为什么有这个文件):
 *   `cli/router.js` 历史上把 `watch` / `rank` 实现成两行占位:
 *     watch → printInfo(`监控 ${sym} — 功能开发中,敬请期待`)
 *     rank  → printInfo('排行功能开发中 — 将显示涨幅榜、跌幅榜、成交量榜')
 *   命令存在(广度)却什么都不做(无深度)——正是用户差评「堆砌的功能无法实际使用」的物理形态。
 *   实际上行情数据层早已可用:`marketDataService.getRealTimeQuote`(`quote`/`hq` 命令在用)、
 *   `userProfile` 的自选股(favoriteSymbols)持久化。这两条命令只是从未接到既有能力上。
 *
 *   本模块**复用既有服务**(不新建任何数据层)把它们做成真能用的功能:
 *     watch        → 显示自选列表里所有股票的实时行情(监控面板)
 *     watch <代码>  → 加入自选 + 显示该股实时行情
 *     watch rm <代码> → 移出自选
 *     watch clear  → 清空自选
 *     rank [N]     → 拉取「自选 ∪ 常用」股票的实时行情,按涨跌幅排出涨幅榜/跌幅榜(诚实标注:
 *                    排的是你关注的股票,而非全市场——全市场快照需 akshare 数据服务)。
 *
 * 设计:
 *   - **纯函数核心**(parseWatchArgs / quoteChangePct / rankQuotes / buildWatchRows / buildRankRows)
 *     零 I/O、确定性、可单测,与网络/磁盘解耦。
 *   - IO 处理器(handleWatch / handleRank)经可选 `deps` 注入 marketDataService / userProfile /
 *     formatters,默认走真实 require;测试注入 mock 即可全链路验证(无需联网)。
 *   - 拉取多只行情用 `Promise.allSettled`:个别失败不拖垮整张表(fail-soft)。
 */

// ───────────────────────────────────────────────────────────────────────────
// 纯函数核心(零 I/O · 确定性 · 可单测)
// ───────────────────────────────────────────────────────────────────────────

const _REMOVE_VERBS = new Set(['rm', 'remove', 'del', 'delete', '-', '移除', '删除']);

/**
 * 解析 watch 子命令。
 * @param {string[]} args
 * @returns {{action:'list'|'add'|'remove'|'clear', symbol:(string|null)}}
 */
function parseWatchArgs(args) {
  const list = Array.isArray(args) ? args.map(a => String(a || '').trim()).filter(Boolean) : [];
  if (list.length === 0) return { action: 'list', symbol: null };
  const head = list[0].toLowerCase();
  if (head === 'clear' || head === '清空') return { action: 'clear', symbol: null };
  if (_REMOVE_VERBS.has(head)) {
    return { action: 'remove', symbol: list[1] || null };
  }
  return { action: 'add', symbol: list[0] };
}

/**
 * 由行情对象算涨跌幅(百分比)。优先用昨收,退而用今开;都无效则 0。绝不返回 NaN/Infinity。
 * 与 `formatters.printQuote` 的算法保持一致:(现价-昨收)/昨收*100。
 * @param {object} quote
 * @returns {number}
 */
function quoteChangePct(quote) {
  if (!quote || typeof quote !== 'object') return 0;
  const cur = Number(quote.current);
  if (!Number.isFinite(cur)) return 0;
  const base = Number(quote.preClose) > 0 ? Number(quote.preClose)
    : (Number(quote.open) > 0 ? Number(quote.open) : 0);
  if (!(base > 0)) return 0;
  const pct = ((cur - base) / base) * 100;
  return Number.isFinite(pct) ? pct : 0;
}

/** 格式化百分比为带符号字符串,如 +1.23% / -0.45% / 0.00%。 */
function formatPct(n) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

/** 格式化价格为 ¥x.xx;无效价显示 '-'。 */
function formatPrice(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `¥${v.toFixed(2)}` : '-';
}

/**
 * 对一组行情排序并取前 N。
 * @param {object[]} quotes
 * @param {{by?:'gainers'|'losers'|'volume', limit?:number}} [opts]
 * @returns {object[]}  附带 `_pct` 字段(已算好的涨跌幅),不修改原对象。
 */
function rankQuotes(quotes, opts = {}) {
  const by = opts.by || 'gainers';
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 10;
  const rows = (Array.isArray(quotes) ? quotes : [])
    .filter(q => q && typeof q === 'object' && Number.isFinite(Number(q.current)))
    .map(q => ({ ...q, _pct: quoteChangePct(q) }));
  let cmp;
  if (by === 'volume') {
    cmp = (a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0);
  } else if (by === 'losers') {
    cmp = (a, b) => a._pct - b._pct; // 升序:跌得最多在前
  } else {
    cmp = (a, b) => b._pct - a._pct; // 降序:涨得最多在前
  }
  // 稳定排序兜底:同值按 symbol 字典序,保证确定性。
  return rows
    .sort((a, b) => cmp(a, b) || String(a.symbol || '').localeCompare(String(b.symbol || '')))
    .slice(0, limit);
}

/** 自选监控表的行:[代码, 名称, 现价, 涨跌幅]。 */
function buildWatchRows(quotes) {
  return (Array.isArray(quotes) ? quotes : [])
    .filter(q => q && typeof q === 'object')
    .map(q => [
      String(q.symbol || '-'),
      String(q.name || '-'),
      formatPrice(q.current),
      formatPct(quoteChangePct(q)),
    ]);
}

/** 排行表的行:[排名, 代码, 名称, 现价, 涨跌幅]。 */
function buildRankRows(rankedQuotes) {
  return (Array.isArray(rankedQuotes) ? rankedQuotes : [])
    .map((q, i) => [
      String(i + 1),
      String(q.symbol || '-'),
      String(q.name || '-'),
      formatPrice(q.current),
      formatPct(q._pct != null ? q._pct : quoteChangePct(q)),
    ]);
}

/** 去重保序合并多个符号来源。 */
function dedupeSymbols(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const s of (Array.isArray(list) ? list : [])) {
      const sym = String(s || '').trim();
      if (sym && !seen.has(sym)) { seen.add(sym); out.push(sym); }
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 依赖装配(默认真实服务;测试可注入 mock)
// ───────────────────────────────────────────────────────────────────────────

function _defaultDeps() {
  return {
    marketDataService: require('../../services/marketDataService'),
    userProfile: require('../../services/userProfile'),
    formatters: require('../formatters'),
  };
}

/** 并发拉取多只行情,fail-soft:失败的丢弃,只返回成功的。 */
async function _fetchQuotes(symbols, marketDataService) {
  const settled = await Promise.allSettled(
    symbols.map(sym => marketDataService.getRealTimeQuote(sym)),
  );
  return settled
    .filter(r => r.status === 'fulfilled' && r.value && typeof r.value === 'object')
    .map(r => r.value);
}

// ───────────────────────────────────────────────────────────────────────────
// IO 处理器
// ───────────────────────────────────────────────────────────────────────────

/**
 * `watch` 命令:自选股监控。
 * @param {string[]} args
 * @param {object} [deps]  可注入 { marketDataService, userProfile, formatters }
 */
async function handleWatch(args, deps) {
  const { marketDataService, userProfile, formatters } = deps || _defaultDeps();
  const { printQuote, printTable, printInfo, printSuccess, printError, withSpinner } = formatters;
  const { action, symbol } = parseWatchArgs(args);

  if (action === 'add') {
    userProfile.addFavoriteSymbol(symbol);
    try {
      const quote = await withSpinner(`查询 ${symbol} 行情...`, () => marketDataService.getRealTimeQuote(symbol));
      printQuote(quote);
    } catch (err) {
      printError(`行情查询失败: ${err.message}`);
    }
    printSuccess(`已加入自选监控: ${symbol}  (查看全部: watch · 移出: watch rm ${symbol})`);
    return true;
  }

  if (action === 'remove') {
    if (!symbol) { printError('用法: watch rm <代码>'); return true; }
    userProfile.removeFavoriteSymbol(symbol);
    printSuccess(`已移出自选监控: ${symbol}`);
    return true;
  }

  if (action === 'clear') {
    const favs = (userProfile.getProfileSummary().favoriteSymbols || []).slice();
    favs.forEach(s => userProfile.removeFavoriteSymbol(s));
    printSuccess(`已清空自选监控 (${favs.length} 只)`);
    return true;
  }

  // action === 'list':监控面板
  const favorites = userProfile.getProfileSummary().favoriteSymbols || [];
  if (favorites.length === 0) {
    printInfo('自选监控为空。用法: watch <代码|名称> 加入自选,watch 查看全部,watch rm <代码> 移出。');
    return true;
  }
  const quotes = await withSpinner(`刷新 ${favorites.length} 只自选行情...`,
    () => _fetchQuotes(favorites, marketDataService), { muteOutput: true });
  if (quotes.length === 0) {
    printError('自选行情全部获取失败(网络或数据源问题),请稍后重试。');
    return true;
  }
  // 默认按涨跌幅降序展示,便于一眼看强弱。
  const ordered = rankQuotes(quotes, { by: 'gainers', limit: quotes.length });
  printTable(['代码', '名称', '现价', '涨跌幅'], buildWatchRows(ordered));
  if (quotes.length < favorites.length) {
    printInfo(`(${favorites.length - quotes.length} 只行情暂不可用,已跳过)`);
  }
  return true;
}

/**
 * `rank` 命令:把你关注的股票排出涨幅榜/跌幅榜。
 * 诚实范围:排的是「自选 ∪ 常用」而非全市场(全市场快照需 akshare 数据服务)。
 * @param {string[]} args  args[0] 可为榜单大小 N(默认 10)
 * @param {object} [deps]
 */
async function handleRank(args, deps) {
  const { marketDataService, userProfile, formatters } = deps || _defaultDeps();
  const { printTable, printInfo, printError, withSpinner } = formatters;

  const nRaw = Array.isArray(args) ? parseInt(args[0], 10) : NaN;
  const topN = Number.isInteger(nRaw) && nRaw > 0 ? Math.min(nRaw, 50) : 10;

  const summary = userProfile.getProfileSummary();
  const universe = dedupeSymbols(summary.favoriteSymbols, summary.topSymbols);
  if (universe.length === 0) {
    printInfo('暂无可排行的股票。先用 watch <代码> 加入自选,或 quote <代码> 查询过,再运行 rank。');
    printInfo('(范围说明: rank 排的是你关注的股票,全市场涨跌幅榜需配置 akshare 数据服务。)');
    return true;
  }

  const quotes = await withSpinner(`拉取 ${universe.length} 只行情排行...`,
    () => _fetchQuotes(universe, marketDataService), { muteOutput: true });
  if (quotes.length === 0) {
    printError('行情全部获取失败(网络或数据源问题),请稍后重试。');
    return true;
  }

  const gainers = rankQuotes(quotes, { by: 'gainers', limit: topN });
  const losers = rankQuotes(quotes, { by: 'losers', limit: topN });

  printInfo(`行情排行 — 你关注的 ${quotes.length} 只股票(范围: 自选 ∪ 常用):`);
  printInfo('▲ 涨幅榜');
  printTable(['#', '代码', '名称', '现价', '涨跌幅'], buildRankRows(gainers));
  printInfo('▼ 跌幅榜');
  printTable(['#', '代码', '名称', '现价', '涨跌幅'], buildRankRows(losers));
  return true;
}

module.exports = {
  // pure core (testable)
  parseWatchArgs,
  quoteChangePct,
  formatPct,
  formatPrice,
  rankQuotes,
  buildWatchRows,
  buildRankRows,
  dedupeSymbols,
  // IO handlers
  handleWatch,
  handleRank,
};
