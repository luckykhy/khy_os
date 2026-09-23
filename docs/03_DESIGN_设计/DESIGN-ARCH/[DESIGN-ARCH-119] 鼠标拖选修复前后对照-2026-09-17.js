'use strict';
// 修复前后对照表:同一输入、同一真实假布局,读两次判定。
// 修复前 = 用 git 里的原始版本;修复后 = 当前工作区版本。
// 用法: node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 鼠标拖选修复前后对照-2026-09-17.js
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TARGET = 'services/backend/src/cli/tui/mouseButtons.js';

// 从 git HEAD 取「修复前」的版本,落到临时文件(只读,不改仓库)
const tmp = path.join(os.tmpdir(), 'khy-mouse-pre-fix.js');
let preFixOk = true;
try {
  const src = execSync('git show HEAD:' + TARGET, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24 });
  fs.writeFileSync(tmp, src, 'utf8');
} catch (e) {
  preFixOk = false;
  console.log('!! 无法从 git HEAD 取修复前版本:' + e.message);
}

const AFTER = require(path.join(REPO, TARGET));
const BEFORE = preFixOk ? require(tmp) : null;

function makeRoot() {
  const rootYoga = {
    getComputedWidth: () => 80, getComputedHeight: () => 24, getDisplay: () => 0,
    getComputedLeft: () => 0, getComputedTop: () => 0,
  };
  const btnYoga = {
    getComputedWidth: () => 4, getComputedHeight: () => 1, getDisplay: () => 0,
    getComputedLeft: () => 10, getComputedTop: () => 5,
  };
  return {
    yogaNode: rootYoga, style: {}, childNodes: [
      { yogaNode: btnYoga, style: { onClick: () => {} }, childNodes: [] },
    ],
  };
}
const CTX = { rootNode: makeRoot(), rows: 24, anchorBottom: false, cacheKey: 'k' };

const CASES = [
  ['[<0;1;1M', '空白处左键按下'],
  ['[<0;1;1m', '空白处左键松开'],
  ['[<4;1;1M', 'Shift+左键按下'],
  ['[<4;1;1m', 'Shift+左键松开'],
  ['[<8;1;1M', 'Alt+左键按下'],
  ['[<16;1;1M', 'Ctrl+左键按下'],
  ['[<64;1;1M', '滚轮上'],
  ['[<68;1;1M', 'Shift+滚轮上'],
  ['[<0;11;6M', '按钮上按下'],
  ['[<0;11;6m', '按钮上松开'],
  ['[<0;11;6M', '按钮上按下→空白处松开(R10)', '[<0;1;1m'],
];

function run(mod, seq, seq2) {
  const d = mod.createMouseDispatcher({ motionThrottleMs: 0, onWheel: () => {} });
  const a = d.onInput(seq, CTX);
  return seq2 ? d.onInput(seq2, CTX) : a;
}
const fmt = (v) => (v === true ? '  吞  ' : v === false ? ' 放行 ' : String(v));

console.log('onInput 返回值: 吞 = 本进程消费; 放行 = 不消费(终端可自行解释)\n');
console.log('输入序列                    | 修复前 | 修复后 | 场景');
console.log('----------------------------|--------|--------|------------------------------');
for (const [seq, name, seq2] of CASES) {
  const b = BEFORE ? run(BEFORE, seq, seq2) : '?';
  const a = run(AFTER, seq, seq2);
  const label = name + (seq2 ? ' → 判定落在' + seq2 : '');
  console.log(seq.padEnd(27) + ' | ' + fmt(b) + ' | ' + fmt(a) + ' | ' + label);
}
console.log('\n关键三行:空白处按下 / Shift+按下 从「吞」变「放行」 => 原生拖选起点不再被吃。');
console.log('滚轮与按钮两行保持「吞」 => §0.9.3 与 click 档零回退。');
