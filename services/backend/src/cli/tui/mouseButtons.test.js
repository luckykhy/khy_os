'use strict';

/**
 * mouseButtons leaf tests (node:test).
 *
 * Covers:
 *   - isMouseSequence / parseSgrMouse (press/release/motion, 0-based coords)
 *   - gates (buttons win32-default-on, hover default off)
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
test('mouseButtonsEnabled: win32 defaults on and other platforms default off', () => {
  assert.equal(mouseButtonsEnabled({}, 'win32'), true);
  assert.equal(mouseButtonsEnabled({}, 'linux'), false);
  assert.equal(mouseButtonsEnabled({}, 'darwin'), false);
});

test('mouseButtonsEnabled: explicit env overrides platform defaults', () => {
  assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: '1' }, 'linux'), true);
  assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: 'on' }, 'darwin'), true);
  assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: 'yes' }, 'win32'), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: v }, 'win32'), false, v);
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
test('enableBytes/disableBytes: exact terminal modes', () => {
  assert.equal(enableBytes({ hover: false }), '\x1b[?1000h\x1b[?1006h');
  assert.equal(enableBytes({ hover: true }), '\x1b[?1000h\x1b[?1006h\x1b[?1003h');
  assert.equal(disableBytes({ hover: false }), '\x1b[?1000l\x1b[?1006l');
  assert.equal(disableBytes({ hover: true }), '\x1b[?1000l\x1b[?1006l\x1b[?1003l');
  assert.equal(enableBytes(), '\x1b[?1000h\x1b[?1006h');
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

// ── 对抗式透传:pendingSelect(按下落空)→ 拖动 → onNative ─────────────────────
test('dispatcher: press on empty + drag → onNative (selection intent)', () => {
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

  d.onInput('[<0;50;20M', ctx); // press on empty space
  assert.equal(natives, 0);
  d.onInput('[<32;55;20M', ctx); // drag (motion bit | left button) → selection intent
  assert.equal(natives, 1);
  d.onInput('[<0;55;20m', ctx); // release (native now, not reported) — no click
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
  d.onInput('[<0;50;20M', ctx); // press on empty → pendingSelect
  d.onInput('[<0;2;20m', ctx); // release on button → pendingSelect cleared, no click
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
