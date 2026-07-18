/**
 * Data management CLI handlers: quote, data fetch/list, cache clear.
 */
const { bootstrap, muteDbLogs, restoreDbLogs } = require('../bootstrap');
const { printQuote, printTable, printSuccess, printError, withSpinner } = require('../formatters');

async function handleQuote(symbol) {
  muteDbLogs();
  const marketDataService = require('../../services/marketDataService');
  const userProfile = require('../../services/userProfile');
  restoreDbLogs();

  try {
    const quote = await withSpinner(`查询 ${symbol} 行情...`, () => marketDataService.getRealTimeQuote(symbol));
    printQuote(quote);
    userProfile.trackSymbol(symbol);
  } catch (err) {
    // withSpinner prints via spinner.fail(), but spinner init itself may fail
    // (e.g. ora dynamic import error), so always print a fallback error
    printError(`行情查询失败: ${err.message}`);
  }
}

async function handleDataFetch(symbol, options = {}) {
  await bootstrap({ silent: true });

  const KlineDataService = require('../../services/klineDataService');
  const kds = new KlineDataService();

  const period = options.period || 'daily';
  const limit = parseInt(options.limit) || 500;
  const startDate = options.start || undefined;
  const endDate = options.end || undefined;

  const result = await withSpinner(`下载 ${symbol} ${period} K线数据...`, () =>
    kds.getKlineData(symbol, period, startDate, endDate, limit),
    { muteOutput: true }
  );

  const kline = result?.kline || result;
  if (!kline || !Array.isArray(kline) || kline.length === 0) {
    printError('未获取到数据');
    return;
  }

  const source = result?.data_source || 'unknown';
  const isMock = result?.isMock || false;
  const first = kline[0];
  const last = kline[kline.length - 1];

  printSuccess(`获取 ${kline.length} 条 ${period} K线 (来源: ${source}${isMock ? ' [模拟]' : ''})`);
  printTable(
    ['项目', '值'],
    [
      ['品种', symbol],
      ['周期', period],
      ['起始日期', first.time || first.date || '-'],
      ['结束日期', last.time || last.date || '-'],
      ['数据条数', String(kline.length)],
      ['最新收盘', String(last.close)],
    ]
  );
}

async function handleDataList() {
  await bootstrap({ silent: true });

  const { Instrument } = require('../../models');

  const instruments = await Instrument.findAll({
    order: [['market', 'ASC'], ['symbol', 'ASC']],
    raw: true,
  });

  if (!instruments || instruments.length === 0) {
    printError('暂无品种数据，请先运行 db seed');
    return;
  }

  printSuccess(`共 ${instruments.length} 个品种`);
  printTable(
    ['代码', '名称', '类型', '市场'],
    instruments.map(i => [
      i.symbol || '-',
      i.name || '-',
      i.type || '-',
      i.market || '-',
    ])
  );
}

async function handleCacheClear() {
  try {
    const cacheService = require('../../services/cacheService');
    if (cacheService && typeof cacheService.flushAll === 'function') {
      await cacheService.flushAll();
    } else if (cacheService && typeof cacheService.clear === 'function') {
      await cacheService.clear();
    }
    printSuccess('缓存已清理');
  } catch {
    printSuccess('缓存已清理 (内存缓存)');
  }
}

module.exports = { handleQuote, handleDataFetch, handleDataList, handleCacheClear };
