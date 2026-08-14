/**
 * aiTaskClassifier.js — Task classification, difficulty assessment, capability checking, and task guard logic.
 *
 * Extracted from aiChatCore.js to improve modularity. Contains all functions related to
 * analyzing user tasks (classification, difficulty scoring), model capability checking,
 * task self-awareness prompt building, and the hard task guard mechanism.
 *
 * @module cli/aiTaskClassifier
 */
'use strict';

// ── Imports ──
const crypto = require('crypto');

const _chatState = require('./aiChatState');

// ── Host-injected deps (set via setAiTaskClassifierDeps) ──
let MODEL_CAPABILITIES = null;
let _resolveTaskScale = null;
let _getStudyModeRuntimeMeta = null;

function setAiTaskClassifierDeps(deps = {}) {
  if (deps.MODEL_CAPABILITIES !== undefined) {
    MODEL_CAPABILITIES = deps.MODEL_CAPABILITIES;
  }
  if (deps._resolveTaskScale !== undefined) {
    _resolveTaskScale = deps._resolveTaskScale;
  }
  if (deps._getStudyModeRuntimeMeta !== undefined) {
    _getStudyModeRuntimeMeta = deps._getStudyModeRuntimeMeta;
  }
}

// ── Task Classification ──

function _classifyTaskType(message) {
  if (!message) {
    return 'conversation';
  }
  const lower = message.toLowerCase();
  if (/回测|backtest|策略|strategy/.test(lower)) {
    return 'backtest';
  }
  if (/分析|analyze|评估|诊断/.test(lower)) {
    return 'analysis';
  }
  if (/数据|data|下载|fetch/.test(lower)) {
    return 'dataFetch';
  }
  if (/策略|strategy|signal|信号/.test(lower)) {
    return 'strategy';
  }
  return 'conversation';
}

/**
 * Strip harness-injected scaffolding from a user message before task-difficulty
 * scoring. The planning / key-findings preambles are prepended as `[System: ...]`
 * blocks separated from the real user text by a blank line (`\n\n`), and may
 * contain their own square brackets (e.g. the planning example `[read]`), so we
 * split on the blank-line boundary and drop leading segments that begin with
 * `[System:` rather than trying to bracket-match. Also removes any residual
 * `<finding>` / `<execution_plan>` scaffolding. Scoring-only: the untouched
 * message is still what reaches the model — this just prevents harness prose
 * (e.g. the key-findings "根本原因" hint) from inflating the required capability
 * and hard-blocking trivial user input like "你好".
 */
function _stripHarnessScaffolding(input) {
  const raw = String(input || '');
  if (!raw) {
    return raw;
  }
  try {
    const text = raw
      .replace(/<finding\b[\s\S]*?<\/finding>/gi, ' ')
      .replace(/<execution_plan\b[\s\S]*?<\/execution_plan>/gi, ' ');
    const segments = text.split(/\n{2,}/);
    while (segments.length > 1 && /^\s*\[System:/i.test(segments[0])) {
      segments.shift();
    }
    const stripped = segments.join('\n\n').trim();
    return stripped || raw;
  } catch (_e) {
    return raw;
  }
}

function _assessTaskDifficulty(input) {
  const cleaned = _stripHarnessScaffolding(input);
  const lower = cleaned.toLowerCase();
  const required = { code: 1, reasoning: 1, creative: 1, contextNeeded: 0 };

  if (
    /重构|refactor|实现|implement|debug|修复|写代码|编码|class\s|function\s|async\s|promise/.test(
      lower
    )
  ) {
    required.code = 4;
  }
  if (/分析|analyze|推理|reason|比较|对比|为什么|原因|策略设计|复杂/.test(lower)) {
    required.reasoning = 4;
  }
  if (/设计|design|创意|创建|generate|生成|写文章|write\s/.test(lower)) {
    required.creative = 3;
  }
  if (cleaned.length > 3000 || /全部|所有文件|整个项目|complete|comprehensive/.test(lower)) {
    required.contextNeeded = cleaned.length * 4;
  }

  return required;
}

// ── Model Capability Check ──

function checkModelCapability(input) {
  let currentModel = null;
  try {
    const gw = _chatState.gateway || require('../services/gateway/aiGateway');
    const active = gw && typeof gw.getActiveAdapter === 'function' ? gw.getActiveAdapter() : null;
    if (active) {
      currentModel = active.activeModel || active.model || active.name || null;
    }
    if (!currentModel) {
      const status = gw && typeof gw.getStatus === 'function' ? gw.getStatus() : null;
      if (Array.isArray(status)) {
        const activeRec = status.find((s) => s && (s.active || s.isActive)) || status[0];
        currentModel = activeRec?.activeModel || activeRec?.model || activeRec?.name || null;
      } else if (status && typeof status === 'object') {
        currentModel = status.activeModel || status.model || status.name || null;
      }
    }
  } catch (e) {
    console.error('[ai] 模型状态获取失败:', e?.message);
  }
  if (!currentModel) {
    currentModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim() || null;
  }
  if (!currentModel) {
    return null;
  }

  const lowerModel = currentModel.toLowerCase();
  let cap = null;
  const sortedCaps = Object.entries(MODEL_CAPABILITIES).sort(
    (a, b) => String(b[0] || '').length - String(a[0] || '').length
  );
  for (const [key, val] of sortedCaps) {
    if (lowerModel === key || lowerModel.includes(key)) {
      cap = val;
      break;
    }
  }
  if (!cap) {
    return null;
  }

  const taskReq = _assessTaskDifficulty(input);
  const issues = [];
  if (taskReq.code > cap.code) {
    issues.push(`代码能力不足 (需要 ${taskReq.code}/5, 当前 ${cap.code}/5)`);
  }
  if (taskReq.reasoning > cap.reasoning) {
    issues.push(`推理能力不足 (需要 ${taskReq.reasoning}/5, 当前 ${cap.reasoning}/5)`);
  }
  if (taskReq.contextNeeded > cap.context * 0.8) {
    issues.push(
      `上下文可能不够 (估计需要 ${Math.round(taskReq.contextNeeded / 1000)}k, 限制 ${Math.round(cap.context / 1000)}k)`
    );
  }
  if (issues.length === 0) {
    return null;
  }

  const better = Object.entries(MODEL_CAPABILITIES)
    .filter(([key]) => !lowerModel.includes(key))
    .filter(
      ([, m]) =>
        m.code >= taskReq.code &&
        m.reasoning >= taskReq.reasoning &&
        m.context >= (taskReq.contextNeeded || 0)
    )
    .sort((a, b) => b[1].code + b[1].reasoning - (a[1].code + a[1].reasoning))
    .slice(0, 3);

  return {
    issues,
    recommendations: better.map(([key, m]) => ({ key, label: m.label })),
  };
}

// ── Task Self-Awareness ──

function _buildTaskSelfAwarenessPrompt(userMessage = '', opts = {}) {
  try {
    const scale = _resolveTaskScale(userMessage, opts);
    const runtimeMeta = _getStudyModeRuntimeMeta(opts.preferredAdapter, opts.preferredModel);
    const effort = String(opts.effort || _chatState.currentEffort || 'medium').trim();
    const { getSelfAwarenessProfile } = require('../services/knowledgeTeachingService');
    const profile = getSelfAwarenessProfile({
      studyMode: _chatState.studyMode,
      adapter: runtimeMeta.adapter,
      model: runtimeMeta.model,
      effort,
    });

    const modelCheck = checkModelCapability(userMessage);
    const caps = Array.isArray(profile.capabilities) ? profile.capabilities.slice(0, 4) : [];
    const limits = Array.isArray(profile.boundaries) ? profile.boundaries.slice(0, 4) : [];
    const capsBlock =
      caps.map((s, i) => `${i + 1}. ${s}`).join('\n') || '1. 按当前配置执行标准任务。';
    const limitsBlock =
      limits.map((s, i) => `${i + 1}. ${s}`).join('\n') || '1. 未检出显著边界风险。';

    const modelRisk =
      modelCheck && Array.isArray(modelCheck.issues) && modelCheck.issues.length > 0
        ? modelCheck.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : '1. 当前模型能力未检出明显短板。';
    const modelSuggest =
      modelCheck &&
      Array.isArray(modelCheck.recommendations) &&
      modelCheck.recommendations.length > 0
        ? modelCheck.recommendations.map((r, i) => `${i + 1}. ${r.label || r.key}`).join('\n')
        : '1. 保持当前模型并优先分步执行。';

    return [
      '### KHY_TASK_SELF_AWARENESS_GUIDE',
      '你在执行任务前必须先做能力自检，并将自检结果用于执行策略。',
      '',
      '执行规范:',
      '1) 先写明本轮任务目标与完成标准。',
      '2) 输出"已知/假设/未知"，未知项不得伪装为确定事实。',
      '3) 若能力或上下文不足，优先拆分任务并先完成可验证子任务。',
      '4) 回答必须包含可验证结果（检查点、命令输出摘要或证据）。',
      '',
      `任务规模: ${scale}`,
      `当前通道: ${profile.runtime?.adapter || 'auto'} / ${profile.runtime?.model || 'auto'} / effort=${effort}`,
      '',
      '可用能力:',
      capsBlock,
      '',
      '能力边界:',
      limitsBlock,
      '',
      '模型风险自检:',
      modelRisk,
      '',
      '模型改进建议:',
      modelSuggest,
    ].join('\n');
  } catch {
    return '';
  }
}

// ── Task Guard ──

function _taskGuardHardModeEnabled() {
  const raw = String(process.env.KHY_TASK_SELF_AWARENESS_HARD || 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no', 'n'].includes(raw);
}

function _taskGuardTtlMs() {
  const raw = parseInt(String(process.env.KHY_TASK_SELF_AWARENESS_HARD_TTL_MS || '900000'), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 900000;
  }
  return Math.max(30000, Math.min(24 * 60 * 60 * 1000, raw));
}

function _expirePendingTaskGuard() {
  if (!_chatState.pendingTaskGuard) {
    return;
  }
  if (Date.now() >= Number(_chatState.pendingTaskGuard.expiresAt || 0)) {
    _chatState.pendingTaskGuard = null;
  }
}

function _createTaskGuardId() {
  return `tg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

function _parseTaskGuardCommand(input = '') {
  const text = String(input || '').trim();
  if (!text) {
    return { confirm: false, cancel: false, id: '' };
  }

  const confirmMatch = text.match(
    /^(?:确认执行|继续执行|确认|confirm|approve|yes)(?:\s+([a-z0-9-]+))?$/i
  );
  if (confirmMatch) {
    return {
      confirm: true,
      cancel: false,
      id: String(confirmMatch[1] || '')
        .trim()
        .toLowerCase(),
    };
  }

  const cancelMatch = text.match(/^(?:取消执行|取消|cancel|abort)(?:\s+([a-z0-9-]+))?$/i);
  if (cancelMatch) {
    return {
      confirm: false,
      cancel: true,
      id: String(cancelMatch[1] || '')
        .trim()
        .toLowerCase(),
    };
  }

  return { confirm: false, cancel: false, id: '' };
}

function _buildHardGuardPlan(userMessage = '', hardIssues = [], recommendations = []) {
  const taskSummary =
    String(userMessage || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '当前任务';
  const issues =
    (hardIssues || [])
      .slice(0, 3)
      .map((x, i) => `${i + 1}. ${x}`)
      .join('\n') || '1. 未识别到硬性风险。';
  const recs =
    (recommendations || [])
      .slice(0, 3)
      .map((r, i) => `${i + 1}. ${r.label || r.key || '保持当前模型分步执行'}`)
      .join('\n') || '1. 保持当前模型并严格分步验证。';

  return [
    `目标: 完成「${taskSummary}」并保持结果可验证`,
    '步骤:',
    '1. 锁定验收标准：先明确交付物、边界条件和失败定义。',
    '2. 缩小风险面：优先选择更匹配模型或把任务拆成可独立验证的小步骤。',
    '3. 先做最小可验证子任务，给出证据后再扩展。',
    '4. 每一步输出"已知/假设/未知"，避免伪确定性。',
    '',
    '当前能力风险:',
    issues,
    '',
    '建议通道/模型调整:',
    recs,
  ].join('\n');
}

function _resolveHardTaskGuard(userMessage = '', opts = {}) {
  _expirePendingTaskGuard();
  const parsedCommand = _parseTaskGuardCommand(userMessage);

  if (_chatState.pendingTaskGuard) {
    const expectedId = String(_chatState.pendingTaskGuard.id || '').toLowerCase();
    const matchesId = !parsedCommand.id || parsedCommand.id === expectedId;

    if (parsedCommand.cancel) {
      if (matchesId) {
        const oldId = _chatState.pendingTaskGuard.id;
        _chatState.pendingTaskGuard = null;
        return {
          action: 'cancelled',
          reply: `已取消受限任务（${oldId}）。如需重新执行，请重新描述任务。`,
        };
      }
      return {
        action: 'blocked',
        reply: `取消口令不匹配。当前待确认任务: ${expectedId}\n请使用: 取消执行 ${expectedId}`,
      };
    }

    if (parsedCommand.confirm) {
      if (matchesId) {
        const pending = _chatState.pendingTaskGuard;
        _chatState.pendingTaskGuard = null;
        return {
          action: 'confirmed',
          replayMessage: pending.originalUserMessage,
          guardId: pending.id,
        };
      }
      return {
        action: 'blocked',
        reply: `确认口令不匹配。当前待确认任务: ${expectedId}\n请使用: 确认执行 ${expectedId}`,
      };
    }
  }

  if (!_taskGuardHardModeEnabled()) {
    return { action: 'none' };
  }
  if (opts._taskGuardConfirmed || opts.disableHardTaskGuard) {
    return { action: 'none' };
  }

  const text = String(userMessage || '').trim();
  if (!text) {
    return { action: 'none' };
  }

  const scale = _resolveTaskScale(text, opts);
  if (
    scale === 'small' &&
    !/实现|重构|修复|改造|端到端|完整|full|implement|refactor|fix/i.test(text)
  ) {
    return { action: 'none' };
  }

  const modelCheck = checkModelCapability(text);
  if (!modelCheck || !Array.isArray(modelCheck.issues) || modelCheck.issues.length === 0) {
    return { action: 'none' };
  }

  const hardIssues = modelCheck.issues.filter(
    (issue) => !/(上下文可能不够|context)/i.test(String(issue || ''))
  );
  if (hardIssues.length === 0) {
    return { action: 'none' };
  }

  const hardMin = Math.max(
    1,
    parseInt(String(process.env.KHY_TASK_GUARD_HARD_ISSUES_MIN || '2'), 10) || 2
  );
  const complexMinIssues = Math.max(
    1,
    parseInt(String(process.env.KHY_TASK_GUARD_COMPLEX_ISSUES_MIN || '1'), 10) || 1
  );
  const complexMinChars = Math.max(
    80,
    parseInt(String(process.env.KHY_TASK_GUARD_COMPLEX_MIN_CHARS || '160'), 10) || 160
  );
  const isComplex = scale === 'large' || text.length >= complexMinChars;
  const shouldBlock =
    hardIssues.length >= hardMin || (isComplex && hardIssues.length >= complexMinIssues);
  if (!shouldBlock) {
    return { action: 'none' };
  }

  const guardId = _createTaskGuardId();
  const expiresAt = Date.now() + _taskGuardTtlMs();
  const plan = _buildHardGuardPlan(text, hardIssues, modelCheck.recommendations || []);
  _chatState.pendingTaskGuard = {
    id: guardId,
    createdAt: Date.now(),
    expiresAt,
    originalUserMessage: text,
    issues: hardIssues,
    recommendations: Array.isArray(modelCheck.recommendations) ? modelCheck.recommendations : [],
    scale,
    plan,
  };

  const expireSec = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  const reply = [
    `能力硬约束触发（任务ID: ${guardId}）`,
    '原因: 当前任务需求与模型能力存在高风险不匹配，已暂停自动执行。',
    '',
    plan,
    '',
    `确认执行（将在约 ${expireSec}s 后过期）: 确认执行 ${guardId}`,
    `取消任务: 取消执行 ${guardId}`,
  ].join('\n');

  return {
    action: 'blocked',
    reply,
    guardId,
    scale,
  };
}

// ── Exports ──
module.exports = {
  _classifyTaskType,
  _stripHarnessScaffolding,
  _assessTaskDifficulty,
  checkModelCapability,
  _buildTaskSelfAwarenessPrompt,
  _resolveHardTaskGuard,
  setAiTaskClassifierDeps,
};
