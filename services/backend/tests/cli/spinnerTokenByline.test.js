'use strict';

/**
 * spinnerTokenByline — 刀41 回归:spinner token byline 数字格式须走 ccFormatNumber
 * (对齐 CC SpinnerAnimationRow.tsx:178 `formatNumber(totalTokens)`),**保留尾随 ".0"**
 * (8000→"8.0k"、1000000→"1.0m"),而非此前误用的 ccFormatTokens(去 ".0",显 "8k"/"1m")。
 *
 * 背后逻辑:agentStatLine.js 自述同族铁律——AgentProgressLine / TeammateSpinnerLine /
 * CoordinatorAgentStatus / **Spinner** 全走 formatNumber(非 formatTokens,保留尾随 ".0")。
 * spinner 此前是该族唯一被接错 helper 的一支;本刀换回 ccFormatNumber 与 CC + 同文件
 * legacy 回退(`(n/1000).toFixed(1)k` 本就保 ".0")重新一致。
 *
 * token byline 受 30s reveal-gate(spinnerMeta SHOW_TOKENS_AFTER_MS)控制,故测试把
 * _startTime 拨到 31s 前强制 byline 显出,再 stub process.stdout.write 捕获帧。零网络零 IO。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { DynamicSpinner } = require('../../src/cli/spinner');

// 拨到 31s 前 → 越过 30s reveal-gate,token byline 显出。stub 掉计时器副作用:
// 直接调 _renderInner() 不 start(),避免真 setInterval。
function frameWithInputTokens(n, env) {
  const prevEnv = {};
  for (const k of Object.keys(env || {})) {
    prevEnv[k] = process.env[k];
    if (env[k] == null) delete process.env[k];
    else process.env[k] = env[k];
  }
  const sp = new DynamicSpinner('thinking');
  sp._startTime = Date.now() - 31000; // force reveal-gate open
  sp._lastTokenAt = Date.now();
  sp.setTokens(n, 'input');

  let captured = '';
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => { captured += String(chunk); return true; };
  try {
    sp._renderInner();
  } finally {
    process.stdout.write = realWrite;
    for (const k of Object.keys(env || {})) {
      if (prevEnv[k] == null) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
  }
  return captured;
}

test('gate ON: 8000 input tokens → "8.0k"(formatNumber 保 .0),不再 "8k"', () => {
  const frame = frameWithInputTokens(8000, { KHY_CC_FORMAT: undefined }); // default-on
  assert.ok(frame.includes('8.0k tokens'), `expected "8.0k tokens" in: ${JSON.stringify(frame)}`);
  assert.ok(!frame.includes('8k tokens'), `should not contain bare "8k tokens": ${JSON.stringify(frame)}`);
});

test('gate ON: 1000000 input tokens → "1.0m"(mega 单位 + 保 .0)', () => {
  const frame = frameWithInputTokens(1000000, {});
  assert.ok(frame.includes('1.0m tokens'), `expected "1.0m tokens" in: ${JSON.stringify(frame)}`);
});

test('gate ON: 12345 → "12.3k"(非整千值与 formatTokens 同,无回归)', () => {
  const frame = frameWithInputTokens(12345, {});
  assert.ok(frame.includes('12.3k tokens'), `expected "12.3k tokens" in: ${JSON.stringify(frame)}`);
});

test('gate OFF: 逐字节回退 legacy(8000→"8.0k",legacy 本就保 .0)', () => {
  const frame = frameWithInputTokens(8000, { KHY_CC_FORMAT: 'off' });
  // legacy = `(n/1000).toFixed(1)k` → "8.0k";门控关 ccFormatNumber 不参与,逐字节回退。
  assert.ok(frame.includes('8.0k tokens'), `expected legacy "8.0k tokens" in: ${JSON.stringify(frame)}`);
});
