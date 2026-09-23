'use strict';
// 验收探针:覆盖 [DESIGN-ARCH-119] §7.2 的反例矩阵 R1–R13。
// 只读、不改业务;判据与 mouseButtons.js 同源(直接调真实模块)。
//
// 用法:
//   node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 鼠标拖选修复验收-2026-09-17.js            # 跑矩阵
//   node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 鼠标拖选修复验收-2026-09-17.js --pre-fix  # 对照:修复前的期望值
const path = require('path');
const MB = require(path.resolve(__dirname, '..', '..', '..', 'services/backend/src/cli/tui/mouseButtons.js'));

const PRE_FIX = process.argv.includes('--pre-fix');
let pass = 0, fail = 0;
function check(id, name, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + name);
  if (!ok) {
    console.log('        实得=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected));
  }
  ok ? pass++ : fail++;
}
// onInput 返回值语义:true = 吞掉(本进程消费),false = 放行(不消费)
// 修复前:press/release 无条件 return true(全吞)→ 拖选起点被吃
// 修复后:滚轮与命中按钮仍吞;含修饰键 / 空白处按下松开 放行
const SWALLOW = true, RELEASE = false;

// 造一个「右下角有个按钮」的布局,让 (0,0) 是空白、(10,5) 是按钮。
// 通过 stub hitTest 依赖的 collectLayout 输出,走真实 onInput 路径。
function makeDispatcher(opts) {
  const d = MB.createMouseDispatcher(Object.assign({ hover: false, motionThrottleMs: 0 }, opts || {}));
  return d;
}
// rootNode 为 null 时 onInput 会在 ctx 检查处提前 return true —— 那会掩盖真实判定。
// 故提供一个最小可用的假 root:collectLayout 直接吃 yogaNode,这里给足接口。
function fakeRoot() {
  const yoga = {
    getComputedWidth: () => 80,
    getComputedHeight: () => 24,
    getDisplay: () => 0,
    getComputedLeft: () => 0,
    getComputedTop: () => 0,
  };
  return {
    yogaNode: yoga,
    style: {},
    childNodes: [
      // 按钮:位于 row=5, col=10,宽 4 高 1
      {
        yogaNode: {
          getComputedWidth: () => 4,
          getComputedHeight: () => 1,
          getDisplay: () => 0,
          getComputedLeft: () => 10,
          getComputedTop: () => 5,
        },
        style: { onClick: () => { global.__clicked = (global.__clicked || 0) + 1; } },
        childNodes: [],
      },
    ],
  };
}
const CTX = { rootNode: fakeRoot(), rows: 24, anchorBottom: false, cacheKey: 'k' };

console.log('=== 矩阵 R1–R11(修复' + (PRE_FIX ? '前' : '后') + ')===');
console.log('SGR 序栏: b = button 码(x=1,y=1 为空白;x=10,y=5 命中按钮)\n');

// R1/R2 空白处按下/松开 —— y=1 即 row=0,空白
check('R1', '空白处左键按下      不吞', makeDispatcher().onInput('[<0;1;1M', CTX), RELEASE);
check('R2', '空白处左键松开      不吞', makeDispatcher().onInput('[<0;1;1m', CTX), RELEASE);

// R3–R6 修饰键按下/松开 —— SGR button: Shift=4, Alt=8, Ctrl=16(叠加)
check('R3', 'Shift+左键按下      不吞', makeDispatcher().onInput('[<4;1;1M', CTX), RELEASE);
check('R4', 'Shift+左键松开      不吞', makeDispatcher().onInput('[<4;1;1m', CTX), RELEASE);
check('R5', 'Alt+左键按下        不吞', makeDispatcher().onInput('[<8;1;1M', CTX), RELEASE);
check('R6', 'Ctrl+左键按下       不吞', makeDispatcher().onInput('[<16;1;1M', CTX), RELEASE);

// R7/R8 滚轮必须仍被吞(§0.9.3 备屏不可交还) —— 64=上,68=Shift+上
let wheelFired = 0;
const dw = makeDispatcher({ onWheel: () => { wheelFired++; } });
check('R7', '滚轮上              仍吞', dw.onInput('[<64;1;1M', CTX), SWALLOW);
const dw2 = makeDispatcher({ onWheel: () => { wheelFired++; } });
check('R8', 'Shift+滚轮上        仍吞(走 onWheel)', dw2.onInput('[<68;1;1M', CTX), SWALLOW);
check('R8b', 'Shift+滚轮确实喂给了 onWheel(未被放行)', wheelFired, 2);

// R9 按钮上按下+松开 → 吞 + 触发 onClick
global.__clicked = 0;
const d9 = makeDispatcher();
const p9a = d9.onInput('[<0;11;6M', CTX);   // x=11→col10, y=6→row5 命中按钮
const p9b = d9.onInput('[<0;11;6m', CTX);
check('R9a', '按钮上按下          吞', p9a, SWALLOW);
check('R9b', '按钮上松开          吞', p9b, SWALLOW);
check('R9c', '按钮 onClick 被触发', global.__clicked, 1);

// R10 按钮上按下、拖出后松开 → 按下吞、松开不触发
global.__clicked = 0;
const d10 = makeDispatcher();
d10.onInput('[<0;11;6M', CTX);
const p10 = d10.onInput('[<0;1;1m', CTX);   // 松开在空白
check('R10a', '拖出按钮后松开      不吞', p10, RELEASE);
check('R10b', '拖出后 onClick 不触发', global.__clicked, 0);

// R11 hover 位移(full 档)
const d11 = makeDispatcher({ hover: true });
check('R11', 'hover 位移(1003)   吞', d11.onInput('[<35;10;10M', CTX), SWALLOW);

console.log('\n=== A3 判据 R12/R13:演示「只修一条不够」===');
console.log('（这两条不是期望通过,是防回归注释:证明三条必须都修）');
// R12 只修 A(空白处放行)不修 B → Shift 仍被吞 → 用户按 Shift 拖选照样失败
const simOnlyA = MB.parseSgrMouse('[<4;1;1M');
check('R12', '只修A:isShift 仍未暴露', typeof simOnlyA.isShift, 'boolean');
// R13 只修 B(Shift 放行)不修 A → 不按 Shift 拖选仍失败
check('R13', '只修B:空白处按下已放行', makeDispatcher().onInput('[<0;1;1M', CTX), RELEASE);

console.log('\nSummary: ' + fail + ' unexpected, ' + pass + ' as-expected.');
if (fail > 0) { process.exitCode = 1; }
