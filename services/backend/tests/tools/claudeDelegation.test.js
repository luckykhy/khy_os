'use strict';

/**
 * claudeDelegation.decideClaudeDelegation — 委派决策纯函数特征化测试（node:test）。
 *
 * 守护用户两条诉求：
 *   ① 模型显式选 claude → 可用就委派、不可用就干净回退并说明原因（不强求、不中断）。
 *   ② Khy auto 判断 → 仅 feature flag 开 + 启发式命中 + 可用时才委派；默认偏不委派。
 * 以及 fail-soft：探测/开关抛错一律降级为「不委派」，绝不让委派逻辑崩。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  decideClaudeDelegation,
  _looksLikeClaudeCodeTask,
} = require('../../src/tools/AgentTool/claudeDelegation');

// ── explicit 路径（不受 feature flag 约束） ──────────────────────────────────

test('explicit + 可用 → 委派 claude，mode=explicit', () => {
  const d = decideClaudeDelegation(
    { prompt: '随便什么', role: 'claude', explicitlyRequested: true },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.adapter, 'claude');
  assert.strictEqual(d.available, true);
  assert.strictEqual(d.mode, 'explicit');
});

test('explicit + 不可用 → 不委派、不报错，reason 含「未安装」（核心：不强求）', () => {
  const d = decideClaudeDelegation(
    { prompt: '随便什么', role: 'claude', explicitlyRequested: true },
    { detect: () => false, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.available, false);
  assert.strictEqual(d.mode, 'explicit');
  assert.ok(/未安装/.test(d.reason), `reason 应说明未安装: ${d.reason}`);
});

// ── auto 路径（feature flag + 启发式 + 可用三重门） ──────────────────────────

test('auto + flag 开 + 启发式命中 + 可用 → 委派，mode=auto', () => {
  const d = decideClaudeDelegation(
    { prompt: '请重构整个支付模块，跨多文件迁移到新的网关抽象层，并保证所有端到端集成测试全部通过', role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.adapter, 'claude');
  assert.strictEqual(d.mode, 'auto');
});

test('auto + flag 开 + 启发式不命中 → 不委派（由 Khy 自身处理）', () => {
  const d = decideClaudeDelegation(
    { prompt: '改个错别字', role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.mode, 'none');
});

test('auto + flag 关 → 不委派，即便可用且启发式命中', () => {
  const d = decideClaudeDelegation(
    { prompt: '请重构整个支付模块，跨多文件迁移到新的网关抽象层，并保证所有端到端集成测试全部通过', role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.mode, 'none');
});

test('auto + flag 开 + 启发式命中 + 不可用 → 不委派，reason 含「未安装」', () => {
  const d = decideClaudeDelegation(
    { prompt: '请重构整个支付模块，跨多文件迁移到新的网关抽象层，并保证所有端到端集成测试全部通过', role: 'general', explicitlyRequested: false },
    { detect: () => false, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.available, false);
  assert.ok(/未安装/.test(d.reason), `reason 应说明未安装: ${d.reason}`);
});

// ── fail-soft ───────────────────────────────────────────────────────────────

test('detect 抛错 → fail-soft 不委派、不抛', () => {
  const d = decideClaudeDelegation(
    { prompt: '请重构整个项目', role: 'general', explicitlyRequested: true },
    { detect: () => { throw new Error('spawn boom'); }, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.mode, 'none');
});

test('isAutoDelegationEnabled 抛错 → fail-soft 不委派、不抛', () => {
  const d = decideClaudeDelegation(
    { prompt: '请重构整个项目并迁移所有文件', role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => { throw new Error('flag boom'); } }
  );
  assert.strictEqual(d.delegate, false);
});

// ── 启发式边界 ────────────────────────────────────────────────────────────────

test('_looksLikeClaudeCodeTask：太短 → false（不值得 spawn 重进程）', () => {
  assert.strictEqual(_looksLikeClaudeCodeTask('重构', 'general'), false);
});

test('_looksLikeClaudeCodeTask：强信号（refactor across files）→ true', () => {
  assert.strictEqual(
    _looksLikeClaudeCodeTask('Refactor the auth layer across multiple files and update callers', 'general'),
    true
  );
});

test('_looksLikeClaudeCodeTask：弱信号 + 短描述 → false（保守偏不委派）', () => {
  assert.strictEqual(_looksLikeClaudeCodeTask('implement a helper', 'general'), false);
});
