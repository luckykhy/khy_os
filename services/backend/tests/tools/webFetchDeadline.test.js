'use strict';

/**
 * webFetchDeadline — guard tests for WebFetch's total wall-clock deadline + abort
 * wiring (goal「khy 卡顿/卡死,无法做真正的软件项目」;症状「一显示正在处理就卡死」).
 *
 * 现场:WebFetch 卡在「正在检索外部信息… 1m59s · 等待响应…」直到外层 120s 硬顶。两条根因——
 *   ① Node `timeout` 是 socket 空闲超时(非总时限),慢站点滴数据/重定向每跳重置它 → 无总上限;
 *   ② execute 从不读 _context.signal → ESC 到不了在途请求,socket 永不销毁。
 * 本叶子做纯决策(门控 / 挑父信号 / 总墙钟预算 / 合并 signal / 识别 abort),有状态的
 * AbortController+定时器留在工具里。
 *
 * Invariants:
 *   ① gate KHY_WEBFETCH_HARD_DEADLINE default ON; 0/false/off/no → OFF
 *   ② resolveParentSignal: gate off → null; 无/非 signal-like → null; signal-like → 原信号
 *   ③ resolveTotalDeadlineMs: 有效正数 → 原值;非有限/非正 → fallback;fallback 也坏 → 30000
 *   ④ mergeSignalOption: signal 为空 → **返回原 options 引用**(逐字节等价);有 signal → 浅拷贝含 signal
 *   ⑤ isAbortError: ABORT_ERR / AbortError / __webFetchDeadline → true;其余 → false
 *   ⑥ LIVE wiring: index.js require 叶子 + execute 建 controller/总定时器/链父信号 + 沿链传 signal
 *      + catch 用 isAbortError 塑结果;flag 注册 default ON
 *
 * node:test(jest via rtk proxy unavailable — Exec format error).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leaf = require('../../src/tools/WebFetchTool/webFetchDeadline');
const BACKEND_ROOT = path.resolve(__dirname, '../../');

// ── ① gate default ON; falsy words → OFF ──────────────────────────────────
test('KHY_WEBFETCH_HARD_DEADLINE defaults ON, reverts on falsy words', () => {
  assert.strictEqual(leaf.isWebFetchHardDeadlineEnabled({}), true);
  assert.strictEqual(leaf.isWebFetchHardDeadlineEnabled({ KHY_WEBFETCH_HARD_DEADLINE: undefined }), true);
  assert.strictEqual(leaf.isWebFetchHardDeadlineEnabled({ KHY_WEBFETCH_HARD_DEADLINE: '' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      leaf.isWebFetchHardDeadlineEnabled({ KHY_WEBFETCH_HARD_DEADLINE: off }), false, `'${off}'`);
  }
  assert.strictEqual(leaf.isWebFetchHardDeadlineEnabled({ KHY_WEBFETCH_HARD_DEADLINE: '1' }), true);
});

// ── ② resolveParentSignal ─────────────────────────────────────────────────
test('resolveParentSignal picks a signal-like from context, else null', () => {
  const ac = new AbortController();
  // gate on + valid signal → the signal itself
  assert.strictEqual(leaf.resolveParentSignal({ signal: ac.signal }, {}), ac.signal);
  // gate off → null (byte-revert: tool wires nothing)
  assert.strictEqual(
    leaf.resolveParentSignal({ signal: ac.signal }, { KHY_WEBFETCH_HARD_DEADLINE: '0' }), null);
  // no context / no signal / non-signal-like → null
  assert.strictEqual(leaf.resolveParentSignal(null, {}), null);
  assert.strictEqual(leaf.resolveParentSignal({}, {}), null);
  assert.strictEqual(leaf.resolveParentSignal({ signal: {} }, {}), null);
  assert.strictEqual(leaf.resolveParentSignal({ signal: 'nope' }, {}), null);
});

// ── ③ resolveTotalDeadlineMs ──────────────────────────────────────────────
test('resolveTotalDeadlineMs takes valid positive, else fallback, else 30000', () => {
  assert.strictEqual(leaf.resolveTotalDeadlineMs(45000, 30000), 45000);
  assert.strictEqual(leaf.resolveTotalDeadlineMs(1, 30000), 1);
  // non-finite / non-positive → fallback
  assert.strictEqual(leaf.resolveTotalDeadlineMs(0, 30000), 30000);
  assert.strictEqual(leaf.resolveTotalDeadlineMs(-5, 30000), 30000);
  assert.strictEqual(leaf.resolveTotalDeadlineMs(NaN, 30000), 30000);
  assert.strictEqual(leaf.resolveTotalDeadlineMs(undefined, 30000), 30000);
  assert.strictEqual(leaf.resolveTotalDeadlineMs('slow', 12000), 12000);
  // fallback itself bad → hard 30000
  assert.strictEqual(leaf.resolveTotalDeadlineMs(0, 0), 30000);
  assert.strictEqual(leaf.resolveTotalDeadlineMs(NaN, NaN), 30000);
});

// ── ④ mergeSignalOption: null signal returns ORIGINAL ref (byte-identical) ─
test('mergeSignalOption returns original options ref when signal is null', () => {
  const opts = { timeout: 30000, headers: { a: 1 } };
  assert.strictEqual(leaf.mergeSignalOption(opts, null), opts, 'same reference when null');
  assert.strictEqual(leaf.mergeSignalOption(opts, undefined), opts, 'same reference when undefined');
  assert.ok(!('signal' in opts), 'original never gains a signal key');
});

test('mergeSignalOption attaches signal on a shallow copy when present', () => {
  const ac = new AbortController();
  const opts = { timeout: 30000, headers: { a: 1 } };
  const merged = leaf.mergeSignalOption(opts, ac.signal);
  assert.notStrictEqual(merged, opts, 'a copy, not the original');
  assert.strictEqual(merged.signal, ac.signal, 'signal attached');
  assert.strictEqual(merged.timeout, 30000, 'preserves other keys');
  assert.deepStrictEqual(merged.headers, { a: 1 });
  assert.ok(!('signal' in opts), 'original still untouched');
});

// ── ⑤ isAbortError ────────────────────────────────────────────────────────
test('isAbortError classifies abort-family errors, rejects the rest', () => {
  assert.strictEqual(leaf.isAbortError({ code: 'ABORT_ERR' }), true);
  assert.strictEqual(leaf.isAbortError({ name: 'AbortError' }), true);
  assert.strictEqual(leaf.isAbortError({ __webFetchDeadline: true }), true);
  assert.strictEqual(leaf.isAbortError(new Error('boom')), false);
  assert.strictEqual(leaf.isAbortError({ code: 'ETIMEDOUT' }), false);
  assert.strictEqual(leaf.isAbortError(null), false);
  assert.strictEqual(leaf.isAbortError(undefined), false);
  assert.strictEqual(leaf.isAbortError('AbortError'), false);
});

// ── ⑥ LIVE wiring guards ──────────────────────────────────────────────────
test('WebFetchTool wires webFetchDeadline into execute + fetch chain', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/tools/WebFetchTool/index.js'), 'utf8');
  assert.ok(/require\(['"]\.\/webFetchDeadline['"]\)/.test(src),
    'index.js must require ./webFetchDeadline');
  assert.ok(/resolveParentSignal\(context,\s*process\.env\)/.test(src),
    'execute must resolve the parent abort signal');
  assert.ok(/new AbortController\(\)/.test(src),
    'execute must create an internal AbortController for the total deadline');
  assert.ok(/resolveTotalDeadlineMs\(timeoutMs/.test(src),
    'execute must arm the total-deadline timer from resolveTotalDeadlineMs');
  assert.ok(/mergeSignalOption\(/.test(src),
    'fetch options must be threaded through mergeSignalOption');
  assert.ok(/webFetchDeadline\.isAbortError\(err\)/.test(src),
    'catch must shape abort into a truthful cancelled/timeout result');
  // execute signature now names `context` (was `_context` — signal was ignored)
  assert.ok(/async execute\(params,\s*context\)/.test(src),
    'execute must accept and use the tool execution context');
});

test('flagRegistry registers KHY_WEBFETCH_HARD_DEADLINE default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_WEBFETCH_HARD_DEADLINE', {}), true);
  assert.strictEqual(
    reg.isFlagEnabled('KHY_WEBFETCH_HARD_DEADLINE', { KHY_WEBFETCH_HARD_DEADLINE: 'off' }), false);
});
