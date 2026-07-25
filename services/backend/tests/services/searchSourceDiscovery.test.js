'use strict';

/**
 * searchSourceDiscovery.test.js — 搜索「源发现」单一真源纯模块单测。
 *
 * 守护(goal 2026-06-26「搜索工具都是固定站点,要是出现什么新的站点 khy 怎么发现呢」):
 *   1. 动态引擎注册:loadDynamicEngines 从 env JSON / 配置文本声明额外引擎(无需改源码);
 *      _normalizeEngine 校验 name / urlTemplate({q})/ parser(未知→generic)/ weight(夹取)。
 *   2. buildEngineUrl 填 {q}(encodeURIComponent + 截断)与 {fresh}(占位或按需追加)。
 *   3. discoverEmergingSources:从结果里挖跨引擎反复出现 / 排名靠前却不在已知源里的新域名;
 *      打分排序;绝不改入参;门控关闭 → []。
 *   4. suggestSiteQueries / formatDiscoveryFooter 产 site: 跟进检索与页脚。
 *   5. env 门控 KHY_SEARCH_SOURCE_DISCOVERY 默认开,显式 0/false/off 关闭。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const sd = require('../../src/services/search/searchSourceDiscovery');
const { normalizeEngine, host, isKnownHost, scoreSource } = sd.__internal;

describe('1. 门控', () => {
  test('默认开', () => {
    assert.equal(sd.isEnabled({}), true);
    assert.equal(sd.isEnabled(undefined), true);
  });
  test('显式 0/false/off 关闭', () => {
    for (const v of ['0', 'false', 'off']) {
      assert.equal(sd.isEnabled({ KHY_SEARCH_SOURCE_DISCOVERY: v }), false, v);
    }
  });
  test('关闭后 loadDynamicEngines / discoverEmergingSources 返回 []', () => {
    const env = { KHY_SEARCH_SOURCE_DISCOVERY: '0', KHY_SEARCH_EXTRA_ENGINES: '[{"name":"x","url":"https://x.com/s?q={q}"}]' };
    assert.deepEqual(sd.loadDynamicEngines({ env }), []);
    assert.deepEqual(sd.discoverEmergingSources([{ url: 'https://new.io/a' }], { env }), []);
  });
});

describe('2. _normalizeEngine 校验', () => {
  test('合法声明归一化', () => {
    const e = normalizeEngine({ name: 'MySearch', url: 'https://my.com/s?q={q}', parser: 'bing', weight: 0.8 });
    assert.equal(e.name, 'mysearch');
    assert.equal(e.parser, 'bing');
    assert.equal(e.weight, 0.8);
  });
  test('非法 name → null', () => {
    assert.equal(normalizeEngine({ name: '-bad', url: 'https://a.com/{q}' }), null);
    assert.equal(normalizeEngine({ name: '', url: 'https://a.com/{q}' }), null);
  });
  test('非 http(s) 或缺 {q} → null', () => {
    assert.equal(normalizeEngine({ name: 'a', url: 'ftp://a.com/{q}' }), null);
    assert.equal(normalizeEngine({ name: 'a', url: 'https://a.com/search' }), null);
  });
  test('未知 parser → generic;bing-cn → bing', () => {
    assert.equal(normalizeEngine({ name: 'a', url: 'https://a.com/{q}', parser: 'whatever' }).parser, 'generic');
    assert.equal(normalizeEngine({ name: 'a', url: 'https://a.com/{q}', parser: 'bing-cn' }).parser, 'bing');
  });
  test('weight 夹取到 [0.1,1],缺省 0.5', () => {
    assert.equal(normalizeEngine({ name: 'a', url: 'https://a.com/{q}', weight: 99 }).weight, 1);
    assert.equal(normalizeEngine({ name: 'a', url: 'https://a.com/{q}', weight: -5 }).weight, 0.1);
    assert.equal(normalizeEngine({ name: 'a', url: 'https://a.com/{q}' }).weight, 0.5);
  });
});

describe('3. loadDynamicEngines', () => {
  test('从 env JSON 数组装载', () => {
    const env = { KHY_SEARCH_EXTRA_ENGINES: '[{"name":"foo","url":"https://foo.com/s?q={q}"}]' };
    const list = sd.loadDynamicEngines({ env });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'foo');
    assert.equal(list[0].origin, 'env');
  });
  test('配置文本接受 {engines:[...]} 形态 + 同名去重(先到先得)', () => {
    const env = { KHY_SEARCH_EXTRA_ENGINES: '[{"name":"foo","url":"https://foo.com/{q}","weight":0.9}]' };
    const configText = '{"engines":[{"name":"foo","url":"https://other.com/{q}"},{"name":"bar","url":"https://bar.com/{q}"}]}';
    const list = sd.loadDynamicEngines({ env, configText });
    assert.equal(list.length, 2);
    const foo = list.find((e) => e.name === 'foo');
    assert.equal(foo.weight, 0.9, '同名先到先得:env 的 foo 胜出');
    assert.ok(list.find((e) => e.name === 'bar'));
  });
  test('非法 JSON / 非数组 → 静默跳过', () => {
    assert.deepEqual(sd.loadDynamicEngines({ env: { KHY_SEARCH_EXTRA_ENGINES: 'not json' } }), []);
    assert.deepEqual(sd.loadDynamicEngines({ configText: '{"engines":"oops"}' }), []);
  });
});

describe('4. buildEngineUrl', () => {
  const desc = { urlTemplate: 'https://my.com/search?q={q}', parser: 'generic' };
  test('填 {q} 并 encodeURIComponent', () => {
    assert.equal(sd.buildEngineUrl(desc, 'a b&c'), 'https://my.com/search?q=a%20b%26c');
  });
  test('截断查询到 200 字符', () => {
    const long = 'x'.repeat(500);
    const url = sd.buildEngineUrl(desc, long);
    assert.equal(decodeURIComponent(url.split('q=')[1]).length, 200);
  });
  test('{fresh} 占位被替换', () => {
    const d = { urlTemplate: 'https://my.com/s?q={q}&{fresh}' };
    assert.equal(sd.buildEngineUrl(d, 'hi', 'df=w'), 'https://my.com/s?q=hi&df=w');
  });
  test('无 {fresh} 占位但给了 fresh → 按需以 & 追加', () => {
    assert.equal(sd.buildEngineUrl(desc, 'hi', 'df=w'), 'https://my.com/search?q=hi&df=w');
  });
  test('无 ? 的模板 + fresh → 以 ? 追加', () => {
    const d = { urlTemplate: 'https://my.com/{q}' };
    assert.equal(sd.buildEngineUrl(d, 'hi', 'tsn=1'), 'https://my.com/hi?tsn=1');
  });
});

describe('5. _host / _isKnownHost', () => {
  test('去 www. + 小写', () => {
    assert.equal(host('https://WWW.Example.COM/a'), 'example.com');
  });
  test('无法解析 → 空', () => {
    assert.equal(host('not a url'), '');
  });
  test('已知域 + 子域命中', () => {
    assert.equal(isKnownHost('baidu.com'), true);
    assert.equal(isKnownHost('img.baidu.com'), true);
    assert.equal(isKnownHost('zh.wikipedia.org'), true);
    assert.equal(isKnownHost('brand-new-site.io'), false);
  });
  test('空 host 视为已知(不当新源)', () => {
    assert.equal(isKnownHost(''), true);
  });
});

describe('6. discoverEmergingSources', () => {
  test('跨引擎共识(engineCount≥2)的新域名被发现', () => {
    const results = [
      { url: 'https://baidu.com/x', engineCount: 3 },          // 已知,排除
      { url: 'https://fresh-authority.io/a', engineCount: 2 }, // 新冒头·共识
      { url: 'https://fresh-authority.io/b', engineCount: 1 },
    ];
    const out = sd.discoverEmergingSources(results);
    assert.equal(out.length, 1);
    assert.equal(out[0].host, 'fresh-authority.io');
    assert.equal(out[0].maxEngineCount, 2);
  });
  test('出现≥2次也算冒头', () => {
    const results = [
      { url: 'https://newblog.dev/1' },
      { url: 'https://newblog.dev/2' },
      { url: 'https://once.net/x' },   // 仅 1 次且排名靠后 → 不算
      { url: 'https://once.net/y2' },
      { url: 'https://filler.org/z' },
      { url: 'https://once.net/3rd' },
    ];
    const hosts = sd.discoverEmergingSources(results).map((s) => s.host);
    assert.ok(hosts.includes('newblog.dev'));
  });
  test('排进前 3 名也算冒头(即便仅 1 次)', () => {
    const results = [
      { url: 'https://topnew.ai/a' },  // rank 0
      { url: 'https://baidu.com/x' },
    ];
    const hosts = sd.discoverEmergingSources(results).map((s) => s.host);
    assert.ok(hosts.includes('topnew.ai'));
  });
  test('绝不改入参', () => {
    const results = [{ url: 'https://x.io/a', engineCount: 2 }, { url: 'https://x.io/b', engineCount: 2 }];
    const snapshot = JSON.stringify(results);
    sd.discoverEmergingSources(results);
    assert.equal(JSON.stringify(results), snapshot);
  });
  test('空 / 非数组 → []', () => {
    assert.deepEqual(sd.discoverEmergingSources([]), []);
    assert.deepEqual(sd.discoverEmergingSources(null), []);
  });
  test('max 上限生效', () => {
    const results = [];
    for (let i = 0; i < 10; i++) { results.push({ url: `https://s${i}.io/a`, engineCount: 2 }); results.push({ url: `https://s${i}.io/b`, engineCount: 2 }); }
    assert.equal(sd.discoverEmergingSources(results, { max: 3 }).length, 3);
  });
});

describe('7. scoreSource 确定性', () => {
  test('共识 > 频次 > 排名,确定性', () => {
    const a = scoreSource({ maxEngineCount: 2, hits: 1, bestRank: 5 }, 10);
    const b = scoreSource({ maxEngineCount: 1, hits: 1, bestRank: 5 }, 10);
    assert.ok(a > b, '有跨引擎共识者得分更高');
  });
});

describe('8. suggestSiteQueries / formatDiscoveryFooter', () => {
  const emerging = [
    { host: 'fresh-a.io', maxEngineCount: 2, hits: 2 },
    { host: 'fresh-b.dev', maxEngineCount: 1, hits: 3 },
  ];
  test('site: 跟进检索串', () => {
    const qs = sd.suggestSiteQueries(emerging, 'rust async', 2);
    assert.deepEqual(qs, ['site:fresh-a.io rust async', 'site:fresh-b.dev rust async']);
  });
  test('空 query / 空 emerging → []', () => {
    assert.deepEqual(sd.suggestSiteQueries(emerging, '   '), []);
    assert.deepEqual(sd.suggestSiteQueries([], 'q'), []);
  });
  test('页脚包含新发现来源标题与主机名', () => {
    const footer = sd.formatDiscoveryFooter(emerging);
    assert.match(footer, /新发现来源/);
    assert.match(footer, /fresh-a\.io/);
    assert.match(footer, /site:/);
  });
  test('空 emerging → 空页脚', () => {
    assert.equal(sd.formatDiscoveryFooter([]), '');
    assert.equal(sd.formatDiscoveryFooter(null), '');
  });
});
