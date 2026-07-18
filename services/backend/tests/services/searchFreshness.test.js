'use strict';

/**
 * searchFreshness.test.js — 时间维度 / 新鲜度单一真源纯模块单测。
 *
 * 守护(goal 2026-06-25「怎么搜才能拿到最新数据」,用户三条):
 *   1. 意图识别 + 窗口解析:时效问题(最新/今天/新闻/latest…)→ 合适窗口;
 *      普通检索 → null(不限时,不动既有召回);显式优先于自动。
 *   2. 每引擎时间过滤 URL 参数:DDG df / 百度 gpc-stf / Bing qft / 搜狗 tsn;
 *      拿不准的引擎(360)留空,靠重排兜底。
 *   3. 结果日期解析 + 按时间重排:富化 publishedDate,窗口内顶前,绝不丢结果。
 *   4. env 门控:KHY_SEARCH_FRESHNESS / KHY_SEARCH_FRESHNESS_RERANK 默认开,off 回退。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const fr = require('../../src/services/search/searchFreshness');

// 固定 now,保持确定性:2026-06-25T00:00:00Z。
const NOW = Date.UTC(2026, 5, 25);
const DAY = 24 * 60 * 60 * 1000;

describe('1. detectFreshness 意图识别', () => {
  test('强信号:今天/实时 → day', () => {
    assert.equal(fr.detectFreshness('今天的金价'), 'day');
    assert.equal(fr.detectFreshness('实时股价 600519'), 'day');
    assert.equal(fr.detectFreshness('breaking news on the election'), 'day');
  });
  test('本周/本月/今年', () => {
    assert.equal(fr.detectFreshness('本周新出的显卡'), 'week');
    assert.equal(fr.detectFreshness('本月行情回顾'), 'month');
    assert.equal(fr.detectFreshness('今年的诺贝尔奖'), 'year');
  });
  test('通用时效意图 → week 默认', () => {
    assert.equal(fr.detectFreshness('最新的 Node.js 版本'), 'week');
    assert.equal(fr.detectFreshness('latest react release'), 'week');
    assert.equal(fr.detectFreshness('OpenAI 最近的新闻'), 'week');
  });
  test('普通检索 → null(不限时)', () => {
    assert.equal(fr.detectFreshness('快速排序算法原理'), null);
    assert.equal(fr.detectFreshness('how does TCP handshake work'), null);
    assert.equal(fr.detectFreshness(''), null);
  });
});

describe('1b. normalizeWindow / resolveWindow', () => {
  test('归一化各种外部形态', () => {
    assert.equal(fr.normalizeWindow('day'), 'day');
    assert.equal(fr.normalizeWindow('W'), 'week');
    assert.equal(fr.normalizeWindow('oneMonth'), 'month');
    assert.equal(fr.normalizeWindow('oneYear'), 'year');
    assert.equal(fr.normalizeWindow('noLimit'), null);
    assert.equal(fr.normalizeWindow('none'), null);
    assert.equal(fr.normalizeWindow('auto'), 'auto');
    assert.equal(fr.normalizeWindow('garbage'), null);
  });
  test('显式优先于自动识别', () => {
    // query 含「最新」(→week),但显式 day 覆盖。
    assert.equal(fr.resolveWindow('day', '最新新闻', {}), 'day');
  });
  test('auto / 未提供 → 走自动识别', () => {
    assert.equal(fr.resolveWindow('auto', '今天天气', {}), 'day');
    assert.equal(fr.resolveWindow(undefined, '最新进展', {}), 'week');
    assert.equal(fr.resolveWindow(undefined, '普通问题', {}), null);
  });
  test('门控关闭 → 一律 null', () => {
    assert.equal(fr.resolveWindow('day', '今天', { KHY_SEARCH_FRESHNESS: 'off' }), null);
    assert.equal(fr.resolveWindow('day', '今天', { KHY_SEARCH_FRESHNESS: '0' }), null);
  });
});

describe('2. freshnessToEngineParam 每引擎 URL 参数', () => {
  test('DuckDuckGo df=d|w|m|y', () => {
    assert.equal(fr.freshnessToEngineParam('day', 'duckduckgo', NOW), 'df=d');
    assert.equal(fr.freshnessToEngineParam('week', 'duckduckgo', NOW), 'df=w');
    assert.equal(fr.freshnessToEngineParam('month', 'duckduckgo', NOW), 'df=m');
    assert.equal(fr.freshnessToEngineParam('year', 'duckduckgo', NOW), 'df=y');
  });
  test('百度 gpc=stf=start,end|stftype=2(URL 编码,确定性时间戳)', () => {
    const p = fr.freshnessToEngineParam('day', 'baidu', NOW);
    assert.ok(p.startsWith('gpc='));
    const decoded = decodeURIComponent(p.slice('gpc='.length));
    const endSec = Math.floor(NOW / 1000);
    const startSec = Math.floor((NOW - DAY) / 1000);
    assert.equal(decoded, `stf=${startSec},${endSec}|stftype=2`);
  });
  test('Bing qft interval(年留空)', () => {
    assert.equal(fr.freshnessToEngineParam('day', 'bing-cn', NOW), `qft=${encodeURIComponent('interval="7"')}`);
    assert.equal(fr.freshnessToEngineParam('week', 'bing-cn', NOW), `qft=${encodeURIComponent('interval="8"')}`);
    assert.equal(fr.freshnessToEngineParam('year', 'bing-cn', NOW), '');
  });
  test('搜狗 tsn=1|2|3|4', () => {
    assert.equal(fr.freshnessToEngineParam('day', 'sogou', NOW), 'tsn=1');
    assert.equal(fr.freshnessToEngineParam('year', 'sogou', NOW), 'tsn=4');
  });
  test('360 留空(参数不稳定,靠重排兜底)', () => {
    assert.equal(fr.freshnessToEngineParam('day', 'so360', NOW), '');
  });
  test('无窗口 / 未知引擎 → 空串', () => {
    assert.equal(fr.freshnessToEngineParam(null, 'baidu', NOW), '');
    assert.equal(fr.freshnessToEngineParam('day', 'unknown-engine', NOW), '');
  });
  test('windowToBochaFreshness 枚举', () => {
    assert.equal(fr.windowToBochaFreshness('day'), 'oneDay');
    assert.equal(fr.windowToBochaFreshness('year'), 'oneYear');
    assert.equal(fr.windowToBochaFreshness(null), 'noLimit');
  });
});

describe('3. parseResultDate 日期解析', () => {
  test('中文相对', () => {
    assert.equal(fr.parseResultDate('3小时前', NOW), NOW - 3 * 60 * 60 * 1000);
    assert.equal(fr.parseResultDate('2天前发布', NOW), NOW - 2 * DAY);
    assert.equal(fr.parseResultDate('昨天', NOW), NOW - DAY);
    assert.equal(fr.parseResultDate('今天', NOW), NOW);
  });
  test('英文相对', () => {
    assert.equal(fr.parseResultDate('3 days ago', NOW), NOW - 3 * DAY);
    assert.equal(fr.parseResultDate('2 hours ago', NOW), NOW - 2 * 60 * 60 * 1000);
  });
  test('绝对日期', () => {
    assert.equal(fr.parseResultDate('2026-06-20', NOW), Date.UTC(2026, 5, 20));
    assert.equal(fr.parseResultDate('2026/06/20 报道', NOW), Date.UTC(2026, 5, 20));
    assert.equal(fr.parseResultDate('2026年6月20日', NOW), Date.UTC(2026, 5, 20));
    assert.equal(fr.parseResultDate('Jun 20, 2026', NOW), Date.UTC(2026, 5, 20));
    assert.equal(fr.parseResultDate('20 Jun 2026', NOW), Date.UTC(2026, 5, 20));
  });
  test('解析不出 → null', () => {
    assert.equal(fr.parseResultDate('no date here', NOW), null);
    assert.equal(fr.parseResultDate('', NOW), null);
  });
});

describe('3b. applyRecencyRanking 重排', () => {
  const mk = (id, extra = {}) => ({ title: `t${id}`, url: `http://e/${id}`, snippet: '', ...extra });

  test('窗口内的新结果顶到前面,过期下沉,无日期居中,绝不丢结果', () => {
    const input = [
      mk('stale', { publishedDate: '2020-01-01' }),       // 过期
      mk('undated'),                                       // 无日期
      mk('fresh2', { snippet: '2天前' }),                  // 窗口内,较旧
      mk('fresh1', { snippet: '今天' }),                   // 窗口内,最新
    ];
    const out = fr.applyRecencyRanking(input, 'week', NOW, {});
    assert.equal(out.length, 4, '不丢结果');
    assert.deepEqual(out.map(r => r.title), ['tfresh1', 'tfresh2', 'tundated', 'tstale']);
  });

  test('回填空的 publishedDate(即便不重排)', () => {
    const input = [mk('a', { snippet: '2026-06-20 发布' })];
    const out = fr.applyRecencyRanking(input, null, NOW, {});
    assert.equal(out[0].publishedDate, '2026-06-20');
  });

  test('不改入参(返回新数组)', () => {
    const input = [mk('a', { snippet: '今天' })];
    const snapshot = JSON.parse(JSON.stringify(input));
    fr.applyRecencyRanking(input, 'day', NOW, {});
    assert.deepEqual(input, snapshot, '入参未被改动');
  });

  test('rerank 门控关闭 → 仅富化不重排', () => {
    const input = [
      mk('stale', { publishedDate: '2020-01-01' }),
      mk('fresh', { snippet: '今天' }),
    ];
    const out = fr.applyRecencyRanking(input, 'week', NOW, { KHY_SEARCH_FRESHNESS_RERANK: 'off' });
    assert.deepEqual(out.map(r => r.title), ['tstale', 'tfresh'], '原序保持');
  });

  test('内部辅助字段不泄漏到输出', () => {
    const out = fr.applyRecencyRanking([mk('a', { snippet: '今天' })], 'day', NOW, {});
    assert.ok(!('_freshTs' in out[0]));
    assert.ok(!('_origIdx' in out[0]));
  });

  test('空 / 非数组 输入安全', () => {
    assert.deepEqual(fr.applyRecencyRanking([], 'day', NOW, {}), []);
    assert.deepEqual(fr.applyRecencyRanking(null, 'day', NOW, {}), []);
  });
});
