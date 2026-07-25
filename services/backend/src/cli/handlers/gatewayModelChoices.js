'use strict';

/**
 * Gateway model-choice / probe / vendor-switch subsystem (extracted from cli/handlers/gateway.js).
 *
 * Owns: buildGatewayModelChoices (probe all enabled adapters + reliability filtering, shared by the
 * classic CLI selector and the Ink TUI ModelPicker), applyGatewayModelSelection, handleGatewaySelectModel,
 * buildVendorModelChoices and handleModelSwitchByVendor. Extracted verbatim (byte-identical bodies) as a
 * same-directory sibling leaf so in-body relative require() paths resolve identically; the host re-imports
 * every public handler by the same name to keep the model-selection command contracts unchanged.
 *
 * This leaf performs IO (multi-second adapter probes, interactive prompts, .env persistence, terminal
 * output) so it does NOT self-declare as a pure zero-IO leaf. Its many host callbacks (probe cache/timeout
 * helpers, reason classifiers, model-tag formatters, reliability filter, readline/prompt utilities, prefer
 * persistence) plus the shared STRICT_OPERATIONAL_ADAPTERS set are injected via setGatewayModelChoicesDeps
 * to avoid a require cycle back into the host. The debounce config + in-flight deep-probe map are used only
 * by this subsystem and moved here wholesale.
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const {
  printSuccess,
  printError,
  printInfo,
} = require('../formatters');

// ── Host callbacks + shared STRICT_OPERATIONAL_ADAPTERS injected via DI (avoid require cycle) ──
let promptWithReplGuard = null;
let _getDeepProbeCache = null;
let _setDeepProbeCache = null;
let _getAdapterProbeTimeoutMs = null;
let _getAdapterModelListTimeoutMs = null;
let shouldTreatGenerationFailureAsWarning = null;
let _compactReasonText = null;
let _isTimeoutLikeReason = null;
let _isTransientProbeLikeReason = null;
let _classifyHiddenReason = null;
let _shouldRetryProbeByDebounce = null;
let _formatModelSourceTag = null;
let _formatConnectionTag = null;
let _formatUpstreamTag = null;
let _formatVisionTag = null;
let _resolvePreferredAdapterIssue = null;
let _filterModelsByReliability = null;
let maybeAutoSyncSwitchCenterForGateway = null;
let getTokenInfoForSelection = null;
let askLine = null;
let recoverGatewayPromptInput = null;
let withTimeout = null;
let isAdapterOperational = null;
let persistGatewayPreference = null;
let STRICT_OPERATIONAL_ADAPTERS = null;

function setGatewayModelChoicesDeps(deps = {}) {
  if (typeof deps.promptWithReplGuard === 'function') promptWithReplGuard = deps.promptWithReplGuard;
  if (typeof deps._getDeepProbeCache === 'function') _getDeepProbeCache = deps._getDeepProbeCache;
  if (typeof deps._setDeepProbeCache === 'function') _setDeepProbeCache = deps._setDeepProbeCache;
  if (typeof deps._getAdapterProbeTimeoutMs === 'function') _getAdapterProbeTimeoutMs = deps._getAdapterProbeTimeoutMs;
  if (typeof deps._getAdapterModelListTimeoutMs === 'function') _getAdapterModelListTimeoutMs = deps._getAdapterModelListTimeoutMs;
  if (typeof deps.shouldTreatGenerationFailureAsWarning === 'function') shouldTreatGenerationFailureAsWarning = deps.shouldTreatGenerationFailureAsWarning;
  if (typeof deps._compactReasonText === 'function') _compactReasonText = deps._compactReasonText;
  if (typeof deps._isTimeoutLikeReason === 'function') _isTimeoutLikeReason = deps._isTimeoutLikeReason;
  if (typeof deps._isTransientProbeLikeReason === 'function') _isTransientProbeLikeReason = deps._isTransientProbeLikeReason;
  if (typeof deps._classifyHiddenReason === 'function') _classifyHiddenReason = deps._classifyHiddenReason;
  if (typeof deps._shouldRetryProbeByDebounce === 'function') _shouldRetryProbeByDebounce = deps._shouldRetryProbeByDebounce;
  if (typeof deps._formatModelSourceTag === 'function') _formatModelSourceTag = deps._formatModelSourceTag;
  if (typeof deps._formatConnectionTag === 'function') _formatConnectionTag = deps._formatConnectionTag;
  if (typeof deps._formatUpstreamTag === 'function') _formatUpstreamTag = deps._formatUpstreamTag;
  if (typeof deps._formatVisionTag === 'function') _formatVisionTag = deps._formatVisionTag;
  if (typeof deps._resolvePreferredAdapterIssue === 'function') _resolvePreferredAdapterIssue = deps._resolvePreferredAdapterIssue;
  if (typeof deps._filterModelsByReliability === 'function') _filterModelsByReliability = deps._filterModelsByReliability;
  if (typeof deps.maybeAutoSyncSwitchCenterForGateway === 'function') maybeAutoSyncSwitchCenterForGateway = deps.maybeAutoSyncSwitchCenterForGateway;
  if (typeof deps.getTokenInfoForSelection === 'function') getTokenInfoForSelection = deps.getTokenInfoForSelection;
  if (typeof deps.askLine === 'function') askLine = deps.askLine;
  if (typeof deps.recoverGatewayPromptInput === 'function') recoverGatewayPromptInput = deps.recoverGatewayPromptInput;
  if (typeof deps.withTimeout === 'function') withTimeout = deps.withTimeout;
  if (typeof deps.isAdapterOperational === 'function') isAdapterOperational = deps.isAdapterOperational;
  if (typeof deps.persistGatewayPreference === 'function') persistGatewayPreference = deps.persistGatewayPreference;
  if (deps.STRICT_OPERATIONAL_ADAPTERS) STRICT_OPERATIONAL_ADAPTERS = deps.STRICT_OPERATIONAL_ADAPTERS;
}

// ── Subsystem-local config + state (used only here; moved out of the host verbatim) ──
const MODEL_PROBE_DEBOUNCE_ENABLED = String(process.env.KHY_MODEL_PROBE_DEBOUNCE || 'true').toLowerCase() !== 'false';
const MODEL_PROBE_DEBOUNCE_DELAY_MS = Math.max(
  0,
  parseInt(process.env.KHY_MODEL_PROBE_DEBOUNCE_DELAY_MS || '600', 10) || 600
);
const MODEL_PROBE_DEBOUNCE_MAX_RETRIES = Math.max(
  1,
  parseInt(process.env.KHY_MODEL_PROBE_DEBOUNCE_MAX_RETRIES || '2', 10) || 2
);
const _modelDeepProbeInFlight = new Map();

/**
 * Select AI model from available adapters (with connectivity indicators).
 */
/**
 * buildGatewayModelChoices — probe all enabled adapters and assemble the
 * selectable model list, WITHOUT any prompting. Shared by the classic CLI
 * handler (handleGatewaySelectModel) and the Ink TUI ModelPicker so both reuse
 * the exact same probing, reliability filtering and adapter-hiding logic.
 *
 * Side-effecting progress/diagnostic output is delegated to the caller via
 * `onNotice` / `onError` callbacks (the classic CLI passes printInfo/printError;
 * the TUI pushes transcript messages). This keeps the function presentation-free
 * while preserving streaming feedback during the (multi-second) probe.
 *
 * Returns { modelChoices, preferredIssueAfterProbe, empty }. `empty` is true
 * when there is nothing selectable (no enabled adapters, or all filtered out);
 * the relevant explanatory notices have already been emitted in that case.
 */
async function buildGatewayModelChoices({ onNotice = () => {}, onError = () => {} } = {}) {
  const gateway = require('../../services/gateway/aiGateway');
  const autoSync = await withTimeout(
    maybeAutoSyncSwitchCenterForGateway('gateway-model'),
    10000, 'switch-center-sync'
  ).catch(() => null);
  if (!gateway._initialized) await withTimeout(gateway.init(), 15000, 'gateway-init').catch(() => {});
  if (autoSync && autoSync.synced && (autoSync.changed || autoSync.activeChanged)) {
    try { await withTimeout(gateway.refreshAdapters(), 15000, 'refresh-adapters'); } catch { /* best effort */ }
    onNotice(`已自动同步 switch-center: ${(autoSync.profileName || autoSync.profileId || 'windsurf-auto')} (${autoSync.modelsCount || 0} models)`);
  }

  const statuses = gateway.getStatus();
  const enabledAdapters = statuses.filter(s => s.enabled);
  const verboseAdapterDetails = String(process.env.KHY_MODEL_VERBOSE_ADAPTER_DETAILS || 'false').toLowerCase() === 'true';

  if (enabledAdapters.length === 0) {
    onError('无已启用 AI 通道');
    return { modelChoices: [], preferredIssueAfterProbe: null, empty: true };
  }

  if (verboseAdapterDetails) {
    const windsurfStatus = statuses.find(s => String(s.type || '').toLowerCase() === 'windsurf');
    if (windsurfStatus && windsurfStatus.tokenPath) {
      onNotice(`Windsurf token 位置: ${windsurfStatus.tokenPath}`);
      const official = windsurfStatus.officialModels || null;
      if (official) {
        if (official.hit) {
          const endpointLabel = official.endpoint ? ` (${official.endpoint})` : '';
          onNotice(`Windsurf 官方模型列表: 已命中${endpointLabel} · 官方 ${official.officialCount} / 本地 ${official.localCount} / 合并 ${official.mergedCount}`);
        } else {
          const reason = String(official.error || '').trim();
          onNotice(`Windsurf 官方模型列表: 未命中${reason ? ` (${reason})` : '（已回退本地发现）'}`);
        }
      }
    }
  }

  const preferredIssueBeforeProbe = _resolvePreferredAdapterIssue(statuses, {});
  if (preferredIssueBeforeProbe && preferredIssueBeforeProbe.type === 'invalid') {
    onError(preferredIssueBeforeProbe.message);
    onNotice('当前将忽略该无效配置，并仅展示可执行通道');
  }

  // Fast probe for model-selection UX.
  // For unstable-prone adapters, include a lightweight generation probe
  // to avoid "detected but unusable" false positives in /model.
  const probeTimeoutMs = Math.max(
    4000,
    parseInt(process.env.KHY_MODEL_PROBE_TIMEOUT_MS || '8000', 10) || 8000,
  );
  const generationProbeTimeoutMs = Math.max(
    probeTimeoutMs,
    parseInt(process.env.KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS || '25000', 10) || 25000,
  );
  const strictOperationalAdapters = STRICT_OPERATIONAL_ADAPTERS;
  const twoPhaseProbeEnabled = String(process.env.KHY_MODEL_TWO_PHASE_PROBE || 'true').toLowerCase() !== 'false';
  onNotice(`检测各通道连通性（快速模式，单通道超时 ${Math.round(probeTimeoutMs / 1000)}s）...`);
  const testResults = {};
  const strictCandidates = [];
  const testPromises = enabledAdapters.map(async (s) => {
    const adapterType = String(s.type || '').toLowerCase();
    const requireGenerationProbe = strictOperationalAdapters.has(adapterType);
    const adapterProbeTimeoutMs = _getAdapterProbeTimeoutMs(adapterType, probeTimeoutMs);
    const adapterGenerationProbeTimeoutMs = Math.max(adapterProbeTimeoutMs, generationProbeTimeoutMs);
    if (requireGenerationProbe) strictCandidates.push(s);
    try {
      testResults[s.type] = await withTimeout(
        gateway.testAdapter(s.type, {
          quick: !requireGenerationProbe,
          timeoutMs: adapterProbeTimeoutMs,
          probeGenerationTimeoutMs: adapterGenerationProbeTimeoutMs,
        }),
        Math.max(adapterProbeTimeoutMs + 1000, adapterGenerationProbeTimeoutMs + 1000),
        `${s.type} probe`,
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
  });
  await Promise.all(testPromises);
  const preferredIssueAfterProbe = _resolvePreferredAdapterIssue(enabledAdapters, testResults);

  let debounceRetried = 0;
  let debounceRecovered = 0;
  if (MODEL_PROBE_DEBOUNCE_ENABLED) {
    const retryCandidates = enabledAdapters.filter((s) => {
      const firstTest = testResults[s.type];
      if (isAdapterOperational(s, firstTest, strictOperationalAdapters)) return false;
      return _shouldRetryProbeByDebounce(s, firstTest);
    });
    if (retryCandidates.length > 0) {
      debounceRetried = retryCandidates.length;
      await Promise.all(retryCandidates.map(async (s) => {
        const adapterType = String(s.type || '').toLowerCase();
        const requireGenerationProbe = strictOperationalAdapters.has(adapterType);
        const adapterProbeTimeoutMs = _getAdapterProbeTimeoutMs(adapterType, probeTimeoutMs);
        const adapterGenerationProbeTimeoutMs = Math.max(adapterProbeTimeoutMs, generationProbeTimeoutMs);
        for (let attempt = 1; attempt <= MODEL_PROBE_DEBOUNCE_MAX_RETRIES; attempt++) {
          if (MODEL_PROBE_DEBOUNCE_DELAY_MS > 0) {
            const waitMs = MODEL_PROBE_DEBOUNCE_DELAY_MS * attempt;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
          try {
            const retried = await withTimeout(
              gateway.testAdapter(s.type, {
                quick: !requireGenerationProbe,
                timeoutMs: adapterProbeTimeoutMs,
                probeGenerationTimeoutMs: adapterGenerationProbeTimeoutMs,
              }),
              Math.max(adapterProbeTimeoutMs + 1000, adapterGenerationProbeTimeoutMs + 1000),
              `${s.type} debounce-probe`,
            );
            testResults[s.type] = retried;
            if (isAdapterOperational(s, retried, strictOperationalAdapters)) {
              debounceRecovered += 1;
              break;
            }
            if (!_shouldRetryProbeByDebounce(s, retried)) break;
          } catch (err) {
            testResults[s.type] = {
              connectivity: {
                success: false,
                latencyMs: adapterProbeTimeoutMs,
                error: err && err.message ? err.message : 'debounce probe failed',
              },
            };
          }
        }
      }));
    }
  }

  let backgroundDeepProbeStarted = 0;
  if (twoPhaseProbeEnabled && strictCandidates.length > 0) {
    for (const s of strictCandidates) {
      const adapterType = String(s.type || '').toLowerCase();
      const currentGeneration = testResults[s.type]?.generation || null;
      if (currentGeneration?.success) continue;
      if (currentGeneration && !_isTransientProbeLikeReason(String(currentGeneration.error || ''))) continue;
      const cached = _getDeepProbeCache(adapterType);
      if (cached && cached.test && cached.test.generation) {
        const cachedGeneration = cached.test.generation;
        // Prefer fresh live probe result; only use cache when it can improve confidence.
        if (!currentGeneration || (cachedGeneration?.success && !currentGeneration.success)) {
          testResults[s.type] = {
            ...(testResults[s.type] || {}),
            generation: cachedGeneration,
          };
        }
        continue;
      }
      if (_modelDeepProbeInFlight.has(adapterType)) continue;
      backgroundDeepProbeStarted += 1;
      const deepTask = (async () => {
        try {
          const adapterProbeTimeoutMs = _getAdapterProbeTimeoutMs(s.type, probeTimeoutMs);
          const adapterGenerationProbeTimeoutMs = Math.max(adapterProbeTimeoutMs, generationProbeTimeoutMs);
          const deep = await withTimeout(
            gateway.testAdapter(s.type, {
              quick: false,
              timeoutMs: adapterProbeTimeoutMs,
              probeGenerationTimeoutMs: adapterGenerationProbeTimeoutMs,
            }),
            Math.max(adapterProbeTimeoutMs + 3000, adapterGenerationProbeTimeoutMs + 3000),
            `${s.type} deep-probe`,
          );
          _setDeepProbeCache(adapterType, deep);
        } catch (err) {
          _setDeepProbeCache(adapterType, {
            connectivity: { success: false, error: err && err.message ? err.message : 'deep probe failed' },
            generation: { success: false, error: err && err.message ? err.message : 'deep probe failed' },
          });
        } finally {
          _modelDeepProbeInFlight.delete(adapterType);
        }
      })();
      _modelDeepProbeInFlight.set(adapterType, deepTask);
      deepTask.catch(() => {});
    }
  }

// Collect models from all available adapters with indicators
  const modelChoices = [];
  let skippedUnavailableAdapters = 0;
  const hiddenAdapters = [];
  let generationWarnCount = 0;
  let filteredModelCount = 0;
  const filteredModelReasonCount = {};
  for (const s of enabledAdapters) {
    const test = testResults[s.type];
    const adapterOk = isAdapterOperational(s, test);
    if (!adapterOk) {
      skippedUnavailableAdapters += 1;
      hiddenAdapters.push({
        name: s.name || s.type,
        type: s.type,
        reason: _classifyHiddenReason(s, test),
      });
      continue;
    }
    const generationWarn = !!(test?.generation && !test.generation.success && shouldTreatGenerationFailureAsWarning(s.type));
    if (generationWarn) generationWarnCount += 1;
    const indicator = generationWarn
      ? chalk.yellow(`● ${test.generation.error || '实测告警'}`)
      : chalk.green(`● ${test.connectivity.latencyMs}ms`);
    const statusTag = generationWarn ? chalk.yellow('[可用-告警]') : chalk.green('[可用]');

    try {
      const modelListTimeoutMs = _getAdapterModelListTimeoutMs(s.type, Math.max(3000, probeTimeoutMs));
      const models = await withTimeout(
        gateway.listModels(s.type),
        modelListTimeoutMs,
        `${s.type} listModels`,
      );
      if (models && models.length > 0) {
        const reliabilityFiltered = _filterModelsByReliability(s, test, models);
        if (reliabilityFiltered.filtered > 0) {
          filteredModelCount += reliabilityFiltered.filtered;
          for (const reason of reliabilityFiltered.reasons) {
            filteredModelReasonCount[reason] = (filteredModelReasonCount[reason] || 0) + 1;
          }
        }
        for (const m of reliabilityFiltered.models) {
          const sourceTag = _formatModelSourceTag(m);
          const connTag = _formatConnectionTag(m);
          const upstreamTag = _formatUpstreamTag(m);
          const visionTag = _formatVisionTag(m);
          const adapterTag = chalk.dim(`(执行:${s.name}/${s.type})`);
          modelChoices.push({
            name: `${statusTag} ${m.name || m.id}${visionTag ? ` ${visionTag}` : ''}${sourceTag ? ` ${sourceTag}` : ''}${upstreamTag ? ` ${upstreamTag}` : ''}${connTag ? ` ${connTag}` : ''} ${adapterTag} ${indicator}${m.isDefault ? chalk.green(' ✓ 当前') : ''}`,
            value: { adapter: s.type, model: m.id },
            disabled: false,
          });
        }
      } else {
        // Adapter available but no model list (e.g. relay)
        modelChoices.push({
          name: `${statusTag} ${s.name} ${chalk.dim('(默认模型)')} ${indicator}`,
          value: { adapter: s.type, model: null },
          disabled: false,
        });
      }
    } catch (err) {
      const reasonText = err && err.message ? err.message : 'listModels failed';
      if (String(s.type || '').toLowerCase() === 'kiro' && _isTimeoutLikeReason(reasonText)) {
        // Keep Kiro selectable when model listing is slow; selection still works
        // and runtime can refresh models in background.
        modelChoices.push({
          name: `${statusTag} ${s.name} ${chalk.dim('(模型列表超时，使用默认模型)')} ${indicator}`,
          value: { adapter: s.type, model: null },
          disabled: false,
        });
        hiddenAdapters.push({
          name: s.name || s.type,
          type: s.type,
          reason: `模型列表超时，已保留默认模型入口: ${_compactReasonText(reasonText)}`,
        });
        continue;
      }
      skippedUnavailableAdapters += 1;
      hiddenAdapters.push({
        name: s.name || s.type,
        type: s.type,
        reason: _classifyHiddenReason(s, test, reasonText),
      });
    }
  }

  if (modelChoices.length === 0) {
    onNotice('当前无可执行模型可选（已过滤未通过实测的通道）');
    if (preferredIssueAfterProbe && preferredIssueAfterProbe.type === 'unavailable') {
      onNotice(preferredIssueAfterProbe.message);
      onNotice('可先运行 khy gateway status 查看失败细节，再切换到可执行通道');
    }
    return { modelChoices: [], preferredIssueAfterProbe, empty: true };
  }

  if (skippedUnavailableAdapters > 0) {
    onNotice(`已隐藏 ${skippedUnavailableAdapters} 个未通过实测的通道（可用 khy gateway status 查看详情）`);
    const shown = [];
    const seen = new Set();
    for (const item of hiddenAdapters) {
      const key = `${String(item.type || '').toLowerCase()}|${String(item.reason || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      shown.push(item);
      if (shown.length >= 3) break;
    }
    for (const item of shown) {
      onNotice(`  - ${item.name} (${item.type}): ${item.reason}`);
    }
    if (hiddenAdapters.length > shown.length) {
      onNotice(`  - 其余 ${hiddenAdapters.length - shown.length} 个通道请用 khy gateway status 查看完整原因`);
    }
  }
  if (preferredIssueAfterProbe && preferredIssueAfterProbe.type === 'unavailable') {
    onNotice(preferredIssueAfterProbe.message);
  }
  if (generationWarnCount > 0) {
    onNotice(`探测告警 ${generationWarnCount} 项：为快速健康探测结果，不等同于运行时必然失败`);
  }
  if (filteredModelCount > 0) {
    const reasonLabels = {
      hint: '提示源模型',
      builtin: '内置回退模型',
      'warn-unverified': '告警通道的未验证模型',
      'cross-provider-claude': '跨提供商 Claude 模型',
    };
    const reasonSummary = Object.keys(filteredModelReasonCount)
      .map((key) => `${reasonLabels[key] || key}×${filteredModelReasonCount[key]}`)
      .join('，');
    onNotice(`已过滤 ${filteredModelCount} 个低置信模型（${reasonSummary || '默认可靠性策略'}）`);

    // Smart adapter suggestion: if Claude models were filtered due to cross-provider,
    // suggest switching to claude adapter
    if (filteredModelReasonCount['cross-provider-claude'] > 0) {
      const claudeAdapterAvailable = enabledAdapters.find(s =>
        String(s.type || '').toLowerCase() === 'claude' && s.available
      );
      if (claudeAdapterAvailable) {
        onNotice(`💡 提示: 若需使用 Claude Opus 4.8/4.7 等模型，可切换到 Claude 适配器`);
        onNotice(`   快速切换: export GATEWAY_PREFERRED_ADAPTER=claude && khy`);
      }
    }
  }
  if (debounceRetried > 0) {
    onNotice(`防抖复检: 已复检 ${debounceRetried} 个抖动通道，恢复 ${debounceRecovered} 个`);
  }
  if (twoPhaseProbeEnabled && backgroundDeepProbeStarted > 0) {
    onNotice(`已启动 ${backgroundDeepProbeStarted} 个后台深测任务（strict 通道），下次 /model 会显示更准确告警`);
  }

  // 模型列表顶部增设可选「Auto」入口(/goal「khy 在模型列表下设置一个 auto 模型」)。
  // 门控 KHY_AUTO_MODEL_SELECT 默认开;关 → 不 unshift(字节回退旧行为)。Auto 标签用纯排序
  // 原语按「当前会话默认任务」预览一个「最适合且可用」的模型 id(候选=已枚举的可用模型)。
  try {
    const autoSelect = require('../../services/gateway/autoModelSelect');
    if (autoSelect.isEnabled() && modelChoices.some(c => c && c.value && !c.disabled && c.value.model)) {
      const candidates = modelChoices
        .filter(c => c && c.value && !c.disabled && c.value.model)
        .map(c => ({ model: c.value.model, adapter: c.value.adapter }));
      const preview = autoSelect.pickAutoModel('conversation', candidates);
      modelChoices.unshift(autoSelect.buildAutoChoice({
        previewModel: preview && preview.model ? preview.model : '',
        chalk,
      }));
    }
  } catch { /* fail-soft: no Auto entry, picker unchanged */ }

  return { modelChoices, preferredIssueAfterProbe, empty: false };
}

/**
 * applyGatewayModelSelection — persist a chosen { adapter, model } as the
 * gateway preference, sync the live switch, and refresh adapters. Shared by the
 * classic CLI handler and the Ink TUI ModelPicker so selection has identical
 * side effects regardless of the front-end. Returns { tokenInfo } describing the
 * token source resolved for the selection.
 */
async function applyGatewayModelSelection(selected, options = {}) {
  const refreshTimeoutMs = Number.isFinite(options.refreshTimeoutMs) ? options.refreshTimeoutMs : 10000;
  const gateway = require('../../services/gateway/aiGateway');
  persistGatewayPreference(selected);
  try { gateway.syncModelSwitch(selected.model || null); } catch { /* best effort */ }
  try {
    await withTimeout(gateway.refreshAdapters(), refreshTimeoutMs, 'post-select-refresh');
  } catch { /* best effort */ }
  return { tokenInfo: getTokenInfoForSelection(selected) };
}

async function handleGatewaySelectModel(args = [], options = {}) {
  try {
  const built = await buildGatewayModelChoices({ onNotice: printInfo, onError: printError });
  if (built.empty) return;
  const { modelChoices } = built;

  const isInteractive = !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
  const requestedAdapter = (args[0] || options.adapter || '').toLowerCase();
  const requestedModel = options.model || args[1] || '';

  // Non-interactive mode: auto-pick a model without prompting.
  if (!isInteractive) {
    let pick = null;
    if (requestedAdapter || requestedModel) {
      pick = modelChoices.find(c => {
        if (!c || !c.value || c.disabled) return false;
        const adapterOk = !requestedAdapter || c.value.adapter === requestedAdapter;
        const modelOk = !requestedModel || c.value.model === requestedModel;
        return adapterOk && modelOk;
      }) || null;
    }
    if (!pick) {
      // Blind fallback must NOT pick the synthetic Auto sentinel entry (/goal「auto 模型」):
      // Auto is an explicit user choice, not a default. It is only selected above when
      // requestedAdapter/requestedModel === 'auto'. Gate-off → no Auto entry exists → no-op filter.
      let _isAutoValue;
      try { _isAutoValue = require('../../services/gateway/autoModelSelect').isAutoSelection; }
      catch { _isAutoValue = () => false; }
      pick = modelChoices.find(c => c && c.value && !c.disabled && !_isAutoValue(c.value)) || null;
    }
    if (!pick) {
      printError('无可用模型可选择');
      return;
    }
    const selected = pick.value;
    const { tokenInfo } = await applyGatewayModelSelection(selected);
    printSuccess(`已选择: ${selected.model || '默认模型'} (${selected.adapter})`);
    printInfo(`可用性: ${pick.disabled ? '不可用' : '可用'}`);
    printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
    return;
  }

  let selected = null;
  let picked = null;
  try {
    const inquirer = require('inquirer');
    const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
    const preferredModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
    const defaultChoice = modelChoices.find((c) => {
      if (!c || !c.value || c.disabled) return false;
      if (!preferredAdapter) return false;
      if (c.value.adapter !== preferredAdapter) return false;
      return preferredModel ? String(c.value.model || '') === preferredModel : true;
    });

    const { selectedValue } = await promptWithReplGuard([{
      type: 'list',
      name: 'selectedValue',
      message: '选择模型（上下方向键选择，回车确认）:',
      choices: [
        ...modelChoices.map(c => ({
          name: c.name,
          value: c.value,
          disabled: c.disabled ? '不可选' : false,
        })),
        new inquirer.Separator(),
        { name: '返回', value: null },
      ],
      pageSize: Math.min(16, Math.max(8, modelChoices.length + 2)),
      default: defaultChoice ? defaultChoice.value : undefined,
      loop: false,
    }]);
    if (!selectedValue) {
      printInfo('已取消模型选择');
      return;
    }
    selected = selectedValue;
    picked = modelChoices.find((c) => (
      c && c.value
      && c.value.adapter === selected.adapter
      && String(c.value.model || '') === String(selected.model || '')
    )) || null;
  } catch (err) {
    // User cancelled (Ctrl+C or Esc) or inquirer unavailable
    const isUserCancel = err && (
      err.message === 'User force closed the prompt'
      || err.name === 'ExitPromptError'
      || String(err).includes('force closed')
    );
    if (isUserCancel) {
      console.log('');
      printInfo('已取消模型选择');
      return;
    }

    // Fallback: numeric selection for environments where inquirer is unavailable.
    console.log('');
    for (let i = 0; i < modelChoices.length; i++) {
      const c = modelChoices[i];
      const unavailable = c.disabled ? chalk.dim(' (不可选)') : '';
      console.log(`  ${chalk.white(`${i + 1}.`)} ${c.name}${unavailable}`);
    }
    console.log(`  ${chalk.dim('0. 返回')}`);
    console.log('');

    const answer = await askLine(chalk.dim('  输入编号: '));
    const idx = Number.parseInt(String(answer || '').trim(), 10);
    if (!Number.isFinite(idx) || idx === 0) {
      printInfo('已取消模型选择');
      return;
    }
    if (idx < 1 || idx > modelChoices.length) {
      printError('编号超出范围');
      return;
    }
    picked = modelChoices[idx - 1];
    if (!picked || picked.disabled) {
      printError('该模型当前不可选，请选择可用模型');
      return;
    }
    selected = picked.value;
  }

  // Save selection to .env and apply (sync + refresh) via the shared helper.
  const { tokenInfo } = await applyGatewayModelSelection(selected);

  printSuccess(`已选择: ${selected.model || '默认模型'} (${selected.adapter})`);
  const selectedChoice = modelChoices.find((c) => {
    if (!c || !c.value) return false;
    return c.value.adapter === selected.adapter
      && String(c.value.model || '') === String(selected.model || '');
  });
  printInfo(`可用性: ${selectedChoice && selectedChoice.disabled ? '不可用' : '可用'}`);
  printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
  console.log('');
  } finally {
    recoverGatewayPromptInput();
  }
}

/**
 * Build the model choices for a SINGLE vendor, reusing the exact same catalog
 * `/model` uses (buildGatewayModelChoices) and filtering it via the pure leaf
 * nlModelSwitchResolver. Powers the natural-language "切换模型到 <vendor>" flow
 * in both front-ends (TUI openModelPickerForVendor / classic handleModelSwitchByVendor).
 *
 * @param {object} opts
 * @param {string} opts.vendor       poolKey (e.g. 'deepseek')
 * @param {string} [opts.modelHint]  concrete model id if the user named one
 * @param {function} [opts.onNotice]
 * @param {function} [opts.onError]
 * @returns {Promise<{modelChoices:Array, directPick:(object|null), empty:boolean, vendor:string}>}
 */
async function buildVendorModelChoices({ vendor, modelHint = '', onNotice = () => {}, onError = () => {} } = {}) {
  const built = await buildGatewayModelChoices({ onNotice, onError });
  if (!built || built.empty) return { modelChoices: [], directPick: null, empty: true, vendor };
  const leaf = require('../nlModelSwitchResolver');
  const filtered = leaf.filterModelChoices(built.modelChoices, vendor, modelHint);
  if (!filtered || filtered.length === 0) {
    onNotice(`未找到厂商 ${vendor} 的可用模型（可先运行 khy gateway status 查看通道状态）`);
    return { modelChoices: [], directPick: null, empty: true, vendor };
  }
  const directPick = leaf.resolveDirectPick(filtered, modelHint);
  return { modelChoices: filtered, directPick, empty: false, vendor };
}

/**
 * Classic-REPL entry for natural-language model switching: list a vendor's models
 * (via buildVendorModelChoices) and let the user pick, OR — when the user named a
 * concrete model that uniquely matches — apply it directly. Mirrors
 * handleGatewaySelectModel's inquirer + numeric-fallback + apply flow.
 *
 * @param {object} opts
 * @param {string} opts.vendor
 * @param {string} [opts.modelHint]
 */
async function handleModelSwitchByVendor({ vendor, modelHint = '' } = {}) {
  const hadGuard = global.__KHY_INQUIRER_ACTIVE__ === true;
  global.__KHY_INQUIRER_ACTIVE__ = true;
  try {
    const built = await buildVendorModelChoices({ vendor, modelHint, onNotice: printInfo, onError: printError });
    if (built.empty) return;
    const { modelChoices, directPick } = built;

    // Uniquely-named model → apply directly, no picker.
    if (directPick) {
      const { tokenInfo } = await applyGatewayModelSelection(directPick);
      printSuccess(`已切换: ${directPick.model || '默认模型'} (${directPick.adapter})`);
      printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
      console.log('');
      return;
    }

    let selected = null;
    let picked = null;
    try {
      const inquirer = require('inquirer');
      const { selectedValue } = await promptWithReplGuard([{
        type: 'list',
        name: 'selectedValue',
        message: `选择 ${vendor} 模型（上下方向键选择，回车确认）:`,
        choices: [
          ...modelChoices.map((c) => ({
            name: c.name,
            value: c.value,
            disabled: c.disabled ? '不可选' : false,
          })),
          new inquirer.Separator(),
          { name: '返回', value: null },
        ],
        pageSize: Math.min(16, Math.max(8, modelChoices.length + 2)),
        loop: false,
      }]);
      if (!selectedValue) {
        printInfo('已取消模型选择');
        return;
      }
      selected = selectedValue;
    } catch (err) {
      const isUserCancel = err && (
        err.message === 'User force closed the prompt'
        || err.name === 'ExitPromptError'
        || String(err).includes('force closed')
      );
      if (isUserCancel) {
        console.log('');
        printInfo('已取消模型选择');
        return;
      }
      // Numeric fallback for environments where inquirer is unavailable.
      console.log('');
      for (let i = 0; i < modelChoices.length; i++) {
        const c = modelChoices[i];
        const unavailable = c.disabled ? chalk.dim(' (不可选)') : '';
        console.log(`  ${chalk.white(`${i + 1}.`)} ${c.name}${unavailable}`);
      }
      console.log(`  ${chalk.dim('0. 返回')}`);
      console.log('');
      const answer = await askLine(chalk.dim('  输入编号: '));
      const idx = Number.parseInt(String(answer || '').trim(), 10);
      if (!Number.isFinite(idx) || idx === 0) {
        printInfo('已取消模型选择');
        return;
      }
      if (idx < 1 || idx > modelChoices.length) {
        printError('编号超出范围');
        return;
      }
      picked = modelChoices[idx - 1];
      if (!picked || picked.disabled) {
        printError('该模型当前不可选，请选择可用模型');
        return;
      }
      selected = picked.value;
    }

    const { tokenInfo } = await applyGatewayModelSelection(selected);
    printSuccess(`已切换: ${selected.model || '默认模型'} (${selected.adapter})`);
    printInfo(`Token: ${tokenInfo.source} → ${tokenInfo.detail}`);
    console.log('');
  } finally {
    if (!hadGuard) global.__KHY_INQUIRER_ACTIVE__ = false;
    recoverGatewayPromptInput();
  }
}

module.exports = {
  buildGatewayModelChoices,
  applyGatewayModelSelection,
  handleGatewaySelectModel,
  buildVendorModelChoices,
  handleModelSwitchByVendor,
  setGatewayModelChoicesDeps,
};
