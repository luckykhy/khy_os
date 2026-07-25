'use strict';

// spinnerShimmer 契约测试 — 纯叶子(spinner 工作动词 shimmer 扫光算法)。
// 对齐 CC src/bridge/bridgeStatusUtil.ts 的 computeGlimmerIndex /
// computeShimmerSegments 后端逻辑:确定性反向扫光索引 + 按视觉列切分动词。
// 零 IO 零时钟(tick 由调用方注入)。
const test = require('node:test');
const assert = require('node:assert');

const {
  SHIMMER_INTERVAL_MS,
  spinnerShimmerEnabled,
  computeGlimmerIndex,
  computeShimmerSegments,
  shimmerSegmentsForTick,
} = require('../../src/cli/spinnerShimmer');

// 等宽 ASCII 时,视觉列 = 字符数,便于精确断言(CJK 分支另测)。
const asciiWidth = (s) => String(s).length;

// ── 门控 ─────────────────────────────────────────────────────────────────
test('spinnerShimmerEnabled:默认开;{0,false,off,no} 关(大小写/空白无关)', () => {
  assert.strictEqual(spinnerShimmerEnabled({}), true);
  assert.strictEqual(spinnerShimmerEnabled({ KHY_SPINNER_SHIMMER: '1' }), true);
  assert.strictEqual(spinnerShimmerEnabled({ KHY_SPINNER_SHIMMER: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(spinnerShimmerEnabled({ KHY_SPINNER_SHIMMER: v }), false, v);
  }
});

// ── computeGlimmerIndex(CC 逐字节口径)─────────────────────────────────────
test('computeGlimmerIndex = CC: messageWidth+10-(tick % (messageWidth+20))', () => {
  const w = 6;
  const cycle = w + 20; // 26
  // tick=0 → w+10 = 16(扫光起点在文本右侧外)
  assert.strictEqual(computeGlimmerIndex(0, w), 16);
  // tick=16 → 索引 0(扫到文本头)
  assert.strictEqual(computeGlimmerIndex(16, w), 0);
  // 逐字节复算若干点
  for (const tick of [0, 1, 5, 16, 25, 26, 40]) {
    assert.strictEqual(computeGlimmerIndex(tick, w), w + 10 - (tick % cycle), `tick=${tick}`);
  }
});

test('computeGlimmerIndex:一个周期后回到起点(周期 = messageWidth+20)', () => {
  const w = 6;
  assert.strictEqual(computeGlimmerIndex(0, w), computeGlimmerIndex(w + 20, w));
});

test('computeGlimmerIndex:非有限 / 退化宽度 → -100(offscreen,绝不抛)', () => {
  assert.strictEqual(computeGlimmerIndex(NaN, 6), -100);
  assert.strictEqual(computeGlimmerIndex(0, NaN), -100);
  assert.strictEqual(computeGlimmerIndex(0, -20), -100); // cycleLength<=0
  assert.doesNotThrow(() => computeGlimmerIndex(Infinity, Infinity));
});

// ── computeShimmerSegments ────────────────────────────────────────────────
test('computeShimmerSegments:重组永远 = 原文(整性不变式)', () => {
  const text = 'thinking';
  for (let gi = -5; gi <= text.length + 5; gi++) {
    const s = computeShimmerSegments(text, gi, asciiWidth);
    assert.strictEqual(s.before + s.shimmer + s.after, text, `gi=${gi}`);
  }
});

test('computeShimmerSegments:3 列窗口 [gi-1..gi+1] 落在文本中间', () => {
  // text 列 0..7;gi=4 → 窗口列 [3,4,5] 为 shimmer,before=列0..2,after=列6..7。
  const s = computeShimmerSegments('abcdefgh', 4, asciiWidth);
  assert.strictEqual(s.before, 'abc');
  assert.strictEqual(s.shimmer, 'def');
  assert.strictEqual(s.after, 'gh');
});

test('computeShimmerSegments:窗口触左边界则 clamp(before 为空)', () => {
  // gi=0 → shimmerStart=-1 clamp 到 0 → shimmer 从列 0 起。
  const s = computeShimmerSegments('abcdefgh', 0, asciiWidth);
  assert.strictEqual(s.before, '');
  assert.ok(s.shimmer.length > 0);
  assert.strictEqual(s.before + s.shimmer + s.after, 'abcdefgh');
});

test('computeShimmerSegments:offscreen(gi 远右/远左)→ 整文本落 before,无 shimmer', () => {
  const wide = computeShimmerSegments('abcdef', 100, asciiWidth); // shimmerStart>=width
  assert.deepStrictEqual(wide, { before: 'abcdef', shimmer: '', after: '' });
  const left = computeShimmerSegments('abcdef', -100, asciiWidth); // shimmerEnd<0
  assert.deepStrictEqual(left, { before: 'abcdef', shimmer: '', after: '' });
});

test('computeShimmerSegments:CJK 用注入宽度(每字 2 列)切分正确且可重组', () => {
  // 每个汉字视觉 2 列。injected widthOf 让列会计与代码点解耦。
  const cjkWidth = (s) => Array.from(String(s)).reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e00 ? 2 : 1), 0);
  const text = '正在思考'; // 4 字 = 8 列
  for (let gi = -3; gi <= 11; gi++) {
    const s = computeShimmerSegments(text, gi, cjkWidth);
    assert.strictEqual(s.before + s.shimmer + s.after, text, `gi=${gi}`);
  }
  // gi=4 → 窗口列 [3,4,5];列 0..1='正',2..3='在',4..5='思',6..7='考'。
  // 列3 属'在'(2..3),列4..5 属'思' → shimmer 覆盖 '在思'。
  const mid = computeShimmerSegments(text, 4, cjkWidth);
  assert.strictEqual(mid.before, '正');
  assert.strictEqual(mid.shimmer, '在思');
  assert.strictEqual(mid.after, '考');
});

test('computeShimmerSegments:非有限 gi → 整文本 before(绝不抛)', () => {
  assert.deepStrictEqual(
    computeShimmerSegments('abc', NaN, asciiWidth),
    { before: 'abc', shimmer: '', after: '' },
  );
});

// ── shimmerSegmentsForTick(call-site 便捷)──────────────────────────────────
test('shimmerSegmentsForTick:门控关 → 整动词 before(flat,不扫光)', () => {
  const s = shimmerSegmentsForTick('thinking', 3, asciiWidth, { KHY_SPINNER_SHIMMER: 'off' });
  assert.deepStrictEqual(s, { before: 'thinking', shimmer: '', after: '' });
});

test('shimmerSegmentsForTick:门控开 → 随 tick 推进,段可重组为原动词', () => {
  const verb = 'thinking';
  for (const tick of [0, 3, 8, 16, 40]) {
    const s = shimmerSegmentsForTick(verb, tick, asciiWidth, { KHY_SPINNER_SHIMMER: '1' });
    assert.strictEqual(s.before + s.shimmer + s.after, verb, `tick=${tick}`);
  }
});

test('shimmerSegmentsForTick:widthOf 抛错 → 兜底整动词 before(绝不抛)', () => {
  const boom = () => { throw new Error('width boom'); };
  const s = shimmerSegmentsForTick('thinking', 3, boom, { KHY_SPINNER_SHIMMER: '1' });
  assert.deepStrictEqual(s, { before: 'thinking', shimmer: '', after: '' });
});

test('shimmerSegmentsForTick:非字符串动词 / 缺 widthOf → 不抛', () => {
  assert.doesNotThrow(() => shimmerSegmentsForTick(null, 0, undefined, {}));
  assert.doesNotThrow(() => shimmerSegmentsForTick(undefined, 0, undefined, {}));
  const s = shimmerSegmentsForTick('abc', 0, undefined, { KHY_SPINNER_SHIMMER: '1' });
  assert.strictEqual(s.before + s.shimmer + s.after, 'abc');
});

// ── 常量 ─────────────────────────────────────────────────────────────────
test('SHIMMER_INTERVAL_MS = CC 的 150', () => {
  assert.strictEqual(SHIMMER_INTERVAL_MS, 150);
});
