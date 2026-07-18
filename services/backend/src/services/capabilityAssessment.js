'use strict';

/**
 * Capability assessment — pre-execution checks for whether the
 * current tool/model environment can handle a user's request.
 *
 * Extracted from toolUseLoop.js (lines 365-696) as part of the
 * industrial-grade modularization (Phase 1H).
 *
 * Dependencies: taskComplexity.isComplexTask, intentHeuristics.looksLikeActionRequest,
 *               toolCallParser.expandToolNameVariants, fs, path.
 */

const fs = require('fs');
const path = require('path');

// ── Env flag helper ──────────────────────────────────────────────────

const envFlagEnabled = require('../utils/envFlagEnabled');

// ── Default policy ───────────────────────────────────────────────────

const DEFAULT_CAPABILITY_POLICY = Object.freeze({
  enabled: true,
  blockMode: 'strict',
  tasks: [
    {
      key: 'file_edit',
      patterns: [
        '修改', '编辑', '重构', '实现', '修复', '新增', '添加', '删除', '替换', '写入', '创建文件',
        'apply patch', 'edit file', 'write file', 'refactor', 'implement', 'fix', 'update', 'replace', 'remove', 'delete',
      ],
      requiredTools: ['editFile', 'writeFile', 'shellCommand', 'file_edit', 'file_write'],
      reason: '当前环境缺少文件编辑/写入能力（edit/write/shell 工具不可用）。',
    },
    {
      key: 'shell_exec',
      patterns: [
        '运行命令', '执行命令', '终端', 'shell', 'bash', 'cmd', '运行测试', '构建', '编译', '安装依赖',
        'npm', 'pnpm', 'yarn', 'pytest', 'cargo', 'go test', 'make', 'docker', 'kubectl',
      ],
      requiredTools: ['shellCommand', 'run_tests', 'build_project', 'lint_code', 'executeCode'],
      reason: '当前环境缺少命令执行能力（shell/build/test 工具不可用）。',
    },
    {
      key: 'web_search',
      patterns: ['联网', '上网', '互联网', 'web search', '网页搜索', '搜索网页', '查网页', 'fetch url', '访问网站', 'browser search'],
      requiredTools: ['webSearch', 'webFetch', 'search'],
      reason: '当前环境缺少联网检索能力（webSearch/webFetch 不可用）。',
    },
    {
      key: 'app_launch',
      patterns: ['打开应用', '启动应用', '打开程序', '打开浏览器', 'open app', 'launch app', 'start app', 'open browser'],
      requiredTools: ['open_app', 'shellCommand'],
      reason: '当前环境缺少应用启动能力（open_app/shell 工具不可用）。',
    },
  ],
  model: {
    enabled: true,
    ignoreIssuePatterns: ['上下文可能不够'],
    blockWhenHardIssueCountAtLeast: 2,
    blockWhenComplexAndHardIssueCountAtLeast: 1,
    complexMinChars: 160,
    maxRecommendations: 3,
  },
});

// ── Policy management ────────────────────────────────────────────────

const _cloneCapabilityTasks = require('../utils/cloneCapabilityTasks');

function _mergeCapabilityPolicy(basePolicy = {}, overridePolicy = {}) {
  const baseModel = basePolicy && typeof basePolicy.model === 'object' ? basePolicy.model : {};
  const overrideModel = overridePolicy && typeof overridePolicy.model === 'object' ? overridePolicy.model : {};
  return {
    ...basePolicy,
    ...(overridePolicy || {}),
    tasks: Array.isArray(overridePolicy?.tasks)
      ? _cloneCapabilityTasks(overridePolicy.tasks)
      : _cloneCapabilityTasks(basePolicy.tasks || []),
    model: { ...baseModel, ...overrideModel },
  };
}

function _defaultCapabilityPolicyPath() {
  const home = String(process.env.HOME || process.env.USERPROFILE || '').trim();
  if (!home) return '';
  return path.join(home, '.khyquant', 'capability-policy.json');
}

function loadCapabilityPolicy(options = {}) {
  let policy = _mergeCapabilityPolicy(DEFAULT_CAPABILITY_POLICY, {});

  if (options && options.capabilityPolicy && typeof options.capabilityPolicy === 'object') {
    policy = _mergeCapabilityPolicy(policy, options.capabilityPolicy);
  }

  const envPolicyJson = String(process.env.KHY_CAPABILITY_POLICY_JSON || '').trim();
  if (envPolicyJson) {
    try {
      const parsed = JSON.parse(envPolicyJson);
      if (parsed && typeof parsed === 'object') {
        policy = _mergeCapabilityPolicy(policy, parsed);
      }
    } catch { /* ignore malformed JSON */ }
  }

  const policyPath = String(
    options.capabilityPolicyFile || process.env.KHY_CAPABILITY_POLICY_FILE || _defaultCapabilityPolicyPath()
  ).trim();
  if (policyPath && fs.existsSync(policyPath)) {
    try {
      const parsed = JSON.parse(String(fs.readFileSync(policyPath, 'utf-8') || '{}'));
      if (parsed && typeof parsed === 'object') {
        policy = _mergeCapabilityPolicy(policy, parsed);
      }
    } catch { /* ignore malformed file */ }
  }

  return policy;
}

// ── Tool set introspection ───────────────────────────────────────────

function _collectEnabledToolNameSet() {
  const { expandToolNameVariants } = require('./toolCallParser');
  const out = new Set();
  const registerName = (name) => {
    for (const v of expandToolNameVariants(name)) out.add(v);
  };

  try {
    const toolRegistry = require('../tools');
    const enabled = toolRegistry.getEnabled ? toolRegistry.getEnabled() : toolRegistry.getAll?.();
    if (!enabled) return out;
    const names = enabled instanceof Map ? [...enabled.keys()] : Object.keys(enabled);
    for (const name of names) registerName(name);
    const defs = enabled instanceof Map ? [...enabled.values()] : Object.values(enabled);
    for (const tool of defs) {
      if (Array.isArray(tool?.aliases)) {
        for (const alias of tool.aliases) registerName(alias);
      }
    }
  } catch { /* best effort */ }

  return out;
}

function _hasAnyToolEnabled(enabledToolSet, candidates = []) {
  const { expandToolNameVariants } = require('./toolCallParser');
  if (!(enabledToolSet instanceof Set) || enabledToolSet.size === 0) return false;
  for (const name of candidates) {
    const variants = expandToolNameVariants(name);
    for (const variant of variants) {
      if (enabledToolSet.has(variant)) return true;
    }
  }
  return false;
}

// ── Pattern matching ─────────────────────────────────────────────────

function containsPattern(text, pattern) {
  const haystack = String(text || '');
  if (pattern instanceof RegExp) return pattern.test(haystack);
  const raw = String(pattern || '').trim();
  if (!raw) return false;
  if (raw.startsWith('re:')) {
    try { return new RegExp(raw.slice(3), 'i').test(haystack); }
    catch { return haystack.toLowerCase().includes(raw.slice(3).toLowerCase()); }
  }
  return haystack.toLowerCase().includes(raw.toLowerCase());
}

function _detectCapabilityNeeds(message = '', policy = DEFAULT_CAPABILITY_POLICY) {
  const text = String(message || '');
  if (!text) return [];
  const tasks = Array.isArray(policy?.tasks) ? policy.tasks : [];
  const hits = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const patterns = Array.isArray(task.patterns) ? task.patterns : [];
    if (patterns.some(pattern => containsPattern(text, pattern))) hits.push(task);
  }
  return hits;
}

const _dedupeText = require('../utils/dedupeText');

// ── Main assessment ──────────────────────────────────────────────────

function assessExecutionCapability(userMessage, options = {}) {
  const { isComplexTask } = require('./taskComplexity');
  const { looksLikeActionRequest } = require('./intentHeuristics');

  const policy = loadCapabilityPolicy(options);
  const gateEnabled = envFlagEnabled(options.capabilityGate, envFlagEnabled(process.env.KHY_TASK_CAPABILITY_GATE, true));
  const enabled = gateEnabled && envFlagEnabled(policy.enabled, true);
  const mode = String(policy.blockMode || 'strict').trim().toLowerCase();
  const assessment = {
    enabled,
    mode: (mode === 'warn' || mode === 'warning' || mode === 'warn-only') ? 'warn' : 'strict',
    canProceed: true,
    reasons: [],
    warnings: [],
    recommendations: [],
  };
  if (!enabled) return assessment;

  const text = String(userMessage || '').trim();
  if (!text) return assessment;

  const needs = _detectCapabilityNeeds(text, policy);
  const enabledToolSet = _collectEnabledToolNameSet();
  for (const need of needs) {
    const requiredTools = Array.isArray(need?.requiredTools) ? need.requiredTools : [];
    if (requiredTools.length === 0) continue;
    const hasTool = _hasAnyToolEnabled(enabledToolSet, requiredTools);
    if (!hasTool) {
      assessment.reasons.push(
        String(need.reason || `当前环境缺少执行能力：${need.key || 'unknown-task'}`).trim(),
      );
    }
  }

  try {
    // Resolve the model-capability checker via the neutral port instead of a
    // reverse require to cli/ai (DESIGN-ARCH-021, Batch 3). Unregistered (daemon /
    // headless) → null → pre-check skipped, same as the prior require-failure path.
    const checkModelCapability = require('./modelCapabilityPort').getModelCapabilityChecker();
    if (typeof checkModelCapability === 'function') {
      const modelCheck = checkModelCapability(text);
      if (modelCheck && Array.isArray(modelCheck.issues) && modelCheck.issues.length > 0) {
        const modelCfg = (policy && typeof policy.model === 'object') ? policy.model : {};
        if (envFlagEnabled(modelCfg.enabled, true)) {
          const ignoreList = Array.isArray(modelCfg.ignoreIssuePatterns) ? modelCfg.ignoreIssuePatterns : [];
          const hardIssues = modelCheck.issues.filter((issue) => {
            const textIssue = String(issue || '');
            return !ignoreList.some(p => containsPattern(textIssue, p));
          });
          const complexOrAction = isComplexTask(text).isComplex || looksLikeActionRequest(text);
          const hardIssueMin = Math.max(1, parseInt(String(modelCfg.blockWhenHardIssueCountAtLeast ?? '2'), 10) || 2);
          const complexHardIssueMin = Math.max(1, parseInt(String(modelCfg.blockWhenComplexAndHardIssueCountAtLeast ?? '1'), 10) || 1);
          const complexMinChars = Math.max(20, parseInt(String(modelCfg.complexMinChars ?? '160'), 10) || 160);
          const shouldBlockByModel = hardIssues.length >= hardIssueMin
            || (hardIssues.length >= complexHardIssueMin && complexOrAction && text.length >= complexMinChars);

          if (shouldBlockByModel) {
            assessment.reasons.push(`模型能力预判不足：${hardIssues.join('；')}`);
          } else if (modelCheck.issues.length > 0) {
            assessment.warnings.push(`模型能力提醒：${modelCheck.issues.join('；')}`);
          }

          if (Array.isArray(modelCheck.recommendations) && modelCheck.recommendations.length > 0) {
            const labels = modelCheck.recommendations
              .map((item) => String(item?.label || item?.key || '').trim())
              .filter(Boolean);
            assessment.recommendations.push(...labels);
          }
        }
      }
    }
  } catch { /* best effort */ }

  const modelCfg = (policy && typeof policy.model === 'object') ? policy.model : {};
  const maxRecommendations = Math.max(1, parseInt(String(modelCfg.maxRecommendations ?? '3'), 10) || 3);
  assessment.reasons = _dedupeText(assessment.reasons);
  assessment.warnings = _dedupeText(assessment.warnings);
  assessment.recommendations = _dedupeText(assessment.recommendations).slice(0, maxRecommendations);

  if (assessment.mode === 'warn' && assessment.reasons.length > 0) {
    assessment.warnings.push(...assessment.reasons.map(reason => `预判阻断已降级为告警：${reason}`));
    assessment.reasons = [];
    assessment.warnings = _dedupeText(assessment.warnings);
  }

  assessment.canProceed = assessment.reasons.length === 0;
  return assessment;
}

function formatCapabilityFailureResponse(assessment) {
  const reasons = Array.isArray(assessment?.reasons) ? assessment.reasons : [];
  const lines = ['抱歉，执行前能力预判未通过，当前无法可靠完成该任务。'];
  for (let i = 0; i < reasons.length; i++) {
    lines.push(`${i + 1}. ${reasons[i]}`);
  }
  if (Array.isArray(assessment?.recommendations) && assessment.recommendations.length > 0) {
    lines.push(`建议切换模型后重试：${assessment.recommendations.join('、')}`);
  }
  lines.push('你可以把任务拆小、补充更具体上下文，或明确可用工具后再试。');
  return lines.join('\n');
}

// ── Display helpers ──────────────────────────────────────────────────

function extractDecisionPreview(reply = '') {
  const { stripToolCalls, stripExecutionPlan } = require('./deliveryFormatter');
  const plain = stripToolCalls(stripExecutionPlan(String(reply || '')))
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  const sentence = plain.split(/[\n。！？.!?]/).map(s => s.trim()).find(Boolean) || plain;
  return sentence.slice(0, 160);
}

function normalizeToolNameForDisplay(name = '') {
  const raw = String(name || '').trim();
  if (!raw) return '';
  if (raw === '_legacy_cmd') return 'command';
  return raw.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function buildPlannedToolList(toolCalls = [], maxItems = 6) {
  const names = [];
  const seen = new Set();
  for (const call of toolCalls) {
    const normalized = normalizeToolNameForDisplay(call?.name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(normalized);
    if (names.length >= maxItems) break;
  }
  return names;
}

module.exports = {
  envFlagEnabled,
  DEFAULT_CAPABILITY_POLICY,
  loadCapabilityPolicy,
  assessExecutionCapability,
  formatCapabilityFailureResponse,
  extractDecisionPreview,
  normalizeToolNameForDisplay,
  buildPlannedToolList,
  containsPattern,
};
