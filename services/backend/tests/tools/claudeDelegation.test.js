'use strict';

/**
 * claudeDelegation.decideClaudeDelegation — 委派决策纯函数特征化测试（node:test）。
 *
 * 守护：
 *   ① 模型显式选 claude + **闸门 G1 成立** → 委派；不可用 → 干净回退并说明原因（不强求、不中断）。
 *   ② Khy auto 判断 → feature flag 开 + 启发式命中 + **闸门成立** + 可用时才委派。
 *   ③ PROCESS-004 / [DESIGN-PROCESS-001] 委派边界：**启发式命中 ≠ 闸门成立**。auto 路径刻意用
 *      「重构 / 跨文件迁移 / 端到端」这类强启发式信号做反例——它们恰好是 khy 的核心能力，
 *      不构成委派理由。
 * 以及 fail-soft：探测/开关抛错一律降级为「不委派」，绝不让委派逻辑崩。
 *
 * 闸门标记由来：认知层 detectExternalAgentRequest 确定性识别到用户点名后产出一次性 nudge，
 * 要求模型把 `[委派闸门 G1]` 写进 prompt 首行。工具侧看不到用户原文，靠这条标记把「用户点名」
 * 一路传到委派决策点——**没有标记即默认用户没点名，fail-closed 回自做**。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  decideClaudeDelegation,
  _looksLikeClaudeCodeTask,
} = require('../../src/tools/AgentTool/claudeDelegation');

// 用户点名的形态：prompt 首行自声明闸门 G1
const NAMED = '[委派闸门 G1] 请重构整个支付模块，跨多文件迁移到新的网关抽象层，并保证所有端到端集成测试全部通过';
// 强启发式信号（重构 / 跨文件 / 端到端），但没有任何闸门
const HEAVY = '请重构整个支付模块，跨多文件迁移到新的网关抽象层，并保证所有端到端集成测试全部通过';

// ── explicit 路径（须过闸门） ───────────────────────────────────────────────

test('explicit + G1 点名 + 可用 → 委派 claude，mode=explicit，gate=G1', () => {
  const d = decideClaudeDelegation(
    { prompt: NAMED, role: 'claude', explicitlyRequested: true },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.adapter, 'claude');
  assert.strictEqual(d.available, true);
  assert.strictEqual(d.mode, 'explicit');
  assert.strictEqual(d.gate, 'G1');
  assert.strictEqual(d.code, 'allowed');
});

test('explicit + G1 点名 + 不可用 → 不委派、不报错，reason 含「未安装」（核心：不强求）', () => {
  const d = decideClaudeDelegation(
    { prompt: NAMED, role: 'claude', explicitlyRequested: true },
    { detect: () => false, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.available, false);
  assert.strictEqual(d.mode, 'explicit');
  assert.ok(/未安装/.test(d.reason), `reason 应说明未安装: ${d.reason}`);
});

test('explicit + 无闸门标记 → 不委派（默认自做，code=no-gate）', () => {
  const d = decideClaudeDelegation(
    { prompt: HEAVY, role: 'claude', explicitlyRequested: true },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.mode, 'explicit');
  assert.strictEqual(d.code, 'no-gate');
});

test('explicit + G2 能力缺失（结构化证据）→ 委派，gate=G2', () => {
  const d = decideClaudeDelegation(
    {
      prompt: '把这个仓库的 Rust 侧 benchmark 跑一遍',
      role: 'claude',
      explicitlyRequested: true,
      capabilityGap: ['本地无可用的 cargo bench 工具链'],
      delegationReason: '需要 cargo 工具链产出基准数据',
    },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.gate, 'G2');
});

test('explicit + G2 但理由含糊（更快） → 不委派，code=vague-reason', () => {
  const d = decideClaudeDelegation(
    {
      prompt: '重构支付模块',
      role: 'claude',
      explicitlyRequested: true,
      capabilityGap: ['某种能力'],
      delegationReason: '外部 agent 更快',
    },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'vague-reason');
});

test('explicit + selfCapable=true → 无条件不委派（§5.2 本地已覆盖）', () => {
  const d = decideClaudeDelegation(
    { prompt: NAMED, role: 'claude', explicitlyRequested: true, selfCapable: true },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'self-capable');
});

// ── auto 路径（feature flag + 启发式 + 闸门 + 可用，四重门） ────────────────

test('auto + flag 开 + 启发式命中 + 无闸门 → 不委派（启发式不构成委派理由）', () => {
  const d = decideClaudeDelegation(
    { prompt: HEAVY, role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.adapter, null);
  assert.strictEqual(d.mode, 'none');
  assert.strictEqual(d.code, 'no-gate');
});

test('auto + flag 开 + 启发式命中 + G3 隔离要求 → 委派，mode=auto，gate=G3', () => {
  const d = decideClaudeDelegation(
    {
      // ≥40 字 + 强信号（端到端）以命中启发式；真正的放行依据是 G3 隔离要求，不是启发式
      prompt: '请在干净的独立克隆里复现上游仓库的缺陷，并端到端验证修复效果，给出最小复现步骤与关键日志片段。',
      role: 'general',
      explicitlyRequested: false,
      isolationRequired: true,
      isolationNote: '本地工作区有未提交改动，必须在独立拷贝里复现',
    },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, true);
  assert.strictEqual(d.adapter, 'claude');
  assert.strictEqual(d.mode, 'auto');
  assert.strictEqual(d.gate, 'G3');
});

test('auto + flag 开 + 启发式不命中 → 不委派（由 Khy 自身处理）', () => {
  const d = decideClaudeDelegation(
    { prompt: '改个错别字', role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.mode, 'none');
});

test('auto + flag 关 → 不委派，即便可用且启发式命中且点名成立', () => {
  const d = decideClaudeDelegation(
    { prompt: NAMED, role: 'general', explicitlyRequested: false },
    { detect: () => true, isAutoDelegationEnabled: () => false }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.mode, 'none');
});

test('auto + flag 开 + 启发式命中 + 已点名 + 不可用 → 不委派，reason 含「未安装」', () => {
  const d = decideClaudeDelegation(
    { prompt: NAMED, role: 'general', explicitlyRequested: false },
    { detect: () => false, isAutoDelegationEnabled: () => true }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.available, false);
  assert.ok(/未安装/.test(d.reason), `reason 应说明未安装: ${d.reason}`);
});

// ── fail-soft ───────────────────────────────────────────────────────────────

test('detect 抛错 → fail-soft 不委派、不抛（mode=none）', () => {
  const d = decideClaudeDelegation(
    { prompt: NAMED, role: 'claude', explicitlyRequested: true },
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

test('准入判定不可用 → fail-closed 到不委派（绝不因判定缺失而放行）', () => {
  const d = decideClaudeDelegation(
    { prompt: NAMED, role: 'claude', explicitlyRequested: true },
    {
      detect: () => true,
      isAutoDelegationEnabled: () => true,
      tools: { evaluateAdmission: undefined, detectGate: undefined },
    }
  );
  assert.strictEqual(d.delegate, false);
  assert.strictEqual(d.code, 'admission-unavailable');
});

// ── 启发式边界 ──────────────────────────────────────────────────────────────

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
