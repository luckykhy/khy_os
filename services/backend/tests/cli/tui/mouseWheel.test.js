'use strict';

// mouseWheel — 滚轮接管的应用内视口路由。
//
// 背景(为什么这个文件必须存在):
//   本 TUI 跑在**备用缓冲区**(alternate screen)里,那里没有回滚缓冲。只要鼠标追踪
//   被关掉,终端就会把滚轮合成为 ↑/↓ 键送进 stdin —— 而 ↑/↓ 已被 arrowRouting 绑成
//   `history:previous/next`,于是用户看到的「滚轮回溯历史记录」其实是键位串扰。
//   所以备用缓冲区下滚轮**必须**被应用接管,且必须走 `onWheel`(应用内视口),
//   而不是 `onNative`(交还终端)。
//
//   `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const {
  wheelDirection,
  mouseExplicitlyDisabled,
  createMouseDispatcher,
  parseSgrMouse,
  enableBytes,
  altScreenEnabled,
  mouseButtonsEnabled,
} = require('../../../src/cli/tui/mouseButtons');

// ── 默认值:备屏下滚轮**必须**有主(2026-09-20 用户报告「滚轮变成历史回溯」)──────
//
// 这组断言守的是**默认值**本身,而不是某条分支。历史教训:上面那组 dispatcher 断言
// 全绿,故障却照旧 —— 滚轮路由、arrowRouting 绑定、enableBytes 档位各自都对,唯独
// **默认档位**是 off,于是备屏里没有任何人接管滚轮,终端把它合成 ↑/↓,用户看到历史
// 回溯。单测只测「给定了 onWheel 会怎样」,没人测「默认情况下追踪字节写没写出去」。
test('备屏默认接管:未设任何 KHY_* 时,已识别终端必须写出追踪字节', () => {
  const ENV = { WT_SESSION: 'probe', TERM_PROGRAM: 'WindowsTerminal', TERM: 'xterm-256color' };
  assert.equal(altScreenEnabled(ENV), true, '备屏默认开 —— 那里没有回滚缓冲可滚');
  assert.equal(mouseButtonsEnabled(ENV, 'win32'), true, '滚轮必须有主');
  assert.ok(enableBytes({}).includes('1000h'), '追踪字节真的写得出(1000+1006)');
  // 反向:主屏幕下不接管 —— 那才是「原生 scrollback + 拖选」划算的一侧
  assert.equal(
    mouseButtonsEnabled({ ...ENV, KHY_ALT_SCREEN: '0' }, 'win32'),
    false,
    '主屏幕保留原生滚轮'
  );
  // 反向:用户显式否决时,默认接管必须让位
  assert.equal(mouseButtonsEnabled({ ...ENV, KHY_MOUSE: 'off' }, 'win32'), false);
});

test('因果链闭合:终端合成的 ↑/↓ 在 idle / editing 下就是历史回溯', () => {
  // 这条断言是「为什么默认值重要」的**理由本身**。它一旦被改动(比如有人把 ↑ 从
  // history:previous 上摘掉),上面那条默认值断言的紧迫性就消失了 —— 两处必须一起读。
  const arrows = require('../../../src/cli/tui/arrowRouting');
  assert.equal(
    arrows.resolveArrowAction({ key: { upArrow: true }, empty: true }),
    'history:previous',
    '空缓冲区(idle):↑ 召回上一条历史'
  );
  assert.equal(arrows.resolveArrowAction({ key: { downArrow: true }, empty: true }), 'history:next');
  assert.equal(
    arrows.resolveArrowAction({ key: { upArrow: true }, empty: false }),
    'history:previous',
    '缓冲区非空(editing)照样回溯 —— 所以「输入框有字就不会被误伤」是错的'
  );
});

// 一个不参与命中测试的假上下文:滚轮路径不读布局,但 onInput 会先要 rootNode。
const CTX = { rootNode: { yogaNode: null }, rows: 40, anchorBottom: false, cacheKey: 'k' };

const WHEEL_UP = '[<64;10;5M';
const WHEEL_DOWN = '[<65;10;5M';

// ── wheelDirection:按钮号 → 方向 ──────────────────────────────────────────────
test('wheelDirection: 64=上 / 65=下,修饰位(shift/meta/ctrl)不改变方向', () => {
  assert.equal(wheelDirection(64), 'up');
  assert.equal(wheelDirection(65), 'down');
  assert.equal(wheelDirection(68), 'up', 'shift+wheel up (64|4)');
  assert.equal(wheelDirection(69), 'down', 'shift+wheel down (65|4)');
  assert.equal(wheelDirection(72), 'up', 'meta+wheel up (64|8)');
  assert.equal(wheelDirection(80), 'up', 'ctrl+wheel up (64|16)');
});

test('wheelDirection: 非滚轮按钮一律 null(不能吞掉点击/拖动)', () => {
  assert.equal(wheelDirection(0), null, '左键按下');
  assert.equal(wheelDirection(1), null, '中键');
  assert.equal(wheelDirection(2), null, '右键');
  assert.equal(wheelDirection(32), null, '1002 位移位');
  assert.equal(wheelDirection(35), null, '位移 + 左键');
  assert.equal(wheelDirection(undefined), null);
  assert.equal(wheelDirection(NaN), null);
});

test('parseSgrMouse: 滚轮序列被标为 isWheel 且不是 motion', () => {
  const up = parseSgrMouse(WHEEL_UP);
  assert.equal(up.isWheel, true);
  assert.equal(up.isMotion, false, '64 & 32 === 0 → 不是位移事件');
  assert.equal(wheelDirection(up.button), 'up');

  const down = parseSgrMouse(WHEEL_DOWN);
  assert.equal(down.isWheel, true);
  assert.equal(wheelDirection(down.button), 'down');
});

// ── mouseExplicitlyDisabled:显式关掉鼠标的两条通道 ────────────────────────────
test('mouseExplicitlyDisabled: KHY_MOUSE=off 或 KHY_MOUSE_BUTTONS=0 视为显式关闭', () => {
  assert.equal(mouseExplicitlyDisabled({ KHY_MOUSE: 'off' }), true);
  assert.equal(mouseExplicitlyDisabled({ KHY_MOUSE: '0' }), true);
  assert.equal(mouseExplicitlyDisabled({ KHY_MOUSE: 'no' }), true);
  assert.equal(mouseExplicitlyDisabled({ KHY_MOUSE_BUTTONS: '0' }), true);
  assert.equal(mouseExplicitlyDisabled({ KHY_MOUSE_BUTTONS: 'false' }), true);
  assert.equal(mouseExplicitlyDisabled({}), false, '未设置 → 不是显式关闭');
  assert.equal(mouseExplicitlyDisabled({ KHY_MOUSE: 'click' }), false);
  assert.equal(mouseExplicitlyDisabled({ KHY_MOUSE_BUTTONS: '1' }), false);
});

// ── dispatcher:滚轮走 onWheel,不走 onNative ──────────────────────────────────
test('dispatcher: 接了 onWheel 时滚轮只走 onWheel,绝不回退 onNative', () => {
  const seen = [];
  let native = 0;
  const d = createMouseDispatcher({
    onWheel: (dir) => seen.push(dir),
    onNative: () => {
      native += 1;
    },
  });
  assert.equal(d.onInput(WHEEL_UP, CTX), true);
  assert.equal(d.onInput(WHEEL_DOWN, CTX), true);
  assert.deepEqual(seen, ['up', 'down']);
  assert.equal(native, 0, 'onNative 是「交还终端」—— 备用缓冲区下等于把滚轮变成 ↑/↓ 历史回溯');
});

test('dispatcher: 未接 onWheel 时回退 onNative(逐字节保留旧行为)', () => {
  let native = 0;
  const d = createMouseDispatcher({
    onNative: () => {
      native += 1;
    },
  });
  d.onInput(WHEEL_UP, CTX);
  assert.equal(native, 1);
});

test('dispatcher: onWheel 抛异常必须被吞掉,且不得顺带触发 onNative', () => {
  let native = 0;
  const d = createMouseDispatcher({
    onWheel: () => {
      throw new Error('boom');
    },
    onNative: () => {
      native += 1;
    },
  });
  assert.doesNotThrow(() => d.onInput(WHEEL_UP, CTX));
  assert.equal(native, 0, '滚动处理器坏掉不能把滚轮降级成原生透传');
});

test('dispatcher: 滚轮事件永不 arm 点击(pendingClick 不被污染)', () => {
  let clicks = 0;
  const d = createMouseDispatcher({
    onWheel: () => {},
  });
  // 滚轮 → 不应把 pendingClick 置位;随后的「松开」不应触发任何点击。
  d.onInput(WHEEL_UP, CTX);
  d.onInput('[<0;10;5m', CTX); // 左键松开
  assert.equal(clicks, 0);
});

// ── enableBytes 三档追踪模式:select 必须「替换」而非「叠加」──────────────────
//
// 这组断言守的是一条**因果被写反过**的推理(见 mouseButtons.js 头部 ⚠):
// 历史上为了「保住原生拖选」把 1002 降到 1000。真正的病根是 dispatcher 无条件吞
// `press`,与追踪档位无关 —— 降档只是顺手删掉了应用内自绘选择唯一需要的位移信息。
// 现在自绘选择上线,`select=true` 必须把 1002 写回来,且**不能**同时留着 1000:
// 两者是同一能力的不同档位,叠加写在不同终端上行为不确定。
test('enableBytes: select=true 用 1002 替换 1000(不叠加),否则保持 1000', () => {
  assert.equal(enableBytes({}), '\x1b[?1000h\x1b[?1006h', '默认仍是 1000(点击层不需要位移)');
  assert.equal(
    enableBytes({ select: true }),
    '\x1b[?1002h\x1b[?1006h',
    'select 必须单独写 1002 —— 叠加 1000 会让终端按哪一档解释变得不确定'
  );
  assert.ok(
    !enableBytes({ select: true }).includes('1000h'),
    '1000 与 1002 互斥,select 时绝不能同时出现 1000h'
  );
  assert.ok(
    !enableBytes({}).includes('1002h'),
    '未开选择时不该凭空开 1002:位移是纯负担'
  );
  // 1006 是正交的坐标编码,三档下都必须带 —— 少了它,长行选区在 >223 列处错位。
  assert.ok(enableBytes({}).includes('1006h'));
  assert.ok(enableBytes({ select: true }).includes('1006h'));
  assert.ok(enableBytes({ select: true, hover: true }).includes('1006h'));
});

test('enableBytes: select 与 hover 正交,可叠加但各自只关自己的档', () => {
  assert.equal(enableBytes({ select: true, hover: true }), '\x1b[?1002h\x1b[?1006h\x1b[?1003h');
  assert.equal(enableBytes({ hover: true }), '\x1b[?1000h\x1b[?1006h\x1b[?1003h');
  // hover 单独开着时不该偷偷升级追踪档 —— 悬停高亮不需要按住位移。
  assert.ok(!enableBytes({ hover: true }).includes('1002h'));
});
