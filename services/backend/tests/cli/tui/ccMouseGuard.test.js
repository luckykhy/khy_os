'use strict';

/**
 * ccMouseGuard — CC 模式「鼠标序列守卫」的端到端契约（node:test）。
 *
 * 背景：[DESIGN-ARCH-124] §3.5。CcApp 的 `useInput` 原本**没有**鼠标守卫 ——
 * 鼠标追踪一开，SGR 序列（`[<0;20;10M`）会作为 `input` 字符串一路落到按键
 * 分支，轻则该串被当字面文本插进输入框，重则某个字符恰好命中快捷键。守卫必须
 * 排在 useInput 的**最前面**并 `return`。
 *
 * 这个文件守的是「从**原始字节**到**剪贴板文本**」整条链，而不是某一层的算术：
 *   M-01  SGR 四种形态（按下 / 位移 / 松开 / 滚轮）都被识别为鼠标序列；
 *         普通文本/按键绝不能被误判（误判 = 用户打不出字，比不能复制更糟）。
 *   M-02  真实字节 → screenRowToIndex → 选区 → extractByAnchors，
 *         取出的文本必须**正好**是光标划过的那一段。
 *   M-03  带修饰键的序列不产生选区（§6.2：Shift+拖 = 终端原生选择）。
 *   M-04  滚轮序列不产生选区。
 *
 * Run: `node --test tests/cli/tui/ccMouseGuard.test.js`
 */

process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';

const assert = require('node:assert');
const test = require('node:test');
const path = require('path');

const TUI = path.resolve(__dirname, '../../../src/cli/tui');
const P = require(path.join(TUI, 'ink-components/ccMessageProjection'));
const sel = require(path.join(TUI, 'selection'));
const mouse = require(path.join(TUI, 'mouseButtons'));
const { formatModelName, formatContext } = require(path.join(TUI, 'utils/ccFormatters'));
const { getContextWindow } = require(path.join(TUI, 'utils/ccContextWindows'));

const MODEL = 'Khy-4';

function project(scene) {
  return P.projectCcScene(
    Object.assign({}, scene, {
      status: {
        modelName: formatModelName(scene.status && scene.status.modelId),
        contextStr: formatContext(0, getContextWindow(MODEL)),
        cost: 0,
        cols: scene.cols,
      },
    })
  );
}

/** SGR 序列构造：屏幕坐标 0-based → 协议里的 1-based。 */
function sgr(button, col, row, release) {
  return `[<${button};${col + 1};${row + 1}${release ? 'm' : 'M'}`;
}

/**
 * 把一次「按下 → 位移 → 松开」的**原始字节流**跑成剪贴板文本。
 * 这是 CcApp 里 dispatcher → onSelectEvent → extractByAnchors 的等价物。
 */
function dragToText(proj, seqs) {
  const total = proj.lines.length;
  let s = sel.createSelection();
  let selecting = false;
  // **松手才是唯一产出点**（CcApp 的 onSelectEvent 只在 'up' 里 extract +
  // writeClipboard）。半截手势（只按下+位移、没松开）必须**什么都不产出** ——
  // 否则就变成「划过即复制」，用户划过屏幕什么都会被塞进剪贴板。
  let released = false;
  for (const raw of seqs) {
    const ev = mouse.parseSgrMouse(raw);
    if (!ev) {
      continue;
    }
    if (ev.isShift || ev.isAlt || ev.isCtrl) {
      continue; // 修饰键放行 —— 不起自绘选区
    }
    if (ev.isWheel) {
      continue;
    }
    const line = P.screenRowToIndex(ev.row, 0, total, total);
    const col = ev.col;
    if (ev.isMotion) {
      if (!selecting) {
        continue;
      }
      s = sel.extendSelection(s, line, col);
      continue;
    }
    if (ev.isPress) {
      selecting = true;
      s = sel.beginSelection(s, line, col);
      continue;
    }
    // release —— 松手点也要收进选区（CcApp 的 onSelectEvent 在 'up' 里先
    // extendSelection 再 endSelection；理由见该文件注释：快速小拖动可能一个
    // move 都没上报，光看 move 会让选区停在按下点变零宽）。
    if (!selecting) {
      continue;
    }
    selecting = false;
    released = true;
    s = sel.endSelection(sel.extendSelection(s, line, col));
  }
  return released ? P.extractByAnchors(proj, s) : '';
}

// ── M-01：守卫的识别面 ──────────────────────────────────────────────────────

test('M-01: SGR 四种形态都被识别为鼠标序列', () => {
  assert.ok(mouse.isMouseSequence(sgr(0, 20, 10, false)), '按下');
  assert.ok(mouse.isMouseSequence(sgr(32, 21, 10, false)), '按住位移');
  assert.ok(mouse.isMouseSequence(sgr(0, 22, 10, true)), '松开');
  assert.ok(mouse.isMouseSequence(sgr(64, 5, 5, false)), '滚轮');
});

test('M-02: 普通输入绝不能被误判成鼠标（误判 = 打不出字）', () => {
  // 守卫排在 useInput 最前面并 return —— 一旦把普通字符当成鼠标吞掉，
  // 用户就**打不出字**了，比不能复制严重得多。
  for (const plain of [
    'a', 'Z', '0', '?', '/', ' ', '\r', '\t',
    '[A', '\x1b[A', '[<0;1M', '[<x;y;zM', '', '<', '[<',
  ]) {
    assert.strictEqual(mouse.isMouseSequence(plain), false, JSON.stringify(plain));
  }
  // 非字符串（ink 可能传 undefined）也不该炸
  assert.strictEqual(mouse.isMouseSequence(undefined), false);
  assert.strictEqual(mouse.isMouseSequence(null), false);
  assert.strictEqual(mouse.isMouseSequence(42), false);
});

// ── M-02：原始字节 → 剪贴板文本 ─────────────────────────────────────────────

test('M-03: 真实字节流拖过一段正文 → 取出的正是那段原文', () => {
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [
      { id: 1, role: 'user', text: '你好' },
      { id: 2, role: 'assistant', text: '这是一条可以被拖选的回复内容' },
    ],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  const last = proj.anchors.reduce((acc, a, i) => (a ? i : acc), -1);
  assert.ok(last >= 0);
  // 屏幕行形如 `● 这是一条可以被拖选的回复内容`：col0=●、col1=空格，正文自 col2 起。
  const row = last;
  const seqs = [
    sgr(0, 2, row, false), // 按下：正文第 0 列
    sgr(32, 4, row, false), // 位移：拖过「这」
    sgr(32, 10, row, false), // 位移：拖过「这是一条」（4 CJK = 8 列）
    sgr(0, 10, row, true), // 松开
  ];
  assert.strictEqual(dragToText(proj, seqs), '这是一条');
});

test('M-04: 反向拖（从右往左）得到同一段文本', () => {
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [{ id: 1, role: 'assistant', text: 'abcdefghij' }],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  const last = proj.anchors.reduce((acc, a, i) => (a ? i : acc), -1);
  const row = last;
  const fwd = dragToText(proj, [
    sgr(0, 2, row, false),
    sgr(32, 7, row, false),
    sgr(0, 7, row, true),
  ]);
  const rev = dragToText(proj, [
    sgr(0, 7, row, false),
    sgr(32, 2, row, false),
    sgr(0, 2, row, true),
  ]);
  assert.strictEqual(fwd, 'abcde', '正向: |' + fwd + '|');
  assert.strictEqual(rev, 'abcde', '反向: |' + rev + '|');
});

test('M-05: 拖到**另一屏幕行** → 跨行带 \\n', () => {
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [
      { id: 1, role: 'assistant', text: '第一行' },
      { id: 2, role: 'assistant', text: '第二行' },
    ],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  const rows = [];
  for (let i = 0; i < proj.anchors.length; i++) {
    if (proj.anchors[i]) {
      rows.push(i);
    }
  }
  assert.ok(rows.length >= 2, '两条消息应有两行锚点，实际 ' + rows.length);
  // ⚠ 终点列要给够:'● 第二行' 的前缀 `● ` 占了 2 列,正文从第 2 列起。
  // 只拖到 2 列只会选到前缀本身 —— 这是「显示列 vs 字符下标」最容易踩的一脚。
  const got = dragToText(proj, [
    sgr(0, 0, rows[0], false),
    sgr(32, 2, rows[1], false),
    sgr(0, 30, rows[1], true),
  ]);
  assert.ok(got.includes('\n'), '跨消息必须有换行: ' + JSON.stringify(got));
  assert.ok(got.includes('第一行'), '起点内容: ' + JSON.stringify(got));
  assert.ok(got.includes('第二行'), '终点内容: ' + JSON.stringify(got));
});

// ── M-03 / M-04：修饰键与滚轮不产生选区 ─────────────────────────────────────

test('M-06: Shift+拖 不产生自绘选区（§6.2 承诺：Shift+鼠标 = 终端原生选择）', () => {
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [{ id: 1, role: 'assistant', text: 'abcdefghij' }],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  const last = proj.anchors.reduce((acc, a, i) => (a ? i : acc), -1);
  // 4 = Shift 位；36 = Shift|motion
  const got = dragToText(proj, [
    sgr(4, 2, last, false),
    sgr(36, 7, last, false),
    sgr(4, 7, last, true),
  ]);
  assert.strictEqual(got, '', 'Shift 手势一个字符都不该被自选区取走');
});

test('M-07: 滚轮序列不污染选区', () => {
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [{ id: 1, role: 'assistant', text: 'abcdefghij' }],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  const last = proj.anchors.reduce((acc, a, i) => (a ? i : acc), -1);
  const got = dragToText(proj, [
    sgr(64, 5, 5, false), // 滚轮上
    sgr(65, 5, 5, false), // 滚轮下
    sgr(0, 2, last, false),
    sgr(32, 7, last, false),
    sgr(0, 7, last, true),
  ]);
  assert.strictEqual(got, 'abcde', '滚轮不该改变后续选择: |' + got + '|');
});

test('M-08: 只按下+位移、没松开 → 什么都不复制（松手才是唯一产出点）', () => {
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [{ id: 1, role: 'assistant', text: 'abcdefghij' }],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  const last = proj.anchors.reduce((acc, a, i) => (a ? i : acc), -1);
  const got = dragToText(proj, [
    sgr(0, 2, last, false),
    sgr(32, 7, last, false),
  ]);
  assert.strictEqual(got, '', '没松手就不该有产出 —— 少了这条会导致「划过即复制」');
});
