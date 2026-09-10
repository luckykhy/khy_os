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
// ── parseSgrMouse ───────────────────────────────────────────────────────────
// ── gates ───────────────────────────────────────────────────────────────────
// ── enable/disable bytes ────────────────────────────────────────────────────
// ── collectLayout ───────────────────────────────────────────────────────────
// The collectLayout display check hardcodes `=== 1` (Yoga.DISPLAY_NONE). This
// was originally misread as `=== 0` (the real DISPLAY_FLEX), which made
// collectLayout skip EVERY visible node �?"图标可见但点不中". Lock the enum so a
// future yoga upgrade that flips it fails loudly here, not in a real terminal.
// ── screenOffset ────────────────────────────────────────────────────────────
// ── hitTest ─────────────────────────────────────────────────────────────────
// ── createMouseDispatcher ───────────────────────────────────────────────────
// ── 1000 降档后的拖选契�?dispatcher 完全不介�?─────────────────────────────
// 布局缓存(�?1003 移动风暴):�?cacheKey 复用、换 key 重算;渲染之间的事�?
// 不重复跑整树 DFS,否则高频鼠标移动会把键盘输入挤掉(「输入延迟卡断�?�?

describe('Mouse Buttons', () => {
  test('isMouseSequence: press/release/motion matched', async () => {
      expect(isMouseSequence('[<0;20;10M').toBe(true);
      expect(isMouseSequence('[<0;20;10m').toBe(true);
      expect(isMouseSequence('[<35;20;10M').toBe(true); // motion (32+3)
  });

  test('isMouseSequence: rejects non-mouse input', async () => {
      expect(isMouseSequence('a').toBe(false);
      expect(isMouseSequence('[<0;20;10Mx').toBe(false);
      expect(isMouseSequence('[<0;20;10').toBe(false); // missing final byte
      expect(isMouseSequence('').toBe(false);
      expect(isMouseSequence(null).toBe(false);
      expect(isMouseSequence(undefined).toBe(false);
      expect(isMouseSequence(42).toBe(false);
  });

  test('parseSgrMouse: press (uppercase M)', async () => {
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

  test('parseSgrMouse: release (lowercase m)', async () => {
      const ev = parseSgrMouse('[<0;20;10m');
      expect(ev.isPress).toBe(false);
      expect(ev.isRelease).toBe(true);
      assert.deepEqual({ col: ev.col, row: ev.row }, { col: 19, row: 9 });
  });

  test('parseSgrMouse: motion event (button 35 = motion bit | none)', async () => {
      const ev = parseSgrMouse('[<35;2;3M');
      expect(ev.isMotion).toBe(true);
      expect(ev.col).toBe(1);
      expect(ev.row).toBe(2);
  });

  test('parseSgrMouse: wheel up/down (SGR buttons 64/65, modifiers stripped)', async () => {
      const up = parseSgrMouse('[<64;10;5M');
      expect(up.isWheel).toBe(true);
      expect(up.isPress).toBe(true);
      const down = parseSgrMouse('[<65;10;5m');
      expect(down.isWheel).toBe(true);
      expect(down.isRelease).toBe(true);
      // ctrl(+16)/shift(+4) modifiers still resolve as the same wheel button.
      expect(parseSgrMouse('[<80;10;5M').isWheel).toBe(true); // ctrl+wheel up
      expect(parseSgrMouse('[<69;10;5M').isWheel).toBe(true); // shift+wheel down
      // Plain clicks are NOT wheel.
      expect(parseSgrMouse('[<0;10;5M').isWheel).toBe(false);
      expect(parseSgrMouse('[<2;10;5M').isWheel).toBe(false);
  });

  test('parseSgrMouse: 1-based coords floor at 0', async () => {
      expect(parseSgrMouse('[<0;1;1M').col).toBe(0);
      expect(parseSgrMouse('[<0;1;1M').row).toBe(0);
      expect(parseSgrMouse('[<0;0;0M').col).toBe(0); // degenerate, still safe
  });

  test('parseSgrMouse: null on non-mouse / non-string', async () => {
      expect(parseSgrMouse('hello').toBe(null);
      expect(parseSgrMouse('').toBe(null);
      expect(parseSgrMouse(null).toBe(null);
  });

  test('mouseButtonsEnabled: defaults OFF on every platform (tracking is exclusive)', async () => {
      // 追踪态一开,终端就收不到滚轮与拖�?—�?那是「翻页」和「复制」两个基础能力�?
      // 收益只有两个可点元素,且都有键位替�?所以默认必须关,包括 win32�?
      expect(mouseButtonsEnabled({})).toBe('win32');
      expect(mouseButtonsEnabled({})).toBe('linux');
      expect(mouseButtonsEnabled({})).toBe('darwin');
  });

  test('mouseButtonsEnabled: explicit env is the only way in, on any platform', async () => {
      for (const p of ['win32', 'linux', 'darwin']) {
        expect(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: '1' })).toBe(p);
        expect(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: 'on' })).toBe(p);
        expect(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: 'yes' })).toBe(p);
        for (const v of ['0', 'false', 'off', 'no', 'OFF', '', 'unexpected']) {
          expect(mouseButtonsEnabled({ KHY_MOUSE_BUTTONS: v })).toBe(p);
        }
      }
  });

  test('mouseHoverEnabled: default off, explicit truthy on', async () => {
      expect(mouseHoverEnabled({}).toBe(false);
      expect(mouseHoverEnabled({ KHY_MOUSE_HOVER: '0' }).toBe(false);
      expect(mouseHoverEnabled({ KHY_MOUSE_HOVER: 'no' }).toBe(false);
      expect(mouseHoverEnabled({ KHY_MOUSE_HOVER: '1' }).toBe(true);
      expect(mouseHoverEnabled({ KHY_MOUSE_HOVER: 'yes' }).toBe(true);
      expect(mouseHoverEnabled({ KHY_MOUSE_HOVER: 'unexpected' }).toBe(false);
  });

  test('enableBytes: 1000 (not 1002) �?no motion reporting, drag-select stays native', async () => {
      // 对齐 Claude Code:�?bundle 里唯一那处追踪调用就是 1000/1006,全量检索没�?1002
      // 也没�?1003�?000 只报按下/松开,点击只需要这两个端点;位移一旦上�?按下那一�?
      // 就已经被本进程吃�?拖选起点必然丢�?—�?所以不报才是对的�?
      expect(enableBytes({ hover: false }).toBe('\x1b[?1000h\x1b[?1006h');
      expect(enableBytes({ hover: true }).toBe('\x1b[?1000h\x1b[?1006h\x1b[?1003h');
      expect(enableBytes().toBe('\x1b[?1000h\x1b[?1006h');
  });

  test('disableBytes: resets every mode enableBytes can set, regardless of hover', async () => {
      // 「只关自己开过的」写法埋�?开 1002 而关 1000 会把终端留在追踪�?用户之后
      // 每条命令都没有滚轮和复制。DECRST 打在没开过的模式上是 no-op,多关零成�?—�?
      // 降档�?1000 之后 1002 这一关就是纯遗留清理(旧版�?旧会话可能把终端留在 1002)�?
      const expected = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
      expect(disableBytes({ hover: false }).toBe(expected);
      expect(disableBytes({ hover: true }).toBe(expected);
      expect(disableBytes().toBe(expected);
      // 回归护栏:enableBytes 能开的每一个模式号,disableBytes 都必须关掉�?
      for (const on of [enableBytes({ hover: false }), enableBytes({ hover: true })]) {
        for (const mode of on.match(/\?\d+(?=h)/g) || []) {
          expect(expected.includes(mode + 'l').toBe();
        }
      }
  });

  test('collectLayout: accumulates offsets and collects handlers', async () => {
      // Realistic ink model: <Static> is position:absolute �?out of flow (no height,
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
      expect(layout.width).toBe(80);
      expect(layout.height).toBe(15);
      // Only the live button survives (static subtree skipped).
      expect(layout.items.length).toBe(1);
      const it = layout.items[0];
      expect(it.x).toBe(0);
      expect(it.y).toBe(0);
      expect(it.width).toBe(4);
      expect(it.height).toBe(1);
      expect(typeof it.onClick).toBe('function');
  });

  test('collectLayout: skips display:none and non-interactive nodes', async () => {
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
      expect(layout.items.length).toBe(0);
  });

  test('Yoga display enum values are DISPLAY_FLEX=0 / DISPLAY_NONE=1', async () => {
      const mod = await import('yoga-layout');
      const yoga = mod.default || mod;
      expect(yoga.DISPLAY_FLEX).toBe(0);
      expect(yoga.DISPLAY_NONE).toBe(1);
  });

  test('collectLayout: missing yoga / null root is safe', async () => {
      assert.deepEqual(collectLayout(null), { width: 0, height: 0, items: [] });
      assert.deepEqual(collectLayout({}), { width: 0, height: 0, items: [] });
      const noYoga = { childNodes: [] };
      expect(collectLayout(noYoga).items.length).toBe(0);
  });

  test('screenOffset: bottom-anchor mode subtracts root height', async () => {
      expect(screenOffset(20, { rows: 30, anchorBottom: true }).toBe(10);
      expect(screenOffset(20, { rows: 30, anchorBottom: false }).toBe(0);
  });

  test('screenOffset: defaults to top-aligned continuous rendering', async () => {
      expect(screenOffset(20)).toBe({ rows: 30 });
      expect(screenOffset(20)).toBe({});
      expect(screenOffset(20).toBe(0);
  });

  test('hitTest: matches bounds and returns topmost', async () => {
      const layout = {
        items: [
          { node: 'a', x: 0, y: 0, width: 10, height: 2 },
          { node: 'b', x: 2, y: 1, width: 5, height: 1 }, // overlapping, painted later �?on top
        ],
      };
      expect(hitTest(layout, 3, 1, 0).node).toBe('b'); // inside both �?topmost
      expect(hitTest(layout, 1, 1, 0).node).toBe('a');
      expect(hitTest(layout, 11, 0, 0).toBe(null); // outside
      expect(hitTest(layout, 3, 3, 0).toBe(null); // below
  });

  test('hitTest: offset shifts rows (bottom anchor)', async () => {
      const layout = { items: [{ node: 'btn', x: 0, y: 10, width: 4, height: 1 }] };
      // y 10 + offset 10 = 20; screen row 20 is inside [20,21)
      expect(hitTest(layout, 1, 20, 10).node).toBe('btn');
      expect(hitTest(layout, 1, 10, 0).node).toBe('btn'); // no offset �?row 10
      expect(hitTest(layout, 1, 19, 10).toBe(null); // just above the offset row
  });

  test('hitTest: defensive on bad layout', async () => {
      expect(hitTest(null, 0, 0, 0).toBe(null);
      expect(hitTest({}, 0, 0, 0).toBe(null);
  });

  test('dispatcher: click fires onClick on release', async () => {
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
    
      // offset = 24 - 5 = 19 �?button occupies screen rows [19,20), cols [0,4)
      expect(dispatch('[<0;2;20M').toBe(ctx); // press
      expect(clicks).toBe(0);
      expect(dispatch('[<0;2;20m').toBe(ctx); // release on the button
      expect(clicks).toBe(1);
  });

  test('dispatcher: top-aligned continuous mode clicks without a bottom offset', async () => {
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
      expect(clicks).toBe(1);
  });

  test('dispatcher: release off-button does not click', async () => {
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
      expect(clicks).toBe(0);
  });

  test('dispatcher: onMouseUp preferred over onClick', async () => {
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
      expect(fired).toBe('up');
  });

  test('dispatcher: hover state machine fires over/out', async () => {
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
      d.onInput('[<35;1;20M', ctx); // same node �?no duplicate
      assert.deepEqual(events, ['over']);
      d.onInput('[<35;50;20M', ctx); // move away
      assert.deepEqual(events, ['over', 'out']);
  });

  test('dispatcher: hover disabled ignores motion', async () => {
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
      expect(d.onInput('[<35;1;20M')).toBe(ctx);
      assert.deepEqual(events, []);
  });

  test('dispatcher: wheel event calls onNative and never fires onClick', async () => {
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
      expect(d.onInput('[<64;2;20M').toBe(ctx); // wheel up �?consumed
      expect(d.onInput('[<65;2;20m').toBe(ctx); // wheel down �?consumed
      expect(natives).toBe(2);
      expect(clicks).toBe(0); // wheel never triggers the button
  });

  test('dispatcher: onNative absent still consumes wheel (no crash)', async () => {
      const root = makeNode({ width: 80, height: 5, children: [] });
      const d = createMouseDispatcher({ hover: false }); // no onNative
      const ctx = { rootNode: root, rows: 24, anchorBottom: true };
      expect(d.onInput('[<64;2;20M')).toBe(ctx);
      expect(d.onInput('[<65;2;20M')).toBe(ctx);
  });

  test('dispatcher: drag on empty space never calls onNative (1000 reports no motion)', async () => {
      // 历史上这里有一条「按下落�?+ 拖动 �?onNative 把拖选交还终端」的补偿分支,它靠
      // 伪造的位移事件才在单测里变�?真实终端�?1002 报出位移�?按下那一下已经被�?
      // 进程吃掉,原生选择只能从半路接�?选出来的范围是错的。降�?1000 后位移根本不
      // 上报,按下/松开落在空白处时 dispatcher 什么都不做,终端自己看到完整一次拖拽�?
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
    
      // 即便终端(或旧会话残留�?1002)真的送来一个按住位移事�?也不再触发透传�?
      d.onInput('[<0;50;20M', ctx); // press on empty space
      d.onInput('[<32;55;20M', ctx); // motion with left button held
      d.onInput('[<0;55;20m', ctx); // release
      expect(natives).toBe(0);
      expect(clicks).toBe(0);
  });

  test('dispatcher: press on empty + release without drag �?no onNative, no click', async () => {
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
      d.onInput('[<0;50;20m', ctx); // plain release (no drag) �?stays in tracking mode
      expect(natives).toBe(0);
      expect(clicks).toBe(0);
  });

  test('dispatcher: plain mouse move (no button) does NOT trigger native', async () => {
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
      d.onInput('[<35;55;20M', ctx); // plain move (motion, no button held �?button 3)
      expect(natives).toBe(0);
  });

  test('dispatcher: press on empty then release ON a button does not click (press must arm)', async () => {
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
      d.onInput('[<0;50;20M', ctx); // press on empty �?nothing armed
      d.onInput('[<0;2;20m', ctx); // release on button �?no armed click, so no fire
      expect(clicks).toBe(0);
  });

  test('dispatcher: press on button then drag off then release cancels the click', async () => {
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
      d.onInput('[<0;2;20M', ctx); // press on button �?pendingClick
      d.onInput('[<32;50;20M', ctx); // drag off (button held) �?pendingClick stays, no native (not select)
      d.onInput('[<0;50;20m', ctx); // release off-button �?no click
      expect(clicks).toBe(0);
  });

  test('dispatcher: non-mouse input returns false, missing root is safe', async () => {
      const d = createMouseDispatcher({ hover: true });
      expect(d.onInput('a')).toBe({});
      expect(d.onInput('[<0;2;20M').toBe({}); // no root �?consumed, no crash
      expect(d.onInput('[<0;2;20m')).toBe({ rootNode: null });
  });

  test('dispatcher: handler throw is fail-soft (no uncaught)', async () => {
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
      expect(() => d.onInput('[<0;1;20M', ctx).not.toThrow());
      expect(() => d.onInput('[<0;1;20m', ctx).not.toThrow());
  });

  test('dispatcher: layout cache reuses within a frame and invalidates across frames', async () => {
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
    
      // Two identical clicks within the same frame �?cached layout reused, still correct.
      d.onInput('[<0;2;20M', ctxA);
      d.onInput('[<0;2;20m', ctxA);
      expect(clicks).toBe(1);
      d.onInput('[<0;2;20M', ctxA);
      d.onInput('[<0;2;20m', ctxA);
      expect(clicks).toBe(2);
    
      // New frame, button moved elsewhere �?cache invalidated; the old spot is now
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
      d.onInput('[<0;2;20M', ctxB); // press at the OLD column �?now empty
      d.onInput('[<0;2;20m', ctxB);
      expect(clicks).toBe(2); // no click
      d.onInput('[<0;42;20M', ctxB); // press at the NEW column (col 41)
      d.onInput('[<0;42;20m', ctxB);
      expect(clicks).toBe(3);
  });

});

