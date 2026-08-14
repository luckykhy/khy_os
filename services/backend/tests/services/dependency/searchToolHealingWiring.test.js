'use strict';

/**
 * searchToolHealingWiring.test.js — 验证 news / webSearch 两个工具把
 * webSearchService 的「缺失依赖软失败」如实传播到 executeTool 自愈漏斗，
 * 而不是静默降级（news）或包成假成功（webSearch）。
 *
 * 关注点：
 *   1) webSearch 工具：内层 success:false 必须向上传播为 success:false 且带 depId；
 *      内层成功仍正常返回 { success:true, data }。
 *   2) news 工具：无结果时返回 success:false 并透传 depId。
 *   3) detectFromError 能据这两个工具产出的失败对象精确辨认（端到端接线证据）。
 *
 * 全程零网络：注入 webSearchService.search 的纯内存桩。
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const webSearchService = require('../../../src/services/webSearchService');
const resolver = require('../../../src/services/dependency/resolver');

const webSearchTool = require('../../../src/tools/webSearch');
const newsTool = require('../../../src/tools/news');

const _origSearch = webSearchService.search;
function stubSearch(fn) { webSearchService.search = fn; }
afterEach(() => { webSearchService.search = _origSearch; });

describe('webSearch 工具 — 失败传播 + depId', () => {
  test('内层 cheerio 缺失软失败 → 向上 success:false 且带 depId', async () => {
    stubSearch(async () => ({ success: false, error: 'HTML 解析依赖 cheerio 未安装', depId: 'cheerio' }));
    const out = await webSearchTool.execute({ query: 'x' }, {});
    assert.equal(out.success, false);
    assert.equal(out.depId, 'cheerio');
    // 该失败对象进 funnel 后能被自愈层精确辨认
    assert.equal(resolver.detectFromError(out).depId, 'cheerio');
  });

  test('内层成功 → 仍正常 { success:true, data }', async () => {
    stubSearch(async () => ({ success: true, results: [{ title: 't', url: 'https://a' }] }));
    const out = await webSearchTool.execute({ query: 'x' }, {});
    assert.equal(out.success, true);
    assert.ok(out.data && out.data.success);
  });
});

describe('news 工具 — 无结果时透传 depId', () => {
  test('web 失败带 depId → news 失败结果透传 depId', async () => {
    stubSearch(async () => ({ success: false, error: 'cheerio 未安装', depId: 'cheerio' }));
    const out = await newsTool.execute({ query: '热点新闻' }, {});
    assert.equal(out.success, false);
    assert.equal(out.depId, 'cheerio');
    assert.equal(resolver.detectFromError(out).depId, 'cheerio');
  });

  test('web 失败无 depId → news 仍失败但不杜撰 depId', async () => {
    stubSearch(async () => ({ success: false, error: '当前环境无法访问外网搜索引擎。' }));
    const out = await newsTool.execute({ query: '热点新闻' }, {});
    assert.equal(out.success, false);
    assert.equal(out.depId, undefined);
    // 网络类失败不应被误判为依赖缺失
    assert.equal(resolver.detectFromError(out), null);
  });
});
