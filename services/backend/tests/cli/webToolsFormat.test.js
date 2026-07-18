'use strict';

/**
 * webToolsFormat.test.js — `/web-tools` 纯叶子的确定性单测 (node:test)。
 *
 * 覆盖：门控开关、后端可用/不可用行、抓取解析行、动态引擎发现开关 + 引擎清单渲染、
 * 空引擎、可复用解析器、配置指引（configPath / env 声明标记）、坏输入 → null、绝不抛。
 * 所有事实由参数传入——叶子零 IO。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  webToolsEnabled,
  formatWebTools,
  ORIGIN_LABELS,
} = require('../../src/cli/webToolsFormat');

describe('webToolsFormat.webToolsEnabled (gate)', () => {
  test('default on', () => {
    assert.equal(webToolsEnabled({}), true);
    assert.equal(webToolsEnabled(), true);
  });
  test('off values disable', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(webToolsEnabled({ KHY_WEB_TOOLS: v }), false);
    }
  });
  test('unknown value stays on', () => {
    assert.equal(webToolsEnabled({ KHY_WEB_TOOLS: 'yes' }), true);
  });
});

describe('webToolsFormat.formatWebTools', () => {
  const sample = {
    success: true,
    backend: { name: 'Kiro MCP', available: true },
    fetch: { htmlParsing: true },
    discovery: { enabled: true, flag: 'KHY_SEARCH_SOURCE_DISCOVERY' },
    engines: [
      { name: 'myengine', parser: 'generic', weight: 0.5, origin: 'config' },
      { name: 'other', parser: 'bing', weight: 0.8, origin: 'env' },
    ],
    knownParsers: ['baidu', 'bing', 'generic'],
    configPath: '/home/u/.khy/search_engines.json',
    envEngineDeclared: true,
  };

  test('renders header, backend, fetch, discovery, engines and guidance', () => {
    const out = formatWebTools(sample, {});
    assert.ok(out.includes('对齐 Claude Code /web-tools'));
    assert.ok(out.includes('搜索后端：Kiro MCP ✓ 可用'));
    assert.ok(out.includes('HTML 解析 ✓ 可用'));
    assert.ok(out.includes('动态引擎发现：开'));
    assert.ok(out.includes('KHY_SEARCH_SOURCE_DISCOVERY'));
    assert.ok(out.includes('已加载 2 个动态引擎'));
    assert.ok(out.includes('myengine'));
    assert.ok(out.includes('解析器 generic'));
    assert.ok(out.includes('权重 0.50'));
    assert.ok(out.includes('权重 0.80'));
    assert.ok(out.includes('配置文件 search_engines.json'));
    assert.ok(out.includes('环境变量 KHY_SEARCH_EXTRA_ENGINES'));
    assert.ok(out.includes('可复用解析器：baidu、bing、generic'));
    assert.ok(out.includes('/home/u/.khy/search_engines.json'));
    assert.ok(out.includes('[已声明]'));
  });

  test('unavailable backend + fetch surface degradation hints', () => {
    const out = formatWebTools(
      {
        backend: { name: 'Kiro MCP', available: false },
        fetch: { htmlParsing: false },
        discovery: { enabled: false, flag: 'KHY_SEARCH_SOURCE_DISCOVERY' },
        engines: [],
        knownParsers: [],
      },
      {},
    );
    assert.ok(out.includes('✗ 不可用'));
    assert.ok(out.includes('降级到公开引擎兜底'));
    assert.ok(out.includes('退化为纯文本抓取'));
    assert.ok(out.includes('动态引擎发现：关'));
    assert.ok(out.includes('当前未加载任何动态引擎'));
  });

  test('env not declared → no [已声明] marker', () => {
    const out = formatWebTools(
      { backend: {}, fetch: {}, discovery: {}, engines: [], envEngineDeclared: false },
      {},
    );
    assert.ok(!out.includes('[已声明]'));
  });

  test('gate off → null (byte-identical fallback: command not taken over)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(formatWebTools(sample, { KHY_WEB_TOOLS: v }), null);
    }
  });

  test('bad input → null', () => {
    assert.equal(formatWebTools(null, {}), null);
    assert.equal(formatWebTools(undefined, {}), null);
    assert.equal(formatWebTools('nope', {}), null);
    assert.equal(formatWebTools(42, {}), null);
    assert.equal(formatWebTools([], {}), null);
  });

  test('never throws on hostile input', () => {
    assert.doesNotThrow(() =>
      formatWebTools(
        { backend: 42, fetch: null, discovery: 'x', engines: [null, {}, { name: 5 }], knownParsers: 'no' },
        {},
      ),
    );
    const out = formatWebTools(
      { engines: [null, { name: 'ok', parser: 'generic', weight: 'bad', origin: 'zzz' }] },
      {},
    );
    // weight 非法 → 回退 0.50；未知 origin 原样透传。
    assert.ok(out.includes('权重 0.50'));
    assert.ok(out.includes('zzz'));
  });

  test('ORIGIN_LABELS maps env/config to friendly zh', () => {
    assert.ok(/KHY_SEARCH_EXTRA_ENGINES/.test(ORIGIN_LABELS.env));
    assert.ok(/search_engines\.json/.test(ORIGIN_LABELS.config));
  });
});
