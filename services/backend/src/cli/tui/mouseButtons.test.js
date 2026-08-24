'use strict';

/**
 * mouseButtons leaf tests (node:test).
 *
 * Covers:
 *   - isMouseSequence / parseSgrMouse (press/release/motion, 0-based coords)
 *   - gates (buttons default off on every platform, hover default off)
 *   - enable/disable bytes (1000/1006/1003)
 *   - collectLayout (static/display:none skip, offset accumulation, handlers)
 *   - screenOffset (anchor-bottom vs top modes)
 *   - hitTest (bounds + z-order)
 *   - createMouseDispatcher (click on release, hover state machine, fail-soft)
 */

const assert = require('node:assert');
const test = require('node:test');

const {
  isMouseSequence,
  parseSgrMouse,
  mouseButtonsEnabled,
  mouseHoverEnabled,
  enableBytes,
  disableBytes,
  collectLayout,
  screenOffset,
  hitTest,
  createMouseDispatcher,
} = require('./mouseButtons');

// ── fake yoga node helpers ──────────────────────────────────────────────────
// Yoga enum: DISPLAY_FLEX === 0, DISPLAY_NONE === 1 (verified against yoga-layout).
function makeNode({
  left = 0,
  top = 0,
  width = 0,
  height = 0,
  display = 0, // 0 = flex (visible)
  isStatic = false,
  style = {},
  children = [],
} = {}) {
  return {
    internal_static: isStatic,
    style,
    childNodes: children,
    yogaNode: {
      getComputedLeft: () => left,
      getComputedTop: () => top,
      getComputedWidth: () => width,
      getComputedHeight: () => height,
      getDisplay: () => display,
    },
  };
}

// ── isMouseSequence ─────────────────────────────────────────────────────────
test('isMouseSequence: press/release/motion matched', () => {
  assert.equal(isMouseSequence('[<0;20;10M'), true);
  assert.equal(isMouseSequence('[<0;20;10m'), true);
  assert.equal(isMouseSequence('[<35;20;10M'), true); // motion (32+3)
});

test('isMouseSequence: rejects non-mouse input', () => {
  assert.equal(isMouseSequence('a'), false);
  assert.equal(isMouseSequence('[<0;20;10Mx'), false);
  assert.equal(isMouseSequence('[<0;20;10'), false); // missing final byte
  assert.equal(isMouseSequence(''), false);
  assert.equal(isMouseSequence(null), false);
  assert.equal(isMouseSequence(undefined), false);
  assert.equal(isMouseSequence(42), false);
});

// ── parseSgrMouse ───────────────────────────────────────────────────────────
test('parseSgrMouse: press (uppercase M)', () => {
  const ev = parseSgrMouse('[<0;20;10M');
  assert.deepEqual(ev, {
    button: 0,
    col: 19,
    row: 9,
    isPress: true,
    isRelease: false,
    isMotion: false,
    isWheel: false,
  });
});

test('parseSgrMouse: release (lowercase m)', () => {
  const ev = parseSgrMouse('[<0;20;10m');
  assert.equal(ev.isPress, false);
  assert.equal(ev.isRelease, true);
  assert.deepEqual({ col: ev.col, row: ev.row }, { col: 19, row: 9 });
});

test('parseSgrMouse: motion event (button 35 = motion bit | none)', () => {
  const ev = parseSgrMouse('[<35;2;3M');
  assert.equal(ev.isMotion, true);
  assert.equal(ev.col, 1);
  assert.equal(ev.row, 2);
});

test('parseSgrMouse: wheel up/down (SGR buttons 64/65, modifiers stripped)', () => {
  const up = parseSgrMouse('[<64;10;5M');
  assert.equal(up.isWheel, true);
  assert.equal(up.isPress, true);
  const down = parseSgrMouse('[<65;10;5m');
  assert.equal(down.isWheel, true);
  assert.equal(down.isRelease, true);
  // ctrl(+16)/shift(+4) modifiers still resolve as the same wheel button.
  assert.equal(parseSgrMouse('[<80;10;5M').isWheel, true); // ctrl+wheel up
  assert.equal(parseSgrMouse('[<69;10;5M').isWheel, true); // shift+wheel down
  // Plain clicks are NOT wheel.
  assert.equal(parseSgrMouse('[<0;10;5M').isWheel, false);
  assert.equal(parseSgrMouse('[<2;10;5M').isWheel, false);
});

test('parseSgrMouse: 1-based coords floor at 0', () => {
  assert.equal(parseSgrMouse('[<0;1;1M').col, 0);
  assert.equal(parseSgrMouse('[<0;1;1M').row, 0);
  assert.equal(parseSgrMouse('[<0;0;0M').col, 0); // degenerate, still safe
});

test('parseSgrMouse: null on non-mouse / non-string', () => {
  assert.equal(parseSgrMouse('hello'), null);
  assert.equal(parseSgrMouse(''), null);
  assert.equal(parseSgrMouse(null), null);
});

// ── gates ───────────────────────────────────────────────────────────────────
test('mouseButtonsEnabled: defaults OFF on every platform (tracking is exclusive)', () => {
  // 追踪态一开,终端就收不到滚轮与拖选 —— 那是「翻页」和「复制」两个基础能力。
  // 收益只有两个可点元素,且都有键位替代,所以默认必须关,包括 win32。
  assert.equal(mouseButtonsEnabled({}, 'win32'), false);
  assert.equal(mouseButtonsEnabled({}, 'linux'), false);
  assert.equal(mouseButtonsEnabled({}, 'darwin'), false);
});

test('mouseButtonsEnabled: explicit env is the only way in, on any platform', () => {
  for (const p of ['win32', 'linux', 'darwin']) {
    assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: '1' }, p), true, p);
    assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: 'on' }, p), true, p);
    assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: 'yes' }, p), true, p);
    for (const v of ['0', 'false', 'off', 'no', 'OFF', '', 'unexpected']) {
      assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: v }, p), false, p + '/' + v);
    }
  }
});

test('mouseHoverEnabled: default off, explicit truthy on', () => {
  assert.equal(mouseHoverEnabled({}), false);
  assert.equal(mouseHoverEnabled({ KHY_MOUSE_HOVER: '0' }), false);
  assert.equal(mouseHoverEnabled({ KHY_MOUSE_HOVER: 'no' }), false);
  assert.equal(mouseHoverEnabled({ KHY_MOUSE_HOVER: '1' }), true);
  assert.equal(mouseHoverEnabled({ KHY_MOUSE_HOVER: 'yes' }), true);
  assert.equal(mouseHoverEnabled({ KHY_MOUSE_HOVER: 'unexpected' }), false);
});

// ── enable/disable bytes ────────────────────────────────────────────────────
test('enableBytes: 1000 (not 1002) — no motion reporting, drag-select stays native', () => {
  // 对齐 Claude Code:其 bundle 里唯一那处追踪调用就是 1000/1006,全量检索没有 1002
  // 也没有 1003。1000 只报按下/松开,点击只需要这两个端点;位移一旦上报,按下那一下
  // 就已经被本进程吃掉,拖选起点必然丢失 —— 所以不报才是对的。
  assert.equal(enableBytes({ hover: false }), '\x1b[?1000h\x1b[?1006h');
  assert.equal(enableBytes({ hover: true }), '\x1b[?1000h\x1b[?1006h\x1b[?1003h');
  assert.equal(enableBytes(), '\x1b[?1000h\x1b[?1006h');
});

test('disableBytes: resets every mode enableBytes can set, regardless of hover', () => {
  // 「只关自己开过的」写法埋雷:开 1002 而关 1000 会把终端留在追踪态,用户之后
  // 每条命令都没有滚轮和复制。DECRST 打在没开过的模式上是 no-op,多关零成本 ——
  // 降档到 1000 之后 1002 这一关就是纯遗留清理(旧版本/旧会话可能把终端留在 1002)。
  const expected = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
  assert.equal(disableBytes({ hover: false }), expected);
  assert.equal(disableBytes({ hover: true }), expected);
  assert.equal(disableBytes(), expected);
  // 回归护栏:enableBytes 能开的每一个模式号,disableBytes 都必须关掉。
  for (const on of [enableBytes({ hover: false }), enableBytes({ hover: true })]) {
    for (const mode of on.match(/\?\d+(?=h)/g) || []) {
      assert.ok(expected.includes(mode + 'l'), 'disableBytes 漏关 ' + mode);
    }
  }
});

// ── collectLayout ───────────────────────────────────────────────────────────
test('collectLayout: accumulates offsets and collects handlers', () => {
  // Realistic ink model: <Static> is position:absolute → out of flow (no height,
  // no offset push). Root height = live height only; live button sits at y=0+0.
  const button = makeNode({ left: 0, top: 0, width: 4, height: 1, style: { onClick: () => {} } });
  const liveBox = makeNode({ left: 0, top: 0, width: 80, height: 15, children: [button] });
  const staticNode = makeNode({
    left: 0,
    top: 0,
    width: 80,
    height: 5,
    isStatic: true,
    children: [makeNode({ left: 0, top: 0, width: 2, height: 1, style: { onClick: () => {} } })],
  });
  const root = makeNode({ width: 80, height: 15, children: [staticNode, liveBox] });

  const layout = collectLayout(root);
  assert.equal(layout.width, 80);
  assert.equal(layout.height, 15);
  // Only the live button survives (static subtree skipped).
  assert.equal(layout.items.length, 1);
  const it = layout.items[0];
  assert.equal(it.x, 0);
  assert.equal(it.y, 0);
  assert.equal(it.width, 4);
  assert.equal(it.height, 1);
  assert.equal(typeof it.onClick, 'function');
});

test('collectLayout: skips display:none and non-interactive nodes', () => {
  const hidden = makeNode({
    left: 0,
    top: 0,
    width: 5,
    height: 1,
    display: 1,
    style: { onClick: () => {} },
  });
  const plain = makeNode({ left: 0, top: 0, width: 5, height: 1 });
  const root = makeNode({ width: 80, height: 5, children: [hidden, plain] });
  const layout = collectLayout(root);
  assert.equal(layout.items.length, 0);
});

// The collectLayout display check hardcodes `=== 1` (Yoga.DISPLAY_NONE). This
// was originally misread as `=== 0` (the real DISPLAY_FLEX), which made
// collectLayout skip EVERY visible node → "图标可见但点不中". Lock the enum so a
// future yoga upgrade that flips it fails loudly here, not in a real terminal.
test('Yoga display enum values are DISPLAY_FLEX=0 / DISPLAY_NONE=1', async () => {
  const mod = await import('yoga-layout');
  const yoga = mod.default || mod;
  assert.equal(yoga.DISPLAY_FLEX, 0);
  assert.equal(yoga.DISPLAY_NONE, 1);
});

test('collectLayout: missing yoga / null root is safe', () => {
  assert.deepEqual(collectLayout(null), { width: 0, height: 0, items: [] });
  assert.deepEqual(collectLayout({}), { width: 0, height: 0, items: [] });
  const noYoga = { childNodes: [] };
  assert.equal(collectLayout(noYoga).items.length, 0);
});

// ── screenOffset ────────────────────────────────────────────────────────────
test('screenOffset: bottom-anchor mode subtracts root height', () => {
  assert.equal(screenOffset(20, { rows: 30, anchorBottom: true }), 10);
  assert.equal(screenOffset(20, { rows: 30, anchorBottom: false }), 0);
});

test('screenOffset: defaults to top-aligned continuous rendering', () => {
  assert.equal(screenOffset(20, { rows: 30 }), 0);
  assert.equal(screenOffset(20, {}), 0);
  assert.equal(screenOffset(20), 0);
});

// ── hitTest ─────────────────────────────────────────────────────────────────
test('hitTest: matches bounds and returns topmost', () => {
  const layout = {
    items: [
      { node: 'a', x: 0, y: 0, width: 10, height: 2 },
      { node: 'b', x: 2, y: 1, width: 5, height: 1 }, // overlapping, painted later → on top
    ],
  };
  assert.equal(hitTest(layout, 3, 1, 0).node, 'b'); // inside both → topmost
  assert.equal(hitTest(layout, 1, 1, 0).node, 'a');
  assert.equal(hitTest(layout, 11, 0, 0), null); // outside
  assert.equal(hitTest(layout, 3, 3, 0), null); // below
});

test('hitTest: offset shifts rows (bottom anchor)', () => {
  const layout = { items: [{ node: 'btn', x: 0, y: 10, width: 4, height: 1 }] };
  // y 10 + offset 10 = 20; screen row 20 is inside [20,21)
  assert.equal(hitTest(layout, 1, 20, 10).node, 'btn');
  assert.equal(hitTest(layout, 1, 10, 0).node, 'btn'); // no offset → row 10
  assert.equal(hitTest(layout, 1, 19, 10), null); // just above the offset row
});

test('hitTest: defensive on bad layout', () => {
  assert.equal(hitTest(null, 0, 0, 0), null);
  assert.equal(hitTest({}, 0, 0, 0), null);
});

// ── createMouseDispatcher ───────────────────────────────────────────────────
test('dispatcher: click fires onClick on release', () => {
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        clicks += 1;
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const dispatch = createMouseDispatcher({ hover: false }).onInput;
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };

  // offset = 24 - 5 = 19 → button occupies screen rows [19,20), cols [0,4)
  assert.equal(dispatch('[<0;2;20M', ctx), true); // press
  assert.equal(clicks, 0);
  assert.equal(dispatch('[<0;2;20m', ctx), true); // release on the button
  assert.equal(clicks, 1);
});

test('dispatcher: top-aligned continuous mode clicks without a bottom offset', () => {
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: { onClick: () => clicks++ },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const dispatch = createMouseDispatcher({ hover: false }).onInput;
  const ctx = { rootNode: root, rows: 24, anchorBottom: false };

  dispatch('[<0;2;1M', ctx);
  dispatch('[<0;2;1m', ctx);
  assert.equal(clicks, 1);
});

test('dispatcher: release off-button does not click', () => {
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        clicks += 1;
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const dispatch = createMouseDispatcher({ hover: false }).onInput;
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  dispatch('[<0;2;20M', ctx);
  dispatch('[<0;50;20m', ctx); // release far away
  assert.equal(clicks, 0);
});

test('dispatcher: onMouseUp preferred over onClick', () => {
  let fired = null;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        fired = 'click';
      },
      onMouseUp: () => {
        fired = 'up';
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const dispatch = createMouseDispatcher({ hover: false }).onInput;
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  dispatch('[<0;1;20M', ctx);
  dispatch('[<0;1;20m', ctx);
  assert.equal(fired, 'up');
});

test('dispatcher: hover state machine fires over/out', () => {
  const events = [];
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: { onMouseOver: () => events.push('over'), onMouseOut: () => events.push('out') },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({ hover: true, motionThrottleMs: 0 });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };

  d.onInput('[<35;1;20M', ctx); // move onto button
  assert.deepEqual(events, ['over']);
  d.onInput('[<35;1;20M', ctx); // same node → no duplicate
  assert.deepEqual(events, ['over']);
  d.onInput('[<35;50;20M', ctx); // move away
  assert.deepEqual(events, ['over', 'out']);
});

test('dispatcher: hover disabled ignores motion', () => {
  const events = [];
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: { onMouseOver: () => events.push('over') },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({ hover: false });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  assert.equal(d.onInput('[<35;1;20M', ctx), true);
  assert.deepEqual(events, []);
});

test('dispatcher: wheel event calls onNative and never fires onClick', () => {
  let natives = 0;
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        clicks += 1;
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({
    hover: false,
    onNative: () => {
      natives += 1;
    },
  });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  assert.equal(d.onInput('[<64;2;20M', ctx), true); // wheel up → consumed
  assert.equal(d.onInput('[<65;2;20m', ctx), true); // wheel down → consumed
  assert.equal(natives, 2);
  assert.equal(clicks, 0); // wheel never triggers the button
});

test('dispatcher: onNative absent still consumes wheel (no crash)', () => {
  const root = makeNode({ width: 80, height: 5, children: [] });
  const d = createMouseDispatcher({ hover: false }); // no onNative
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  assert.equal(d.onInput('[<64;2;20M', ctx), true);
  assert.equal(d.onInput('[<65;2;20M', ctx), true);
});

// ── 1000 降档后的拖选契约:dispatcher 完全不介入 ─────────────────────────────
test('dispatcher: drag on empty space never calls onNative (1000 reports no motion)', () => {
  // 历史上这里有一条「按下落空 + 拖动 → onNative 把拖选交还终端」的补偿分支,它靠
  // 伪造的位移事件才在单测里变绿:真实终端里 1002 报出位移时,按下那一下已经被本
  // 进程吃掉,原生选择只能从半路接管,选出来的范围是错的。降到 1000 后位移根本不
  // 上报,按下/松开落在空白处时 dispatcher 什么都不做,终端自己看到完整一次拖拽。
  let natives = 0;
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        clicks += 1;
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({
    hover: false,
    motionThrottleMs: 0,
    onNative: () => {
      natives += 1;
    },
  });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };

  // 即便终端(或旧会话残留的 1002)真的送来一个按住位移事件,也不再触发透传。
  d.onInput('[<0;50;20M', ctx); // press on empty space
  d.onInput('[<32;55;20M', ctx); // motion with left button held
  d.onInput('[<0;55;20m', ctx); // release
  assert.equal(natives, 0);
  assert.equal(clicks, 0);
});

test('dispatcher: press on empty + release without drag → no onNative, no click', () => {
  let natives = 0;
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        clicks += 1;
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({
    hover: false,
    onNative: () => {
      natives += 1;
    },
  });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  d.onInput('[<0;50;20M', ctx); // press on empty
  d.onInput('[<0;50;20m', ctx); // plain release (no drag) → stays in tracking mode
  assert.equal(natives, 0);
  assert.equal(clicks, 0);
});

test('dispatcher: plain mouse move (no button) does NOT trigger native', () => {
  let natives = 0;
  const root = makeNode({ width: 80, height: 5, children: [] });
  const d = createMouseDispatcher({
    hover: false,
    motionThrottleMs: 0,
    onNative: () => {
      natives += 1;
    },
  });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  d.onInput('[<0;50;20M', ctx); // press on empty
  d.onInput('[<35;55;20M', ctx); // plain move (motion, no button held → button 3)
  assert.equal(natives, 0);
});

test('dispatcher: press on empty then release ON a button does not click (press must arm)', () => {
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        clicks += 1;
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({ hover: false });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  d.onInput('[<0;50;20M', ctx); // press on empty → nothing armed
  d.onInput('[<0;2;20m', ctx); // release on button → no armed click, so no fire
  assert.equal(clicks, 0);
});

test('dispatcher: press on button then drag off then release cancels the click', () => {
  let clicks = 0;
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        clicks += 1;
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  d.onInput('[<0;2;20M', ctx); // press on button → pendingClick
  d.onInput('[<32;50;20M', ctx); // drag off (button held) → pendingClick stays, no native (not select)
  d.onInput('[<0;50;20m', ctx); // release off-button → no click
  assert.equal(clicks, 0);
});

test('dispatcher: non-mouse input returns false, missing root is safe', () => {
  const d = createMouseDispatcher({ hover: true });
  assert.equal(d.onInput('a', {}), false);
  assert.equal(d.onInput('[<0;2;20M', {}), true); // no root → consumed, no crash
  assert.equal(d.onInput('[<0;2;20m', { rootNode: null }), true);
});

test('dispatcher: handler throw is fail-soft (no uncaught)', () => {
  const button = makeNode({
    left: 0,
    top: 0,
    width: 4,
    height: 1,
    style: {
      onClick: () => {
        throw new Error('boom');
      },
    },
  });
  const root = makeNode({ width: 80, height: 5, children: [button] });
  const d = createMouseDispatcher({ hover: false });
  const ctx = { rootNode: root, rows: 24, anchorBottom: true };
  assert.doesNotThrow(() => d.onInput('[<0;1;20M', ctx));
  assert.doesNotThrow(() => d.onInput('[<0;1;20m', ctx));
});

// 布局缓存(抗 1003 移动风暴):同 cacheKey 复用、换 key 重算;渲染之间的事件
// 不重复跑整树 DFS,否则高频鼠标移动会把键盘输入挤掉(「输入延迟卡断」)。
test('dispatcher: layout cache reuses within a frame and invalidates across frames', () => {
  let clicks = 0;
  const rootA = makeNode({
    width: 80,
    height: 5,
    children: [
      makeNode({
        left: 0,
        top: 0,
        width: 4,
        height: 1,
        style: {
          onClick: () => {
            clicks += 1;
          },
        },
      }),
    ],
  });
  const d = createMouseDispatcher({ hover: false });
  const ctxA = { rootNode: rootA, rows: 24, anchorBottom: true, cacheKey: 'frame-1' };

  // Two identical clicks within the same frame → cached layout reused, still correct.
  d.onInput('[<0;2;20M', ctxA);
  d.onInput('[<0;2;20m', ctxA);
  assert.equal(clicks, 1);
  d.onInput('[<0;2;20M', ctxA);
  d.onInput('[<0;2;20m', ctxA);
  assert.equal(clicks, 2);

  // New frame, button moved elsewhere → cache invalidated; the old spot is now
  // empty (press→release = no click), the new spot clicks.
  const rootB = makeNode({
    width: 80,
    height: 5,
    children: [
      makeNode({
        left: 40,
        top: 0,
        width: 4,
        height: 1,
        style: {
          onClick: () => {
            clicks += 1;
          },
        },
      }),
    ],
  });
  const ctxB = { rootNode: rootB, rows: 24, anchorBottom: true, cacheKey: 'frame-2' };
  d.onInput('[<0;2;20M', ctxB); // press at the OLD column → now empty
  d.onInput('[<0;2;20m', ctxB);
  assert.equal(clicks, 2); // no click
  d.onInput('[<0;42;20M', ctxB); // press at the NEW column (col 41)
  d.onInput('[<0;42;20m', ctxB);
  assert.equal(clicks, 3);
});
