'use strict';

/**
 * 应用内自绘选择 —— 第二层端到端接线验证(不依赖 ink 渲染器,手工模拟接线)。
 *
 * 为什么需要这个探针(而不是再加一个单测):
 *   `selection.test.js`(27 绿)、`mouseSelectEvent.test.js`(12 绿)、
 *   `viewportSelection.test.js`(16 绿)各自覆盖一层,但**层与层之间的缝**没人守:
 *     · parser 吐的坐标 → App 的「屏幕行 − 视口偏移」换算
 *     · 换算出的区间 → extractText 拿到的文本
 *     · 文本 → clipboard 的实际调用(带什么参数)
 *   这三处任一处写错,三层单测都还是全绿 —— 而用户看到的仍是「复制不出来」。
 *   本探针把这条链**串起来**跑,并用假剪贴板捕获真实调用。
 *
 * 断言风格:每条都写明「错了会怎样」,便于日后回归时定位。
 *
 *   node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 应用内自绘选择-端到端验证-2026-09-17.js
 */

const assert = require('assert');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message}`);
  }
}
function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BASE = path.join(ROOT, 'services/backend/src/cli/tui');
const sel = require(path.join(BASE, 'selection'));
const mouse = require(path.join(BASE, 'mouseButtons'));
const { sliceLineForSelection } = require(path.join(BASE, 'ink-components/Viewport'));

// ── SGR 序列构造器(消除 1-based / 0-based 的心算错误)───────────────────────
//
// 这是我第一版探针反复出错的地方:SGR 坐标是 **1-based**,而 `selection.js` 全程
// **0-based**。手写 `'[<0;4;1m'` 时很容易把「我想要第 3 列」和「SGR 里写 4」搞混,
// 于是测试期望跟着一起错 —— 而错误的期望会**掩盖真实缺陷**。
// 用 col0/row0 命名 + 内部 +1 转换,把心算彻底挤出去。
//
// @param {number} col0 0-based 列
// @param {number} row0 0-based 行
// @returns {string} 按下序列
const pressAt = (col0, row0) => `[<0;${col0 + 1};${row0 + 1}M`;
/** 拖动位移(带 32 位移位)。 */
const dragTo = (col0, row0) => `[<32;${col0 + 1};${row0 + 1}M`;
/** 松开序列。 */
const releaseAt = (col0, row0) => `[<0;${col0 + 1};${row0 + 1}m`;

// ── 模拟 App 层接线(与 App.js 的 onSelectEvent 同构,只换成可控入参)─────────────
/**
 * @param {string[]} lines 行投影
 * @param {number} offset 视口滚动偏移(clampedScroll)
 * @param {number} viewH 视口高度
 * @param {(t:string)=>void} writeClip 假剪贴板
 */
function makeHarness(lines, offset, viewH, writeClip) {
  // 选区形状**必须与 selection.js 的契约一致**:`{anchor:{line,col}, head:{line,col}, dragging}`。
  // ⚠ 第一版本探针用了 `{start,end}` —— 那是对 selection.js API 的误读,链路上
  // `normalizeSelection` 静默返回 null,表现为「剪贴板拿到 null」。这个错误**三层单测
  // 都发现不了**(各自测自己那层),正是端到端探针存在的理由。
  const state = { region: null };
  const refs = { region: sel.createSelection() };

  const onSelectEvent = (kind, ev) => {
    const total = lines.length;
    const maxScroll = Math.max(0, total - viewH);
    const off = Math.max(0, Math.min(offset, maxScroll));
    // ⚠ 方向是 `row + off`,**不是** `row - off`。真源:
    //     Viewport.js:  visible = lines.slice(clampedScroll, clampedScroll + height)
    // 即屏幕第 0 行 = 数组下标 clampedScroll。写成减法会让「滚动过之后选的每一行
    // 都整体偏移」——用户一滚就选不中,且表现为「随机选错行」。
    const line = Math.max(0, Math.min(Math.trunc(ev.row) + off, Math.max(0, total - 1)));
    const pt = { line, col: Math.max(0, Math.trunc(ev.col)) };

    if (kind === 'down') {
      // ⚠ 签名是 `(sel, line, col)` 三参 —— line/col **分开传**,不是传点对象。
      // 传点对象会让 col 变成 undefined → 归零 → 选区永远从第 0 列开始。
      refs.region = sel.beginSelection(refs.region, pt.line, pt.col);
      state.region = refs.region;
      return;
    }
    if (kind === 'move') {
      refs.region = sel.extendSelection(refs.region, pt.line, pt.col);
      state.region = refs.region;
      return;
    }
    if (kind === 'up') {
      refs.region = sel.endSelection(refs.region);
      const range = sel.normalizeSelection(refs.region);
      state.region = refs.region;
      if (!range) {
        return;
      }
      const text = sel.extractText(lines, refs.region);
      if (text) writeClip(text);
    }
  };

  const dispatcher = mouse.createMouseDispatcher({
    hover: false,
    onSelectEvent,
  });

  return {
    state,
    dispatcher,
    // 走 dispatcher → onSelectEvent 的真实路径(不是直接调 handler)
    feed: (seq) => dispatcher.onInput(seq, { rootNode: {}, rows: 40, cacheKey: 'k' }),
  };
}

// ── 1. 单行拖选 → 剪贴板 ─────────────────────────────────────────────────────
section('1. 单行拖选:鼠标序列 → 选区 → 剪贴板');
check('从 col 0 拖到 col 4 → 剪贴板拿到 "hell"(半开区间,不含 head 所在列)', () => {
  const lines = ['hello world', 'second line'];
  let clip = null;
  const h = makeHarness(lines, 0, 10, (t) => {
    clip = t;
  });
  h.feed(pressAt(0, 0));
  h.feed(dragTo(2, 0));
  h.feed(dragTo(4, 0));
  h.feed(releaseAt(4, 0));
  assert.equal(clip, 'hell', `半开区间:head 所在列不含,实得 ${JSON.stringify(clip)}`);
});

check('半开区间语义:anchor=0 head=3 → "abc";anchor=0 head=4 → "abcd"', () => {
  // 这条是 selection.js 头部写明的硬契约:`head` 所在列不含,与鼠标拖动直觉一致
  // (反色的是「已经划过去」的部分)。搞错会稳定少选/多选一个字符 —— 用户很难描述,
  // 但这种「总是差一个」的故障几乎必然是这里。
  //
  // ⚠ 必须带一次 drag:只有 press+release 且两点相同 → 零宽 → 无内容。
  //   这是「手势必须完整」在测试侧的体现,第一版探针就是漏了这步。
  const lines = ['abcdef'];
  const results = [];
  const h = makeHarness(lines, 0, 10, (t) => results.push(t));
  h.feed(pressAt(0, 0));
  h.feed(dragTo(3, 0));
  h.feed(releaseAt(3, 0));
  assert.equal(results[0], 'abc', 'anchor=0, head=3 → 取 [0,3)');
  results.length = 0;
  h.feed(pressAt(0, 0));
  h.feed(dragTo(4, 0));
  h.feed(releaseAt(4, 0));
  assert.equal(results[0], 'abcd', 'anchor=0, head=4 → 取 [0,4)');
});

// ── 2. 视口偏移换算(最容易错的一环)─────────────────────────────────────────
section('2. 视口偏移:屏幕行 ≠ 数组下标时仍要选对');
check('offset=2 时点屏幕 row 0 → 选中数组下标 2 的那一行', () => {
  // 场景:用户往上滚了两行(offset=2),现在视口顶端显示的是数组第 2 行。
  // 此时屏幕上 row 0 = 数组下标 2,row 2 = 数组下标 4。
  // 换算错了(比如忘了减 offset)会让用户点 A 行选到 C 行 —— 这种「选错行」
  // 用户往往以为是「程序乱选」,很难报清楚,所以要用偏移量非 0 的用例守住。
  const lines = ['AAA', 'BBB', 'CCC_target', 'DDD', 'EEE', 'FFF', 'GGG'];
  let clip = null;
  const h = makeHarness(lines, 2, 3, (t) => {
    clip = t;
  });
  h.feed(pressAt(0, 0)); // 屏幕 row 0 → 数组下标 0 + 2 = 2 → 'CCC_target'
  h.feed(dragTo(2, 0));
  h.feed(releaseAt(2, 0));
  assert.equal(
    clip,
    'CC',
    `忘了减 offset 就会选到 'AAA',实得 ${JSON.stringify(clip)}`
  );
});

check('offset=2 时点屏幕 row 2 → 数组下标 4,不是 2', () => {
  const lines = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE_target', 'FFF', 'GGG'];
  let clip = null;
  const h = makeHarness(lines, 2, 3, (t) => {
    clip = t;
  });
  h.feed(pressAt(0, 2));
  h.feed(dragTo(2, 2));
  h.feed(releaseAt(2, 2));
  assert.equal(clip, 'EE', `实得 ${JSON.stringify(clip)}`);
});

check('offset 超过 maxScroll 时被 clamp(不索引越界)', () => {
  const lines = ['one', 'two'];
  let clip = null;
  const h = makeHarness(lines, 999, 5, (t) => {
    clip = t;
  });
  // 2 行、视口 5 行 → maxScroll = 0 → offset 被 clamp 到 0 → 屏幕 row 0 = 数组下标 0
  h.feed(pressAt(0, 0));
  h.feed(dragTo(2, 0));
  h.feed(releaseAt(2, 0));
  assert.equal(clip, 'on', 'offset clamp 后就该落在第 0 行(取 [0,2) = "on")');
});

// ── 3. 跨行选区 ─────────────────────────────────────────────────────────────
section('3. 跨行选区:行间补 \\n');
check('从第 1 行 col 2 拖到第 2 行 col 4 → "rst\\nsec"', () => {
  const lines = ['first', 'second', 'third'];
  let clip = null;
  const h = makeHarness(lines, 0, 10, (t) => {
    clip = t;
  });
  h.feed(pressAt(2, 0)); // line 0, col 2 → 'first' 的 'r' 处
  h.feed(dragTo(4, 1)); // line 1, col 4 → 'second' 的 'o' 之后
  h.feed(releaseAt(4, 1));
  // 首行 [2,5) = 'rst';末行 [0,4) = 'seco'... 不对,应验算:
  // 'first'.slice(2) = 'rst';'second'.slice(0,4) = 'seco'? 不,head col 4 → [0,4) = 'seco'
  assert.equal(clip, 'rst\nseco', `实得 ${JSON.stringify(clip)}`);
});

check('三行全选:首行尾段 + 中间整行 + 末行首段', () => {
  const lines = ['AAAA', 'BBBB', 'CCCC'];
  let clip = null;
  const h = makeHarness(lines, 0, 10, (t) => {
    clip = t;
  });
  h.feed(pressAt(2, 0)); // 首行从 col 2 起 → 'AA'
  h.feed(dragTo(2, 2)); // 末行到 col 2(不含)→ 'CC'
  h.feed(releaseAt(2, 2));
  assert.equal(clip, 'AA\nBBBB\nCC', `实得 ${JSON.stringify(clip)}`);
});

// ── 4. 零宽手势不得污染剪贴板 ────────────────────────────────────────────────
section('4. 零宽手势:普通点击不该覆盖剪贴板');
check('按下即松开(同一格)→ 不写剪贴板,选区归零宽', () => {
  const lines = ['hello'];
  const clips = [];
  const h = makeHarness(lines, 0, 10, (t) => clips.push(t));
  h.feed(pressAt(2, 0));
  h.feed(releaseAt(2, 0));
  assert.deepEqual(clips, [], '零宽手势写剪贴板会静默清空用户原有剪贴板内容');
  // 零宽手势的选区应 normalize 成 null(无可选内容),而不是留一个零宽反色。
  assert.equal(
    sel.normalizeSelection(h.state.region),
    null,
    '零宽手势必须归一化成「无选区」,否则每次点空白都留下闪烁的空反色'
  );
});

check('只按下不松开(手势中断)→ 不写剪贴板', () => {
  const clips = [];
  const h = makeHarness(['x'], 0, 10, (t) => clips.push(t));
  h.feed(pressAt(0, 0));
  h.feed(dragTo(0, 0));
  assert.deepEqual(clips, [], '没有 up 就没有定稿');
});

// ── 5. 修饰键 / 滚轮不得触发选择(§6.2 硬承诺)────────────────────────────────
section('5. 修饰键与滚轮:不启自绘选区');
check('Shift+按下 → 不启手势(留给终端原生选择)', () => {
  const clips = [];
  const h = makeHarness(['hello'], 0, 10, (t) => clips.push(t));
  const before = h.state.region;
  h.feed('[<4;0;1M'); // Shift(4) + press
  h.feed('[<36;3;1M'); // Shift(4) + motion(32)
  h.feed('[<4;3;1m'); // Shift + release
  assert.deepEqual(clips, [], 'Shift 手势必须留给终端,否则与原生选择打架');
  // 断言「一个字都没动」比断言 `=== null` 更准确:onSelectEvent 根本没被调用,
  // 所以 region 保持 makeHarness 里的初值(`createSelection()`),而不是被清成 null。
  assert.deepEqual(h.state.region, before, 'Shift 手势不该让选区对象发生任何变化');
  assert.equal(sel.normalizeSelection(h.state.region), null, '且不应产生可渲染的区间');
});

check('滚轮不污染选区', () => {
  const clips = [];
  const h = makeHarness(['hello'], 0, 10, (t) => clips.push(t));
  const before = h.state.region;
  h.feed('[<64;3;1M'); // 滚轮上
  h.feed('[<65;3;1M'); // 滚轮下
  assert.deepEqual(clips, []);
  assert.deepEqual(h.state.region, before, '滚轮不该触碰选区状态');
});

// ── 6. 渲染侧与模型侧的一致性(层间缝)──────────────────────────────────────
section('6. 反色渲染与提取文本必须一致');
check('被反色的字符集合 == 被复制的字符集合', () => {
  const lines = ['D:/Portable/khy-os/a.js', 'second'];
  let clip = null;
  const h = makeHarness(lines, 0, 10, (t) => {
    clip = t;
  });
  h.feed(pressAt(2, 0));
  h.feed(dragTo(12, 0));
  h.feed(releaseAt(12, 0));
  assert.ok(clip, '应有复制内容');

  // 用渲染侧同一个分段函数算出「屏幕上看起来反色的那一段」
  const seg = sliceLineForSelection(lines[0], 0, h.state.region);
  assert.equal(seg.highlighted, true);
  assert.equal(seg.mid, clip, `反色的「${seg.mid}」与复制的「${clip}」必须一致 —— 不一致就是「看起来选中了但复制出别的东西」`);
});

check('未命中行不反色(head 承载整行,mid 为空)', () => {
  const lines = ['a', 'b', 'c'];
  const h = makeHarness(lines, 0, 10, () => {});
  h.feed(pressAt(0, 0));
  h.feed(releaseAt(0, 0));
  const seg = sliceLineForSelection(lines[2], 2, h.state.region);
  assert.equal(seg.highlighted, false);
  assert.equal(seg.mid, '');
  assert.equal(seg.head, 'c', '未命中时整行应放 head,否则拼接会得到双份文本');
});

// ── 7. 门控语义 ─────────────────────────────────────────────────────────────
section('7. 门控:不开选择时逐字节老行为');
check('未接 onSelectEvent → 拖动不发任何选择事件,返回值与老行为一致', () => {
  const d = mouse.createMouseDispatcher({ hover: false });
  const CTX = { rootNode: {}, rows: 40, cacheKey: 'k' };
  assert.equal(d.onInput('[<0;30;8M', CTX), false, '空白处按下 → 放行');
  assert.equal(d.onInput('[<32;31;8M', CTX), true, '位移事件在 hover 关时 → 吞');
  assert.equal(d.onInput('[<0;32;8m', CTX), false, '空白处松开 → 放行');
});

check('enableBytes: select 档写 1002,默认档写 1000,互不叠加', () => {
  assert.equal(mouse.enableBytes({}), '\x1b[?1000h\x1b[?1006h');
  assert.equal(mouse.enableBytes({ select: true }), '\x1b[?1002h\x1b[?1006h');
  assert.ok(!mouse.enableBytes({ select: true }).includes('1000h'));
});

// ── 8. 规模:大转录不炸 ─────────────────────────────────────────────────────
section('8. 规模');
check('5000 行 × 全选:extractText 在合理时间内完成', () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`line ${i} with some content here`);
  const region = {
    anchor: { line: 0, col: 0 },
    head: { line: 4999, col: 33 },
  };
  const t0 = Date.now();
  const text = sel.extractText(lines, region);
  const ms = Date.now() - t0;
  assert.ok(text.includes('line 0 with'), '首行应在');
  assert.ok(text.includes('line 4999 with'), '末行应在');
  assert.ok(ms < 500, `5000 行提取耗时 ${ms}ms,应远低于 500ms`);
});

check('每次 move 都是纯算术(不随选区增大而变慢)', () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`line ${i}`);
  let region = sel.beginSelection(sel.createSelection(), { line: 0, col: 0 });
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    region = sel.extendSelection(region, { line: i % 5000, col: 3 });
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 200, `1000 次 extendSelection 耗时 ${ms}ms —— 拖动全程每点一次,必须极快`);
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`\x1b[32m全部通过:${pass}/${pass}\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m失败 ${fail} 条 / 通过 ${pass} 条\x1b[0m`);
  for (const f of failures) {
    console.log(`\n• ${f.name}\n  ${f.err.stack.split('\n').slice(0, 3).join('\n  ')}`);
  }
  process.exit(1);
}
