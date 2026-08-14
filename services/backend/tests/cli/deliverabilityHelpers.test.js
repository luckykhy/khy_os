'use strict';

/**
 * Tests for the complex-task deliverability helpers added to
 * aiGatewayGenerateHelpers.js (_buildWrapUpPrompt / _wrapUpEnabled) and the
 * MAX_HISTORY single source of truth (constants/chatHistoryDefaults.js).
 *
 * These cover the "复杂任务可交付性" improvements:
 *   1. Tool-loop wrap-up prompt: when the natural tool loop exhausts its turn
 *      budget, the model is asked to synthesize a deliverable final summary
 *      from collected tool results instead of dumping raw tool output.
 *   2. KHY_MAX_HISTORY: default raised 80 → 160, env-tunable, floored.
 */
const test = require('node:test');
const assert = require('node:assert');

const HELPERS = '../../src/cli/aiGatewayGenerateHelpers';
const HISTORY = '../../src/constants/chatHistoryDefaults';

test('_buildWrapUpPrompt anchors the original task and lists tool outcomes', () => {
  const { _buildWrapUpPrompt } = require(HELPERS);
  const prompt = _buildWrapUpPrompt([
    { action: 'Read', arg: { file_path: 'a.js' }, result: '[Tool:Read] file content', success: true },
    { action: 'Edit', arg: { file_path: 'a.js' }, result: '[Tool:Edit] edited', success: false },
  ], '请修复 a.js 的 bug');
  assert.strictEqual(typeof prompt, 'string');
  assert.ok(prompt.includes('请修复 a.js 的 bug'), 'original task must be anchored');
  assert.ok(prompt.includes('[Read]'), 'successful tool listed');
  assert.ok(prompt.includes('失败'), 'failed tool marked as failed');
  assert.ok(prompt.includes('<tool_call>'), 'prompt forbids further tool calls');
});

test('_buildWrapUpPrompt tolerates empty tool results / missing user message', () => {
  const { _buildWrapUpPrompt } = require(HELPERS);
  const empty = _buildWrapUpPrompt([]);
  assert.strictEqual(typeof empty, 'string');
  assert.ok(empty.length > 0);
  const noUser = _buildWrapUpPrompt([{ action: 'Bash', result: 'out', success: true }]);
  assert.strictEqual(typeof noUser, 'string');
  assert.ok(noUser.includes('Bash'));
});

test('_wrapUpEnabled gates on KHY_TOOL_LOOP_WRAPUP, default on, fail-soft', () => {
  const { _wrapUpEnabled } = require(HELPERS);
  assert.strictEqual(_wrapUpEnabled({}), true);
  assert.strictEqual(_wrapUpEnabled({ KHY_TOOL_LOOP_WRAPUP: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(_wrapUpEnabled({ KHY_TOOL_LOOP_WRAPUP: v }), false, `off value ${v}`);
  }
});

test('resolveMaxHistory: default 160, env-tunable, invalid falls back to default', () => {
  const { resolveMaxHistory, MAX_HISTORY_DEFAULT } = require(HISTORY);
  assert.strictEqual(MAX_HISTORY_DEFAULT, 160);
  assert.strictEqual(resolveMaxHistory({}), 160);
  assert.strictEqual(resolveMaxHistory({ KHY_MAX_HISTORY: '200' }), 200);
  // Non-numeric / zero / negative → default (never a zero cap that disables trimming).
  assert.strictEqual(resolveMaxHistory({ KHY_MAX_HISTORY: 'abc' }), 160);
  assert.strictEqual(resolveMaxHistory({ KHY_MAX_HISTORY: '0' }), 160);
  assert.strictEqual(resolveMaxHistory({ KHY_MAX_HISTORY: '-5' }), 160);
});

test('chatHistoryDefaults is a zero-IO pure leaf (does not read process.env at load)', () => {
  // Contract: env is injected via the arg; the module must not throw without env.
  const mod = require(HISTORY);
  assert.doesNotThrow(() => mod.resolveMaxHistory());
  assert.strictEqual(mod.resolveMaxHistory(), 160);
});

test('_annotateTruncation appends a clear error reason when stopped by length/max_tokens', () => {
  const { _annotateTruncation } = require(HELPERS);
  // Non-empty reply + truncation stop → notice appended, truncated=true.
  const hit = _annotateTruncation('已完成一半的总结', 'length');
  assert.strictEqual(hit.truncated, true);
  assert.ok(hit.reply.startsWith('已完成一半的总结'), 'keeps the partial content');
  assert.ok(hit.reply.includes('截断'), 'states the truncation reason');
  assert.ok(hit.reply.includes('maxTokens'), 'gives the fix direction');
  // max_tokens stop reason (Anthropic family) behaves identically.
  const maxTok = _annotateTruncation('part', 'max_tokens');
  assert.strictEqual(maxTok.truncated, true);
});

test('_annotateTruncation is a no-op for natural stops / empty replies', () => {
  const { _annotateTruncation } = require(HELPERS);
  // Natural stop → untouched.
  const natural = _annotateTruncation('完整回答', 'stop');
  assert.strictEqual(natural.truncated, false);
  assert.strictEqual(natural.reply, '完整回答');
  // Empty reply → untouched (empty-reply path has its own diagnostics).
  const empty = _annotateTruncation('', 'length');
  assert.strictEqual(empty.truncated, false);
  assert.strictEqual(empty.reply, '');
  // Unknown/missing stop reason → untouched.
  const unknown = _annotateTruncation('answer', '');
  assert.strictEqual(unknown.truncated, false);
  assert.strictEqual(unknown.reply, 'answer');
});

test('_annotateTruncation is idempotent — never double-annotates an already-truncated reply', () => {
  const { _annotateTruncation } = require(HELPERS);
  const first = _annotateTruncation('内容...', 'length');
  assert.strictEqual(first.truncated, true);
  const second = _annotateTruncation(first.reply, 'length');
  assert.strictEqual(second.truncated, true);
  // No second notice appended (no duplicate "截断" block).
  const occurrences = (second.reply.match(/截断/g) || []).length;
  assert.strictEqual(occurrences, 1, 'must not append the notice twice');
});

test('_buildRecoveryAttemptsNote states internal attempts + fix directions for network/timeout', () => {
  const { _buildRecoveryAttemptsNote } = require(HELPERS);
  const result = {
    errorType: 'timeout',
    attempts: [
      { provider: 'Claude', success: false, error: 'timeout', errorType: 'timeout' },
      { provider: 'api', success: false, error: 'ECONNRESET', errorType: 'network' },
    ],
  };
  const note = _buildRecoveryAttemptsNote(result);
  assert.ok(note.includes('内部已尝试 2 次请求'), 'must disclose internal attempts');
  assert.ok(note.includes('Claude、api'), 'must list the tried providers');
  assert.ok(note.includes('处理方法'), 'must offer fix directions');
  assert.ok(note.includes('khy gateway status'), 'timeout fix must mention gateway status');
});

test('_buildRecoveryAttemptsNote gives per-type fix directions', () => {
  const { _buildRecoveryAttemptsNote } = require(HELPERS);
  const auth = _buildRecoveryAttemptsNote({ errorType: 'auth' });
  assert.ok(auth.includes('API key'), 'auth fix must mention API key');
  const context = _buildRecoveryAttemptsNote({ errorType: 'context_length' });
  assert.ok(context.includes('压缩'), 'context fix must mention compression');
  const model = _buildRecoveryAttemptsNote({ errorType: 'model_not_found' });
  assert.ok(model.includes('model'), 'model fix must mention model selection');
  const empty = _buildRecoveryAttemptsNote({ errorType: 'empty' });
  assert.ok(empty.includes('maxTokens'), 'empty fix must mention maxTokens');
});

test('_buildRecoveryAttemptsNote returns empty for unknown/clean results', () => {
  const { _buildRecoveryAttemptsNote } = require(HELPERS);
  assert.strictEqual(_buildRecoveryAttemptsNote({}), '');
  assert.strictEqual(_buildRecoveryAttemptsNote(null, ''), '');
  // Success result → no attempts note.
  assert.strictEqual(_buildRecoveryAttemptsNote({ success: true }), '');
});

test('_buildWrapUpPrompt aggregates per-step results into a final delivery', () => {
  const { _buildWrapUpPrompt } = require(HELPERS);
  const planSteps = [
    { id: 1, description: '查看现有表结构', status: 'completed' },
    { id: 2, description: '创建 users 表', status: 'completed' },
    { id: 3, description: '编写注册接口', status: 'pending' },
  ];
  const results = [
    { action: 'Read', result: '[Tool:Read] CREATE TABLE users...', success: true },
    { action: 'shell_command', result: '[Tool:shell_command] table created', success: true },
  ];
  const prompt = _buildWrapUpPrompt(results, '请实现用户登录功能', planSteps);
  assert.ok(prompt.includes('原始任务: 请实现用户登录功能'), 'anchors the original task');
  assert.ok(prompt.includes('步骤 1'), 'lists step 1');
  assert.ok(prompt.includes('步骤 2'), 'lists step 2');
  assert.ok(prompt.includes('[Read]'), 'step 1 gets its Read result');
  assert.ok(prompt.includes('CREATE TABLE users'), 'step 1 result content included');
  assert.ok(prompt.includes('指向原始任务目标'), 'final delivery oriented at the goal');
});

test('_buildWrapUpPrompt without plan keeps the legacy flat tool-result listing', () => {
  const { _buildWrapUpPrompt } = require(HELPERS);
  const results = [
    { action: 'Read', result: '[Tool:Read] content', success: true },
    { action: 'Edit', result: '[Tool:Edit] edited', success: false },
  ];
  const prompt = _buildWrapUpPrompt(results, 'task');
  assert.ok(prompt.includes('工具执行记录'), 'legacy flat listing header');
  assert.ok(prompt.includes('[Read]') && prompt.includes('content'));
  assert.ok(prompt.includes('失败'), 'failed tool marked');
  assert.ok(!prompt.includes('执行计划'), 'no plan section when no plan provided');
});

test('_buildWrapUpPrompt matches natural-language step descriptions to tool results', () => {
  const { _buildWrapUpPrompt } = require(HELPERS);
  const planSteps = [
    { id: 1, description: '查看现有表结构', status: 'completed' },
    { id: 2, description: '创建 users 表', status: 'completed' },
  ];
  const results = [
    { action: 'Read', result: '[Tool:Read] schema', success: true },
    { action: 'shell_command', result: '[Tool:shell_command] ok', success: true },
  ];
  const prompt = _buildWrapUpPrompt(results, 'task', planSteps);
  // Step 1 ("查看" → Read) and step 2 ("创建" → shell_command) consume their results.
  assert.ok(prompt.includes('[Read]') && prompt.includes('schema'));
  assert.ok(prompt.includes('[shell_command]') && prompt.includes('ok'));
});

test('_buildStepDriverPrompt drives the next step during mid-execution', () => {
  const { _buildStepDriverPrompt } = require(HELPERS);
  const steps = [
    { id: 1, description: '查看现有表结构', status: 'completed' },
    { id: 2, description: '创建 users 表', status: 'pending' },
    { id: 3, description: '编写注册接口', status: 'pending' },
  ];
  const prompt = _buildStepDriverPrompt(steps, 1);
  assert.ok(prompt.includes('已完成 1/3 步'), 'reports completed progress');
  assert.ok(prompt.includes('步骤 2'), 'points at the next step');
  assert.ok(prompt.includes('创建 users 表'), 'next step description');
  assert.ok(prompt.includes('立即执行下一步'), 'urges executing the next step');
});

test('_buildStepDriverPrompt tells the model to finalize when all steps are done', () => {
  const { _buildStepDriverPrompt } = require(HELPERS);
  const steps = [
    { id: 1, description: '查看表结构', status: 'completed' },
    { id: 2, description: '创建表', status: 'completed' },
  ];
  const prompt = _buildStepDriverPrompt(steps, 2);
  assert.ok(prompt.includes('已完成 2/2 步'), 'all steps done');
  assert.ok(prompt.includes('最终交付总结'), 'must instruct final aggregation');
  assert.ok(prompt.includes('原始任务目标'), 'aggregation points at the original goal');
});

test('_buildStepDriverPrompt is a no-op without a plan', () => {
  const { _buildStepDriverPrompt } = require(HELPERS);
  assert.strictEqual(_buildStepDriverPrompt(null, 0), '');
  assert.strictEqual(_buildStepDriverPrompt([], 0), '');
});

test('_buildStepRecoveryPrompt guides retry on first failure', () => {
  const { _buildStepRecoveryPrompt } = require(HELPERS);
  const p = _buildStepRecoveryPrompt(
    { action: 'shell_command', arg: { command: 'sqlite3 init' } },
    'command not found: sqlite3', 1, 2
  );
  assert.ok(p.includes('shell_command'), 'names the failed tool');
  assert.ok(p.includes('command not found'), 'includes the error');
  assert.ok(p.includes('第 1/2 次'), 'reports attempt number');
  assert.ok(p.includes('换一种方式重试'), 'urges retrying differently');
});

test('_buildStepRecoveryPrompt tells the model to continue remaining steps when exhausted', () => {
  const { _buildStepRecoveryPrompt } = require(HELPERS);
  const p = _buildStepRecoveryPrompt(
    { action: 'Write', arg: { file_path: 'auth.js' } },
    'EACCES permission denied', 2, 2
  );
  assert.ok(p.includes('已重试 2 次仍失败'), 'reports exhaustion');
  assert.ok(p.includes('回到正文'), 'must return to the mainline');
  assert.ok(p.includes('后续步骤'), 'must continue remaining steps');
  assert.ok(p.includes('说明此步骤失败'), 'must disclose failure in the final delivery');
});

test('_buildStepDriverPrompt surfaces failed steps and skips them', () => {
  const { _buildStepDriverPrompt } = require(HELPERS);
  const steps = [
    { id: 1, description: '查看表结构', status: 'completed' },
    { id: 2, description: '创建表', status: 'failed' },
    { id: 3, description: '写接口', status: 'pending' },
  ];
  const p = _buildStepDriverPrompt(steps, 2);
  assert.ok(p.includes('失败 1 步'), 'reports failed count');
  assert.ok(p.includes('✗ 步骤 2'), 'marks the failed step');
  assert.ok(p.includes('不要反复重试'), 'tells model not to retry endlessly');
  assert.ok(p.includes('步骤 3'), 'points at the next step');
});

test('_buildWrapUpPrompt reports failed steps honestly in the aggregation', () => {
  const { _buildWrapUpPrompt } = require(HELPERS);
  const planSteps = [
    { id: 1, description: '查看表结构', status: 'completed' },
    { id: 2, description: '创建 users 表', status: 'failed', lastError: 'EACCES: permission denied' },
  ];
  const results = [
    { action: 'Read', result: '[Tool:Read] schema ok', success: true },
  ];
  const p = _buildWrapUpPrompt(results, '实现登录', planSteps);
  assert.ok(p.includes('执行失败'), 'must mark the failed step');
  assert.ok(p.includes('EACCES'), 'must include the failure reason');
  assert.ok(p.includes('[Read] (成功)'), 'successful step still aggregated');
});

test('_buildResumePlanPrompt restores step state for "continue" after an interruption', () => {
  const { _buildResumePlanPrompt } = require(HELPERS);
  const savedSteps = [
    { id: 1, description: '查看现有表结构', status: 'completed' },
    { id: 2, description: '创建 users 表', status: 'failed', lastError: 'EACCES: permission denied' },
    { id: 3, description: '编写注册接口', status: 'pending' },
  ];
  const p = _buildResumePlanPrompt(savedSteps);
  assert.ok(p.includes('断点恢复'), 'announces resume mode');
  assert.ok(p.includes('已完成 1/3 步'), 'reports completed progress');
  assert.ok(p.includes('✗ 步骤 2'), 'marks the failed step');
  assert.ok(p.includes('EACCES'), 'carries the failure reason');
  assert.ok(p.includes('下一步(步骤 3)'), 'points at the next step');
  assert.ok(p.includes('不要重复已完成步骤'), 'tells model not to redo completed work');
  assert.ok(p.includes('改到一半') || p.includes('被删'), 'checks workspace half-state');
});

test('_buildResumePlanPrompt is a no-op without a saved plan', () => {
  const { _buildResumePlanPrompt } = require(HELPERS);
  assert.strictEqual(_buildResumePlanPrompt(null), '');
  assert.strictEqual(_buildResumePlanPrompt([]), '');
});

test('_buildResumePlanPrompt handles the all-done case', () => {
  const { _buildResumePlanPrompt } = require(HELPERS);
  const savedSteps = [
    { id: 1, description: '查看表结构', status: 'completed' },
    { id: 2, description: '创建表', status: 'completed' },
  ];
  const p = _buildResumePlanPrompt(savedSteps);
  assert.ok(p.includes('已完成 2/2 步'), 'all done');
  assert.ok(p.includes('最终总结'), 'prompts final summary');
});
