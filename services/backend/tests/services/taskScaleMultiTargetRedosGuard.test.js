'use strict';

/**
 * taskScaleMultiTargetRedosGuard — latent greedy-digit ReDoS in _MULTI_TARGET.
 *
 * `_MULTI_TARGET` (used by resolveTaskScale to detect multi-step/多目标 intent)
 * had an unbounded greedy alternative `\d+[\)）、]`: the digit run consumes the
 * whole string, then the trailing symbol class fails and backtracks at every
 * start position → O(n^2). The bare regex froze ~9402ms on a 100k digit run.
 *
 * NOTE ON REACHABILITY (honest, R14-style): this is NOT a live DoS. The only
 * caller, resolveTaskScale, hits Rule 2 (`len >= 700 → 'large'`) BEFORE this
 * regex runs at Rule 6, so any input long enough to backtrack has already
 * returned (200k-char entry point resolves in ~1ms). The fix is defense-in-depth
 * — the "safety" otherwise depends only on the incidental ordering/threshold of
 * an adjacent rule, and would resurrect if Rule 2 were reordered or raised.
 *
 * Fix: bound the numeric head to `\d{1,15}` in the two digit alternatives.
 * Real numbered lists never exceed 15 digits → byte-identical classification on
 * every realistic message; linear on the pathological one.
 */

const PATH = require.resolve('../../src/services/taskScale');

function fresh() {
  delete require.cache[PATH];
  return require(PATH);
}

function elapsedMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('taskScaleMultiTargetRedosGuard — _MULTI_TARGET ReDoS', () => {
  it('the bounded regex stays linear on a huge digit run (was ~9402ms)', () => {
    const { _MULTI_TARGET } = fresh();
    const q = '9'.repeat(100000) + 'x';
    const ms = elapsedMs(() => _MULTI_TARGET.test(q));
    expect(ms).toBeLessThan(500);
  });

  it('resolveTaskScale entry point is linear on huge input (Rule 2 short-circuit)', () => {
    const { resolveTaskScale } = fresh();
    const q = '9'.repeat(200000) + 'x 帮我写代码';
    let out;
    const ms = elapsedMs(() => { out = resolveTaskScale(q); });
    expect(ms).toBeLessThan(500);
    expect(out).toBe('large'); // len >= 700 → large, unchanged
  });

  it('realistic numbered-list multi-target intent is still detected (byte-identical)', () => {
    const { _MULTI_TARGET } = fresh();
    // The digit alternatives still fire on real序号 up to 15 digits.
    expect(_MULTI_TARGET.test('1) 修复bug')).toBe(true);
    expect(_MULTI_TARGET.test('3、添加测试')).toBe(true);
    expect(_MULTI_TARGET.test('1. 先做这个')).toBe(true);
    // Non-digit alternatives unaffected.
    expect(_MULTI_TARGET.test('第三步做这个')).toBe(true);
    expect(_MULTI_TARGET.test('首先编译然后测试')).toBe(true);
    // Plain prose with no multi-step signal does not match.
    expect(_MULTI_TARGET.test('帮我看下这个函数')).toBe(false);
  });

  it('resolveTaskScale classifies a real multi-step coding message as large', () => {
    const { resolveTaskScale } = fresh();
    const msg = '帮我做这几件事：1) 修复登录bug 2) 重构路由 3) 添加单元测试';
    expect(resolveTaskScale(msg)).toBe('large');
  });
});
