'use strict';

// hudRenderer 的 elapsed 时长显示一律走 ccFormatDuration SSOT 的契约测试。
// 对齐 CC src/utils/format.ts::formatDuration —— 与 turnStats / spinner
// _formatElapsed 同一单一真源。HUD 此前用本地 fmtDuration **丢秒**:
// 90s → "1m"(丢 30s)、小时态无空格 "1h1m"。门控 KHY_CC_FORMAT 默认开走
// { hideTrailingZeros:true }(90s → "1m 30s"、60s → "1m");关 → 逐字节回退
// 本地旧口径。fmtDuration 是模块内私有,经公开 renderHudPanel 的 "Session"
// 行(elapsed = Date.now() - sessionStart)验证:读真 sessionStart(getState
// 返回浅拷贝可读)后把 Date.now mock 到 sessionStart+Δ 得确定性时长。零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const hud = require('../../src/cli/hudRenderer');
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// 用确定性 elapsed 渲染 "Session" 行(mock Date.now 到 sessionStart+deltaMs)。
function sessionLine(deltaMs, env) {
  const savedEnv = process.env.KHY_CC_FORMAT;
  const realNow = Date.now;
  if (env === undefined) delete process.env.KHY_CC_FORMAT;
  else process.env.KHY_CC_FORMAT = env;
  try {
    const sessionStart = hud.getState().sessionStart; // 真值(只读)
    Date.now = () => sessionStart + deltaMs;
    const out = strip(hud.renderHudPanel(80));
    return out.split('\n').find((l) => /Session/.test(l)) || '';
  } finally {
    Date.now = realNow;
    if (savedEnv === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = savedEnv;
  }
}

test('门控开(默认):HUD elapsed 走 ccFormatDuration·90s → "1m 30s"(非丢秒 "1m")', () => {
  const line = sessionLine(90000, undefined);
  assert.match(line, /1m 30s/, '90s 应显 CC "1m 30s" 保留秒');
  assert.ok(!/\b1m\b(?! 30s)/.test(line), '不应是本地丢秒的裸 "1m"');
});

test('门控开:60s → "1m"(hideTrailingZeros 隐藏 0s),小时态带空格 "1h 1m 1s"', () => {
  assert.match(sessionLine(60000, undefined), /Session\s+1m\b/, '60s → "1m"(不显 "1m 0s")');
  assert.match(sessionLine(3661000, undefined), /1h 1m 1s/, '1h1m1s → CC 带空格 "1h 1m 1s"');
});

test('门控关:逐字节回退本地 fmtDuration(90s → "1m" 丢秒,1h1m1s → "1h1m" 无空格)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const l90 = sessionLine(90000, off);
    assert.match(l90, /Session\s+1m\b/, `门控关(${off})90s 应回退本地 "1m"`);
    assert.ok(!/1m 30s/.test(l90), `门控关(${off})不应出现 CC "1m 30s"`);
    assert.match(sessionLine(3661000, off), /1h1m/, `门控关(${off})1h1m1s → 本地 "1h1m" 无空格`);
  }
});

test('SSOT 对齐:本地丢秒/无空格的发散点经 SSOT 修正', () => {
  // 直接对照 SSOT 与本地旧口径,锁定本刀修正的发散点。
  const { ccFormatDuration } = require('../../src/cli/ccFormat');
  const local = (ms) => {
    const sec = Math.floor(ms / 1000);
    if (sec >= 3600) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
    if (sec >= 60) return `${Math.floor(sec / 60)}m`;
    return `${sec}s`;
  };
  const opt = { hideTrailingZeros: true };
  assert.strictEqual(ccFormatDuration(90000, opt), '1m 30s');
  assert.strictEqual(local(90000), '1m'); // 旧口径丢 30s
  assert.strictEqual(ccFormatDuration(3661000, opt), '1h 1m 1s');
  assert.strictEqual(local(3661000), '1h1m'); // 旧口径无空格 + 丢秒
  assert.strictEqual(ccFormatDuration(60000, opt), '1m');
  assert.strictEqual(local(60000), '1m'); // 整分两者一致
});

// ── 补刀:tool-history(第 511 行)/ agent(第 531 行)两条 per-item elapsed 此前是
// 裸 `${(ms/1000).toFixed(1)}s` 孤儿(绕过 fmtDuration SSOT,尽管 fmtDuration 文档
// 自称「所有 4 条 HUD elapsed 都经 SSOT」)。现经 sibling fmtElapsedItem 收敛:
// 门控开 → CC 紧凑体(125s → "2m 5s",不再丑陋 "125.0s");门控关 → 逐字节回退各自
// 历史小数秒 "125.0s"(保 byte-identical 红线,区别于 Session/active-tool 的向下取整体)。

// 渲染指定 elapsed 的「Tools」历史行(toolEnd 直存 elapsed,无需 mock Date.now)。
function toolRow(elapsedMs, env, name) {
  const savedEnv = process.env.KHY_CC_FORMAT;
  if (env === undefined) delete process.env.KHY_CC_FORMAT;
  else process.env.KHY_CC_FORMAT = env;
  try {
    hud.toolEnd(name, 'success', elapsedMs);
    const out = strip(hud.renderHudPanel(80));
    return out.split('\n').find((l) => l.includes(name)) || '';
  } finally {
    if (savedEnv === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = savedEnv;
  }
}

// 渲染指定 elapsed 的「Agents」行(agentUpdate 整体替换 activeAgents,直存 elapsed)。
function agentRow(elapsedMs, env, name) {
  const savedEnv = process.env.KHY_CC_FORMAT;
  if (env === undefined) delete process.env.KHY_CC_FORMAT;
  else process.env.KHY_CC_FORMAT = env;
  try {
    hud.agentUpdate([{ name, status: 'running', elapsed: elapsedMs }]);
    const out = strip(hud.renderHudPanel(80));
    return out.split('\n').find((l) => l.includes(name)) || '';
  } finally {
    if (savedEnv === undefined) delete process.env.KHY_CC_FORMAT;
    else process.env.KHY_CC_FORMAT = savedEnv;
  }
}

test('tool-history elapsed:门控开走 SSOT(90s → "1m 30s"·3.2s → "3s"),不再裸 "90.0s"', () => {
  const l90 = toolRow(90000, undefined, 'HudLongBash');
  assert.match(l90, /1m 30s/, '90s 应显 CC 紧凑 "1m 30s"');
  assert.ok(!/90\.0s/.test(l90), '不应残留裸 "90.0s"');
  const l3 = toolRow(3200, undefined, 'HudFastGrep');
  assert.match(l3, /\b3s\b/, '3.2s 门控开向下取整 → "3s"');
  assert.ok(!/3\.2s/.test(l3), '门控开不应显小数 "3.2s"');
});

test('tool-history elapsed:门控关逐字节回退历史小数秒 "90.0s" / "3.2s"', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.match(toolRow(90000, off, 'HudOffBash'), /90\.0s/, `门控关(${off})应回退 "90.0s"`);
    assert.match(toolRow(3200, off, 'HudOffGrep'), /3\.2s/, `门控关(${off})应回退 "3.2s"`);
  }
});

test('agent elapsed:门控开走 SSOT(125s → "2m 5s"),不再丑陋 "125.0s";门控关回退 "125.0s"', () => {
  const on = agentRow(125000, undefined, 'HudAgentOn');
  assert.match(on, /2m 5s/, '125s 门控开 → CC 紧凑 "2m 5s"');
  assert.ok(!/125\.0s/.test(on), '门控开不应残留 "125.0s"');
  const off = agentRow(125000, 'off', 'HudAgentOff');
  assert.match(off, /125\.0s/, '门控关逐字节回退 "125.0s"');
  assert.ok(!/2m 5s/.test(off), '门控关不应出现 CC "2m 5s"');
});
