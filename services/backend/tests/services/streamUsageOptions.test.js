'use strict';

/**
 * streamUsageOptions — 让 OpenAI 兼容流式请求主动索取 usage,修「ctx 卡在 0%」。
 *
 * 回归目标(截图:agnes `api:agnes:agnes-2.0-flash` 跑 37 分钟大量输出仍 `0% ctx (0/128k)`):
 * 流式请求须带 `stream_options:{include_usage:true}`,否则标准 OpenAI 兼容网关整条流无 usage。
 * 本套件验证:门控开时就地补该字段、门控关字节回退不加、非对象/异常 fail-soft、保守合并已有
 * stream_options、LIVE wiring 进 multiFreeService 流式请求。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('../../src/services/streamUsageOptions');

test('门控开:就地补 stream_options.include_usage=true', () => {
  const body = { model: 'm', messages: [], stream: true };
  const out = mod.applyStreamUsage(body, {});
  assert.strictEqual(out, body, '应返回同一对象(就地)');
  assert.deepStrictEqual(body.stream_options, { include_usage: true });
});

test('门控关 → 不加字段(逐字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const body = { model: 'm', messages: [], stream: true };
    mod.applyStreamUsage(body, { KHY_STREAM_USAGE: off });
    assert.strictEqual(body.stream_options, undefined, off);
  }
});

test('保守合并:已有 stream_options 的其它子键不被覆盖', () => {
  const body = { stream: true, stream_options: { continuous_usage_stats: true } };
  mod.applyStreamUsage(body, {});
  assert.deepStrictEqual(body.stream_options, {
    continuous_usage_stats: true,
    include_usage: true,
  });
});

test('fail-soft:非对象 / 异常输入原样返回,绝不抛', () => {
  for (const bad of [null, undefined, 123, 'x']) {
    assert.doesNotThrow(() => mod.applyStreamUsage(bad, {}));
    assert.strictEqual(mod.applyStreamUsage(bad, {}), bad);
  }
});

test('streamUsageEnabled:默认开 + 关闭词表(CANON 4 词)', () => {
  assert.strictEqual(mod.streamUsageEnabled({}), true);
  assert.strictEqual(mod.streamUsageEnabled({ KHY_STREAM_USAGE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.streamUsageEnabled({ KHY_STREAM_USAGE: off }), false, off);
  }
});

test('LIVE wiring:multiFreeService 流式分支确实 require 本叶子', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/services/multiFreeService.js'),
    'utf8',
  );
  assert.ok(
    /require\(['"]\.\/streamUsageOptions['"]\)/.test(src),
    'multiFreeService 应懒加载 streamUsageOptions',
  );
  assert.ok(/applyStreamUsage/.test(src), '应调用 applyStreamUsage');
});
