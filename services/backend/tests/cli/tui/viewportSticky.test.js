'use strict';

// viewportSticky — 视口偏移的「贴底」语义。
//
// 背景(为什么这个文件必须存在):
//   转录默认应当停在**最新一条**(用户要看的是刚输出的东西),而滚动 state 只能是
//   某个具体数字。历史实现把初值写成 0,再用 `scroll >= maxScroll` 判「之前在底部」——
//   内容一旦长过视口,`0 >= maxScroll` 恒假,视口就永远停在**顶部**,用户看到的
//   仍是最早那几行。于是即使把转录搬进应用内 Viewport、修好了 fullscreen 清屏,
//   「输出回显看不见」的体感依然存在。
//
//   现在:`null` / `undefined` / 负数 = **贴底**;数字 = 固定偏移;
//   滚回最底时回写 `null`,自动恢复跟随。
//
//   `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const {
  applyViewportScroll,
  resolveViewportOffset,
  applyStickyViewportAction,
  viewportContentRows,
  STICKY_BOTTOM,
} = require('../../../src/cli/tui/ink-components/Viewport');

const vp = { applyViewportScroll, resolveViewportOffset, applyStickyViewportAction, viewportContentRows };

const VIEW = 10;
const TOTAL = 40; // maxScroll = 30

// ── resolveViewportOffset ────────────────────────────────────────────────────
test('resolveViewportOffset: null/undefined/负数 = 贴底 → maxScroll', () => {
  assert.equal(resolveViewportOffset(null, VIEW, TOTAL), 30);
  assert.equal(resolveViewportOffset(undefined, VIEW, TOTAL), 30);
  assert.equal(resolveViewportOffset(-1, VIEW, TOTAL), 30);
  assert.equal(STICKY_BOTTOM, null, '哨兵就是 null');
});

test('resolveViewportOffset: 数字按 clamp 处理,越界不抛', () => {
  assert.equal(resolveViewportOffset(0, VIEW, TOTAL), 0);
  assert.equal(resolveViewportOffset(7, VIEW, TOTAL), 7);
  assert.equal(resolveViewportOffset(999, VIEW, TOTAL), 30, '上越界 → maxScroll');
  assert.equal(resolveViewportOffset('12', VIEW, TOTAL), 12, '字符串数字可接受');
  assert.equal(resolveViewportOffset(NaN, VIEW, TOTAL), 30, 'NaN 视同贴底');
});

test('resolveViewportOffset: 内容不超视口 → 恒 0(没有滚动空间)', () => {
  assert.equal(resolveViewportOffset(null, 24, 12), 0);
  assert.equal(resolveViewportOffset(5, 24, 12), 0);
  assert.equal(resolveViewportOffset(null, 24, 24), 0, '恰好一屏');
});

test('resolveViewportOffset: 退化几何(0/负/非数字)不抛', () => {
  assert.equal(resolveViewportOffset(null, 0, 40), 39, 'viewH 0 → 视作 1');
  assert.equal(resolveViewportOffset(null, -5, 40), 39);
  assert.equal(resolveViewportOffset(null, NaN, NaN), 0);
});

// ── applyStickyViewportAction ────────────────────────────────────────────────
test('applyStickyViewportAction: 从贴底往上滚一格 → maxScroll-1(不是从 0 开始)', () => {
  assert.equal(applyStickyViewportAction('lineUp', null, VIEW, TOTAL), 29);
});

test('applyStickyViewportAction: 滚回最底 → 回写 null,恢复跟随', () => {
  assert.equal(applyStickyViewportAction('bottom', 7, VIEW, TOTAL), null);
  assert.equal(applyStickyViewportAction('lineDown', 30, VIEW, TOTAL), null);
  assert.equal(applyStickyViewportAction('lineDown', 29, VIEW, TOTAL), null, '29+1=30=maxScroll');
});

test('applyStickyViewportAction: 未到底时保持数字(不误判成贴底)', () => {
  assert.equal(applyStickyViewportAction('lineUp', 5, VIEW, TOTAL), 4);
  assert.equal(applyStickyViewportAction('lineDown', 5, VIEW, TOTAL), 6);
  assert.equal(applyStickyViewportAction('top', 12, VIEW, TOTAL), 0);
});

test('applyStickyViewportAction: 顶部继续上滚停在 0,且不写成 null', () => {
  assert.equal(applyStickyViewportAction('lineUp', 0, VIEW, TOTAL), 0);
});

test('applyStickyViewportAction: 内容不超视口 → 恒 null(无处可滚)', () => {
  assert.equal(applyStickyViewportAction('lineUp', null, 24, 12), null);
  assert.equal(applyStickyViewportAction('top', 0, 24, 12), null);
});

test('applyStickyViewportAction: 与 applyViewportScroll 的 clamp 一致(不产生越界值)', () => {
  let s = null;
  for (let i = 0; i < 100; i++) {
    s = applyStickyViewportAction('lineUp', s, VIEW, TOTAL);
    if (s !== null) {
      assert.ok(s >= 0 && s <= 30, `偏移越界: ${s}`);
    }
  }
  // 100 次上滚后必然到顶(0),且不是 null
  assert.equal(s, 0);
});

test('applyStickyViewportAction: 半页/整页动作也遵守贴底回写', () => {
  assert.equal(applyStickyViewportAction('halfPageDown', 25, VIEW, TOTAL), null, '25+5=30');
  assert.equal(applyStickyViewportAction('halfPageDown', 24, VIEW, TOTAL), 29);
  assert.equal(applyStickyViewportAction('fullPageDown', 20, VIEW, TOTAL), null, '20+10=30');
  assert.equal(applyStickyViewportAction('fullPageDown', 19, VIEW, TOTAL), 29);
  assert.equal(applyStickyViewportAction('fullPageUp', 3, VIEW, TOTAL), 0);
});

// ── 与旧实现的差异回归(防止有人把 0 初值改回来) ────────────────────────────
test('回归:旧的「scroll >= maxScroll」判据在初值 0 下永远不贴底', () => {
  // 旧代码:`if (autoScroll && scroll >= maxScroll) clamped = maxScroll;`
  const scroll = 0;
  const maxScroll = TOTAL - VIEW;
  assert.equal(scroll >= maxScroll, false, '这正是「视口永远停在顶部」的根因');
  // 新代码:同一个 state 值 0 仍表示「固定在第 0 行」—— 所以初值必须是 null。
  assert.equal(resolveViewportOffset(0, VIEW, TOTAL), 0);
  assert.equal(resolveViewportOffset(null, VIEW, TOTAL), maxScroll);
});

test('回归:applyViewportScroll 本身语义未变(仍接受纯数字 offset)', () => {
  assert.equal(applyViewportScroll('lineUp', { offset: 10, viewport: VIEW, total: TOTAL }), 9);
  assert.equal(applyViewportScroll('bottom', { offset: 0, viewport: VIEW, total: TOTAL }), 30);
  assert.equal(applyViewportScroll('top', { offset: 30, viewport: VIEW, total: TOTAL }), 0);
});

// ── viewportContentRows:指示器必须向内容借一行 ──────────────────────────────
//
// 背景(真机现象,BUG-25):Viewport 把「可见内容行 + 1 行指示器」塞进一个
// `height` 高、`overflow:hidden` 的盒子里 ⇒ 盒里有 `height + 1` 个子节点 ⇒
// yoga 按 flexShrink 把总高摊回 `height`,**中间**那一行高度取整成 0。
// 于是屏幕上永远少一行内容(该行在模型里存在、能被拖选复制出来,就是看不见)。
// 修法:渲染侧按 `viewportContentRows()` 只切 `height - 1` 行,把那一行**显式**
// 让给指示器,而不是让 yoga 隐式吃掉。本段守住这条换算的两端一致性。
test('viewportContentRows: 有指示器且内容超视口 → 盒子高减 1', () => {
  assert.equal(vp.viewportContentRows(13, 40, true), 12);
  assert.equal(vp.viewportContentRows(13, 40, false), 13, '关指示器则全部归内容');
  assert.equal(vp.viewportContentRows(13, 13, true), 13, '恰好一屏 → 无指示器,不扣');
  assert.equal(vp.viewportContentRows(13, 5, true), 13, '内容不足 → 不扣');
});

test('viewportContentRows: 退化入参不抛,且至少留 1 行', () => {
  assert.equal(vp.viewportContentRows(0, 40, true), 1);
  assert.equal(vp.viewportContentRows(1, 40, true), 1, '1 高盒子不能扣成 0');
  assert.equal(vp.viewportContentRows(NaN, 40, true), 1);
  assert.equal(vp.viewportContentRows(13, NaN, true), 13, 'total 非法视作 0 → 不扣');
  assert.equal(vp.viewportContentRows(undefined, undefined, undefined), 1);
});

test('不变量: 内容行 + 指示器 ≤ 盒子高(yoga 无从吃掉任何一行)', () => {
  for (let height = 3; height <= 24; height++) {
    for (const total of [0, height - 1, height, height + 1, 200]) {
      const contentRows = vp.viewportContentRows(height, total, true);
      const maxScroll = Math.max(0, total - contentRows);
      const indicator = maxScroll > 0 ? 1 : 0;
      assert.ok(
        contentRows + indicator <= height,
        `height=${height} total=${total}: ${contentRows}+${indicator} > ${height}`
      );
      // 切片不得越界
      const offset = vp.resolveViewportOffset(null, contentRows, total);
      const end = Math.min(total, offset + contentRows);
      assert.ok(end <= total, `切片越界: end=${end} > total=${total}`);
    }
  }
});

test('回归: 贴底时最后一行必须落在可见切片内(偏移与切片同用内容行数)', () => {
  const height = 13;
  const total = 40;
  const contentRows = vp.viewportContentRows(height, total, true);
  const offset = vp.resolveViewportOffset(null, contentRows, total);
  const slice = [];
  for (let i = offset; i < Math.min(total, offset + contentRows); i++) slice.push(i);
  assert.equal(slice.length, contentRows, '可见行数 == 内容行数,不含指示器');
  assert.equal(slice[slice.length - 1], total - 1, '贴底应看到最后一行');

  // 口径分叉的后果:偏移按**盒子高**解析、切片按**内容行数**裁剪 →
  // 最后一行落在窗外,「贴底」永远差一行(与 BUG-25 同族,方向相反)。
  const mixed = [];
  const badOffset = vp.resolveViewportOffset(null, height, total);
  for (let i = badOffset; i < Math.min(total, badOffset + contentRows); i++) mixed.push(i);
  assert.notEqual(mixed[mixed.length - 1], total - 1, '混合口径必然丢最后一行');
});
