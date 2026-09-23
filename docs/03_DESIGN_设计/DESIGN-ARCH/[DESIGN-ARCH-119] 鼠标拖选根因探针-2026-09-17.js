'use strict';
// 探针:验证「Shift+拖选 / 空白处拖选」在现状下是否被吞,以及收窄判据后是否放行。
// 只读、不改业务;判据与 mouseButtons.js 同源(直接调真实模块)。
const path = require('path');
const MB = require(path.resolve(__dirname, '..', '..', '..', 'services/backend/src/cli/tui/mouseButtons.js'));

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '\n        实得=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected));
  ok ? pass++ : fail++;
}

console.log('=== A. 现状:事件是否被 dispatcher 吞掉 ===');
const ctx = { rootNode: null, rows: 24, anchorBottom: false };

const d0 = MB.createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
check('空白处左键按下被吞(现状=bug)', d0.onInput('[<0;1;1M', ctx), true);

const d1 = MB.createMouseDispatcher({ hover: false, motionThrottleMs: 0 });
check('Shift+左键按下被吞(现状=违约 §6.2)', d1.onInput('[<4;1;1M', ctx), true);

const d2 = MB.createMouseDispatcher({ hover: false, motionThrottleMs: 0, onWheel: function () {} });
check('滚轮事件被吞(预期:备屏下必须接管)', d2.onInput('[<64;1;1M', ctx), true);

console.log('\n=== B. 解析层缺失的能力 ===');
const evShift = MB.parseSgrMouse('[<4;1;1M');
check('parseSgrMouse 暴露 isShift 字段', typeof evShift.isShift, 'undefined');
check('parseSgrMouse 暴露 isAlt 字段', typeof evShift.isAlt, 'undefined');
check('parseSgrMouse 暴露 isCtrl 字段', typeof evShift.isCtrl, 'undefined');

console.log('\n=== C. 门控默认值现状 ===');
check('mouseTier({}) 文档声称 click', MB.mouseTier({}), 'click');
check('mouseButtonsEnabled({}) 无终端标识时不接管', MB.mouseButtonsEnabled({}, 'win32'), false);
check('mouseExplicitlyDisabled({}) 默认未显式关', MB.mouseExplicitlyDisabled({}), false);
const wantMouse = MB.mouseButtonsEnabled({}, 'win32') || (true && !MB.mouseExplicitlyDisabled({}));
check('默认(备屏开)= 强制接管鼠标 -> 用户失去原生拖选', wantMouse, true);

console.log('\nSummary: ' + fail + ' unexpected, ' + pass + ' as-expected.');
