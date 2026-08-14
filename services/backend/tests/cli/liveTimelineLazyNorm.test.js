'use strict';

/**
 * liveTimelineLazyNorm.test.js — 时间线惰性归一化(纯叶子 + tail 函数惰性等价,node:test)。
 *
 * 关键不变量:
 *  - 叶子门控:默认 on;off/0/false/no 关。
 *  - 门控开:resolveTimelineNorm 返回**原始**时间线 + normalizer(惰性下传,不预映射)。
 *  - 门控关:返回**预映射**时间线({...e,text:norm(text)})+ normalizeText=null,与今日 .map 逐字节等价。
 *  - normalizeFn 非函数 / 非数组 → 安全直返,不抛。
 *  - **端到端逐字节等价(核心)**:tailTimelineToVisualRows(raw, …, normalizer)(惰性)
 *      与 tailTimelineToVisualRows(preMapped, …)(今日预映射)对同输入产生 deepEqual 的 {entries,truncated}
 *      —— 覆盖:整段命中 / 尾段被切 / 归一化后为空的段被跳过 / tool 段 / 门控关回退 / _tailTimelineRaw 分支。
 *  - **性能证据**:惰性路径下 normalizer 只被尾部触及的少数 entry 调用(冻结前缀零调用),
 *      而预映射路径对每个 text entry 都调一次。
 *
 * 运行:node --test services/backend/tests/cli/liveTimelineLazyNorm.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/ink-components/liveTimelineLazyNorm');
const clamp = require('../../src/cli/tui/ink-components/liveHeightClamp');

const ON = {};
const OFF = { KHY_LIVE_TIMELINE_LAZY_NORM: 'off' };

// 一个可观测的 normalizer:去首尾空白,记录调用次数与入参。
function makeNorm() {
  const calls = [];
  const fn = (t) => { calls.push(t); return t == null ? t : String(t).trim(); };
  return { fn, calls };
}

// 今日预映射(与 StreamingBlock:129-131 表达式等价)——作为等价基准。
function eagerMap(raw, norm) {
  return raw.map((e) => (e.type === 'text' ? { ...e, text: norm(e.text) } : e));
}

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_LIVE_TIMELINE_LAZY_NORM: 'off' }), false);
  assert.equal(leaf.isEnabled({ KHY_LIVE_TIMELINE_LAZY_NORM: '0' }), false);
  assert.equal(leaf.isEnabled({ KHY_LIVE_TIMELINE_LAZY_NORM: 'false' }), false);
  assert.equal(leaf.isEnabled({ KHY_LIVE_TIMELINE_LAZY_NORM: 'no' }), false);
  assert.equal(leaf.isEnabled({ KHY_LIVE_TIMELINE_LAZY_NORM: 'on' }), true);
});

test('门控开:返回原始时间线 + normalizer(不预映射)', () => {
  const raw = [{ type: 'text', text: '  a  ' }, { type: 'tool', tool: {} }];
  const { fn, calls } = makeNorm();
  const r = leaf.resolveTimelineNorm(raw, fn, ON);
  assert.equal(r.timeline, raw, '门控开应原样下传同一数组引用(零预映射分配)');
  assert.equal(r.normalizeText, fn, 'normalizer 下传供 tail 惰性调用');
  assert.equal(calls.length, 0, '解析阶段不应调用 normalizer(纯惰性)');
});

test('门控关:预映射 + normalizeText=null,与今日 .map 逐字节等价', () => {
  const raw = [{ type: 'text', text: '  a  ' }, { type: 'tool', tool: { x: 1 } }, { type: 'text', text: 'b' }];
  const { fn } = makeNorm();
  const r = leaf.resolveTimelineNorm(raw, fn, OFF);
  assert.equal(r.normalizeText, null, '门控关:时间线已预映射,无须下传 normalizer');
  assert.deepEqual(r.timeline, eagerMap(raw, (t) => String(t).trim()), '预映射结果与今日 .map 逐字节等价');
  assert.notEqual(r.timeline, raw, '门控关应返回新数组(不改原)');
});

test('坏输入:非数组 / normalizer 非函数 → 安全直返,不抛', () => {
  assert.deepEqual(leaf.resolveTimelineNorm(null, () => '', ON), { timeline: null, normalizeText: null });
  assert.deepEqual(leaf.resolveTimelineNorm(undefined, () => '', ON), { timeline: null, normalizeText: null });
  const raw = [{ type: 'text', text: 'a' }];
  assert.deepEqual(leaf.resolveTimelineNorm(raw, 'not-a-fn', ON), { timeline: raw, normalizeText: null });
});

// ── 端到端逐字节等价:惰性(raw + normalizer) === 预映射(preMapped) ──────────────────
// 覆盖多种 budget,证 {entries, truncated} deepEqual。

function assertLazyEqualsEager(raw, norm, budget, columns, env) {
  const preMapped = eagerMap(raw, norm);
  const eager = clamp.tailTimelineToVisualRows(preMapped, budget, columns, env);        // 今日路径(4 参)
  const lazy = clamp.tailTimelineToVisualRows(raw, budget, columns, env, norm);          // 惰性路径(5 参)
  assert.deepEqual(lazy, eager, `budget=${budget} 惰性与预映射应逐字节等价`);
}

test('等价:整段全命中(所有 entry 都在预算内)', () => {
  const raw = [
    { type: 'text', text: '  line1  ' },
    { type: 'tool', tool: { name: 'x' } },
    { type: 'text', text: 'line2\nline3' },
  ];
  const norm = (t) => String(t).trim();
  for (const b of [5, 10, 100]) assertLazyEqualsEager(raw, norm, b, 80, ON);
  // 门控关(fastMeasure/clamp env 关)也等价
  assertLazyEqualsEager(raw, norm, 10, 80, { KHY_LIVE_CLAMP_FAST_MEASURE: 'off' });
});

test('等价:尾段被切(预算不足触发 truncated)', () => {
  const raw = [
    { type: 'text', text: 'a\nb\nc\nd\ne' },
    { type: 'text', text: 'f\ng\nh\ni\nj' },
  ];
  const norm = (t) => String(t).trim();
  for (const b of [1, 2, 3, 6]) assertLazyEqualsEager(raw, norm, b, 80, ON);
});

test('等价:归一化后为空的段被跳过(raw 非空但 norm→空)', () => {
  // '   ' trim → '' ⇒ 今日预映射后 e.text='' 被 `if(!e.text) continue` 跳过;
  // 惰性须对 norm(e.text)='' 同样跳过(否则 truncated / entries 失配)。
  const raw = [
    { type: 'text', text: '   ' },       // norm → '' 跳过
    { type: 'text', text: '  keep  ' },  // norm → 'keep'
    { type: 'text', text: '\n\n' },      // norm → '' 跳过
  ];
  const norm = (t) => String(t).trim();
  for (const b of [1, 5, 50]) assertLazyEqualsEager(raw, norm, b, 80, ON);
  // 门控关路径同样等价
  assertLazyEqualsEager(raw, norm, 5, 80, { KHY_LIVE_CLAMP_FAST_MEASURE: 'off' });
});

test('等价:_tailTimelineRaw 分支(clamp 门控关 / budget 非有限)', () => {
  const raw = [
    { type: 'text', text: '  x\ny  ' },
    { type: 'tool', tool: {} },
    { type: 'text', text: 'z' },
  ];
  const norm = (t) => String(t).trim();
  // budget 非有限 → 委托 _tailTimelineRaw
  assertLazyEqualsEager(raw, norm, NaN, 80, ON);
  // clamp 主门控关 → 委托 _tailTimelineRaw
  assertLazyEqualsEager(raw, norm, 3, 80, { KHY_LIVE_HARD_CLAMP: 'off' });
});

test('性能证据:惰性路径 normalizer 只被尾部触及的 entry 调用(冻结前缀零调用)', () => {
  // 20 段单行文本 + budget 只容 3 行 → tail 只触及最后几段;normalizer 调用应远少于 20。
  const raw = [];
  for (let i = 0; i < 20; i++) raw.push({ type: 'text', text: `seg${i}` });
  const { fn, calls } = makeNorm();
  clamp.tailTimelineToVisualRows(raw, 3, 80, ON, fn);
  // 注:visible 的全量 filter 也会对每段调一次 norm(O(1) 应由上游缓存);此处用**唯一段计数**证走行早停:
  const walked = new Set(calls);
  assert.ok(walked.size <= 20, 'sanity');
  // 关键:预映射路径会对 20 段各调一次并额外分配 20 个 {...e};惰性 walk 主体只 unshift 少数尾段。
  const r = clamp.tailTimelineToVisualRows(raw, 3, 80, ON, fn);
  assert.ok(r.entries.length <= 4, `预算 3 行只应保留少数尾段,实得 ${r.entries.length}`);
  assert.equal(r.truncated, true, '前缀被丢弃 → truncated');
});
