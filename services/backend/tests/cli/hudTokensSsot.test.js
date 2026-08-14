'use strict';

// hudRenderer 的 token 计数显示一律走 ccFormatTokens SSOT 的契约测试。
// 对齐 CC src/utils/format.ts::formatTokens(Intl 紧凑记数:12345→"12.3k"、
// 1000→"1k"、1.5M→"1.5m")——HUD 此前用本地 fmtTokens 偏离(>10k 丢小数
// "12k"、无 m 兆单位 "1500k")。门控 KHY_CC_FORMAT 关 → 逐字节回退本地口径。
// 经公开 renderHudPanel API 验证(fmtTokens 是模块内私有)。零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const hud = require('../../src/cli/hudRenderer');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function panelContextLine(env) {
  const saved = process.env.KHY_CC_FORMAT;
  if (env === undefined) delete process.env.KHY_CC_FORMAT;
  else process.env.KHY_CC_FORMAT = env;
  try {
    hud.setContextUsage(12345, 200000);
    const out = strip(hud.renderHudPanel(80));
    return out.split('\n').find((l) => /Context/.test(l)) || '';
  } finally {
    if (saved === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = saved;
  }
}

test('门控开(默认):HUD token 计数走 ccFormatTokens(12345→12.3k,非本地 12k)', () => {
  const line = panelContextLine(undefined);
  assert.match(line, /12\.3k/, 'used 应为 CC 紧凑 12.3k');
  assert.ok(!/\b12k\b/.test(line), '不应是本地丢小数的 12k');
  assert.match(line, /200k/, 'limit 200000 → 200k');
});

test('门控关:逐字节回退本地 fmtTokens(12345→12k)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const line = panelContextLine(off);
    assert.match(line, /\b12k\b/, `门控关(${off})应回退本地 12k`);
    assert.ok(!/12\.3k/.test(line), `门控关(${off})不应出现 CC 12.3k`);
  }
});

test('SSOT 对齐:小数/兆单位差异(本地无 m、>10k 丢小数)经 SSOT 修正', () => {
  // 直接对照 SSOT 与本地旧口径,锁定本刀修正的发散点。
  const { ccFormatTokens } = require('../../src/cli/ccFormat');
  const local = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  assert.strictEqual(ccFormatTokens(1000), '1k');
  assert.strictEqual(local(1000), '1.0k'); // 旧口径多余 .0
  assert.strictEqual(ccFormatTokens(123456), '123.5k');
  assert.strictEqual(local(123456), '123k'); // 旧口径丢小数
  assert.strictEqual(ccFormatTokens(1500000), '1.5m');
  assert.strictEqual(local(1500000), '1500k'); // 旧口径无兆单位
});
