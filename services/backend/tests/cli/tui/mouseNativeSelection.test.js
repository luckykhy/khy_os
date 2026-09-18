'use strict';

// mouseNativeSelection — 原生拖选/修饰键放行的回归护栏。
//
// 背景(为什么这个文件必须存在):
//   用户报「khy TUI 里拖选复制选不中」。根因是三条**独立**的缺陷(见
//   `docs/03_DESIGN_设计/[DESIGN-ARCH-119] TUI原生文本选择与复制可用性修复.md`)：
//
//     A. dispatcher 对 `press` **无条件** `return true`。历史注释断言「1000 不报
//        位移,所以拖选不受影响」—— 混淆了 motion 与 press。1000 确实不报 motion,
//        但**按下那一下就是 press**,而它是终端原生拖选的**起点**。起点被吃进 stdin
//        后,终端只看到一团无主位移,原生选择无法启动。
//     B. `parseSgrMouse` 存了整颗 button 码却从不拆修饰位 → `[DESIGN-ARCH-102]`
//        §6.2 的「Shift + 任何鼠标操作永远走终端原生选择」在实现侧不存在。
//     C. `app.js` 的备屏 `||` 分支绕过「未知终端不接管」(那条在 app 层,不在本文件)。
//
//   **三条必须都修**:只修 A,按 Shift 拖选仍失败;只修 B,不按 Shift 拖选仍失败。
//   本文件的 R12/R13 就是这条纪律的机械保障(见文件末)。
//
//   契约(onInput 返回值):`true` = 本进程吞掉;`false` = 放行(不消费)。
//   ⚠ 诚实边界:ink 已把事件从 stdin 读走,`false` 物理上回不到终端。放行的价值是
//   「不去吞它」—— 终端自身对本机鼠标的最终解释(Shift 的原生选择、完整拖选手势)
//   不受我们干扰。
//
//   `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const { createMouseDispatcher, parseSgrMouse } = require('../../../src/cli/tui/mouseButtons');

// 假布局:视口 80x24,右下 (col=10,row=5) 有 4x1 的按钮。其余全是空白。
// 命中测试吃 yoga 接口,故这里把 yogaNode 的读法补全。
function makeCtx() {
  const btnYoga = {
    getComputedWidth: () => 4,
    getComputedHeight: () => 1,
    getDisplay: () => 0,
    getComputedLeft: () => 10,
    getComputedTop: () => 5,
  };
  const rootYoga = {
    getComputedWidth: () => 80,
    getComputedHeight: () => 24,
    getDisplay: () => 0,
    getComputedLeft: () => 0,
    getComputedTop: () => 0,
  };
  let clicks = 0;
  const rootNode = {
    yogaNode: rootYoga,
    style: {},
    childNodes: [
      {
        yogaNode: btnYoga,
        style: { onClick: () => { clicks++; } },
        childNodes: [],
      },
    ],
  };
  return {
    ctx: { rootNode, rows: 24, anchorBottom: false, cacheKey: 'k' },
    clicks: () => clicks,
  };
}

// SGR 坐标 1-based:x=1 → col=0,y=1 → row=0(空白);x=11 → col=10,y=6 → row=5(按钮)
const BLANK_PRESS = '[<0;1;1M';
const BLANK_RELEASE = '[<0;1;1m';
const BTN_PRESS = '[<0;11;6M';
const BTN_RELEASE = '[<0;11;6m';

// ── R1–R2:空白处按下/松开 → 放行(终端需要完整手势)────────────────────────────
test('R1/R2 空白处左键按下与松开都必须放行(拖选起点的命门)', () => {
  const { ctx } = makeCtx();
  const d = createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
  assert.equal(d.onInput(BLANK_PRESS, ctx), false, '按下被吞 → 终端永远等不到拖选起点');
  assert.equal(d.onInput(BLANK_RELEASE, ctx), false, '松开被吞 → 手势缺终点');
});

// ── R3–R6:修饰键 → 放行(§6.2 硬承诺)──────────────────────────────────────────
test('R3/R4 Shift+左键按下与松开必须放行(§6.2「永远走终端原生选择」)', () => {
  const { ctx } = makeCtx();
  const d = createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
  assert.equal(d.onInput('[<4;1;1M', ctx), false, 'shift(4)+按下');
  assert.equal(d.onInput('[<4;1;1m', ctx), false, 'shift(4)+松开');
});

test('R5/R6 Alt / Ctrl + 左键同样放行(修饰键统一是「绕过本程序」)', () => {
  const { ctx } = makeCtx();
  assert.equal(createMouseDispatcher({ motionThrottleMs: 0 }).onInput('[<8;1;1M', ctx), false, 'meta(8)');
  assert.equal(createMouseDispatcher({ motionThrottleMs: 0 }).onInput('[<16;1;1M', ctx), false, 'ctrl(16)');
});

// ── R7/R8:滚轮必须**仍被吞**(§0.9.3 备屏不可交还)────────────────────────────
test('R7/R8 滚轮与 Shift+滚轮都必须仍被吞 —— 且走 onWheel,不被修饰键放行误伤', () => {
  const { ctx } = makeCtx();
  const seen = [];
  const d = createMouseDispatcher({ motionThrottleMs: 0, onWheel: (dir) => seen.push(dir) });
  assert.equal(d.onInput('[<64;1;1M', ctx), true, '滚轮上:备屏下必须接管,否则被合成 ↑');
  assert.equal(d.onInput('[<68;1;1M', ctx), true, 'Shift+滚轮上:终端语义是横向滚动,不是「要拖选」');
  assert.deepEqual(seen, ['up', 'up'], 'Shift+滚轮也必须喂给 onWheel,不能被修饰键放行抢走');
});

// ── R9:命中按钮 → 吞 + 触发(click 档存在的唯一理由)────────────────────────
test('R9 按钮上按下+松开仍被吞且触发 onClick(收窄不能收窄到闸门失效)', () => {
  const { ctx, clicks } = makeCtx();
  const d = createMouseDispatcher({ motionThrottleMs: 0 });
  assert.equal(d.onInput(BTN_PRESS, ctx), true, '起点在按钮上 → arm');
  assert.equal(d.onInput(BTN_RELEASE, ctx), true, '终点也在按钮上 → 触发');
  assert.equal(clicks(), 1, 'onClick 必须被触发,否则麦克风/图片 × 点不动了');
});

// ── R10:从按钮上按下、拖出后松开 → 按**命中**决定吞不吞,不按 armed ──────────
test('R10 从按钮上按下、拖到空白处松开:松开点必须放行且不触发点击', () => {
  const { ctx, clicks } = makeCtx();
  const d = createMouseDispatcher({ motionThrottleMs: 0 });
  d.onInput(BTN_PRESS, ctx);                                  // 起点在按钮上
  assert.equal(d.onInput(BLANK_RELEASE, ctx), false, '拖出去 = 用户放弃点击、想要原生拖选');
  assert.equal(clicks(), 0, '拖出按钮 → 取消点击(opencode 同语义)');
});

// ── R11:hover 位移仍被吞(full 档的高亮状态机)──────────────────────────────
test('R11 hover 档的位移事件仍被吞(高亮状态机不受本次收窄影响)', () => {
  const { ctx } = makeCtx();
  const d = createMouseDispatcher({ hover: true, motionThrottleMs: 0 });
  assert.equal(d.onInput('[<35;10;10M', ctx), true, '35 = motion(32)+左键(3… 实为 32|button)');
});

// ── 解析层:修饰位必须被暴露(缺陷 B 的机械保障)────────────────────────────
test('parseSgrMouse 必须拆出 isShift/isAlt/isCtrl(否则 §6.2 无从实现)', () => {
  assert.equal(parseSgrMouse('[<0;1;1M').isShift, false, '无修饰');
  assert.equal(parseSgrMouse('[<4;1;1M').isShift, true, 'shift(4)');
  assert.equal(parseSgrMouse('[<4;1;1M').isAlt, false);
  assert.equal(parseSgrMouse('[<8;1;1M').isAlt, true, 'meta(8)');
  assert.equal(parseSgrMouse('[<16;1;1M').isCtrl, true, 'ctrl(16)');
  // 组合位:shift(4)+meta(8) = 12
  const both = parseSgrMouse('[<12;1;1M');
  assert.equal(both.isShift, true, '组合位 & 4');
  assert.equal(both.isAlt, true, '组合位 & 8');
  // 滚轮 + shift = 68 —— 修饰位与 isWheel 必须**同时**成立(放行判据要排除 isWheel)
  const sw = parseSgrMouse('[<68;1;1M');
  assert.equal(sw.isWheel, true);
  assert.equal(sw.isShift, true, '两个标志并存 → 调用方负责优先判 isWheel');
  // button 码本身不得被改动(向后兼容)
  assert.equal(parseSgrMouse('[<68;1;1M').button, 68);
});

// ── A3 判据 R12/R13:证明「只修一条不够」──────────────────────────────────────
// 这两条不是功能性断言,是**防回归的纪律注释**。若有人日后「简化」掉修饰位检查或
// press 的放行,必须先想清楚:历史 bug 正是「以为修一条就够」造成的。
test('R12/R13 只修 A 或只修 B 都不够 —— 三条缺陷相互独立', () => {
  const { ctx } = makeCtx();
  // R12:只修 A(空白处放行)、不修 B(修饰位不暴露) → Shift 拖选仍失败。
  // 判据:修饰位字段存在 ⇒ B 已修。若把它删掉,这条会红。
  assert.equal(
    typeof parseSgrMouse('[<4;1;1M').isShift,
    'boolean',
    'B 未修 → Shift+拖选无放行依据 → 用户按 Shift 仍选不中'
  );
  // R13:只修 B(Shift 放行)、不修 A(空白处仍吞) → 不按 Shift 拖选仍失败。
  assert.equal(
    createMouseDispatcher({ motionThrottleMs: 0 }).onInput(BLANK_PRESS, ctx),
    false,
    'A 未修 → 默认拖选的起点被吞 → 用户不按 Shift 照样选不中'
  );
});
