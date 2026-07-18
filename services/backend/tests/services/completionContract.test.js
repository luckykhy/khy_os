'use strict';

/**
 * completionContract.test.js — 完成标准契约纯叶子(node:test)。
 *
 * 覆盖:从「完成标准/验收/definition of done」段 + 反引号命令解析 criteria、证据逐条比对、
 * 各 criterion 形态(command/test/check/freeform)、绝不抛、契约缺失时空 criteria、wiring grep。
 * 零 IO、确定性。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseCompletionContract,
  matchEvidenceAgainstContract,
  buildContractRedriveMessage,
  _deriveEvidencePattern,
  _looksLikeCommand,
} = require('../../src/services/completionContract');

const BACKEND_ROOT = path.resolve(__dirname, '../..');

test('无声明标准的目标 → 空 criteria(行为不变)', () => {
  const c = parseCompletionContract('让 khy 学会使用 goal 模式');
  assert.equal(c.hasContract, false);
  assert.equal(c.criteria.length, 0);
  assert.deepEqual(parseCompletionContract('').criteria, []);
  assert.deepEqual(parseCompletionContract(null).criteria, []);
});

test('反引号命令(任意位置)→ 可验证标准(非 freeform)', () => {
  // `make deploy` 是纯命令 → command;`npm test` 含测试信号 → test(分类以证据信号优先)。
  const c = parseCompletionContract('完成后请跑 `make deploy` 和 `npm test`。');
  assert.ok(c.hasContract);
  assert.equal(c.criteria.length, 2);
  assert.ok(c.criteria.every((x) => x.kind !== 'freeform'), '反引号命令都参与门控');
  assert.ok(c.criteria.some((x) => x.kind === 'command'), 'make deploy → command');
  assert.ok(c.criteria.some((x) => x.kind === 'test'), 'npm test → test');
  assert.ok(c.criteria.some((x) => /make deploy/.test(x.text)));
});

test('反引号里的散文不当命令', () => {
  const c = parseCompletionContract('这个 `功能` 很重要。'); // 单词、无命令信号
  assert.equal(c.criteria.length, 0);
});

test('「完成标准」段的条目被解析(反引号在条目内不重复计数)', () => {
  const goal = [
    '实现 X 功能。',
    '',
    '## 完成标准',
    '- 所有单测全绿',
    '- arch:god 无新增超限',
    '- `npm run maintainer:check` 通过',
    '',
    '其它说明……',
  ].join('\n');
  const c = parseCompletionContract(goal);
  assert.ok(c.hasContract);
  // 三条目;第三条的反引号命令已被同名条目包含 → 不额外产生第 4 条(包含式去重)。
  assert.equal(c.criteria.length, 3);
  const kinds = c.criteria.map((x) => x.kind);
  assert.ok(kinds.includes('test'), 'test 类(单测全绿)');
  assert.ok(kinds.includes('check'), 'check 类(arch:god / maintainer)');
  assert.ok(c.criteria.every((x) => x.kind !== 'freeform'), '均为可验证标准');
  assert.ok(c.criteria.some((x) => /maintainer:check/.test(x.text)), '反引号内容并入条目文本');
});

test('definition of done 英文标题 + 数字条目', () => {
  const goal = 'Task.\n\nDefinition of Done:\n1. all tests pass\n2. lint clean\n';
  const c = parseCompletionContract(goal);
  assert.ok(c.hasContract);
  assert.equal(c.criteria.length, 2);
});

test('段首散文行(无可验证信号)被忽略,不误当标准', () => {
  const goal = '验收标准\n这是一段普通说明文字没有任何可验证内容\n';
  const c = parseCompletionContract(goal);
  assert.equal(c.criteria.length, 0, '纯散文段首行不算标准');
});

test('matchEvidenceAgainstContract:证据齐全 → allMet', () => {
  const c = parseCompletionContract('## 完成标准\n- 单测全绿\n- arch:god 无超限\n');
  const reply = '已完成:\n```\n12 passed\n```\narch:god 检查通过,无超限。';
  const m = matchEvidenceAgainstContract(reply, c);
  assert.equal(m.total, 2);
  assert.equal(m.allMet, true);
  assert.equal(m.missing.length, 0);
  assert.equal(m.ratio, 1);
});

test('matchEvidenceAgainstContract:缺一条 → missing 指名', () => {
  const c = parseCompletionContract('## 完成标准\n- 单测全绿\n- arch:god 无超限\n');
  const reply = '已完成:\n```\n12 passed\n```\n(忘了跑 arch)';
  const m = matchEvidenceAgainstContract(reply, c);
  assert.equal(m.allMet, false);
  assert.equal(m.missing.length, 1);
  assert.ok(/arch:god/.test(m.missing[0].text));
});

test('matchEvidenceAgainstContract:命令标准需命令出现在证据里', () => {
  const c = parseCompletionContract('完成后跑 `npm run maintainer:check`。');
  assert.equal(matchEvidenceAgainstContract('目标已完成。', c).allMet, false);
  assert.equal(
    matchEvidenceAgainstContract('已跑 `npm run maintainer:check` → rc=0', c).allMet,
    true,
  );
});

test('_deriveEvidencePattern:各形态分类正确', () => {
  assert.equal(_deriveEvidencePattern('make deploy').kind, 'command'); // 纯命令(无测试/检查信号)
  assert.equal(_deriveEvidencePattern('npm test').kind, 'test');       // 含测试信号 → test 优先
  assert.equal(_deriveEvidencePattern('所有测试全绿').kind, 'test');
  assert.equal(_deriveEvidencePattern('lint 无告警').kind, 'check');
  assert.equal(_deriveEvidencePattern('用户体验流畅顺滑').kind, 'freeform');
});

test('_looksLikeCommand:命令 vs 散文', () => {
  assert.equal(_looksLikeCommand('npm run test'), true);
  assert.equal(_looksLikeCommand('arch:god'), true);
  assert.equal(_looksLikeCommand('node --check foo.js'), true);
  assert.equal(_looksLikeCommand('功能'), false);
  assert.equal(_looksLikeCommand('这是一句话'), false);
});

test('freeform 标准:信息性、永不阻塞收尾(仅可验证类参与门控)', () => {
  const c = parseCompletionContract('验收标准\n- 支持深色模式切换\n');
  // freeform 标准被解析但不参与门控 → 无论回复是否相关都视为满足
  assert.equal(matchEvidenceAgainstContract('随便什么回复', c).allMet, true);
});

test('绝不抛:坏输入 / 非数组 criteria / 坏 pattern', () => {
  assert.doesNotThrow(() => parseCompletionContract(undefined));
  assert.doesNotThrow(() => parseCompletionContract(42));
  assert.doesNotThrow(() => matchEvidenceAgainstContract(null, null));
  assert.doesNotThrow(() => matchEvidenceAgainstContract('x', { criteria: 'nope' }));
  const m = matchEvidenceAgainstContract('x', { criteria: [{ text: 'y', pattern: null }] });
  assert.equal(m.allMet, true, 'null pattern 视为满足,不过度拦截');
});

test('确定性:同输入 → 同输出', () => {
  const goal = '## 完成标准\n- 单测全绿\n- `npm test`\n';
  const a = parseCompletionContract(goal);
  const b = parseCompletionContract(goal);
  assert.deepEqual(a.criteria.map((x) => [x.kind, x.text]), b.criteria.map((x) => [x.kind, x.text]));
});

test('buildContractRedriveMessage:含目标、缺失清单、GoalTool(clear)、用户请求截断', () => {
  const goal = { text: '实现 X' };
  const missing = [{ text: 'arch:god 无超限' }, { text: '单测全绿' }];
  const msg = buildContractRedriveMessage(goal, missing, { userMessage: '做 X' });
  assert.ok(msg.includes('实现 X'));
  assert.ok(msg.includes('arch:god 无超限'));
  assert.ok(msg.includes('单测全绿'));
  assert.ok(msg.includes('GoalTool(action=clear)'));
  assert.ok(msg.includes('completion contract'));
  assert.ok(msg.includes('用户原始请求:'));
  assert.ok(!buildContractRedriveMessage(goal, missing, {}).includes('用户原始请求:'));
});

// ── wiring grep ─────────────────────────────────────────────────────────
test('wiring:goalStopGate 引用契约叶子 + 门 + 已注册', () => {
  const gate = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/goalStopGate.js'), 'utf8');
  assert.ok(gate.includes("require('./completionContract')"), 'require 叶子');
  assert.ok(gate.includes('isCompletionContractEnabled'), '门控 helper');
  assert.ok(gate.includes('contract-unmet'), '接线裁决');
  assert.ok(gate.includes('KHY_GOAL_COMPLETION_CONTRACT'), '门名');

  const reg = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/flagRegistry.js'), 'utf8');
  assert.ok(reg.includes('KHY_GOAL_COMPLETION_CONTRACT'), 'flag 注册');
});
