'use strict';
// 端到端接线验证:不启真 TUI(需要交互终端),而是按 App.js 的**真实调用链**
// 逐段复现,确认修复后的判定经 ink 的 input 路径后,吞/放行的结论一致。
//
// 复现的链路(App.js:4176-4214):
//   ink useInput(input, key)
//     → _mouse.isMouseSequence(input)    守卫
//     → mouseDispatcherRef.current.onInput(input, {rootNode, rows, anchorBottom, cacheKey})
//   ink 的输入来自 stdin,序列已被 ink 剥掉前导 ESC → '[<0;1;1M'
//
// 关键验证点:isMouseSequence 守卫不得把我们要放行的序列误判成非鼠标事件
//            (否则它会掉进文本编辑路径,变成往输入框里打字)。
const path = require('path');
const MB = require(path.resolve(__dirname, '..', '..', '..', 'services/backend/src/cli/tui/mouseButtons.js'));

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  实得=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected)));
  ok ? pass++ : fail++;
};

// 假布局(同测试文件)
function makeRoot() {
  const rootYoga = { getComputedWidth: () => 80, getComputedHeight: () => 24, getDisplay: () => 0, getComputedLeft: () => 0, getComputedTop: () => 0 };
  const btnYoga = { getComputedWidth: () => 4, getComputedHeight: () => 1, getDisplay: () => 0, getComputedLeft: () => 10, getComputedTop: () => 5 };
  return { yogaNode: rootYoga, style: {}, childNodes: [{ yogaNode: btnYoga, style: { onClick: () => {} }, childNodes: [] }] };
}
const CTX = { rootNode: makeRoot(), rows: 24, anchorBottom: false, cacheKey: 'k' };

// 模拟 App.js 的 useInput 第一段(守卫 + 分派)
function appUseInput(input) {
  if (MB.isMouseSequence(input)) {
    const d = MB.createMouseDispatcher({ motionThrottleMs: 0, onWheel: () => {} });
    return { handled: true, swallowed: d.onInput(input, CTX) };
  }
  return { handled: false, swallowed: null };
}

console.log('=== 守卫:修饰键序列必须被认成鼠标事件(否则会掉进文本编辑)===');
for (const seq of ['[<0;1;1M', '[<4;1;1M', '[<8;1;1M', '[<16;1;1M', '[<64;1;1M', '[<68;1;1M']) {
  check(seq + ' 被 isMouseSequence 认出', MB.isMouseSequence(seq), true);
}

console.log('\n=== 端到端:经 App.js 同款调用链后的结论 ===');
const cases = [
  ['[<0;1;1M', '空白处按下 → 放行', false],
  ['[<0;1;1m', '空白处松开 → 放行', false],
  ['[<4;1;1M', 'Shift+按下 → 放行', false],
  ['[<4;1;1m', 'Shift+松开 → 放行', false],
  ['[<64;1;1M', '滚轮 → 吞', true],
  ['[<68;1;1M', 'Shift+滚轮 → 吞', true],
  ['[<0;11;6M', '按钮按下 → 吞', true],
];
for (const [seq, name, expected] of cases) {
  const r = appUseInput(seq);
  check(name, r.swallowed, expected);
}

console.log('\n=== 非鼠标输入不得被误伤(普通按键仍走文本路径)===');
check("'a' 不是鼠标序列", MB.isMouseSequence('a'), false);
check("'[<abc' 残缺序列不是鼠标序列", MB.isMouseSequence('[<abc'), false);
check("'' 空串不是鼠标序列", MB.isMouseSequence(''), false);
check('undefined 不炸', MB.isMouseSequence(undefined), false);

console.log('\nSummary: ' + fail + ' unexpected, ' + pass + ' as-expected.');
if (fail > 0) process.exitCode = 1;
