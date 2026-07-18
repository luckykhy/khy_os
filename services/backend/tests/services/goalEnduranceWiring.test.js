'use strict';

// goalEnduranceWiring.test.js — 功能级接线:证 `khy goal endurance` 路由到底气自检报告,
// 且不误落到 `goal set`(node:test)。捕获 console.log 以断言渲染出报告头(仅 _handleEndurance 会产出)。
const { test } = require('node:test');
const assert = require('node:assert');

const { handleGoal } = require('../../src/cli/handlers/goal');
const { parseInput } = require('../../src/cli/router');

function _capture(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { const rc = fn(); return { rc, lines }; }
  finally { console.log = orig; }
}

test('goal endurance:返回 0 且渲染出「连续多日运行底气自检」报告头', () => {
  const { rc, lines } = _capture(() => handleGoal('endurance', [], {}));
  assert.equal(rc, 0);
  const joined = lines.join('\n');
  assert.ok(joined.includes('连续多日运行底气自检'), '应渲染底气自检报告头');
  assert.ok(joined.includes('确定性中断视界'), '应含中断视界行');
  assert.ok(joined.includes('export KHY_GOAL_IDLE_MS=0'), '应含一键 endurance 配置');
});

test('别名 stamina / endure 同样路由到自检(非 set)', () => {
  for (const verb of ['stamina', 'endure']) {
    const { rc, lines } = _capture(() => handleGoal(verb, [], {}));
    assert.equal(rc, 0);
    assert.ok(lines.join('\n').includes('连续多日运行底气自检'), `${verb} 应路由到自检`);
  }
});

test('help 用法串含 endurance', () => {
  const { rc, lines } = _capture(() => handleGoal('help', [], {}));
  assert.equal(rc, 0);
  assert.ok(lines.join('\n').includes('endurance'), 'help 应列出 endurance 子命令');
});

test('goal endurance --apply:经 injected writeEnvPatch 落盘 endurance patch,返回 0', () => {
  let captured = null;
  const deps = { writeEnvPatch: (patch) => { captured = patch; return '/home/u/.khy/.env'; } };
  const { rc, lines } = _capture(() => handleGoal('endurance', [], { apply: true }, deps));
  assert.equal(rc, 0);
  assert.ok(captured && typeof captured === 'object', 'writeEnvPatch 应被调用');
  assert.equal(captured.KHY_GOAL_IDLE_MS, '0', 'patch 应含关闭闲置退役');
  assert.equal(captured.KHY_TOKEN_BUDGET, '0', 'patch 应含取消硬 token 上限');
  const joined = lines.join('\n');
  assert.ok(joined.includes('落盘'), '应渲染落盘报告');
  assert.ok(joined.includes('/home/u/.khy/.env'), '应显示写入路径');
});

test('goal endurance 落盘(token 参数)同样触发写入', () => {
  let captured = null;
  const deps = { writeEnvPatch: (patch) => { captured = patch; return '/x/.env'; } };
  const { rc } = _capture(() => handleGoal('endurance', ['落盘'], {}, deps));
  assert.equal(rc, 0);
  assert.ok(captured && 'KHY_GOAL_IDLE_MS' in captured, '落盘 token 应触发写入');
});

test('goal endurance(无 --apply)只读:绝不调用 writeEnvPatch', () => {
  let called = false;
  const deps = { writeEnvPatch: () => { called = true; return '/x'; } };
  const { rc, lines } = _capture(() => handleGoal('endurance', [], {}, deps));
  assert.equal(rc, 0);
  assert.equal(called, false, '只读自检不得写盘');
  assert.ok(lines.join('\n').includes('连续多日运行底气自检'));
});

test('goal endurance --apply:写入器抛错 → 返回 1 且报错', () => {
  const deps = { writeEnvPatch: () => { throw new Error('EACCES'); } };
  const { rc, lines } = _capture(() => handleGoal('endurance', [], { apply: true }, deps));
  assert.equal(rc, 1);
  assert.ok(lines.join('\n').includes('落盘失败') || lines.join('\n').includes('EACCES'));
});

test('goal endurance(只读):同时渲染交互式会话维度 + 目标专属治理器', () => {
  const { rc, lines } = _capture(() => handleGoal('endurance', [], {}));
  assert.equal(rc, 0);
  const joined = lines.join('\n');
  assert.ok(joined.includes('交互式会话'), '应渲染交互会话底气段');
  assert.ok(joined.includes('仅设定 /goal 后适用'), '目标治理器段应标注适用条件');
  assert.ok(joined.includes('--apply --session'), '应给出分维度落盘提示');
});

test('goal endurance --apply --session:仅写会话三键,不写目标治理键', () => {
  let captured = null;
  const deps = { writeEnvPatch: (patch) => { captured = patch; return '/x/.env'; } };
  const { rc } = _capture(() => handleGoal('endurance', [], { apply: true, session: true }, deps));
  assert.equal(rc, 0);
  assert.ok(captured && 'KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS' in captured, '应写会话回复边界');
  assert.equal(captured.KHY_TOKEN_BUDGET, '0');
  assert.ok(!('KHY_GOAL_IDLE_MS' in captured), '仅会话维度不应写目标治理键');
});

test('goal endurance --apply --goal:仅写目标四键,不写会话回复边界', () => {
  let captured = null;
  const deps = { writeEnvPatch: (patch) => { captured = patch; return '/x/.env'; } };
  const { rc } = _capture(() => handleGoal('endurance', [], { apply: true, goal: true }, deps));
  assert.equal(rc, 0);
  assert.ok(captured && 'KHY_GOAL_IDLE_MS' in captured, '应写目标治理键');
  assert.ok(!('KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS' in captured), '仅目标维度不应写会话回复边界');
});

test('goal endurance --apply(默认 all):目标键 + 会话键都写', () => {
  let captured = null;
  const deps = { writeEnvPatch: (patch) => { captured = patch; return '/x/.env'; } };
  const { rc } = _capture(() => handleGoal('endurance', [], { apply: true }, deps));
  assert.equal(rc, 0);
  assert.ok('KHY_GOAL_IDLE_MS' in captured, '应写目标键');
  assert.ok('KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS' in captured, '应写会话键');
});

// ── 解析器层路由(闭合此前只测 handleGoal 直调、绕过 parseInput 的盲区)──
// 若 SUB_COMMANDS['goal'] 未含 endurance/stamina/endure,parseInput 会把动词当 freeform
// 目标文本落到 goal set,`khy goal endurance` 便永远到不了自检。这些测试守住那条线。

test('parseInput:goal endurance → subCommand=endurance(非 freeform set)', () => {
  const p = parseInput('goal endurance');
  assert.equal(p.command, 'goal');
  assert.equal(p.subCommand, 'endurance', 'endurance 必须被识别为子命令,否则会误落 goal set');
});

test('parseInput:别名 stamina / endure 同样识别为子命令', () => {
  assert.equal(parseInput('goal stamina').subCommand, 'stamina');
  assert.equal(parseInput('goal endure').subCommand, 'endure');
});

test('parseInput:goal endurance --apply --session → 子命令 + 选项透传', () => {
  const p = parseInput('goal endurance --apply --session');
  assert.equal(p.subCommand, 'endurance');
  assert.ok(p.options.apply, '--apply 应进 options');
  assert.ok(p.options.session, '--session 应进 options');
});
