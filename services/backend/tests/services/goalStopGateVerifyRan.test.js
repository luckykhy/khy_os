'use strict';

/**
 * goalStopGateVerifyRan.test.js — Stop-gate「verify-ran 门」纯叶子契约 + 接线(node:test)。
 *
 * 诉求(goal 2026-07-11「khy 做完任务不会及时验证测试」):证据门只看回复里**有没有证据形状的
 * 文字**——贴一段 ``` 代码块或字面写个 `npm test` 就能过关,哪怕本轮从未真正调用过 shell。本门补
 * 上「行为证据」:回复声称验证通过、却在整轮工具执行记录(toolCallLog)里找不到任何真跑过的验证
 * 命令时,把 clear 降级为 redrive。
 *
 * 覆盖:verificationCommandRan(shell/命令/边界)、isVerifyRanGateEnabled(默认开 + 三级父门控)、
 * evaluateGoalStop 新分支(命中 redrive / 真跑过则 clear / 无 log 或门关字节回退 / 预算耗尽 /
 * 与 evidence 门的先后关系 / 贴假证据文字仍被拦)、以及 toolUseLoopCore 接线传入 toolCallLog。
 * 零 IO、确定性——每个断言显式传 env。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const gate = require('../../src/services/goalStopGate');

const GOAL = { text: '让 khy 学会做完任务及时验证测试' };
// shell 记录构造器:模拟 runToolUseLoop 的 toolCallLog 条目形态 { iteration, tool, params, result }。
const shell = (command) => ({ iteration: 1, tool: 'bash', params: { command }, result: 'ok', elapsed: 1 });

// ── verificationCommandRan ─────────────────────────────────────────────
test('verificationCommandRan:非数组 / 空数组 → false(无从证明跑过)', () => {
  assert.equal(gate.verificationCommandRan(undefined), false);
  assert.equal(gate.verificationCommandRan(null), false);
  assert.equal(gate.verificationCommandRan('npm test'), false);
  assert.equal(gate.verificationCommandRan([]), false);
});

test('verificationCommandRan:shell 工具跑过测试/检查/构建 → true', () => {
  assert.equal(gate.verificationCommandRan([shell('npm test')]), true);
  assert.equal(gate.verificationCommandRan([shell('npm run test:maintainer:all')]), true);
  assert.equal(gate.verificationCommandRan([shell('node --test tests/x.test.js')]), true);
  assert.equal(gate.verificationCommandRan([shell('node --check src/a.js')]), true);
  assert.equal(gate.verificationCommandRan([shell('npm run arch:god')]), true);
  assert.equal(gate.verificationCommandRan([shell('npm run maintainer:check')]), true);
  assert.equal(gate.verificationCommandRan([shell('pytest -q')]), true);
  assert.equal(gate.verificationCommandRan([shell('cargo test')]), true);
  assert.equal(gate.verificationCommandRan([shell('eslint .')]), true);
});

test('verificationCommandRan:params.cmd 兼容;命令混在多条记录里也能命中', () => {
  assert.equal(gate.verificationCommandRan([{ tool: 'shell_command', params: { cmd: 'node --test a.js' } }]), true);
  assert.equal(gate.verificationCommandRan([shell('ls -la'), shell('cat x'), shell('npm test')]), true);
});

test('verificationCommandRan:非验证命令 / 非 shell 工具 / 偶然含关键字 → false(保守宁缺勿滥)', () => {
  assert.equal(gate.verificationCommandRan([shell('ls -la'), shell('git status')]), false);
  // read_file 不是 shell 工具,即便路径含 test 也不算「跑过验证」
  assert.equal(gate.verificationCommandRan([{ tool: 'read_file', params: { path: 'a.test.js' } }]), false);
  // 偶然含 npm 但非 `npm <space> test`(要求命令与关键字间有空白)
  assert.equal(gate.verificationCommandRan([shell('cat npm-test.log')]), false);
});

test('verificationCommandRan:坏记录(null / 无 params)跳过,绝不抛', () => {
  assert.doesNotThrow(() => gate.verificationCommandRan([null, 42, {}, { tool: 'bash' }, shell('npm test')]));
  assert.equal(gate.verificationCommandRan([null, {}, { tool: 'bash' }, shell('npm test')]), true);
});

// ── isVerifyRanGateEnabled ─────────────────────────────────────────────
test('isVerifyRanGateEnabled:默认开;显式 falsy 关;三级父门控关则本门也关', () => {
  assert.equal(gate.isVerifyRanGateEnabled({}), true);
  assert.equal(gate.isVerifyRanGateEnabled({ KHY_GOAL_VERIFY_RAN_GATE: '0' }), false);
  assert.equal(gate.isVerifyRanGateEnabled({ KHY_GOAL_VERIFY_RAN_GATE: 'off' }), false);
  assert.equal(gate.isVerifyRanGateEnabled({ KHY_GOAL_STOP_GATE: '0' }), false); // 父
  assert.equal(gate.isVerifyRanGateEnabled({ KHY_GOAL: '0' }), false);           // 祖父
});

// ── evaluateGoalStop 新分支 ────────────────────────────────────────────
test('evaluateGoalStop:声称验证 + 有证据文字但没真跑命令 → redrive(verify-not-run)', () => {
  // 有证据形状文字 → 越过 evidence 门;但整轮没真跑过验证命令 → verify-ran 门命中。
  const reply = '目标已完成,全部测试通过:\n```\n所有用例 OK\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL, reply, redriveCount: 0, env: {}, toolCallLog: [shell('ls -la')] });
  assert.equal(v.action, 'redrive');
  assert.equal(v.reason, 'verify-not-run');
  assert.match(v.message, /从未实际执行过任何验证命令/);
});

test('evaluateGoalStop:关键洞——贴了「假证据文字」但没真跑命令,仍被 verify-ran 门拦下', () => {
  // evidence 门看到 ``` 代码块会放行;verify-ran 门核对真实执行 → 命中 redrive。
  const reply = '目标已完成,测试全部通过:\n```\n12 passed\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL, reply, redriveCount: 0, env: {}, toolCallLog: [shell('echo hi')] });
  assert.equal(v.action, 'redrive');
  assert.equal(v.reason, 'verify-not-run');
});

test('evaluateGoalStop:声称验证 + 本轮真跑过验证命令 → clear(satisfied)', () => {
  const reply = '目标已完成,测试全部通过:\n```\n12 passed\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL, reply, redriveCount: 0, env: {}, toolCallLog: [shell('npm test')] });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:不传 toolCallLog(旧调用方)→ verify-ran 门跳过,逐字节回退', () => {
  const reply = '目标已完成,测试全部通过:\n```\n12 passed\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL, reply, redriveCount: 0, env: {} });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:门关(KHY_GOAL_VERIFY_RAN_GATE=0)→ 有 log 也字节回退,证据齐即 clear', () => {
  const reply = '目标已完成,测试全部通过:\n```\n12 passed\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL, reply, redriveCount: 0, env: { KHY_GOAL_VERIFY_RAN_GATE: '0' }, toolCallLog: [shell('echo hi')] });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:未声称验证的纯「目标完成」→ verify-ran 门不适用(不过度拦截)', () => {
  // 回复只说达成、不声称验证 → 不应因「没跑测试」被拦(避免误伤无需 shell 验证的任务)。
  const v = gate.evaluateGoalStop({ goal: GOAL, reply: '目标已完成。', redriveCount: 0, env: {}, toolCallLog: [] });
  assert.equal(v.action, 'clear');
  assert.equal(v.reason, 'satisfied');
});

test('evaluateGoalStop:verify-ran 预算耗尽 → pass(不自动清除未经验证的目标)', () => {
  const reply = '目标已完成,全部测试通过:\n```\n12 passed\n```';
  const v = gate.evaluateGoalStop({ goal: GOAL, reply, redriveCount: 1, env: {}, toolCallLog: [shell('echo hi')] });
  assert.equal(v.action, 'pass');
  assert.equal(v.reason, 'verify-not-run-exhausted');
});

test('evaluateGoalStop:声称验证但无证据文字且没跑命令 → evidence 门先命中(既有行为保持)', () => {
  // 既有 evidence 门(声称验证却无任何证据文字)优先级在前 → reason=evidence-missing,不被本门改写。
  const reply = '目标已完成,全部测试通过。';
  const v = gate.evaluateGoalStop({ goal: GOAL, reply, redriveCount: 0, env: {}, toolCallLog: undefined });
  assert.equal(v.action, 'redrive');
  assert.equal(v.reason, 'evidence-missing');
});

// ── 接线:toolUseLoopCore 把 toolCallLog 传进 evaluateGoalStop ──────────
test('wiring:toolUseLoopCore 的 evaluateGoalStop 调用传入 toolCallLog', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/toolUseLoopCore.js'), 'utf8');
  const idx = src.indexOf('_goalStopGate.evaluateGoalStop({');
  assert.ok(idx >= 0, '应存在 evaluateGoalStop 调用');
  const block = src.slice(idx, idx + 400);
  assert.match(block, /toolCallLog,/, 'evaluateGoalStop 调用块应传入 toolCallLog');
});

test('wiring:flagRegistry 注册 KHY_GOAL_VERIFY_RAN_GATE(default-on,父 KHY_GOAL_STOP_GATE)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/services/flagRegistry.js'), 'utf8');
  assert.match(src, /KHY_GOAL_VERIFY_RAN_GATE:\s*\{[^}]*default:\s*true[^}]*parent:\s*'KHY_GOAL_STOP_GATE'/);
});
