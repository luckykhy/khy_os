'use strict';

/**
 * tailTruncation.test.js — 尾切 truncated 早停判定(纯叶子 + liveHeightClamp 集成,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关。
 *  - _isVisible:tool 恒可见;text 仅当(归一化后)非空;其它/空 → false。
 *  - hasVisibleAbove:早停命中即返;stopIndex<0 → false;非数组 → false;异常 → true(保守)。
 *  - resolveTailTruncated:innerCut → 直接 true;否则等价 hasVisibleAbove。
 *  - **逐字节等价**:liveHeightClamp.tailTimelineToVisualRows 在 KHY_TAIL_TRUNCATION_FAST ON 与 OFF 下,
 *    对同输入产出相同 { entries, truncated }——覆盖视觉路径(KHY_LIVE_HARD_CLAMP 开)与
 *    原始行路径(KHY_LIVE_HARD_CLAMP 关 → 委托 _tailTimelineRaw),含 norm 存在/缺省、
 *    full-fit / budget-cut / inner-cut / 空 text 段 / norm→空跳过。
 *
 * 运行:node --test services/backend/tests/cli/tailTruncation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/ink-components/tailTruncation');
const clamp = require('../../src/cli/tui/ink-components/liveHeightClamp');

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_TAIL_TRUNCATION_FAST: 'off' }), false);
  assert.equal(leaf.isEnabled({ KHY_TAIL_TRUNCATION_FAST: '0' }), false);
  assert.equal(leaf.isEnabled({ KHY_TAIL_TRUNCATION_FAST: 'false' }), false);
  assert.equal(leaf.isEnabled({ KHY_TAIL_TRUNCATION_FAST: 'no' }), false);
  assert.equal(leaf.isEnabled({ KHY_TAIL_TRUNCATION_FAST: 'on' }), true);
});

test('_isVisible:tool 恒可见;text 非空可见;空/未知不可见', () => {
  assert.equal(leaf._isVisible({ type: 'tool' }), true);
  assert.equal(leaf._isVisible({ type: 'text', text: 'hi' }), true);
  assert.equal(leaf._isVisible({ type: 'text', text: '' }), false);
  assert.equal(leaf._isVisible({ type: 'text', text: '   ' }), true); // 非空串(空白也算,与调用点 !!t 一致)
  assert.equal(leaf._isVisible({ type: 'thinking', text: 'x' }), false);
  assert.equal(leaf._isVisible(null), false);
  // norm 参与:归一化到空 → 不可见
  assert.equal(leaf._isVisible({ type: 'text', text: 'x' }, () => ''), false);
  assert.equal(leaf._isVisible({ type: 'text', text: 'x' }, (t) => t.toUpperCase()), true);
});

test('hasVisibleAbove:早停/边界/异常', () => {
  const arr = [{ type: 'text', text: '' }, { type: 'tool' }, { type: 'text', text: 'a' }];
  assert.equal(leaf.hasVisibleAbove(arr, 2, null), true); // 索引 1 是 tool
  assert.equal(leaf.hasVisibleAbove(arr, 0, null), false); // 仅索引 0 空 text
  assert.equal(leaf.hasVisibleAbove(arr, -1, null), false); // 停点 <0
  assert.equal(leaf.hasVisibleAbove('nope', 3, null), false); // 非数组
  // norm 抛错 → 保守 true
  const throwNorm = () => { throw new Error('boom'); };
  assert.equal(leaf.hasVisibleAbove([{ type: 'text', text: 'a' }], 0, throwNorm), true);
});

test('resolveTailTruncated:innerCut 短路 true;否则等价 hasVisibleAbove', () => {
  const arr = [{ type: 'tool' }, { type: 'text', text: 'a' }];
  assert.equal(leaf.resolveTailTruncated(true, -1, arr, null), true); // innerCut → true 即使停点无可见
  assert.equal(leaf.resolveTailTruncated(false, 0, arr, null), true); // 索引 0 是 tool
  assert.equal(leaf.resolveTailTruncated(false, -1, arr, null), false);
});

// ── 集成:tailTimelineToVisualRows 在 FAST ON/OFF 下逐字节等价 ────────────────────────
function runBoth(timeline, budget, columns, extraEnv, norm) {
  const prevFast = process.env.KHY_TAIL_TRUNCATION_FAST;
  const prevHard = process.env.KHY_LIVE_HARD_CLAMP;
  try {
    if (extraEnv.KHY_LIVE_HARD_CLAMP === undefined) delete process.env.KHY_LIVE_HARD_CLAMP;
    else process.env.KHY_LIVE_HARD_CLAMP = extraEnv.KHY_LIVE_HARD_CLAMP;

    process.env.KHY_TAIL_TRUNCATION_FAST = 'off';
    const off = clamp.tailTimelineToVisualRows(timeline, budget, columns, process.env, norm);
    delete process.env.KHY_TAIL_TRUNCATION_FAST; // 默认 on
    const on = clamp.tailTimelineToVisualRows(timeline, budget, columns, process.env, norm);
    return { on, off };
  } finally {
    if (prevFast === undefined) delete process.env.KHY_TAIL_TRUNCATION_FAST;
    else process.env.KHY_TAIL_TRUNCATION_FAST = prevFast;
    if (prevHard === undefined) delete process.env.KHY_LIVE_HARD_CLAMP;
    else process.env.KHY_LIVE_HARD_CLAMP = prevHard;
  }
}

test('集成:FAST ON/OFF 逐字节等价(视觉路径 + 原始行路径 + norm 组合)', () => {
  const scenarios = [
    // [label, timeline, budget]
    ['full-fit', [{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }], 100],
    ['budget-cut-drop-above', [
      { type: 'text', text: 'line1\nline2' },
      { type: 'tool' },
      { type: 'text', text: 'x1\nx2\nx3' },
      { type: 'tool' },
      { type: 'text', text: 'tail1\ntail2' },
    ], 3],
    ['inner-cut-one-big', [{ type: 'text', text: 'a\nb\nc\nd\ne\nf\ng\nh' }], 3],
    ['empty-text-interleaved', [
      { type: 'text', text: '' },
      { type: 'tool' },
      { type: 'text', text: '' },
      { type: 'text', text: 'real' },
    ], 100],
    ['all-empty', [{ type: 'text', text: '' }, { type: 'text', text: '' }], 5],
    ['tools-only', [{ type: 'tool' }, { type: 'tool' }, { type: 'tool' }], 2],
    ['single-visible', [{ type: 'text', text: 'only' }], 100],
  ];
  const norms = [
    ['no-norm', undefined],
    ['upper-norm', (t) => String(t == null ? '' : t).toUpperCase()],
    ['blank-to-empty-norm', (t) => (String(t).trim() === 'DROPME' ? '' : t)],
  ];
  const paths = [
    ['visual-path', { KHY_LIVE_HARD_CLAMP: undefined }], // 默认 on → 视觉行路径
    ['raw-path', { KHY_LIVE_HARD_CLAMP: 'off' }],        // 关 → 委托 _tailTimelineRaw
  ];
  for (const [plabel, extraEnv] of paths) {
    for (const [nlabel, norm] of norms) {
      for (const [slabel, timeline, budget] of scenarios) {
        // 给 blank-to-empty-norm 补一条会被归一到空的段,证「norm→空跳过」等价
        const tl = nlabel === 'blank-to-empty-norm'
          ? [{ type: 'text', text: 'DROPME' }, ...timeline]
          : timeline;
        const { on, off } = runBoth(tl, budget, 20, extraEnv, norm);
        assert.deepEqual(
          on.entries, off.entries,
          `entries 不变 [${plabel}/${nlabel}/${slabel}]`
        );
        assert.equal(
          on.truncated, off.truncated,
          `truncated 等价 [${plabel}/${nlabel}/${slabel}]: on=${on.truncated} off=${off.truncated}`
        );
      }
    }
  }
});
