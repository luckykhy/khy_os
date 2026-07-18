'use strict';

const fs = require('fs');
const path = require('path');
const { detectProject, verify } = require('./verificationAgent');

const BUGFIX_INTENT_PATTERN = /(修复|bug|fix(?:ing|ed)?|hotfix|回归|regression|故障|错误|报错|异常|崩溃|crash|fails?|failing|broken|defect|issue)/i;
const FEATURE_INTENT_PATTERN = /(新增|增加|添加|实现|feature|new\s+feature|enhancement|功能|需求|扩展|重构|refactor|优化|improve|upgrade)/i;
const LOW_TIER_MODEL_PATTERN = /(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i;
const STEP_ALLOWLIST = new Set(['syntax', 'lint', 'typecheck', 'test', 'build']);
const WRITE_TOOL_PATTERN = /^(write_?file|writefile|edit_?file|editfile|edit|multiedit|scaffold_?files?|apply_?patch)$/i;

function _parseBoolean(rawValue, fallback = false) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(normalized)) return false;
  return fallback;
}

function _firstNonEmptyEnv(...keys) {
  for (const key of keys) {
    if (!key) continue;
    const raw = process.env[key];
    if (raw === undefined || raw === null) continue;
    if (String(raw).trim() === '') continue;
    return raw;
  }
  return '';
}

function _normalizeStep(step) {
  const normalized = String(step || '').trim().toLowerCase();
  if (normalized === 'type-check') return 'typecheck';
  return normalized;
}

function _parseSteps(rawValue, fallback = ['syntax', 'test']) {
  if (Array.isArray(rawValue)) {
    return [...new Set(rawValue.map(_normalizeStep).filter(step => STEP_ALLOWLIST.has(step)))];
  }

  const raw = String(rawValue || '').trim();
  if (!raw) return [...fallback];

  const steps = raw
    .split(',')
    .map(item => _normalizeStep(item))
    .filter(step => STEP_ALLOWLIST.has(step));

  return steps.length > 0 ? [...new Set(steps)] : [...fallback];
}

function looksLikeBugfixTask(userMessage = '') {
  return BUGFIX_INTENT_PATTERN.test(String(userMessage || ''));
}

function _detectTaskIntent(userMessage = '') {
  const text = String(userMessage || '');
  if (BUGFIX_INTENT_PATTERN.test(text)) return 'bugfix';
  if (FEATURE_INTENT_PATTERN.test(text)) return 'feature';
  return 'other';
}

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _safeLower = require('../utils/trimLowerCase');

function _resolveModelMeta(chatOpts = {}) {
  let model = String(
    chatOpts.model
      || chatOpts.preferredModel
      || process.env.GATEWAY_PREFERRED_MODEL
      || ''
  ).trim();
  let adapter = String(
    chatOpts.adapter
      || chatOpts.preferredAdapter
      || process.env.GATEWAY_PREFERRED_ADAPTER
      || ''
  ).trim();

  try {
    const gateway = require('./gateway/aiGateway');
    const active = gateway && typeof gateway.getActiveAdapter === 'function'
      ? gateway.getActiveAdapter()
      : null;

    if (!model && active) {
      model = String(active.activeModel || active.model || '').trim();
    }
    if (!adapter && active) {
      adapter = String(active.key || active.adapter || active.name || '').trim();
    }
    if (!adapter && gateway && typeof gateway.getFirstAvailableAdapter === 'function') {
      adapter = String(gateway.getFirstAvailableAdapter() || '').trim();
    }
  } catch { /* best effort */ }

  return { model, adapter };
}

function isLowTierModel(meta = {}) {
  const model = _safeLower(meta.model);
  const adapter = _safeLower(meta.adapter);
  if (adapter === 'localllm' || adapter === 'ollama') return true;
  if (adapter.includes('local llm') || adapter.includes('local')) return true;
  return LOW_TIER_MODEL_PATTERN.test(model);
}

function _normalizeFilePath(rawPath, cwd) {
  const file = String(rawPath || '').trim();
  if (!file) return '';

  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const cwdPrefix = `${path.resolve(cwd)}${path.sep}`;
  if (abs.startsWith(cwdPrefix)) {
    return path.relative(cwd, abs);
  }
  return abs;
}

function collectChangedFiles(toolCallLog = [], cwd = process.cwd()) {
  const files = new Set();
  const pushFile = (candidate) => {
    const normalized = _normalizeFilePath(candidate, cwd);
    if (normalized) files.add(normalized);
  };

  for (const entry of (toolCallLog || [])) {
    const tool = String(entry?.tool || entry?.name || '').trim();
    if (!WRITE_TOOL_PATTERN.test(tool)) continue;
    const succeeded = entry?.result ? entry.result.success !== false : true;
    if (!succeeded) continue;

    const params = entry?.params || {};
    pushFile(params.path);
    pushFile(params.file_path);
    pushFile(params.filePath);

    if (Array.isArray(params.files)) {
      for (const fileItem of params.files) {
        if (typeof fileItem === 'string') {
          pushFile(fileItem);
          continue;
        }
        pushFile(fileItem?.path || fileItem?.file_path || fileItem?.filePath);
      }
    }

    if (Array.isArray(params.operations)) {
      for (const op of params.operations) {
        pushFile(op?.path || op?.file_path || op?.filePath);
      }
    }

    pushFile(entry?.result?.filePath);
    pushFile(entry?.result?.path);
  }

  return [...files];
}

function _buildStepSkipList(availableSteps = [], selectedSteps = []) {
  const selected = new Set(selectedSteps);
  return availableSteps.filter(step => !selected.has(step));
}

function _runVerificationSnapshot(params = {}) {
  const cwd = params.cwd || process.cwd();
  const files = Array.isArray(params.files) ? params.files : [];
  const requiredSteps = _parseSteps(params.requiredSteps, ['syntax', 'test']);

  let project;
  try {
    project = detectProject(cwd);
  } catch (err) {
    return {
      error: `detectProject failed: ${err?.message || 'unknown error'}`,
      projectType: 'unknown',
      availableSteps: [],
      selectedSteps: [],
      missingRequiredSteps: [...requiredSteps],
    };
  }

  const availableSteps = Array.isArray(project?.steps) ? project.steps.map(_normalizeStep) : [];
  const availableSet = new Set(availableSteps);
  const missingRequiredSteps = requiredSteps.filter(step => !availableSet.has(step));

  let selectedSteps = requiredSteps.filter(step => availableSet.has(step));
  if (selectedSteps.length === 0) {
    selectedSteps = [...availableSteps];
  }

  const skipSteps = _buildStepSkipList(availableSteps, selectedSteps);
  let result;
  try {
    result = verify({
      cwd,
      files,
      skipSteps,
      failFast: false,
    });
  } catch (err) {
    return {
      error: `verify failed: ${err?.message || 'unknown error'}`,
      projectType: project?.type || 'unknown',
      availableSteps,
      selectedSteps,
      missingRequiredSteps,
    };
  }

  const failedSteps = (result?.steps || [])
    .filter(step => !step.pass)
    .map(step => step.name);

  return {
    error: null,
    projectType: result?.projectType || project?.type || 'unknown',
    availableSteps,
    selectedSteps,
    missingRequiredSteps,
    passed: !!result?.passed,
    failCount: failedSteps.length,
    failedSteps,
    summary: String(result?.summary || ''),
    steps: Array.isArray(result?.steps) ? result.steps : [],
  };
}

function prepareBugfixRegressionGate(params = {}) {
  const cwd = params.cwd || process.cwd();
  const chatOpts = params.chatOpts || {};
  const userMessage = String(params.userMessage || '');
  const requiredSteps = _parseSteps(
    _firstNonEmptyEnv('KHY_CHANGE_MIN_REQUIRED_STEPS', 'KHY_BUGFIX_MIN_REQUIRED_STEPS'),
    ['syntax', 'test'],
  );
  const enabled = _parseBoolean(
    _firstNonEmptyEnv('KHY_CHANGE_REGRESSION_GATE', 'KHY_BUGFIX_REGRESSION_GATE'),
    true,
  );
  const lowTierOnly = _parseBoolean(
    _firstNonEmptyEnv('KHY_CHANGE_LOW_TIER_ONLY', 'KHY_BUGFIX_LOW_TIER_ONLY'),
    true,
  );
  const includeFeatureTasks = _parseBoolean(
    _firstNonEmptyEnv('KHY_CHANGE_GATE_INCLUDE_FEATURE', 'KHY_BUGFIX_GATE_INCLUDE_FEATURE'),
    true,
  );
  const failOnMissingRequiredSteps = _parseBoolean(
    _firstNonEmptyEnv(
      'KHY_CHANGE_FAIL_ON_MISSING_REQUIRED_STEPS',
      'KHY_BUGFIX_FAIL_ON_MISSING_REQUIRED_STEPS',
    ),
    false,
  );
  const failOpen = _parseBoolean(
    _firstNonEmptyEnv('KHY_CHANGE_GATE_FAIL_OPEN', 'KHY_BUGFIX_GATE_FAIL_OPEN'),
    false,
  );
  const runBaseline = _parseBoolean(
    _firstNonEmptyEnv('KHY_CHANGE_GATE_BASELINE', 'KHY_BUGFIX_GATE_BASELINE'),
    true,
  );

  const taskIntent = _detectTaskIntent(userMessage);
  const bugfixIntent = taskIntent === 'bugfix';
  const featureIntent = taskIntent === 'feature';
  const modelMeta = _resolveModelMeta(chatOpts);
  const lowTierModel = isLowTierModel(modelMeta);

  const intentMatched = bugfixIntent || (includeFeatureTasks && featureIntent);
  const shouldRun = enabled && intentMatched && (!lowTierOnly || lowTierModel);
  const reason = !enabled
    ? 'change regression gate disabled'
    : (!intentMatched
      ? 'message is not recognized as protected change task'
      : (lowTierOnly && !lowTierModel
        ? 'low-tier-only gate skipped for high-tier model'
        : 'active'));

  let baseline = null;
  if (shouldRun && runBaseline) {
    baseline = _runVerificationSnapshot({
      cwd,
      files: [],
      requiredSteps,
    });
  }

  return {
    enabled,
    shouldRun,
    reason,
    cwd,
    userMessage,
    requiredSteps,
    failOnMissingRequiredSteps,
    failOpen,
    runBaseline,
    includeFeatureTasks,
    taskIntent,
    bugfixIntent,
    featureIntent,
    lowTierModel,
    model: modelMeta.model || '',
    adapter: modelMeta.adapter || '',
    baseline,
  };
}

function _buildRegressionSummary(report) {
  if (!report || report.passed) {
    if (report && report.mode === 'no_baseline') {
      return 'Change regression gate passed (baseline disabled, current verification clean).';
    }
    return 'Change regression gate passed.';
  }
  if (report.error) {
    return `Change regression gate failed: ${report.error}`;
  }

  const parts = [];
  if (report.regressedSteps.length > 0) {
    parts.push(`new failing step(s): ${report.regressedSteps.join(', ')}`);
  }
  if (report.failCountIncreased) {
    if (report.baseline && Number.isFinite(report.baseline.failCount)) {
      parts.push(`failure count increased ${report.baseline.failCount} -> ${report.current.failCount}`);
    } else {
      parts.push(`verification has failing step(s): ${report.current.failCount}`);
    }
  }
  if (report.missingRequiredBlocking) {
    parts.push(`required verification step(s) missing: ${report.current.missingRequiredSteps.join(', ')}`);
  }
  if (report.mode === 'no_baseline') {
    parts.push('baseline disabled; current verification must stay clean');
  }
  if (parts.length === 0) {
    parts.push('post-change verification did not meet gate requirements');
  }
  return `Change regression gate blocked delivery: ${parts.join('; ')}.`;
}

function evaluateBugfixRegressionGate(params = {}) {
  const context = params.context || {};
  const cwd = params.cwd || context.cwd || process.cwd();
  const requiredSteps = Array.isArray(context.requiredSteps) ? context.requiredSteps : ['syntax', 'test'];

  if (!context.enabled || !context.shouldRun) {
    return {
      enabled: !!context.enabled,
      skipped: true,
      passed: true,
      reason: context.reason || 'gate not active',
      summary: 'Change regression gate skipped.',
      taskIntent: context.taskIntent || 'other',
      bugfixIntent: !!context.bugfixIntent,
      featureIntent: !!context.featureIntent,
      lowTierModel: !!context.lowTierModel,
      model: context.model || '',
      adapter: context.adapter || '',
    };
  }

  const changedFiles = collectChangedFiles(params.toolCallLog, cwd);
  const current = _runVerificationSnapshot({
    cwd,
    files: changedFiles,
    requiredSteps,
  });
  const baseline = context.baseline || null;

  const report = {
    enabled: true,
    skipped: false,
    passed: true,
    reason: 'active',
    taskIntent: context.taskIntent || 'other',
    bugfixIntent: !!context.bugfixIntent,
    featureIntent: !!context.featureIntent,
    lowTierModel: !!context.lowTierModel,
    model: context.model || '',
    adapter: context.adapter || '',
    requiredSteps: [...requiredSteps],
    changedFiles,
    baseline,
    current,
    mode: baseline ? 'diff' : (context.runBaseline ? 'diff' : 'no_baseline'),
    regressedSteps: [],
    failCountIncreased: false,
    missingRequiredBlocking: false,
    error: '',
    summary: '',
    recommendations: [],
  };

  if (baseline && baseline.error) {
    report.error = `baseline verification error: ${baseline.error}`;
  } else if (current.error) {
    report.error = `post-change verification error: ${current.error}`;
  } else if (!Array.isArray(current.selectedSteps) || current.selectedSteps.length === 0) {
    report.error = 'no verification steps detected for protected change task';
  }

  if (report.error) {
    report.passed = !!context.failOpen;
    report.summary = _buildRegressionSummary(report);
    report.recommendations = [
      'Run the required verification steps manually and retry.',
      'If this is intentional, disable strict mode via KHY_CHANGE_GATE_FAIL_OPEN=true (legacy: KHY_BUGFIX_GATE_FAIL_OPEN=true).',
    ];
    return report;
  }

  const currentFailed = (current?.failedSteps || []).map(step => String(step));
  report.missingRequiredBlocking = !!context.failOnMissingRequiredSteps
    && Array.isArray(current?.missingRequiredSteps)
    && current.missingRequiredSteps.length > 0;

  if (report.mode === 'no_baseline') {
    report.regressedSteps = [...currentFailed];
    report.failCountIncreased = (current?.failCount || 0) > 0;
    report.passed = (current?.failCount || 0) === 0 && !report.missingRequiredBlocking;
  } else {
    const baselineFailed = new Set((baseline?.failedSteps || []).map(step => String(step)));
    report.regressedSteps = currentFailed.filter(step => !baselineFailed.has(step));
    report.failCountIncreased = (current?.failCount || 0) > (baseline?.failCount || 0);
    report.passed = report.regressedSteps.length === 0
      && !report.failCountIncreased
      && !report.missingRequiredBlocking;
  }

  report.summary = _buildRegressionSummary(report);

  if (!report.passed) {
    report.recommendations.push('Reproduce the new failing steps and fix them before final delivery.');
    if (report.lowTierModel) {
      report.recommendations.push('Switch to a higher-tier model for remediation if failures persist.');
    }
  }

  return report;
}

function prepareChangeRegressionGate(params = {}) {
  return prepareBugfixRegressionGate(params);
}

function evaluateChangeRegressionGate(params = {}) {
  return evaluateBugfixRegressionGate(params);
}

module.exports = {
  prepareChangeRegressionGate,
  evaluateChangeRegressionGate,
  prepareBugfixRegressionGate,
  evaluateBugfixRegressionGate,
  looksLikeBugfixTask,
  isLowTierModel,
  collectChangedFiles,
  _runVerificationSnapshot,
  LOW_TIER_MODEL_PATTERN,
  BUGFIX_INTENT_PATTERN,
  FEATURE_INTENT_PATTERN,
};
