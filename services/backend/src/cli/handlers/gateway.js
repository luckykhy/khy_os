/**
 * CLI Handlers for the AI Gateway system.
 * Commands: gateway status, gateway config, gateway relay, gateway debug-prompt
 */
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const {
  printSuccess,
  printError,
  printInfo,
  printTable,
  ICON_GATEWAY,
  stripAnsi,
  displayWidth,
  padToWidth,
  truncateToWidth,
  safeTerminalString,
} = require('../formatters');
const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');
const {
  OLLAMA_HOST: OLLAMA_HOST_DEFAULT,
  getAiBackendUrl,
} = require('../../constants/serviceDefaults');
// Model-name SSOT: relay default flows from constants/models.js
// (env RELAY_API_MODEL still overrides first).
const { PRIMARY: MODELS } = require('../../constants/models');
const {
  buildGatewayManageFeatureLabel,
  buildGatewayRelayFeatureLabel,
  getFeatureFamilyPrefix,
  joinFeatureKey,
} = require('../../services/featureKeyBuilder');
const { parseApiKeyEntries, extractPrimaryApiKey } = require('../../services/apiKeyFormat');
const _sleep = require('../../utils/sleep'); // single-source sleep ([MGMT-RPT-020] REQ-2026-010)
// AI 管理台守护进程生命周期子系统已抽为同目录叶子；按同名 re-import 保契约不变（零反向依赖）。
const {
  handleGatewayManage,
  handleAiServer,
  _resolveAiManageApiBaseUrl,
  _parseIntWithMin,
} = require('./gatewayManageDaemon');

// 供应商 / API Key / 账号池 / 自定义供应商交互子系统已抽为同目录叶子；按同名 re-import 保契约不变。
// 叶子对宿主仅两处函数级回依赖（promptWithReplGuard / _resolveEnvPathForDiscoverModels）经 DI 注入，无环。
const {
  handleGatewayDiscoverModels,
  handleGatewayModels,
  handleGatewayKey,
  handleGatewayAdd,
  handleGatewayPool,
  _addCustomProviderInteractive,
  setGatewayProviderKeyPoolDeps,
} = require('./gatewayProviderKeyPool');
setGatewayProviderKeyPoolDeps({ promptWithReplGuard, _resolveEnvPathForDiscoverModels });


// AI 模型选择 / 探测 / 供应商切换子系统已抽为同目录叶子；按同名 re-import 保命令契约不变。
// require 早于下方 config-editor DI（其 setter 需 buildGatewayModelChoices/handleGatewaySelectModel 引用）；
// 叶子对宿主 24 处函数级 + STRICT_OPERATIONAL_ADAPTERS 值经 DI 注入（见下方 setGatewayModelChoicesDeps），无环。
const {
  buildGatewayModelChoices,
  applyGatewayModelSelection,
  handleGatewaySelectModel,
  buildVendorModelChoices,
  handleModelSwitchByVendor,
  setGatewayModelChoicesDeps,
} = require('./gatewayModelChoices');
// 网关配置编辑子系统已抽为同目录叶子；按同名 re-import 保 handleGatewayConfig 契约不变。
// 叶子对宿主 10 处函数级回依赖经 DI 注入（含 provider-key 叶子的 _addCustomProviderInteractive），无环。
const { handleGatewayConfig, setGatewayConfigEditorDeps } = require('./gatewayConfigEditor');
setGatewayConfigEditorDeps({
  promptWithReplGuard,
  _parseJsonObject,
  _mergeJsonEnvVar,
  _removeJsonEnvVarKey,
  _safeJsonLine,
  _writeEnvMap,
  _unsetEnvKeys,
  buildGatewayModelChoices,
  handleGatewaySelectModel,
  _addCustomProviderInteractive,
});

// relay / 通道检测 / 连通测试 / 工具探测 / 采样自检子系统已抽为同目录叶子；按同名 re-import 保契约不变。
// 叶子对宿主 4 处函数级回依赖（promptWithReplGuard / _compactReasonText / _getGatewayHomeRiskSnapshot / _writeEnvMap）经 DI 注入，无环。
const {
  handleGatewayRelay,
  handleGatewayDetect,
  handleGatewayTest,
  _isGatewaySamplePromptInjected,
  _readGatewaySampleRunSummary,
  _summarizeGatewaySampleCounts,
  handleGatewayProbeTools,
  handleGatewaySample,
  setGatewayRuntimeProbesDeps,
} = require('./gatewayRuntimeProbes');
setGatewayRuntimeProbesDeps({ promptWithReplGuard, _compactReasonText, _getGatewayHomeRiskSnapshot, _writeEnvMap });

// gateway status 展示子系统已抽为同目录叶子；按同名 re-import 保 `gateway status` 契约不变。
// 叶子对宿主 17 处函数级回依赖经 DI 注入（均为已提升的函数声明），无环。
const { handleGatewayStatus, setGatewayStatusViewDeps } = require('./gatewayStatusView');
setGatewayStatusViewDeps({
  _getGatewayHomeRiskSnapshot,
  shouldTreatGenerationFailureAsWarning,
  shouldTreatConnectivityFailureAsWarning,
  _resolvePreferredAdapterIssue,
  _appendGatewayProtocolRiskDetail,
  getGatewayDebugPromptSnapshot,
  _printGatewayStatusTable,
  _buildGatewayLanguageConsistencyText,
  _buildGatewayTraceCommandHint,
  _printLatencyAutoTuneSnapshot,
  maybeAutoSyncSwitchCenterForGateway,
  _resolvePreferredRouteSnapshot,
  _collectConfiguredEndpointObjects,
  _parseProviderFilterFromOptions,
  _filterEndpointObjectsByProvider,
  withTimeout,
  _resolveEnvPathForGateway,
});

const STRICT_OPERATIONAL_ADAPTERS = new Set(
  String(process.env.KHY_MODEL_STRICT_ADAPTERS || 'codex,claude,windsurf,trae,cursor,relay_api')
    .split(',')
    .map(x => String(x || '').trim().toLowerCase())
    .filter(Boolean)
);

// 一次性注入 model-choices 叶子的宿主回依赖（函数声明均已提升 + STRICT_OPERATIONAL_ADAPTERS 已定义于上）。
setGatewayModelChoicesDeps({
  promptWithReplGuard,
  _getDeepProbeCache,
  _setDeepProbeCache,
  _getAdapterProbeTimeoutMs,
  _getAdapterModelListTimeoutMs,
  shouldTreatGenerationFailureAsWarning,
  _compactReasonText,
  _isTimeoutLikeReason,
  _isTransientProbeLikeReason,
  _classifyHiddenReason,
  _shouldRetryProbeByDebounce,
  _formatModelSourceTag,
  _formatConnectionTag,
  _formatUpstreamTag,
  _formatVisionTag,
  _resolvePreferredAdapterIssue,
  _filterModelsByReliability,
  maybeAutoSyncSwitchCenterForGateway,
  getTokenInfoForSelection,
  askLine,
  recoverGatewayPromptInput,
  withTimeout,
  isAdapterOperational,
  persistGatewayPreference,
  STRICT_OPERATIONAL_ADAPTERS,
});
const MODEL_DEEP_PROBE_CACHE_MS = Math.max(
  10000,
  parseInt(process.env.KHY_MODEL_DEEP_PROBE_CACHE_MS || '300000', 10) || 300000
);
const KIRO_PROBE_TIMEOUT_MS = Math.max(
  8000,
  parseInt(process.env.KHY_MODEL_KIRO_PROBE_TIMEOUT_MS || '20000', 10) || 20000
);
const KIRO_MODEL_LIST_TIMEOUT_MS = Math.max(
  KIRO_PROBE_TIMEOUT_MS,
  parseInt(process.env.KHY_MODEL_KIRO_LIST_TIMEOUT_MS || '25000', 10) || 25000
);
const MODEL_HIDE_UNVERIFIED_ENABLED = String(process.env.KHY_MODEL_HIDE_UNVERIFIED || 'true').toLowerCase() !== 'false';
const MODEL_HIDE_FALLBACK_MODELS_ENABLED = String(process.env.KHY_MODEL_HIDE_FALLBACK_MODELS || 'false').toLowerCase() !== 'false';
const MODEL_HIDE_HINT_MODELS_ENABLED = String(process.env.KHY_MODEL_HIDE_HINT_MODELS || 'false').toLowerCase() !== 'false';
const MODEL_WARN_KEEP_MAX = Math.max(
  1,
  parseInt(process.env.KHY_MODEL_WARN_KEEP_MAX || '3', 10) || 3
);
const _modelDeepProbeCache = new Map(); // key: adapter type -> { at, test }
const AI_MANAGE_RUNTIME_FILE = path.join(getDataHome(), 'ai_manage_runtime.json');
const AI_MANAGE_RUNTIME_FILE_LEGACY = path.join(getLegacyDataHome(), 'ai_manage_runtime.json');
const AI_MANAGE_READY_TIMEOUT_MS = Math.max(
  20000,
  parseInt(process.env.AI_MANAGE_READY_TIMEOUT_MS || '65000', 10) || 65000
);
const AI_MANAGE_HEALTH_WAIT_MS = Math.max(
  5000,
  parseInt(process.env.AI_MANAGE_HEALTH_WAIT_MS || '18000', 10) || 18000
);
const AI_MANAGE_HEALTH_POLL_MS = Math.max(
  200,
  parseInt(process.env.AI_MANAGE_HEALTH_POLL_MS || '600', 10) || 600
);
const AI_MANAGE_DAEMON_SCRIPT = path.resolve(__dirname, '../../../scripts/ai-manage-daemon.js');
const KHY_GATEWAY_DEBUG_PROMPT_DEFAULT_FILE = path.join(getDataHome(), 'logs', 'khy_gateway_prompt_debug.log');

const _isPathWithin = require('../../utils/isPathWithin');

function _getGatewayHomeRiskSnapshot(options = {}) {
  const activeAdapterType = String(options.activeAdapterType || '').trim().toLowerCase();
  const envHome = String(process.env.HOME || '').trim();
  const resolvedHome = envHome || os.homedir() || '';
  const tmpDir = String(os.tmpdir() || '').trim();
  const isTempHome = !!resolvedHome && !!tmpDir && _isPathWithin(tmpDir, resolvedHome);
  const hint = isTempHome
    ? `当前 HOME=${resolvedHome} 位于临时目录；Codex CLI 在临时 HOME 下可能出现 tls handshake eof / reconnect 假故障。`
    : '';
  const recommendation = isTempHome
    ? '建议改回真实用户主目录后再采样。'
    : '';
  return {
    homeDir: resolvedHome,
    tmpDir,
    isTempHome,
    hint,
    recommendation,
    activeAdapterAffected: activeAdapterType === 'codex',
  };
}

async function promptWithReplGuard(questions = []) {
  // When the Ink TUI owns the terminal, raw inquirer would topple the managed
  // UI (stdin stays TTY so the non-TTY guards miss it). Route through the
  // native uiPrompt bridge instead; it transparently falls back to real
  // inquirer when the TUI is inactive or a question uses an unsupported
  // feature, so classic-REPL behaviour is unchanged.
  const { isTuiActive, promptCompat } = require('../uiPrompt');
  if (isTuiActive()) {
    return await promptCompat(questions);
  }
  const inquirer = require('inquirer');
  const hadGuard = global.__KHY_INQUIRER_ACTIVE__ === true;
  global.__KHY_INQUIRER_ACTIVE__ = true;
  try {
    return await inquirer.prompt(questions);
  } finally {
    // Defer clearing the guard by one macrotask. When inquirer tears down its
    // readline it can fire a 'close' event on the REPL's readline slightly
    // after prompt() resolves; the REPL close-guard must still see the flag as
    // active, otherwise that stray close is misread as Ctrl+D and exits KHY.
    if (!hadGuard) {
      setImmediate(() => { global.__KHY_INQUIRER_ACTIVE__ = false; });
    }
  }
}

function _getDeepProbeCache(adapterType) {
  const key = String(adapterType || '').toLowerCase();
  if (!key) return null;
  const entry = _modelDeepProbeCache.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.at) > MODEL_DEEP_PROBE_CACHE_MS) {
    _modelDeepProbeCache.delete(key);
    return null;
  }
  return entry;
}

function _setDeepProbeCache(adapterType, test) {
  const key = String(adapterType || '').toLowerCase();
  if (!key) return;
  _modelDeepProbeCache.set(key, { at: Date.now(), test });
}

function _getAdapterProbeTimeoutMs(adapterType, fallbackMs) {
  const type = String(adapterType || '').toLowerCase();
  if (type === 'kiro') return Math.max(fallbackMs, KIRO_PROBE_TIMEOUT_MS);
  return fallbackMs;
}

function _getAdapterModelListTimeoutMs(adapterType, fallbackMs) {
  const type = String(adapterType || '').toLowerCase();
  if (type === 'kiro') return Math.max(fallbackMs, KIRO_MODEL_LIST_TIMEOUT_MS);
  return fallbackMs;
}

function shouldTreatGenerationFailureAsWarning(adapterType) {
  // CLI-bridge related adapters can be environment-dependent.
  // Keep them selectable with warning instead of hard-blocking.
  // Local inference adapters must pass generation probe; otherwise mark unavailable.
  return ['cli', 'claude', 'codex'].includes(String(adapterType || '').toLowerCase());
}

function shouldTreatConnectivityFailureAsWarning(adapterType, reasonText = '') {
  const type = String(adapterType || '').toLowerCase();
  const reason = String(reasonText || '').trim();
  if (!reason) return false;
  // Local inference channels should stay strict on connectivity failures.
  if (type === 'localllm' || type === 'ollama') return false;
  // Auth/install/configuration failures are real blockers.
  if (_isAuthOrInstallLikeReason(reason)) return false;
  // Timeout/process/network-like probe failures are treated as transient warnings.
  return _isTransientProbeLikeReason(reason);
}

function _compactReasonText(text, maxLen = 140) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function _isTimeoutLikeReason(reasonText = '') {
  return /timeout|timed out|stream stalled|reconnecting|channel closed|socket hang up|econnreset|broken pipe|fetch failed|network error/i
    .test(String(reasonText || ''));
}

function _isAuthOrInstallLikeReason(reasonText = '') {
  return /auth|api[_\s-]?key|apikeysource|token|not authenticated|unauthorized|forbidden|login|permission denied|no token|not set|unavailable|command .* not found|not found|enoent/i
    .test(String(reasonText || ''));
}

function _isTransientProbeLikeReason(reasonText = '') {
  return _isTimeoutLikeReason(reasonText)
    || /exited with code|without emitting stream-json output|launch blocked|failed to record rollout items|temporarily unavailable|service unavailable|try again later|overloaded|busy/i
      .test(String(reasonText || ''));
}

function _classifyHiddenReason(status, test, fallbackReason = '') {
  const preferred = _compactReasonText(fallbackReason)
    || _compactReasonText(test?.generation?.error)
    || _compactReasonText(test?.models?.error)
    || _compactReasonText(test?.connectivity?.error)
    || '';
  const text = preferred.toLowerCase();
  if (!text) return '实测失败';
  if (_isAuthOrInstallLikeReason(text)) return `未登录/缺少凭证或未安装: ${preferred}`;
  if (_isTimeoutLikeReason(text)) return `探测超时: ${preferred}`;
  if (text.includes('not detected')) return '未检测到通道可用';
  return preferred;
}

function _extractProbeReasonText(test = {}) {
  return String(
    test?.generation?.error
    || test?.models?.error
    || test?.connectivity?.error
    || ''
  ).trim();
}

function _shouldRetryProbeByDebounce(status = {}, test = {}) {
  const reasonText = _extractProbeReasonText(test);
  if (!reasonText) return false;
  if (_isAuthOrInstallLikeReason(reasonText)) return false;
  return _isTransientProbeLikeReason(reasonText);
}

function _formatModelSourceTag(model = {}) {
  const raw = String(model.discoverySource || model.source || '').trim().toLowerCase();
  if (!raw) return '';
  const map = {
    remote: '远端发现',
    local: '本地发现',
    'remote+local': '远端+本地',
    builtin: '内置',
    config: '配置项',
  };
  const label = map[raw] || raw;
  return chalk.dim(`[${label}]`);
}

function _formatConnectionTag(model = {}) {
  const mode = String(model.connectionMode || '').trim().toLowerCase();
  if (!mode) return '';
  const map = {
    direct: chalk.cyan('⚡直连'),
    bridge: chalk.yellow('🔗中转桥接'),
    proxy: chalk.dim('🔗代理中转'),
    local: chalk.green('📦本地推理'),
    auto: chalk.magenta('✨自动'),
  };
  return map[mode] || chalk.dim(mode);
}

function _formatUpstreamTag(model = {}) {
  const provider = String(model.upstreamProvider || '').trim();
  const host = String(model.upstreamHost || '').trim();
  if (!provider && !host) return '';
  const payload = host ? `${provider || 'unknown'} @ ${host}` : provider;
  return chalk.dim(`[上游:${payload}]`);
}

// 视觉徽章门控 KHY_MODEL_VISION_BADGE(默认开;flagRegistry 优先,注册表不可用 → 本地 CANON 回退)。
const _VISION_BADGE_FALSY = new Set(['0', 'false', 'off', 'no']);
function _visionBadgeEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_MODEL_VISION_BADGE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e && e.KHY_MODEL_VISION_BADGE;
  return !(v !== undefined && v !== null && _VISION_BADGE_FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 为具备识图(视觉)能力的模型渲染「👁 视觉」徽章,让用户在 `/model` 列表里一眼认出
 * glm-4.6v-flash 这类视觉理解模型。视觉判定复用单一真源 visionCapability.isVisionCapableModel
 * (覆盖 GLM glm-4.6v 子串 + KHY_VISION_MODELS + modern hints)。门控关 / 判不出 / 异常 → ''
 * (逐字节回退:行不含徽章)。绝不抛。
 * @param {object} model 至少含 id;可含 modality
 * @returns {string}
 */
function _formatVisionTag(model = {}) {
  try {
    if (!_visionBadgeEnabled(process.env)) return '';
    const id = String((model && (model.id || model.model || model.name)) || '').trim();
    let isVision = String((model && model.modality) || '').trim().toLowerCase() === 'vision';
    if (!isVision && id) {
      const vc = require('../../services/gateway/visionCapability');
      if (vc && typeof vc.isVisionCapableModel === 'function') {
        isVision = vc.isVisionCapableModel(id, { env: process.env });
      }
    }
    return isVision ? chalk.magenta('👁 视觉') : '';
  } catch {
    return '';
  }
}

function _isPreferredAdapterModel(adapterType, modelId) {
  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
  const preferredModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  if (!preferredAdapter || !preferredModel) return false;
  return preferredAdapter === String(adapterType || '').trim().toLowerCase()
    && String(modelId || '').trim() === preferredModel;
}

function _resolvePreferredAdapterIssue(statuses = [], testResults = {}) {
  const configuredRaw = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
  const configured = configuredRaw.toLowerCase();
  if (!configured || configured === 'auto') return null;
  const matched = Array.isArray(statuses)
    ? statuses.find((s) => String(s?.type || '').trim().toLowerCase() === configured)
    : null;
  if (!matched) {
    return {
      type: 'invalid',
      configured: configuredRaw,
      message: `首选通道配置错误: "${configuredRaw}" 未注册`,
    };
  }

  const test = testResults && typeof testResults === 'object' ? testResults[matched.type] : null;
  const reason = _compactReasonText(
    test?.generation?.error
    || test?.models?.error
    || test?.connectivity?.error
    || matched.detail
    || ''
  );
  if (!matched.enabled || !matched.available) {
    return {
      type: 'unavailable',
      configured: configuredRaw,
      adapterType: matched.type,
      reason,
      message: reason
        ? `首选通道当前不可用: ${matched.type}（${reason}）`
        : `首选通道当前不可用: ${matched.type}`,
    };
  }
  return null;
}

function _normalizeGatewayStatusCellText(value) {
  return safeTerminalString(String(value || ''))
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _buildGatewayStatusColumnWidths() {
  const terminalWidth = Math.max(27, Number(process.stdout.columns || 100));
  const fixedChars = 21; // indent + borders + separators + paddings for 6 columns
  const contentBudget = Math.max(6, terminalWidth - fixedChars);

  const preferred = [6, 14, 8, 8, 14, 30];
  const softMinimum = [4, 10, 6, 8, 10, 16];
  const hardMinimum = [1, 4, 3, 4, 6, 8];
  const widths = preferred.slice();
  // 详情列（index 5）最后缩减，确保 endpoint 名称可见。
  const shrinkOrder = [0, 2, 3, 4, 1, 5];

  const sumWidths = () => widths.reduce((sum, w) => sum + w, 0);
  const shrinkToMinimum = (minSet) => {
    let total = sumWidths();
    for (const idx of shrinkOrder) {
      if (total <= contentBudget) break;
      const canShrink = Math.max(0, widths[idx] - minSet[idx]);
      if (canShrink <= 0) continue;
      const delta = Math.min(canShrink, total - contentBudget);
      widths[idx] -= delta;
      total -= delta;
    }
  };

  shrinkToMinimum(softMinimum);
  shrinkToMinimum(hardMinimum);

  // Extreme narrow fallback: continue shrinking down to 1-char columns.
  let total = sumWidths();
  if (total > contentBudget) {
    for (const idx of shrinkOrder) {
      while (total > contentBudget && widths[idx] > 1) {
        widths[idx] -= 1;
        total -= 1;
      }
      if (total <= contentBudget) break;
    }
  }

  if (total < contentBudget) widths[5] += (contentBudget - total);

  return widths;
}

function _truncatePlainByWidth(text, maxWidth) {
  const source = String(text || '');
  if (maxWidth <= 0) return '';
  if (displayWidth(source) <= maxWidth) return source;
  let out = '';
  for (const ch of source) {
    if (displayWidth(out + ch) > maxWidth) break;
    out += ch;
  }
  return out;
}

function _renderGatewayStatusCell(value, width, colorizer) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const plain = _normalizeGatewayStatusCellText(stripAnsi(String(value || '')));
  const trimmed = safeWidth >= 4
    ? truncateToWidth(plain, safeWidth)
    : _truncatePlainByWidth(plain, safeWidth);
  const styled = typeof colorizer === 'function' ? colorizer(trimmed) : trimmed;
  return padToWidth(styled, safeWidth);
}

function _appendGatewayProtocolRiskDetail(detail = '', risk = null) {
  const baseDetail = String(detail || '').trim();
  if (!risk) return baseDetail;
  const protocolDetail = risk.risky ? '协议风险: 上游可覆盖' : '协议: KHY 优先';
  return baseDetail ? `${baseDetail} · ${protocolDetail}` : protocolDetail;
}

function _resolveGatewayDebugPromptLogFile(options = {}) {
  const explicit = String(options.file || options.logFile || '').trim();
  if (explicit) return explicit;
  const envFile = String(process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE || '').trim();
  if (envFile) return envFile;
  return KHY_GATEWAY_DEBUG_PROMPT_DEFAULT_FILE;
}

function _parseGatewayPromptDebugBlock(block = '') {
  const lines = String(block || '')
    .split(/\r?\n/)
    .map(line => String(line || '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const header = lines[0];
  const headerMatch = header.match(/^\[(.+?)\]\s+adapter=([^\s]+)\s+provider="([^"]*)"$/);
  const entry = {
    timestamp: headerMatch?.[1] || '',
    adapter: headerMatch?.[2] || '',
    provider: headerMatch?.[3] || '',
    hasSystem: false,
    systemLength: 0,
    promptLength: 0,
    capsuleMode: '',
    promptCapsules: [],
    capsuleReasons: [],
    systemPreview: '',
    promptPreview: '',
    raw: block,
  };

  for (const line of lines.slice(1)) {
    if (line.startsWith('system_preview=')) {
      entry.systemPreview = line.slice('system_preview='.length).trim();
      continue;
    }
    if (line.startsWith('prompt_preview=')) {
      entry.promptPreview = line.slice('prompt_preview='.length).trim();
      continue;
    }
    const tokenRegex = /([a-z_]+)=("[^"]*"|\S+)/gi;
    let match = null;
    while ((match = tokenRegex.exec(line))) {
      const key = String(match[1] || '').toLowerCase();
      const value = String(match[2] || '').replace(/^"|"$/g, '');
      if (key === 'has_system') entry.hasSystem = value === '1' || value === 'true';
      if (key === 'system_length') entry.systemLength = Math.max(0, parseInt(value, 10) || 0);
      if (key === 'prompt_length') entry.promptLength = Math.max(0, parseInt(value, 10) || 0);
      if (key === 'capsule_mode') entry.capsuleMode = value;
      if (key === 'prompt_capsules') entry.promptCapsules = value && value !== '-' ? value.split(',').map(x => String(x || '').trim()).filter(Boolean) : [];
      if (key === 'capsule_reasons') entry.capsuleReasons = value && value !== '-' ? value.split(',').map(x => String(x || '').trim()).filter(Boolean) : [];
    }
  }

  return entry;
}

function _readGatewayPromptDebugEntries(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return String(raw || '')
    .split(/\n\s*\n/g)
    .map(chunk => _parseGatewayPromptDebugBlock(chunk))
    .filter(Boolean);
}

function _formatGatewayPromptDebugWhen(timestamp = '') {
  const text = String(timestamp || '').trim();
  if (!text) return '-';
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return text;
  return new Date(parsed).toLocaleString('zh-CN', { hour12: false });
}

function getGatewayDebugPromptSnapshot(options = {}) {
  const filePath = _resolveGatewayDebugPromptLogFile(options);
  const tail = Math.min(50, _parseIntWithMin(options.tail ?? options.n, 5, 1));
  const debugEnabled = String(process.env.KHY_GATEWAY_DEBUG_PROMPT || '').trim() === '1';
  const envFile = String(process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE || '').trim();
  const configured = !!String(options.file || options.logFile || '').trim() || !!envFile;
  const exists = fs.existsSync(filePath);
  const recommendedCommand = `KHY_GATEWAY_DEBUG_PROMPT=1 KHY_GATEWAY_DEBUG_PROMPT_FILE=${filePath} khy gateway status`;
  const allEntries = exists ? _readGatewayPromptDebugEntries(filePath) : [];
  const { adapterFilter, entries } = _filterGatewayPromptDebugEntries(allEntries, options);
  const shownEntries = tail > 0 ? entries.slice(-tail) : entries;
  const latest = entries.length > 0 ? entries[entries.length - 1] : null;

  return {
    ok: true,
    debugEnabled,
    fileConfigured: configured,
    file: filePath,
    exists,
    adapterFilter,
    totalEntriesCount: allEntries.length,
    entriesCount: entries.length,
    showing: shownEntries.length,
    latest: latest ? {
      timestamp: latest.timestamp,
      adapter: latest.adapter,
      provider: latest.provider,
      hasSystem: latest.hasSystem,
      systemLength: latest.systemLength,
      promptLength: latest.promptLength,
      capsuleMode: latest.capsuleMode,
      promptCapsules: latest.promptCapsules,
      capsuleReasons: latest.capsuleReasons,
      systemPreview: latest.systemPreview,
      promptPreview: latest.promptPreview,
    } : null,
    entries: shownEntries,
    recommendedCommand,
  };
}

function _buildGatewayPromptDebugEntryKey(entry = {}) {
  return [
    String(entry.timestamp || ''),
    String(entry.adapter || ''),
    String(entry.provider || ''),
    String(entry.systemLength || 0),
    String(entry.promptLength || 0),
    String(entry.promptPreview || ''),
  ].join('|');
}

function _buildGatewayPromptDebugWhyFullText(entry = {}) {
  const mode = String(entry.capsuleMode || '').trim();
  const reasons = Array.isArray(entry.capsuleReasons) ? entry.capsuleReasons : [];
  const reasonByMode = {
    forced_full: 'forceAllPromptSections=true',
    disabled_full: 'KHY_ON_DEMAND_PROMPT_SECTIONS=off',
    default_full: 'missing_user_message',
    continuation_fallback: 'continuation_turn',
    short_request_fallback: 'short_request_guard',
  };
  const expected = reasonByMode[mode];
  if (!expected) return '';
  if (reasons.includes(expected)) return expected;
  return expected || reasons[0] || '';
}

function _printGatewayPromptDebugEntries(entries = [], options = {}) {
  const showCapsules = !!(options.capsules || options['show-capsules'] || options.showCapsules);
  const showWhyFull = !!(options.whyFull || options['why-full'] || options.whyfull);
  entries.forEach((entry, index) => {
    const progress = `${index + 1}/${entries.length}`;
    console.log(chalk.cyan(`  [${progress}] ${_formatGatewayPromptDebugWhen(entry.timestamp)} · ${entry.adapter || '-'} · ${entry.provider || '-'}`));
    console.log(chalk.dim(`    system: ${entry.systemLength} chars · has_system=${entry.hasSystem ? '1' : '0'}`));
    console.log(chalk.dim(`    prompt: ${entry.promptLength} chars`));
    if (showCapsules) {
      const capsuleList = Array.isArray(entry.promptCapsules) && entry.promptCapsules.length > 0
        ? entry.promptCapsules.join(', ')
        : '(none)';
      const reasonList = Array.isArray(entry.capsuleReasons) && entry.capsuleReasons.length > 0
        ? entry.capsuleReasons.join(', ')
        : '(none)';
      console.log(chalk.dim(`    capsule_mode: ${entry.capsuleMode || 'unknown'}`));
      console.log(chalk.dim(`    prompt_capsules: ${safeTerminalString(capsuleList)}`));
      console.log(chalk.dim(`    capsule_reasons: ${safeTerminalString(reasonList)}`));
    }
    const whyFullText = _buildGatewayPromptDebugWhyFullText(entry);
    if (showWhyFull && whyFullText) {
      console.log(chalk.dim(`    why_full: ${safeTerminalString(whyFullText)}`));
    }
    console.log(chalk.dim(`    system_preview: ${safeTerminalString(entry.systemPreview || '(empty)')}`));
    console.log(chalk.dim(`    prompt_preview: ${safeTerminalString(entry.promptPreview || '(empty)')}`));
    console.log('');
  });
}

function _parseGatewayPromptDebugIntervalMs(value, fallback = 1000) {
  const parsed = parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(10000, parsed);
}

function _parseGatewayPromptDebugCycles(value) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(100000, parsed);
}

function _normalizeGatewayPromptDebugAdapterFilter(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function _filterGatewayPromptDebugEntries(entries = [], options = {}) {
  const adapterFilter = String(options.adapter ?? options.type ?? '').trim();
  const normalizedFilter = _normalizeGatewayPromptDebugAdapterFilter(adapterFilter);
  const sourceEntries = Array.isArray(entries) ? entries : [];
  if (!normalizedFilter) {
    return {
      adapterFilter: '',
      entries: sourceEntries,
    };
  }

  return {
    adapterFilter,
    entries: sourceEntries.filter((entry) => (
      _normalizeGatewayPromptDebugAdapterFilter(entry?.adapter) === normalizedFilter
    )),
  };
}

function _printGatewayStatusTable(rows = []) {
  const headers = ['优先级', '适配器', '类型', '状态', '连通', '详情'];
  const widths = _buildGatewayStatusColumnWidths();
  const top = `  ╭${widths.map((w) => '─'.repeat(w + 2)).join('┬')}╮`;
  const mid = `  ├${widths.map((w) => '─'.repeat(w + 2)).join('┼')}┤`;
  const bot = `  ╰${widths.map((w) => '─'.repeat(w + 2)).join('┴')}╯`;

  console.log(chalk.dim(top));
  const headerLine = headers
    .map((header, i) => ` ${_renderGatewayStatusCell(header, widths[i], chalk.cyan)} `)
    .join(chalk.dim('│'));
  console.log(chalk.dim('  │') + headerLine + chalk.dim('│'));
  console.log(chalk.dim(mid));

  for (const row of rows) {
    const cells = [
      _renderGatewayStatusCell(row.priority, widths[0]),
      _renderGatewayStatusCell(row.adapter, widths[1]),
      _renderGatewayStatusCell(row.type, widths[2]),
      _renderGatewayStatusCell(row.status.text, widths[3], row.status.color),
      _renderGatewayStatusCell(row.connectivity.text, widths[4], row.connectivity.color),
      _renderGatewayStatusCell(row.detail, widths[5]),
    ];
    const line = cells.map((cell) => ` ${cell} `).join(chalk.dim('│'));
    console.log(chalk.dim('  │') + line + chalk.dim('│'));
  }
  console.log(chalk.dim(bot));
}

function _buildGatewayLanguageConsistencyText(summary = null) {
  if (!summary || summary.ok === false) {
    return summary?.summary || '当前尚无语言一致性摘要';
  }
  const sample = String(summary.textSample || '').trim();
  return `${summary.summary}${sample ? `；sample=${sample}` : ''}`;
}

function _buildGatewayTraceCommandHint(requestId = '') {
  const rid = String(requestId || '').trim();
  return rid ? `khy gateway trace ${rid}` : 'khy gateway trace';
}

function _modelFamilyKey(model = {}) {
  const base = String(model._baseModelId || '').trim();
  if (base) return base;
  const raw = String(model.id || model.name || '').trim();
  if (!raw) return '';
  return raw.includes('::') ? raw.split('::')[0] : raw;
}

function _isClaudeFamilyModel(model = {}) {
  const modelId = String(model.id || '').trim().toLowerCase();
  const modelName = String(model.name || '').trim().toLowerCase();
  return modelId.startsWith('claude-')
    || modelId.startsWith('claude_')
    || modelName.startsWith('claude ');
}

function _printLatencyAutoTuneSnapshot() {
  try {
    const tuner = require('../../services/chatLatencyAutoTuner');
    if (!tuner || typeof tuner.getAutoTuneSnapshot !== 'function') return;
    const runtimeIsKhy = String(process.env.KHY_RUNTIME_MODE || '').trim().toLowerCase() === 'khy';
    const profile = runtimeIsKhy ? 'khy_chat_interactive' : 'default_chat';
    const snapshot = tuner.getAutoTuneSnapshot(profile);
    const summary = snapshot && snapshot.summary ? snapshot.summary : null;
    if (!summary) return;
    const count = Math.max(0, parseInt(String(summary.count || 0), 10) || 0);
    if (count <= 0) return;

    const p50 = Math.max(0, parseInt(String(summary.p50 || 0), 10) || 0);
    const p95 = Math.max(0, parseInt(String(summary.p95 || 0), 10) || 0);
    const failures = Math.max(0, parseInt(String(summary.failureCount || 0), 10) || 0);
    const noFirst = Math.max(0, parseInt(String(summary.noFirstTokenCount || 0), 10) || 0);
    const failureRate = count > 0 ? Math.round((failures / count) * 100) : 0;
    const noFirstRate = count > 0 ? Math.round((noFirst / count) * 100) : 0;
    const preset = String(snapshot.lastProfile || '') === profile
      ? (String(snapshot.lastPreset || '').trim() || 'pending')
      : 'pending';
    const decisionReason = String(snapshot?.lastDecision?.reason || '').trim();
    const adaptiveTag = String(snapshot?.lastDecision?.adaptiveTag || '').trim();
    const reasonSuffix = decisionReason
      ? `（${decisionReason}${adaptiveTag ? ` · ${adaptiveTag}` : ''}）`
      : '';

    const autoRaw = String(process.env.KHY_CHAT_AUTOTUNE || '').trim().toLowerCase();
    const autoEnabled = autoRaw
      ? !['false', '0', 'off', 'no'].includes(autoRaw)
      : (profile === 'khy_chat_interactive');
    const conf = snapshot?.currentConfig || {};
    const preflightMs = Math.max(0, parseInt(String(conf.KHY_PREFLIGHT_MAX_MS || 0), 10) || 0);
    const preflightProbeMs = Math.max(0, parseInt(String(conf.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS || 0), 10) || 0);
    const preflightCandidates = Math.max(0, parseInt(String(conf.KHY_PREFLIGHT_MAX_CANDIDATES || 0), 10) || 0);
    const rateWaitMs = Math.max(0, parseInt(String(conf.GATEWAY_RATE_LIMIT_MAX_WAIT_MS || 0), 10) || 0);

    printInfo(`首包延迟统计(${profile}): P50/P95=${p50}/${p95}ms，失败率 ${failureRate}%（${failures}/${count}），无首包 ${noFirstRate}%`);
    printInfo(`自动调参状态: ${autoEnabled ? '已启用' : '已关闭'}，当前档位: ${preset}${reasonSuffix}`);
    printInfo(`自动调参参数: preflight ${preflightMs}ms / probe ${preflightProbeMs}ms / candidates ${preflightCandidates} / retry-wait ${rateWaitMs}ms`);
  } catch { /* best effort */ }
}

function _filterModelsByReliability(adapterStatus = {}, test = {}, models = []) {
  const sourceModels = Array.isArray(models) ? models.filter(Boolean) : [];
  if (sourceModels.length <= 1) {
    return { models: sourceModels, filtered: 0, reasons: [] };
  }
  const adapterType = String(adapterStatus.type || '').toLowerCase();
  const generationWarn = !!(test?.generation && !test.generation.success && shouldTreatGenerationFailureAsWarning(adapterType));
  let kept = sourceModels.slice();
  let filtered = 0;
  const reasons = [];
  const hideFallbackForAdapter = adapterType === 'codex';
  const hideHintForAdapter = adapterType === 'codex';

  if (adapterType === 'codex') {
    const next = kept.filter((m) => !_isClaudeFamilyModel(m));
    const removed = kept.length - next.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('cross-provider-claude');
    }
    kept = next;
  }

  if (MODEL_HIDE_HINT_MODELS_ENABLED && hideHintForAdapter) {
    const next = kept.filter((m) => String(m.discoverySource || '').trim().toLowerCase() !== 'hint');
    const removed = kept.length - next.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('hint');
    }
    kept = next;
  }

  if (MODEL_HIDE_FALLBACK_MODELS_ENABLED && hideFallbackForAdapter) {
    const next = kept.filter((m) => String(m.discoverySource || '').trim().toLowerCase() !== 'builtin');
    const removed = kept.length - next.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('builtin');
    }
    kept = next;
  }

  if (MODEL_HIDE_UNVERIFIED_ENABLED && generationWarn && kept.length > MODEL_WARN_KEEP_MAX) {
    const strictKeep = kept.filter((m) => (
      !!m.isDefault || _isPreferredAdapterModel(adapterType, m.id)
    ));
    const normalizedKeep = [];
    const seenIds = new Set();
    const seenFamilies = new Set();
    const pushOne = (m) => {
      if (!m || normalizedKeep.length >= MODEL_WARN_KEEP_MAX) return;
      const id = String(m.id || '');
      if (id && seenIds.has(id)) return;
      normalizedKeep.push(m);
      if (id) seenIds.add(id);
      const fam = _modelFamilyKey(m);
      if (fam) seenFamilies.add(fam);
    };
    for (const m of strictKeep) pushOne(m);
    for (const m of kept) {
      if (normalizedKeep.length >= MODEL_WARN_KEEP_MAX) break;
      const fam = _modelFamilyKey(m);
      if (fam && seenFamilies.has(fam)) continue;
      pushOne(m);
    }
    for (const m of kept) {
      if (normalizedKeep.length >= MODEL_WARN_KEEP_MAX) break;
      pushOne(m);
    }
    const removed = kept.length - normalizedKeep.length;
    if (removed > 0) {
      filtered += removed;
      reasons.push('warn-unverified');
    }
    kept = normalizedKeep;
  }

  if (kept.length === 0) {
    const fallback = sourceModels.find((m) => (
      !!m.isDefault || _isPreferredAdapterModel(adapterType, m.id)
    )) || sourceModels[0];
    kept = fallback ? [fallback] : [];
  }
  return { models: kept, filtered, reasons };
}

async function maybeAutoSyncSwitchCenterForGateway(source = 'gateway') {
  try {
    const proxyHandlers = require('./proxy');
    if (!proxyHandlers || typeof proxyHandlers.maybeAutoSyncSwitchCenter !== 'function') return null;
    const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
    const inferredProvider = preferredAdapter === 'trae'
      ? 'trae'
      : (preferredAdapter === 'windsurf' ? 'windsurf' : 'windsurf');
    return await proxyHandlers.maybeAutoSyncSwitchCenter({
      quiet: true,
      source,
      provider: process.env.SWITCH_CENTER_AUTO_PROVIDER || 'auto',
      preferredProvider: inferredProvider,
    });
  } catch {
    return null;
  }
}

// 收敛到 utils/maskToken 单一真源(逐字节委托,调用点不变)
const maskTokenValue = require('../../utils/maskToken');

function parseProviderFromModelId(modelId, adapter = '') {
  const raw = String(modelId || '').trim();
  if (!raw) return null;

  const adapterKey = String(adapter || '').trim().toLowerCase();
  if (adapterKey === 'api') {
    const apiTriplet = raw.match(/^api:([a-z0-9_-]+):(.+)$/i);
    if (apiTriplet) return apiTriplet[1].toLowerCase();
    const providerPair = raw.match(/^([a-z0-9_-]+):(.+)$/i);
    if (providerPair) return providerPair[1].toLowerCase();
  }

  const generic = raw.match(/^([a-z0-9_-]+)[:/](.+)$/i);
  return generic ? generic[1].toLowerCase() : null;
}

function _resolveApiProviderLabel(providerKey = '') {
  const key = String(providerKey || '').trim().toLowerCase();
  if (!key) return '';
  const customMap = _getCustomProviderMap();
  const custom = customMap.get(key);
  if (custom?.name) return custom.name;
  return API_PROVIDER_DISPLAY_NAMES[key] || key;
}

function _resolvePreferredRouteSnapshot() {
  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
  const preferredModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  if (!preferredAdapter || preferredAdapter === 'auto') return null;

  if (preferredAdapter === 'api') {
    const provider = parseProviderFromModelId(preferredModel, 'api')
      || String(process.env.GATEWAY_API_POOL_PROVIDER || '').trim().toLowerCase()
      || '';
    const modelPart = String(preferredModel || '').replace(/^api:[a-z0-9_-]+:/i, '').replace(/^[a-z0-9_-]+:/i, '').trim();
    const providerLabel = _resolveApiProviderLabel(provider);
    const routeLabel = providerLabel
      ? `${providerLabel}/${modelPart || '(未设置模型)'}`
      : (preferredModel || '(未设置模型)');
    return {
      adapter: preferredAdapter,
      model: preferredModel,
      provider,
      routeLabel,
    };
  }

  if (preferredAdapter === 'relay_api') {
    const model = preferredModel || String(process.env.RELAY_API_MODEL || '').trim();
    return {
      adapter: preferredAdapter,
      model,
      provider: 'custom',
      routeLabel: `custom/${model || '(未设置模型)'}`,
    };
  }

  return {
    adapter: preferredAdapter,
    model: preferredModel,
    provider: preferredAdapter,
    routeLabel: preferredModel
      ? `${preferredAdapter}/${preferredModel}`
      : preferredAdapter,
  };
}

const API_PROVIDER_DISPLAY_NAMES = Object.freeze({
  sensenova: 'SenseNova',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  glm: '智谱 GLM',
  doubao: '豆包',
  wenxin: '百度文心',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  trae: 'Trae API',
  relay: 'API 中转',
  codex: 'Codex API',
});

const API_PROVIDER_ENV_KEYS = Object.freeze({
  sensenova: { key: 'SENSENOVA_API_KEY', endpoint: 'SENSENOVA_API_ENDPOINT', defaultEndpoint: 'https://token.sensenova.cn/v1' },
  deepseek: { key: 'DEEPSEEK_API_KEY', endpoint: 'DEEPSEEK_API_ENDPOINT', defaultEndpoint: 'https://api.deepseek.com/v1' },
  qwen: { key: 'QWEN_API_KEY', endpoint: 'QWEN_API_ENDPOINT', defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  glm: { key: 'GLM_API_KEY', endpoint: 'GLM_API_ENDPOINT', defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4' },
  doubao: { key: 'DOUBAO_API_KEY', endpoint: 'DOUBAO_API_ENDPOINT', defaultEndpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
  wenxin: { key: 'WENXIN_API_KEY', endpoint: 'WENXIN_API_ENDPOINT', defaultEndpoint: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop' },
  openai: { key: 'OPENAI_API_KEY', endpoint: 'OPENAI_API_ENDPOINT', defaultEndpoint: 'https://api.openai.com/v1' },
  anthropic: { key: 'ANTHROPIC_API_KEY', endpoint: 'ANTHROPIC_API_ENDPOINT', defaultEndpoint: 'https://api.anthropic.com/v1' },
  // Trae 使用加密原生协议（adaptive-api.trae.ai），非 OpenAI 兼容；不设 api.trae.ai 默认端点（避免 404）。
  trae: { key: 'TRAE_API_KEY', endpoint: 'TRAE_API_ENDPOINT', defaultEndpoint: '' },
  relay: { key: 'RELAY_API_KEY', endpoint: 'RELAY_API_ENDPOINT', defaultEndpoint: '' },
  codex: { key: 'CODEX_API_KEY', endpoint: 'CODEX_API_ENDPOINT', defaultEndpoint: '' },
});

// Shared env-file patcher (single source of truth, also used by the runtime
// admin API via customProviderRegistrar). The thin wrappers below preserve the
// existing call sites/signatures while delegating to the shared module.
const _envFile = require('../../services/gatewayEnvFile');

function _parseJsonObject(raw, fallback = {}) {
  return _envFile.parseJsonObject(raw, fallback);
}

function _mergeJsonEnvVar(envKey, newEntries, _writeEnvMapUnused) {
  // 3rd arg kept for backward compat; the shared writer is self-contained.
  return _envFile.mergeJsonEnvVar(envKey, newEntries);
}

function _removeJsonEnvVarKey(envKey, keyToRemove, _writeEnvMapUnused) {
  return _envFile.removeJsonEnvVarKey(envKey, keyToRemove);
}

function _safeJsonLine(obj) {
  try {
    return JSON.stringify(obj || {});
  } catch {
    return '{}';
  }
}

function _normalizeEndpointForDisplay(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '(not set)';
  return text.replace(/\/+$/g, '');
}

function _getCustomProviderMap() {
  const out = new Map();
  try {
    const customRegistry = require('../../services/customProviderRegistry');
    const providers = customRegistry.listProviders();
    for (const item of providers) {
      const key = String(item?.poolKey || '').trim().toLowerCase();
      if (!key) continue;
      out.set(key, {
        name: String(item?.name || '').trim() || key,
        endpoint: String(item?.endpoint || '').trim(),
        defaultModel: String(item?.defaultModel || '').trim(),
      });
    }
  } catch { /* best effort */ }
  return out;
}

function _collectConfiguredEndpointRows() {
  const envDefaultModelMap = _parseJsonObject(process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP, {});
  const customProviderMap = _getCustomProviderMap();
  const byKey = new Map(); // provider::endpoint -> row
  const keySeen = new Set(); // provider::endpoint::key

  const addEntry = (providerRaw, endpointRaw, keyRaw, sourceRaw) => {
    const provider = String(providerRaw || '').trim().toLowerCase();
    if (!provider) return;
    const endpoint = _normalizeEndpointForDisplay(endpointRaw);
    const source = String(sourceRaw || '').trim() || 'unknown';
    const keyText = String(keyRaw || '').trim();
    if (!keyText) return;

    const rowKey = `${provider}::${endpoint}`;
    const keySig = `${rowKey}::${keyText}`;
    if (keySeen.has(keySig)) return;
    keySeen.add(keySig);

    let row = byKey.get(rowKey);
    if (!row) {
      const customMeta = customProviderMap.get(provider);
      const displayName = customMeta?.name || API_PROVIDER_DISPLAY_NAMES[provider] || provider;
      const defaultModel = String(
        envDefaultModelMap[provider]
        || customMeta?.defaultModel
        || (provider === 'relay' ? process.env.RELAY_API_MODEL : '')
        || ''
      ).trim() || '—';
      row = {
        provider,
        displayName,
        endpoint,
        defaultModel,
        keyCount: 0,
        sources: new Set(),
      };
      byKey.set(rowKey, row);
    }
    row.keyCount += 1;
    row.sources.add(source);
  };

  // 1) From api key pool file (~/.khyquant/api_keys.json)
  try {
    const poolFile = path.join(os.homedir(), '.khyquant', 'api_keys.json');
    if (fs.existsSync(poolFile)) {
      const parsed = JSON.parse(fs.readFileSync(poolFile, 'utf-8'));
      const providerMap = (parsed && typeof parsed === 'object') ? parsed : {};
      for (const [provider, rawEntries] of Object.entries(providerMap)) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        const entries = parseApiKeyEntries(rawEntries, { endpoint: '', priority: 0, label: '' });
        for (const entry of entries) {
          addEntry(normalizedProvider, entry.endpoint, entry.key, 'api_keys.json');
        }
      }
    }
  } catch { /* best effort */ }

  // 2) From env single-key / multi-key fallback
  for (const [provider, cfg] of Object.entries(API_PROVIDER_ENV_KEYS)) {
    const keyInput = process.env[cfg.key];
    if (!String(keyInput || '').trim()) continue;
    const endpoint = process.env[cfg.endpoint] || cfg.defaultEndpoint || '';
    const entries = parseApiKeyEntries(keyInput, { endpoint, priority: 0, label: 'env' });
    for (const entry of entries) {
      addEntry(provider, entry.endpoint || endpoint, entry.key, '.env');
    }
  }

  const rows = [...byKey.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((item) => [
      `${item.displayName}${item.displayName.toLowerCase() === item.provider ? '' : ` (${item.provider})`}`,
      item.endpoint,
      String(item.keyCount),
      item.defaultModel,
      [...item.sources].sort().join(', '),
    ]);
  return rows;
}

function _collectConfiguredEndpointObjects() {
  const envDefaultModelMap = _parseJsonObject(process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP, {});
  const customProviderMap = _getCustomProviderMap();
  const byKey = new Map(); // provider::endpoint -> row
  const keySeen = new Set(); // provider::endpoint::key

  const addEntry = (providerRaw, endpointRaw, keyRaw, sourceRaw) => {
    const provider = String(providerRaw || '').trim().toLowerCase();
    if (!provider) return;
    const endpoint = _normalizeEndpointForDisplay(endpointRaw);
    const source = String(sourceRaw || '').trim() || 'unknown';
    const keyText = String(keyRaw || '').trim();
    if (!keyText) return;

    const rowKey = `${provider}::${endpoint}`;
    const keySig = `${rowKey}::${keyText}`;
    if (keySeen.has(keySig)) return;
    keySeen.add(keySig);

    let row = byKey.get(rowKey);
    if (!row) {
      const customMeta = customProviderMap.get(provider);
      const displayName = customMeta?.name || API_PROVIDER_DISPLAY_NAMES[provider] || provider;
      const defaultModel = String(
        envDefaultModelMap[provider]
        || customMeta?.defaultModel
        || (provider === 'relay' ? process.env.RELAY_API_MODEL : '')
        || ''
      ).trim() || '—';
      row = {
        provider,
        displayName,
        endpoint,
        keyCount: 0,
        defaultModel,
        sources: new Set(),
      };
      byKey.set(rowKey, row);
    }
    row.keyCount += 1;
    row.sources.add(source);
  };

  try {
    const poolFile = path.join(os.homedir(), '.khyquant', 'api_keys.json');
    if (fs.existsSync(poolFile)) {
      const parsed = JSON.parse(fs.readFileSync(poolFile, 'utf-8'));
      const providerMap = (parsed && typeof parsed === 'object') ? parsed : {};
      for (const [provider, rawEntries] of Object.entries(providerMap)) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        const entries = parseApiKeyEntries(rawEntries, { endpoint: '', priority: 0, label: '' });
        for (const entry of entries) {
          addEntry(normalizedProvider, entry.endpoint, entry.key, 'api_keys.json');
        }
      }
    }
  } catch { /* best effort */ }

  // 收集代码级内置 key（BUILTIN_PROVIDER_KEYS）
  try {
    const pool = require('../../services/apiKeyPool');
    const builtinKeys = pool.BUILTIN_PROVIDER_KEYS || {};
    for (const [provider, cfg] of Object.entries(builtinKeys)) {
      addEntry(provider, cfg.endpoint, cfg.key, 'built-in');
    }
  } catch { /* best effort */ }

  for (const [provider, cfg] of Object.entries(API_PROVIDER_ENV_KEYS)) {
    const keyInput = process.env[cfg.key];
    if (!String(keyInput || '').trim()) continue;
    const endpoint = process.env[cfg.endpoint] || cfg.defaultEndpoint || '';
    const entries = parseApiKeyEntries(keyInput, { endpoint, priority: 0, label: 'env' });
    for (const entry of entries) {
      addEntry(provider, entry.endpoint || endpoint, entry.key, '.env');
    }
  }

  return [...byKey.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((item) => ({
      provider: item.provider,
      displayName: item.displayName,
      endpoint: item.endpoint,
      keys: item.keyCount,
      defaultModel: item.defaultModel,
      sources: [...item.sources].sort(),
    }));
}

function _parseProviderFilterFromOptions(options = {}) {
  const raw = String(options.provider || options.providers || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
}

function _normalizeProviderToken(text = '') {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function _filterEndpointObjectsByProvider(endpointObjects = [], providerFilters = []) {
  if (!Array.isArray(providerFilters) || providerFilters.length === 0) return endpointObjects;
  const filters = providerFilters.map(_normalizeProviderToken).filter(Boolean);
  if (filters.length === 0) return endpointObjects;

  return endpointObjects.filter((item) => {
    const providerKey = _normalizeProviderToken(item?.provider || '');
    const displayName = _normalizeProviderToken(item?.displayName || '');
    return filters.some((f) => providerKey.includes(f) || displayName.includes(f));
  });
}

function getPoolHint(provider) {
  if (!provider) return null;
  try {
    const pool = require('../../services/apiKeyPool');
    pool.init();
    const entries = pool.getPoolStatus(provider);
    if (!entries || entries.length === 0) return null;
    const previews = entries.slice(0, 2).map(e => e.keyPreview).join(', ');
    const more = entries.length > 2 ? ` +${entries.length - 2}` : '';
    return `池中 ${entries.length} 把 key (${previews}${more})`;
  } catch {
    return null;
  }
}

function getTokenInfoForSelection(selected) {
  const adapter = String(selected?.adapter || '').toLowerCase();
  const model = selected?.model || '';

  if (!adapter) return { source: 'unknown', detail: '未知适配器' };

  if (adapter === 'cursor2api') {
    try {
      const svc = require('../../services/cursor2apiIntegrationService');
      const cfg = svc.loadConfig();
      const token = process.env.CURSOR2API_TOKEN || cfg.authToken || '';
      return token
        ? { source: 'CURSOR2API_TOKEN', detail: maskTokenValue(token) }
        : { source: 'CURSOR2API_TOKEN', detail: '未设置' };
    } catch {
      return { source: 'CURSOR2API_TOKEN', detail: '读取失败' };
    }
  }

  if (adapter === 'relay_api') {
    const token = process.env.RELAY_API_KEY || '';
    if (token) return { source: 'RELAY_API_KEY', detail: maskTokenValue(token) };
    const poolHint = getPoolHint('relay');
    return { source: 'RELAY_API_KEY', detail: poolHint || '未设置' };
  }

  if (adapter === 'api') {
    const provider = parseProviderFromModelId(model, adapter);
    const envMap = {
      sensenova: 'SENSENOVA_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'QWEN_API_KEY',
      glm: 'GLM_API_KEY',
      doubao: 'DOUBAO_API_KEY',
      wenxin: 'WENXIN_API_KEY',
      trae: 'TRAE_API_KEY',
      relay: 'RELAY_API_KEY',
    };
    const envKey = provider ? envMap[provider] : null;
    if (envKey && process.env[envKey]) {
      return { source: envKey, detail: maskTokenValue(process.env[envKey]) };
    }
    const poolHint = getPoolHint(provider);
    if (provider) {
      return { source: provider, detail: poolHint || '未设置' };
    }
    return { source: 'api', detail: '该模型未包含 provider 前缀，无法定位 token' };
  }

  if (['cli', 'claude', 'codex', 'cursor', 'kiro', 'trae', 'warp', 'windsurf', 'vscode'].includes(adapter)) {
    return { source: 'local-login', detail: '本地 IDE/CLI 登录态（非显式 API token）' };
  }

  if (adapter === 'ollama' || adapter === 'localllm') {
    return { source: 'local-model', detail: '本地模型通道（无需 token）' };
  }

  if (adapter === 'relay' || adapter === 'clipboard') {
    return { source: 'manual-relay', detail: '网页/剪贴板中转（无需 API token）' };
  }

  return { source: adapter, detail: '未定义 token 映射' };
}

function getSharedReadline() {
  try {
    const toolCalling = require('../../services/toolCalling');
    const provider = toolCalling.getReadlineProvider ? toolCalling.getReadlineProvider() : null;
    return typeof provider === 'function' ? provider() : provider;
  } catch {
    return null;
  }
}

function askLine(promptText) {
  return new Promise((resolve) => {
    const shared = getSharedReadline();
    if (shared && typeof shared.question === 'function') {
      shared.question(promptText, (answer) => resolve(answer));
      return;
    }
    const temp = readline.createInterface({ input: process.stdin, output: process.stdout });
    temp.question(promptText, (answer) => {
      temp.close();
      resolve(answer);
    });
  });
}

function recoverGatewayPromptInput() {
  try {
    if (typeof process.stdin.setRawMode === 'function' && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch { /* ignore */ }
  try { process.stdin.resume(); } catch { /* ignore */ }
}

async function withTimeout(promise, ms, label = 'operation') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAdapterOperational(status, test, strictOperationalAdapters = STRICT_OPERATIONAL_ADAPTERS) {
  if (!status || !status.enabled || !status.available) return false;
  if (!test?.connectivity?.success) return false;
  const adapterType = String(status.type || '').toLowerCase();
  const strictMode = strictOperationalAdapters.has(adapterType);
  if (strictMode && test?.models) {
    if (!test.models.success) return false;
    if (Number(test.models.count || 0) <= 0) return false;
  }
  if (test?.generation && !test.generation.success) {
    if (!shouldTreatGenerationFailureAsWarning(adapterType)) return false;
    if (strictMode) {
      const reasonText = String(test?.generation?.error || '');
      // For strict adapters, keep auth/install failures blocked.
      // Timeout/process-like probe failures are treated as warning to avoid false negatives.
      if (_isAuthOrInstallLikeReason(reasonText)) return false;
      if (!_isTransientProbeLikeReason(reasonText)) return false;
    }
  }
  return true;
}

function _resolveEnvPathsForGateway() {
  return _envFile.resolveEnvPaths();
}

function _patchEnvContent(content, envMap = {}, unsetKeys = []) {
  return _envFile.patchEnvContent(content, envMap, unsetKeys);
}

function _writeEnvPatch(envMap = {}, unsetKeys = [], options = {}) {
  return _envFile.writeEnvPatch(envMap, unsetKeys, options);
}

function persistGatewayPreference(selected) {
  // 「Auto」选择(/goal「khy 在模型列表下设置一个 auto 模型」):写 adapter=auto 哨兵并**清空**
  // GATEWAY_PREFERRED_MODEL(而非把字面 'auto' 写进 model),运行时逐请求经 autoSelectModel 自动选型。
  // 门控关时 isAutoSelection 恒 false → 走原分支(字节回退)。
  try {
    const autoSelect = require('../../services/gateway/autoModelSelect');
    if (autoSelect.isEnabled() && autoSelect.isAutoSelection(selected)) {
      _writeEnvPatch(
        { GATEWAY_PREFERRED_ADAPTER: autoSelect.AUTO_SENTINEL, GATEWAY_PREFERRED_STRICT: 'true' },
        ['GATEWAY_PREFERRED_MODEL'],
      );
      return;
    }
  } catch { /* fail-soft: fall through to canonical persistence */ }
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: selected.adapter,
    GATEWAY_PREFERRED_STRICT: 'true',
  };
  if (selected.model) envMap.GATEWAY_PREFERRED_MODEL = selected.model;
  const unsetKeys = selected.model ? [] : ['GATEWAY_PREFERRED_MODEL'];
  _writeEnvPatch(envMap, unsetKeys);
}

function _resolveEnvPathForGateway() {
  const { canonicalPath } = _resolveEnvPathsForGateway();
  return canonicalPath;
}

function _resolveEnvPathForDiscoverModels() {
  const fs = require('fs');
  const path = require('path');
  const { canonicalPath } = _resolveEnvPathsForGateway();
  const candidates = [
    canonicalPath,
    path.resolve(__dirname, '../../../../.env'),
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

function _writeEnvMap(envMap = {}, options = {}) {
  return _writeEnvPatch(envMap, [], options);
}

function _unsetEnvKeys(keys = [], options = {}) {
  return _writeEnvPatch({}, keys, options);
}

async function handleGatewayTuneLocal(args = [], options = {}) {
  const hw = require('../../services/hardwareProfileService');
  const modeArg = String(args[0] || options.mode || 'auto').trim().toLowerCase();
  const mode = ['auto', 'fast', 'balanced', 'quality'].includes(modeArg) ? modeArg : 'auto';
  const apply = !!options.apply
    || modeArg === 'apply'
    || String(args[1] || '').trim().toLowerCase() === 'apply'
    || String(args[1] || '').trim().toLowerCase() === '--apply'
    || String(args[2] || '').trim().toLowerCase() === '--apply';
  const rec = hw.recommendLocalAiTuning(mode);
  const rows = Object.entries(rec.env).map(([k, v]) => [k, String(v)]);

  console.log('');
  console.log(`  ${ICON_GATEWAY} ${chalk.cyan.bold('本地 AI 智能调优')}`);
  console.log('');
  printInfo(`硬件画像: ${rec.profile}`);
  printInfo(`推荐档位: ${rec.label} (${rec.mode})`);
  printInfo(`依据: ${rec.reason}`);
  console.log('');
  printTable(['配置项', '推荐值'], rows);
  console.log('');

  if (apply) {
    const envPath = _writeEnvMap(rec.env, {});
    printSuccess(`已写入智能匹配配置: ${envPath}`);
    printInfo('新会话将自动生效；当前进程已更新环境变量');
    console.log('');
    return {
      applied: true,
      mode,
      profile: rec.profile,
      envPath,
      values: rec.env,
    };
  }

  printInfo('预览模式：未写入 .env');
  printInfo('应用命令: khy gateway tune-local ' + mode + ' apply');
  console.log('');
  return {
    applied: false,
    mode,
    profile: rec.profile,
    values: rec.env,
  };
}

async function handleGatewayPreferRemote(options = {}) {
  const asJson = !!options.json;
  const silent = !!options.silent;
  const probeOnlyAvailable = !!options.probeOnlyAvailable;
  const logInfo = (...args) => { if (!silent) printInfo(...args); };
  const logError = (...args) => { if (!silent) printError(...args); };
  const logSuccess = (...args) => { if (!silent) printSuccess(...args); };

  const gateway = require('../../services/gateway/aiGateway');
  if (!gateway._initialized) await gateway.init();

  const statuses = gateway.getStatus().filter(s => s.enabled);
  const localTypes = new Set(['localllm', 'ollama']);
  const remoteStatuses = statuses.filter((s) => {
    if (localTypes.has(String(s.type || '').toLowerCase())) return false;
    if (probeOnlyAvailable && !s.available) return false;
    return true;
  });
  if (remoteStatuses.length === 0) {
    const payload = {
      switched: false,
      selected: null,
      reason: 'no-remote-channel',
      tested: 0,
    };
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        action: 'prefer-remote',
        ...payload,
        message: '未找到远程通道（API/桥接/CLI）',
      }, null, 2));
      return payload;
    }
    logError('未找到远程通道（API/桥接/CLI）');
    logInfo('可运行 khy gateway config 配置 API 或桥接通道');
    return payload;
  }

  const requestedProbeTimeoutMs = Number(options.probeTimeoutMs);
  const probeTimeoutDefaultMs = parseInt(process.env.KHY_MODEL_PROBE_TIMEOUT_MS || '8000', 10) || 8000;
  const probeTimeoutBaseMs = Number.isFinite(requestedProbeTimeoutMs) ? requestedProbeTimeoutMs : probeTimeoutDefaultMs;
  const probeTimeoutMs = Math.max(Number.isFinite(requestedProbeTimeoutMs) ? 1000 : 4000, probeTimeoutBaseMs);
  const requestedGenerationProbeTimeoutMs = Number(options.probeGenerationTimeoutMs);
  const generationProbeTimeoutDefaultMs = parseInt(
    process.env.KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS || '25000',
    10
  ) || 25000;
  const generationProbeTimeoutBaseMs = Number.isFinite(requestedGenerationProbeTimeoutMs)
    ? requestedGenerationProbeTimeoutMs
    : generationProbeTimeoutDefaultMs;
  const generationProbeTimeoutMs = Math.max(
    probeTimeoutMs,
    generationProbeTimeoutBaseMs
  );
  if (!asJson) {
    logInfo(`探测远程通道可用性（单通道超时 ${Math.round(probeTimeoutMs / 1000)}s）...`);
  }

  const testResults = {};
  await Promise.all(remoteStatuses.map(async (s) => {
    const adapterType = String(s.type || '').toLowerCase();
    const requireGenerationProbe = STRICT_OPERATIONAL_ADAPTERS.has(adapterType);
    const adapterProbeTimeoutMs = _getAdapterProbeTimeoutMs(adapterType, probeTimeoutMs);
    const adapterGenerationProbeTimeoutMs = Math.max(adapterProbeTimeoutMs, generationProbeTimeoutMs);
    try {
      testResults[s.type] = await withTimeout(
        gateway.testAdapter(s.type, {
          quick: !requireGenerationProbe,
          timeoutMs: adapterProbeTimeoutMs,
          probeGenerationTimeoutMs: adapterGenerationProbeTimeoutMs,
        }),
        Math.max(adapterProbeTimeoutMs + 1000, adapterGenerationProbeTimeoutMs + 1000),
        `${s.type} probe`
      );
    } catch (err) {
      testResults[s.type] = {
        connectivity: {
          success: false,
          latencyMs: adapterProbeTimeoutMs,
          error: err && err.message ? err.message : 'probe failed',
        },
      };
    }
  }));

  const rankByAdapter = {
    api: 100,
    relay_api: 95,
    cursor2api: 90,
    cli: 85,
    claude: 80,
    codex: 78,
    cursor: 76,
    kiro: 74,
    trae: 72,
    windsurf: 68,
    vscode: 66,
    warp: 64,
    relay: 50,
  };

  const candidates = [];
  for (const s of remoteStatuses) {
    const test = testResults[s.type];
    if (!isAdapterOperational(s, test, STRICT_OPERATIONAL_ADAPTERS)) continue;

    const generationWarn = !!(test?.generation && !test.generation.success && shouldTreatGenerationFailureAsWarning(s.type));
    let selectedModel = null;
    try {
      const modelListTimeoutMs = _getAdapterModelListTimeoutMs(s.type, Math.max(3000, probeTimeoutMs));
      const models = await withTimeout(gateway.listModels(s.type), modelListTimeoutMs, `${s.type} listModels`);
      if (Array.isArray(models) && models.length > 0) {
        const filteredModels = _filterModelsByReliability(s, test, models).models;
        const preferred = filteredModels.find(m => m && m.isDefault) || filteredModels[0];
        selectedModel = preferred ? preferred.id : null;
      }
    } catch { /* keep null */ }

    const baseRank = Number(rankByAdapter[s.type] || 40);
    const warnPenalty = generationWarn ? 15 : 0;
    const latencyPenalty = Math.min(20, Math.round((Number(test?.connectivity?.latencyMs || 0) || 0) / 200));
    const score = baseRank - warnPenalty - latencyPenalty;

    candidates.push({
      adapter: s.type,
      model: selectedModel,
      score,
      latencyMs: Number(test?.connectivity?.latencyMs || 0) || 0,
      warn: generationWarn,
      detail: generationWarn ? (test?.generation?.error || 'generation warn') : '',
    });
  }

  if (candidates.length === 0) {
    const payload = {
      switched: false,
      selected: null,
      reason: 'no-operational-remote',
      tested: remoteStatuses.length,
    };
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        action: 'prefer-remote',
        ...payload,
        message: '未找到可用远程通道',
      }, null, 2));
      return payload;
    }
    logError('未找到可用远程通道');
    logInfo('可运行 khy gateway status 查看失败详情，或 khy gateway config 配置 API/桥接');
    return payload;
  }

  candidates.sort((a, b) => b.score - a.score || a.latencyMs - b.latencyMs);
  const selected = candidates[0];
  persistGatewayPreference(selected);
  try { gateway.syncModelSwitch(selected.model || null); } catch { /* best effort */ }
  try { await gateway.refreshAdapters(); } catch { /* best effort */ }

  const tokenInfo = getTokenInfoForSelection(selected);
  const payload = {
    switched: true,
    selected,
    tokenInfo,
    tested: remoteStatuses.length,
    reason: 'switched',
  };
  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'prefer-remote',
      ...payload,
      fromDoctor: !!options.fromDoctor,
    }, null, 2));
    return payload;
  }

  const warnText = selected.warn ? `（实测告警: ${selected.detail || 'generation warn'}）` : '';
  logSuccess(`已切换默认远程通道: ${selected.adapter}${selected.model ? ` · ${selected.model}` : ''}`);
  logInfo(`探测得分: ${selected.score} · 延迟: ${selected.latencyMs}ms ${warnText}`);
  logInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);

  if (options.fromDoctor) {
    logInfo('已根据 doctor 诊断自动避开本地受限通道');
  }

  return payload;
}

async function handleGatewayDebugPrompt(args = [], options = {}) {
  const action = String(args[0] || 'show').trim().toLowerCase();
  const asJson = !!options.json;
  const snapshot = getGatewayDebugPromptSnapshot(options);
  const {
    debugEnabled,
    fileConfigured: configured,
    file: filePath,
    exists,
    adapterFilter,
    totalEntriesCount,
    entriesCount,
    showing,
    entries: shownEntries,
    recommendedCommand,
  } = snapshot;
  const adapterHint = adapterFilter ? `，adapter=${adapterFilter}` : '';

  if (action === 'help') {
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'help',
        command: 'gateway debug-prompt',
        usage: 'gateway debug-prompt [show|live|clear] [--tail 5] [--adapter codex] [--capsules] [--why-full] [--json] [--file /path/to/log]',
        recommendedCommand,
      }, null, 2));
      return;
    }
    printInfo('用法: gateway debug-prompt [show|live|clear] [--tail 5] [--adapter codex] [--capsules] [--why-full] [--json] [--file /path/to/log]');
    printInfo(`建议命令: ${recommendedCommand}`);
    return;
  }

  if (action === 'live' || action === 'watch' || action === 'follow') {
    const intervalMs = _parseGatewayPromptDebugIntervalMs(options.interval ?? options['poll-ms'] ?? options.pollMs, 1000);
    const cycles = _parseGatewayPromptDebugCycles(options.cycles ?? options.count ?? options.iterations);

    if (asJson) {
      console.log(JSON.stringify({
        ...snapshot,
        mode: 'live',
        intervalMs,
        cycles: cycles || null,
      }, null, 2));
      return;
    }

    const baselineSummary = adapterFilter
      ? `最近 ${showing}/${entriesCount} 条匹配基线记录，原始总计 ${totalEntriesCount} 条`
      : `最近 ${showing}/${entriesCount || 0} 条基线记录`;
    printInfo(`正在轮询 KHY prompt 调试日志（文件: ${filePath}${adapterHint}，间隔: ${intervalMs}ms，${baselineSummary}）`);
    printInfo(`实时监听方式: ${cycles > 0 ? `执行 ${cycles} 次轮询后退出` : '持续监听，按 Ctrl+C 退出'}`);

    let baselineEntries = snapshot.entries;
    let seenKeys = new Set(baselineEntries.map(entry => _buildGatewayPromptDebugEntryKey(entry)));
    let seenCount = entriesCount;
    let seenTotalCount = totalEntriesCount;

    if (!configured && !exists) {
      printInfo(`当前未配置调试落盘；可直接执行: ${recommendedCommand}`);
      return;
    }

    if (!exists) {
      printInfo(`KHY prompt 调试日志尚未生成，监听已就绪；请先触发一次请求生成日志，建议命令: ${recommendedCommand}`);
    } else if (baselineEntries.length > 0) {
      printInfo(`正在展示当前基线记录 ${baselineEntries.length}/${entriesCount}${adapterFilter ? `（adapter=${adapterFilter}，原始总计 ${totalEntriesCount} 条）` : ''}`);
      console.log('');
      _printGatewayPromptDebugEntries(baselineEntries, options);
    } else {
      printInfo(
        adapterFilter
          ? `KHY prompt 调试日志已创建，但当前 adapter=${adapterFilter} 尚无匹配记录，监听将等待新请求写入: ${filePath}`
          : `KHY prompt 调试日志已创建，但当前尚无记录，监听将等待新请求写入: ${filePath}`
      );
    }

    let round = 0;
    while (cycles <= 0 || round < cycles) {
      round += 1;
      if (intervalMs > 0) await _sleep(intervalMs);

      const current = getGatewayDebugPromptSnapshot(options);
      const currentEntries = current.entries;

      if (current.totalEntriesCount < seenTotalCount) {
        printInfo(`检测到 KHY prompt 调试日志已重置（当前原始总计 ${current.totalEntriesCount} 条，上一轮 ${seenTotalCount} 条），已重建监听基线`);
        seenKeys = new Set();
      }

      const newEntries = currentEntries.filter((entry) => !seenKeys.has(_buildGatewayPromptDebugEntryKey(entry)));
      if (newEntries.length > 0) {
        printInfo(
          adapterFilter
            ? `检测到新的 KHY 注入记录（新增 ${newEntries.length} 条，第 ${round}/${cycles || '∞'} 次轮询，累计匹配 ${current.entriesCount} 条，原始总计 ${current.totalEntriesCount} 条）`
            : `检测到新的 KHY 注入记录（新增 ${newEntries.length} 条，第 ${round}/${cycles || '∞'} 次轮询，累计 ${current.entriesCount} 条）`
        );
        console.log('');
        _printGatewayPromptDebugEntries(newEntries, options);
      }

      seenKeys = new Set(currentEntries.map(entry => _buildGatewayPromptDebugEntryKey(entry)));
      seenCount = current.entriesCount;
      seenTotalCount = current.totalEntriesCount;
    }

    if (cycles > 0) {
      printInfo(
        adapterFilter
          ? `KHY prompt 实时监听已完成（轮询 ${cycles} 次，累计匹配 ${seenCount} 条记录，原始总计 ${seenTotalCount} 条）`
          : `KHY prompt 实时监听已完成（轮询 ${cycles} 次，累计 ${seenCount} 条记录）`
      );
    }
    return;
  }

  if (action === 'clear' || action === 'truncate' || action === 'reset') {
    const canCreate = configured || exists;
    if (!canCreate) {
      if (asJson) {
        console.log(JSON.stringify({
          ok: true,
          cleared: false,
          reason: 'not_configured',
          file: filePath,
          recommendedCommand,
        }, null, 2));
      } else {
        printInfo(`KHY prompt 调试日志未配置，当前无可清理文件: ${filePath}`);
        printInfo(`先开启落盘: ${recommendedCommand}`);
      }
      return;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf8');
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        cleared: true,
        file: filePath,
      }, null, 2));
    } else {
      printSuccess(`已清空 KHY prompt 调试日志: ${filePath}`);
    }
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  printInfo(`KHY prompt 调试状态: 调试开关=${debugEnabled ? '已开启' : '未开启'}，日志路径=${exists ? '已找到' : '未找到'}，累计请求=${entriesCount}${adapterFilter ? `（adapter=${adapterFilter}，原始总计 ${totalEntriesCount} 条）` : ''}`);
  printInfo(`KHY prompt 调试文件: ${filePath}`);

  if (!configured && !exists) {
    printInfo(`当前未配置调试落盘；可直接执行: ${recommendedCommand}`);
    return;
  }

  if (!exists) {
    printInfo(`KHY prompt 调试日志尚未生成，请先执行一次实际请求后再查看；建议命令: ${recommendedCommand}`);
    return;
  }

  if (entriesCount === 0) {
    printInfo(
      adapterFilter
        ? `KHY prompt 调试日志已创建，但尚未发现 adapter=${adapterFilter} 的请求记录: ${filePath}`
        : `KHY prompt 调试日志已创建，但尚未写入请求记录: ${filePath}`
    );
    return;
  }

  printInfo(`正在展示最近 ${showing}/${entriesCount} 条 KHY 注入记录${adapterFilter ? `（adapter=${adapterFilter}，原始总计 ${totalEntriesCount} 条）` : ''}`);
  console.log('');
  _printGatewayPromptDebugEntries(shownEntries, options);
}

async function handleGatewayTrace(args = [], options = {}) {
  const asJson = !!options.json;
  const requestId = String(args[0] || options.requestId || '').trim();
  const traceAudit = require('../../services/traceAuditService');
  if (!traceAudit || typeof traceAudit.getRequestTraceSummary !== 'function') {
    if (asJson) {
      console.log(JSON.stringify({
        ok: false,
        reason: 'trace_audit_unavailable',
        summary: '审计服务未启用，无法复盘 requestId',
      }, null, 2));
    } else {
      printError('审计服务未启用，无法复盘 requestId');
    }
    return;
  }

  const summary = traceAudit.getRequestTraceSummary({
    requestId: requestId || null,
    sessionId: options.sessionId || null,
    limit: options.limit || 1000,
    role: 'admin',
  });

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!summary || summary.ok === false) {
    printInfo(summary?.summary || '暂无可复盘的 requestId');
    return;
  }

  printInfo(`Request Trace: requestId=${summary.requestId} · session=${summary.sessionId}`);
  printInfo(`链路摘要: ${summary.summary}`);
  if (summary.delivery?.brokenStage) {
    printInfo(`交付断点: ${summary.delivery.brokenStage}`);
  }
  if (summary.language?.status === 'mismatch') {
    printInfo(`语言偏航: 检测=${summary.language.detectedLanguage}，期望=${summary.language.expectedLanguage}，sample=${summary.language.textSample || '-'}`);
  }
  if (summary.firstEvent) {
    printInfo(`起始事件: ${summary.firstEvent.type} @ ${summary.firstEvent.timestamp}`);
  }
  if (summary.lastEvent) {
    printInfo(`最后事件: ${summary.lastEvent.type} @ ${summary.lastEvent.timestamp}`);
  }

  console.log('');
  printInfo('最近事件时间线:');
  for (const item of summary.timeline || []) {
    console.log(chalk.dim(`  ${item.timestamp || '-'} · ${item.stage || 'unknown'} · ${item.type || 'unknown'} · ${item.source || 'unknown'}`));
  }
  console.log('');
}

/**
 * Built-in API providers for the Key pool. The catalog + non-interactive
 * key-apply logic are the single source of truth at the service layer
 * (services/gateway/builtinProviderConfig) so an agent-callable tool can reuse
 * them without importing this cli handler. This handler keeps the interactive
 * shell (inquirer / TUI overlay) and delegates the writes.
 */
const {
  BUILTIN_PROVIDERS,
  listBuiltinProviders,
  applyBuiltinProviderKey,
} = require('../../services/gateway/builtinProviderConfig');

/**
 * Build provider choices for the native TUI Key-config overlay. Each choice's
 * value is the provider descriptor; the label carries a ●/○ marker showing
 * whether a key is already configured (pool or env).
 */
function getProviderKeyChoices() {
  let pool = null;
  try { pool = require('../../services/apiKeyPool'); pool.init(); } catch { pool = null; }
  return BUILTIN_PROVIDERS.map((p) => {
    let configured = false;
    if (pool && p.poolKey) {
      try { configured = (pool.getPoolStatus(p.poolKey) || []).length > 0; } catch { /* ignore */ }
    }
    if (!configured && p.envKey) configured = !!process.env[p.envKey];
    return { name: `${configured ? '●' : '○'} ${p.name}`, value: { ...p } };
  });
}

/**
 * Persist a provider API key (pool + env + route map). Pure logic shared with
 * the TUI overlay; mirrors the classic provider-keys "add" path but without any
 * inquirer prompts. Common path only: default endpoint, no custom providers.
 *
 * @param {object} params - { provider, keyInput, priority?, label?, model?, endpoint? }
 * @param {object} cbs    - { onNotice, onError }
 */
async function applyProviderKey(params = {}, { onNotice = () => {}, onError = () => {} } = {}) {
  const provider = params.provider;
  if (!provider) { onError('未指定厂商'); return { ok: false }; }
  const keyInput = params.keyInput;
  if (!keyInput || !String(keyInput).trim()) { onError('未输入 API Key'); return { ok: false }; }

  // Delegate the pool/env/route writes to the service single source of truth;
  // this handler only provides the interactive notice/error shell.
  let result;
  try {
    result = applyBuiltinProviderKey({
      provider,
      keyInput,
      priority: params.priority,
      label: params.label || '',
      endpoint: params.endpoint != null ? params.endpoint : provider.defaultEndpoint,
      model: params.model || '',
    });
  } catch (e) {
    onError(e && e.message ? e.message : String(e));
    return { ok: false };
  }

  if (result.token) {
    onNotice(`${provider.name} Token 已保存`);
    return { ok: true, token: true };
  }

  if (result.added > 0) onNotice(`已添加到 ${provider.name} Key 池 (${result.added} 个)`);
  if (result.duplicate > 0) onNotice(`跳过重复 Key: ${result.duplicate} 个`);
  if (result.model && provider.poolKey) onNotice(`${provider.name} 已配置: ${result.model}`);

  return { ok: true, added: result.added, duplicate: result.duplicate, primaryKey: result.primaryKey };
}

/** Current network-proxy status for the native overlay header. */
function getProxyConfigInfo() {
  try {
    const proxyConfig = require('../../services/proxyConfigService');
    const status = proxyConfig.getStatus();
    return { active: !!status.active, url: status.url || '', warning: status.compatibilityWarning || '' };
  } catch {
    return { active: false, url: '', warning: '' };
  }
}

/**
 * Apply a proxy action (detect / http / off). Pure logic shared with the TUI
 * overlay; the subscription management sub-tree stays in the classic flow.
 *
 * @param {object} params - { action: 'detect'|'http'|'off', port? }
 * @param {object} cbs    - { onNotice, onError }
 */
async function applyProxyAction(params = {}, { onNotice = () => {}, onError = () => {} } = {}) {
  let proxyConfig;
  try { proxyConfig = require('../../services/proxyConfigService'); } catch { onError('代理服务不可用'); return { ok: false }; }
  const action = params.action;

  if (action === 'off') { proxyConfig.disableProxy(); onNotice('代理已关闭'); return { ok: true }; }
  if (action === 'detect') {
    onNotice('正在检测 Clash...');
    const r = await proxyConfig.autoDetectAndEnable();
    if (r.success) { onNotice(`已检测并启用: ${r.proxy.url}`); return { ok: true }; }
    onError(r.error || '检测失败'); return { ok: false };
  }
  if (action === 'http') {
    const port = String(params.port || '7890').trim();
    if (!/^\d+$/.test(port)) { onError('请输入端口数字'); return { ok: false }; }
    const r = await proxyConfig.enableProxy({ type: 'http', host: '127.0.0.1', port });
    if (r.success) { onNotice(`代理已启用: ${r.proxy.url}`); return { ok: true }; }
    onError(r.error || '启用失败'); return { ok: false };
  }
  onError('未知代理操作'); return { ok: false };
}

/**
 * Interactive gateway configuration.
 */
/**
 * 收集「已配置」的 provider 标识(poolKey + presets id 别名),供引导标注 ✓ 已配置。
 * best-effort,绝不抛。
 */
function _collectConfiguredProviderIds() {
  const ids = new Set();
  const POOLKEY_TO_PRESET = { glm: 'zhipu' };
  const add = (k) => {
    if (!k) return;
    const lk = String(k).toLowerCase();
    ids.add(lk);
    if (POOLKEY_TO_PRESET[lk]) ids.add(POOLKEY_TO_PRESET[lk]);
  };
  try {
    const pool = require('../../services/apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
    const providers = (typeof pool.getProviders === 'function') ? pool.getProviders() : [];
    for (const pv of (Array.isArray(providers) ? providers : [])) {
      try { if ((pool.getPoolStatus(pv) || []).length > 0) add(pv); } catch { /* ignore */ }
    }
  } catch { /* pool optional */ }
  try {
    for (const p of listBuiltinProviders()) {
      if (p && p.envKey && process.env[p.envKey] && p.poolKey) add(p.poolKey);
    }
  } catch { /* ignore */ }
  return Array.from(ids);
}

/**
 * `khy gateway guide`(别名 `gateway help`)—— 打印新手引导(三步 / 配置方式 /
 * 去哪申请 API Key),并对已配置的供应商标注 ✓ 已配置。内容来自单一真源
 * services/gateway/gatewayGuide,与首启向导、Web 引导同义。
 */
async function handleGatewayGuide(options = {}) {
  const guide = require('../../services/gateway/gatewayGuide');
  const configured = _collectConfiguredProviderIds();
  const built = guide.buildGuide({ configured });
  if (options && options.json) {
    console.log(JSON.stringify(built, null, 2));
    return;
  }
  for (const line of guide.renderGuide(built, { c: chalk })) console.log(line);
}

/**
 * Display supported protocol conversion formats.
 */
function handleGatewayProtocols(options = {}) {
  const { getSupportedProtocols, PROTOCOLS } = require('../../services/gateway/protocolConverter');
  const asJson = !!options.json;

  const protocols = getSupportedProtocols();
  const endpoints = {
    [PROTOCOLS.OPENAI]: '/v1/chat/completions',
    [PROTOCOLS.ANTHROPIC]: '/v1/messages',
    [PROTOCOLS.GEMINI]: '/v1beta/models/:model:generateContent',
    [PROTOCOLS.GROK]: '/v1/chat/completions (Grok)',
    [PROTOCOLS.CODEX]: '/v1/responses',
  };
  const rows = protocols.map(p => ({
    protocol: p,
    endpoint: endpoints[p] || '—',
    direction: 'bidirectional',
  }));

  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      action: 'protocols',
      count: rows.length,
      protocols: rows,
      summary: '任意协议间可互转（通过 Canonical 中间格式）',
    }, null, 2));
    return;
  }

  console.log('');
  console.log(`  ${ICON_GATEWAY} ${chalk.cyan.bold('协议转换支持')}`);
  console.log('');

  const tableRows = rows.map(row => [row.protocol, row.endpoint, chalk.green('✓ 双向')]);

  printTable(['协议', '端点', '转换方向'], tableRows);

  console.log('');
  printInfo('任意协议间可互转（通过 Canonical 中间格式）');
  printInfo('代理服务自动检测输入协议，以原协议格式返回');
  console.log('');
}

/**
 * `khy gateway vertex [--project P --location L --model M [--stream]]` ——
 * 把纯叶子 vertexRequestShaping 的 URL 成形能力接到人面前:告诉用户 Google Vertex AI
 * 该在网关表单里填什么 baseUrl、用什么鉴权、请求体是什么格式。
 *
 * 为什么是这个接线点(而非改 relay 热路径):Vertex 复用 Gemini 线格式请求体,唯一不同是
 * 端点 URL 与鉴权。叶子(gateway/vertexRequestShaping.js)是这套 URL 成形的确定性单一真源,
 * 但此前**零消费者**——能力存在却没接到任何人面前。这里给它一个真实 CLI 消费者:纯只读、
 * 不发请求、不碰 relay,门关(KHY_VERTEX_REQUEST_SHAPING=0)时叶子返回 {ok:false} 即回退到
 * 通用模板提示,不改任何其他行为。
 */
function handleGatewayVertex(args = [], options = {}) {
  const shaping = require('../../services/gateway/vertexRequestShaping');
  const asJson = !!(options && options.json);
  const spec = {
    project: options.project || options.p || '',
    location: options.location || options.l || 'us-central1',
    model: options.model || options.m || '',
    streaming: !!(options.stream || options.streaming),
  };
  const plan = shaping.describeVertexRequest(spec);

  if (asJson) {
    console.log(JSON.stringify({ ok: plan.ok, action: 'vertex', spec, plan }, null, 2));
    return plan;
  }

  console.log('');
  console.log(`  ${ICON_GATEWAY} ${chalk.cyan.bold('Google Vertex AI 端点成形')}`);
  console.log('');
  if (!plan.ok) {
    if (plan.reason === 'disabled') {
      printInfo('Vertex 成形当前被 KHY_VERTEX_REQUEST_SHAPING=0 关闭；置 1（或清空）后重试。');
    } else {
      printInfo('缺少必填参数，用法：');
      printInfo('  khy gateway vertex --project <GCP项目> --location <地域, 默认 us-central1> --model <模型名>');
      printInfo('例：khy gateway vertex --project my-proj --location us-central1 --model gemini-2.0-flash');
      if (plan.reason && plan.reason.startsWith('missing-')) {
        printInfo(`（缺少：${plan.reason.slice('missing-'.length)}）`);
      }
    }
    console.log('');
    return plan;
  }

  printTable(['字段', '值'], [
    ['baseUrl（填入网关表单）', plan.baseUrl],
    ['完整端点 URL', plan.url],
    ['HTTP 方法段', plan.method],
    ['鉴权（keyField）', `${plan.keyField} → Authorization: Bearer <token>`],
    ['请求体格式', `${plan.bodyFormat}（复用 Gemini 线格式，单一真源）`],
  ]);
  console.log('');
  printInfo('key 处粘贴 `gcloud auth print-access-token` 的输出（OAuth2 access token）。');
  printInfo('网关会在此 baseUrl 后自动拼 `/models/<model>:generateContent`。');
  console.log('');
  return plan;
}

/**
 * OAuth token management.
 */
async function handleGatewayOAuth(action, provider, options = {}) {
  const oauth = require('../../services/gateway/oauthManager');
  oauth.init();
  const asJson = !!options.json;

  if (action === 'refresh' && provider) {
    const token = await oauth.refreshToken(provider);
    if (asJson) {
      console.log(JSON.stringify({
        ok: !!token,
        action: 'refresh',
        provider,
        refreshed: !!token,
        message: token
          ? `${provider} token 已刷新`
          : `${provider} 刷新失败 — 请检查 refresh_token 配置`,
      }, null, 2));
      return;
    }
    printInfo(`正在刷新 ${provider} token...`);
    if (token) printSuccess(`${provider} token 已刷新`);
    else printError(`${provider} 刷新失败 — 请检查 refresh_token 配置`);
    return;
  }

  // Default: status
  const allStatus = oauth.getAllStatus();
  if (asJson) {
    const providers = Object.entries(allStatus).map(([key, status]) => ({
      providerKey: key,
      provider: status.provider || key,
      valid: !!status.valid,
      registered: !!status.registered,
      hasRefreshToken: !!status.hasRefreshToken,
      expiresIn: Number(status.expiresIn || 0),
      error: status.error || '',
    }));
    console.log(JSON.stringify({
      ok: true,
      action: 'status',
      count: providers.length,
      providers,
    }, null, 2));
    return;
  }
  console.log('');
  console.log(`  ${ICON_GATEWAY} ${chalk.cyan.bold('OAuth Token 状态')}`);
  console.log('');

  for (const [key, status] of Object.entries(allStatus)) {
    const icon = status.valid ? chalk.green('●') : (status.registered ? chalk.yellow('●') : chalk.dim('○'));
    const expiry = status.expiresIn > 0 ? chalk.dim(`(${Math.round(status.expiresIn / 60)}min)`) : '';
    const error = status.error ? chalk.red(` · ${status.error.slice(0, 40)}`) : '';
    const refresh = status.hasRefreshToken ? chalk.dim(' [refresh]') : '';
    console.log(`  ${icon} ${chalk.white(status.provider || key)} ${status.valid ? chalk.green('有效') : (status.registered ? chalk.yellow('已过期') : chalk.dim('未配置'))} ${expiry}${refresh}${error}`);
  }

  console.log('');
  printInfo('使用 gateway oauth refresh <provider> 强制刷新');
  console.log('');
}


module.exports = {
  handleGatewayStatus,
  handleGatewayDebugPrompt,
  handleGatewayTrace,
  handleGatewaySample,
  getGatewayDebugPromptSnapshot,
  handleGatewayConfig,
  handleGatewayGuide,
  handleGatewayRelay,
  handleGatewayDetect,
  handleGatewaySelectModel,
  buildGatewayModelChoices,
  applyGatewayModelSelection,
  persistGatewayPreference,
  buildVendorModelChoices,
  handleModelSwitchByVendor,
  handleGatewayPreferRemote,
  handleGatewayTest,
  handleGatewayProbeTools,
  handleGatewayManage,
  handleAiServer,
  handleGatewayProtocols,
  handleGatewayVertex,
  handleGatewayOAuth,
  handleGatewayDiscoverModels,
  handleGatewayTuneLocal,
  handleGatewayKey,
  handleGatewayModels,
  handleGatewayAdd,
  handleGatewayPool,
  listBuiltinProviders,
  getProviderKeyChoices,
  applyProviderKey,
  getProxyConfigInfo,
  applyProxyAction,
  __test__: {
    _resolveAiManageApiBaseUrl,
    getGatewayDebugPromptSnapshot,
    _isGatewaySamplePromptInjected,
    _getGatewayHomeRiskSnapshot,
    _readGatewaySampleRunSummary,
    _summarizeGatewaySampleCounts,
    promptWithReplGuard,
    _formatVisionTag,
  },
};
