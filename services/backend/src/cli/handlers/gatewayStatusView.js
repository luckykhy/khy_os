'use strict';

/**
 * Gateway status view (extracted from cli/handlers/gateway.js).
 *
 * Owns handleGatewayStatus — the `gateway status` command that probes every adapter with a live
 * connectivity test and renders the status table (plus JSON payload). Extracted verbatim
 * (byte-identical body) as a same-directory sibling leaf so in-body relative require() paths resolve
 * identically; the host re-imports handleGatewayStatus by the same name to keep the command contract
 * unchanged.
 *
 * This leaf performs IO (live adapter probes, terminal output, .env path resolution) so it does NOT
 * self-declare as a pure zero-IO leaf. The 17 host callbacks it still needs (risk snapshot, warning
 * classifiers, preferred-adapter/route resolvers, status-table/latency printers, endpoint collectors,
 * provider filters, timeout wrapper, env-path resolver) are injected via setGatewayStatusViewDeps to
 * avoid a require cycle back into the host.
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const os = require('os');
const path = require('path');
const {
  printSuccess,
  printError,
  printInfo,
  printTable,
  ICON_GATEWAY,
} = require('../formatters');

// ── Host callbacks injected via DI (avoid a require cycle back into gateway.js) ──
let _getGatewayHomeRiskSnapshot = null;
let shouldTreatGenerationFailureAsWarning = null;
let shouldTreatConnectivityFailureAsWarning = null;
let _resolvePreferredAdapterIssue = null;
let _appendGatewayProtocolRiskDetail = null;
let getGatewayDebugPromptSnapshot = null;
let _printGatewayStatusTable = null;
let _buildGatewayLanguageConsistencyText = null;
let _buildGatewayTraceCommandHint = null;
let _printLatencyAutoTuneSnapshot = null;
let maybeAutoSyncSwitchCenterForGateway = null;
let _resolvePreferredRouteSnapshot = null;
let _collectConfiguredEndpointObjects = null;
let _parseProviderFilterFromOptions = null;
let _filterEndpointObjectsByProvider = null;
let withTimeout = null;
let _resolveEnvPathForGateway = null;

function setGatewayStatusViewDeps(deps = {}) {
  if (typeof deps._getGatewayHomeRiskSnapshot === 'function') _getGatewayHomeRiskSnapshot = deps._getGatewayHomeRiskSnapshot;
  if (typeof deps.shouldTreatGenerationFailureAsWarning === 'function') shouldTreatGenerationFailureAsWarning = deps.shouldTreatGenerationFailureAsWarning;
  if (typeof deps.shouldTreatConnectivityFailureAsWarning === 'function') shouldTreatConnectivityFailureAsWarning = deps.shouldTreatConnectivityFailureAsWarning;
  if (typeof deps._resolvePreferredAdapterIssue === 'function') _resolvePreferredAdapterIssue = deps._resolvePreferredAdapterIssue;
  if (typeof deps._appendGatewayProtocolRiskDetail === 'function') _appendGatewayProtocolRiskDetail = deps._appendGatewayProtocolRiskDetail;
  if (typeof deps.getGatewayDebugPromptSnapshot === 'function') getGatewayDebugPromptSnapshot = deps.getGatewayDebugPromptSnapshot;
  if (typeof deps._printGatewayStatusTable === 'function') _printGatewayStatusTable = deps._printGatewayStatusTable;
  if (typeof deps._buildGatewayLanguageConsistencyText === 'function') _buildGatewayLanguageConsistencyText = deps._buildGatewayLanguageConsistencyText;
  if (typeof deps._buildGatewayTraceCommandHint === 'function') _buildGatewayTraceCommandHint = deps._buildGatewayTraceCommandHint;
  if (typeof deps._printLatencyAutoTuneSnapshot === 'function') _printLatencyAutoTuneSnapshot = deps._printLatencyAutoTuneSnapshot;
  if (typeof deps.maybeAutoSyncSwitchCenterForGateway === 'function') maybeAutoSyncSwitchCenterForGateway = deps.maybeAutoSyncSwitchCenterForGateway;
  if (typeof deps._resolvePreferredRouteSnapshot === 'function') _resolvePreferredRouteSnapshot = deps._resolvePreferredRouteSnapshot;
  if (typeof deps._collectConfiguredEndpointObjects === 'function') _collectConfiguredEndpointObjects = deps._collectConfiguredEndpointObjects;
  if (typeof deps._parseProviderFilterFromOptions === 'function') _parseProviderFilterFromOptions = deps._parseProviderFilterFromOptions;
  if (typeof deps._filterEndpointObjectsByProvider === 'function') _filterEndpointObjectsByProvider = deps._filterEndpointObjectsByProvider;
  if (typeof deps.withTimeout === 'function') withTimeout = deps.withTimeout;
  if (typeof deps._resolveEnvPathForGateway === 'function') _resolveEnvPathForGateway = deps._resolveEnvPathForGateway;
}

/**
 * Display status of all gateway adapters with live connectivity test.
 */
async function handleGatewayStatus(options = {}) {
  const gateway = require('../../services/gateway/aiGateway');
  const asJson = !!options.json;
  const endpointsOnly = !!(options['endpoints-only'] || options.endpointsOnly || options.endpoints_only);
  const providerFilters = _parseProviderFilterFromOptions(options);

  if (endpointsOnly) {
    const endpointObjects = _filterEndpointObjectsByProvider(
      _collectConfiguredEndpointObjects(),
      providerFilters
    );
    const payload = {
      generatedAt: Date.now(),
      preferredRoute: _resolvePreferredRouteSnapshot() || null,
      filters: {
        provider: providerFilters,
      },
      files: {
        proxy: path.join(os.homedir(), '.khyquant', 'proxy.json'),
        env: _resolveEnvPathForGateway(),
        apiKeysPool: path.join(os.homedir(), '.khyquant', 'api_keys.json'),
      },
      endpoints: endpointObjects,
    };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const providerHint = providerFilters.length > 0 ? ` (provider=${providerFilters.join(',')})` : '';
      printInfo(`已配置 Key 的 Endpoint 明细${providerHint}:`);
      const endpointRows = endpointObjects.map((item) => [
        `${item.displayName}${item.displayName.toLowerCase() === item.provider ? '' : ` (${item.provider})`}`,
        item.endpoint,
        String(item.keys),
        item.defaultModel,
        item.sources.join(', '),
      ]);
      if (endpointRows.length > 0) {
        printTable(['Provider', 'Endpoint', 'Keys', 'Default Model', 'Source'], endpointRows);
      } else {
        printInfo('未检测到匹配的已配置 endpoint');
      }
      console.log('');
    }
    return;
  }

  const autoSync = await maybeAutoSyncSwitchCenterForGateway('gateway-status');
  if (!gateway._initialized) await gateway.init();
  if (autoSync && autoSync.synced && (autoSync.changed || autoSync.activeChanged)) {
    try { await gateway.refreshAdapters(); } catch { /* best effort */ }
    if (!asJson) {
      printInfo(`已自动同步 switch-center: ${(autoSync.profileName || autoSync.profileId || 'windsurf-auto')} (${autoSync.modelsCount || 0} models)`);
    }
  }

  const statuses = gateway.getStatus();
  const defaultRouteRecommendation = typeof gateway.getDefaultRouteRecommendation === 'function'
    ? gateway.getDefaultRouteRecommendation()
    : null;

  if (!asJson) {
    console.log('');
    console.log(`  ${ICON_GATEWAY} ${chalk.cyan.bold('AI 网关状态')}`);
    console.log(chalk.dim('  正在检测各通道连通性...'));
    console.log('');
  }

  // Run connectivity tests in parallel for enabled+available adapters
  // Global timeout ensures the entire test phase finishes within a reasonable wall-clock window.
  const GLOBAL_TEST_TIMEOUT_MS = parseInt(process.env.GATEWAY_STATUS_TIMEOUT_MS || '20000', 10) || 20000;
  const GLOBAL_TEST_TIMEOUT_GRACE_MS = Math.min(
    1500,
    Math.max(50, Math.round(GLOBAL_TEST_TIMEOUT_MS * 0.1))
  );
  const testPromises = {};
  for (const s of statuses) {
    if (s.enabled && s.available) {
      testPromises[s.type] = gateway.testAdapter(s.type).catch(() => null);
    }
  }
  const testResults = {};
  await Promise.all(Object.entries(testPromises).map(async ([key, promise]) => {
    try {
      testResults[key] = await withTimeout(
        Promise.resolve(promise),
        GLOBAL_TEST_TIMEOUT_MS + GLOBAL_TEST_TIMEOUT_GRACE_MS,
        `${key} status probe`
      );
    } catch {
      testResults[key] = { connectivity: { success: false, latencyMs: 0, error: 'global timeout' } };
    }
  }));
  const preferredIssue = _resolvePreferredAdapterIssue(statuses, testResults);
  const importCommands = [];

  const effectiveStatuses = statuses.map(s => {
    const test = testResults[s.type];

    // 探测完成后，刷新 api adapter 的 detail（含每个 provider 延迟）
    if (s.type === 'api' && test) {
      try {
        const apiAdapter = require('../../services/gateway/adapters/apiAdapter');
        const fresh = apiAdapter.getStatus();
        s = { ...s, detail: fresh.detail };
      } catch { /* ignore */ }
    }

    if (s.enabled && s.available && test?.connectivity && !test.connectivity.success) {
      const reason = test.connectivity.error || 'connectivity failed';
      if (shouldTreatConnectivityFailureAsWarning(s.type, reason)) {
        return {
          ...s,
          available: true,
          detail: `${s.detail}（实测告警: ${reason}）`,
        };
      }
      return {
        ...s,
        available: false,
        detail: `${s.detail}（连通失败: ${reason}）`,
      };
    }
    if (s.enabled && s.available && test?.generation && !test.generation.success) {
      if (shouldTreatGenerationFailureAsWarning(s.type)) {
        const reason = test.generation.error || 'generation probe failed';
        return {
          ...s,
          available: true,
          detail: `${s.detail}（实测告警: ${reason}）`,
        };
      }
      const reason = test.generation.error || 'generation probe failed';
      return {
        ...s,
        available: false,
        detail: `${s.detail}（实测不可用: ${reason}）`,
      };
    }
    return s;
  });
  const effectiveStatusesWithRisk = effectiveStatuses.map((status) => ({
    ...status,
    khyProtocolRisk: typeof gateway.getKhyProtocolPriorityRisk === 'function'
      ? gateway.getKhyProtocolPriorityRisk(status)
      : null,
  }));

  const tableRows = effectiveStatusesWithRisk.map(s => {
      const test = testResults[s.type];
      if (
        String(s.type || '').toLowerCase() === 'localllm'
        && !s.available
        && typeof s.importCommand === 'string'
        && s.importCommand.trim()
      ) {
        importCommands.push(s.importCommand.trim());
      }
      let connectivityText = '—';
      let connectivityColor = chalk.dim;
      if (!s.enabled) {
        connectivityText = '已禁用';
        connectivityColor = chalk.dim;
      } else if (!s.available) {
        if (test?.generation && !test.generation.success) {
          connectivityText = `● ${test.generation.error || 'generation failed'}`;
          connectivityColor = chalk.red;
        } else {
          connectivityText = '—';
          connectivityColor = chalk.dim;
        }
      } else if (test) {
        if (test.connectivity?.success) {
          const ms = test.connectivity.latencyMs;
          const modelOk = test.models?.success;
          const generationFail = test.generation && !test.generation.success;
          if (generationFail) {
            connectivityText = `● ${test.generation.error || 'generation failed'}`;
            connectivityColor = chalk.red;
          } else if (modelOk) {
            connectivityText = `● ${ms}ms (${test.models.count} models)`;
            connectivityColor = chalk.green;
          } else if (test.models) {
            connectivityText = `● ${ms}ms (models: ${test.models.error})`;
            connectivityColor = chalk.yellow;
          } else {
            connectivityText = `● ${ms}ms`;
            connectivityColor = chalk.green;
          }
        } else {
          const reason = test.connectivity?.error || 'failed';
          connectivityText = `● ${reason}`;
          connectivityColor = shouldTreatConnectivityFailureAsWarning(s.type, reason)
            ? chalk.yellow
            : chalk.red;
        }
      }

      const statusText = s.enabled
        ? (s.available ? '✓ 可用' : '⚠ 不可用')
        : '已禁用';
      const statusColor = !s.enabled
        ? chalk.dim
        : (s.available ? chalk.green : chalk.yellow);

      return {
        priority: String(s.priority),
        adapter: s.name,
        type: s.type,
        status: {
          text: statusText,
          color: statusColor,
        },
        connectivity: {
          text: connectivityText,
          color: connectivityColor,
        },
        detail: _appendGatewayProtocolRiskDetail(s.detail, s.khyProtocolRisk),
        khyProtocolRisk: s.khyProtocolRisk,
      };
    });
  if (!asJson) _printGatewayStatusTable(tableRows);

  if (!asJson && importCommands.length > 0) {
    const uniqueCommands = [...new Set(importCommands)];
    printInfo('检测到可导入模型格式，可直接执行:');
    for (const command of uniqueCommands) {
      printInfo(`  ${command}`);
    }
  }

  // Keep the "active channel" consistent with effective availability shown above.
  const preferredRoute = _resolvePreferredRouteSnapshot();
  const availableStatuses = effectiveStatusesWithRisk.filter(s => s.enabled && s.available);
  let activeEntry = null;
  if (preferredRoute?.adapter) {
    activeEntry = availableStatuses.find(s => String(s.type || '').trim().toLowerCase() === preferredRoute.adapter) || null;
  }
  if (!activeEntry && defaultRouteRecommendation?.adapter) {
    activeEntry = availableStatuses.find(
      s => String(s.type || '').trim().toLowerCase() === String(defaultRouteRecommendation.adapter || '').trim().toLowerCase()
    ) || null;
  }
  if (!activeEntry) {
    activeEntry = availableStatuses[0] || null;
  }
  const active = activeEntry ? { name: activeEntry.name, type: activeEntry.type } : null;
  const activeKhyProtocolRisk = activeEntry?.khyProtocolRisk || null;
  const homeRisk = _getGatewayHomeRiskSnapshot({ activeAdapterType: active?.type });
  let latestLanguageConsistency = null;
  try {
    const traceAudit = require('../../services/traceAuditService');
    if (traceAudit && typeof traceAudit.getLatestLanguageConsistencySummary === 'function') {
      latestLanguageConsistency = traceAudit.getLatestLanguageConsistencySummary();
    }
  } catch { /* best effort */ }
  if (!asJson) {
    if (active) {
      console.log('');
      const showRouteHint = preferredRoute
        && String(active.type || '').trim().toLowerCase() === String(preferredRoute.adapter || '').trim().toLowerCase()
        && preferredRoute.routeLabel;
      printSuccess(`当前活跃通道: ${active.name} (${active.type})${showRouteHint ? ` · 默认路由: ${preferredRoute.routeLabel}` : ''}`);
    } else {
      console.log('');
      printInfo('无活跃通道 — 可用 khy gateway relay 启动 Web 中转');
    }
    if (defaultRouteRecommendation?.summary) {
      printInfo(`默认推荐通道: ${defaultRouteRecommendation.summary}`);
    }
    if (activeKhyProtocolRisk) {
      printInfo(`KHY 协议优先级: ${activeKhyProtocolRisk.summary}`);
      if (activeKhyProtocolRisk.risky && activeKhyProtocolRisk.recommendation) {
        printInfo(`排查建议: ${activeKhyProtocolRisk.recommendation}`);
      }
    }
    if (homeRisk.isTempHome && homeRisk.activeAdapterAffected) {
      printInfo(`环境提示: ${homeRisk.hint} ${homeRisk.recommendation}`.trim());
    }
    if (latestLanguageConsistency) {
      printInfo(`语言一致性: ${_buildGatewayLanguageConsistencyText(latestLanguageConsistency)}`);
      if (latestLanguageConsistency.ok && latestLanguageConsistency.status !== 'aligned') {
        printInfo('排查建议: 用 `khy gateway status --json` 查看 latestLanguageConsistency / latestDeliveryRequest，并结合 requestId 回查首段正文与最终答复是否偏航');
        printInfo(`快速复盘命令: ${_buildGatewayTraceCommandHint(latestLanguageConsistency.requestId)}`);
      }
    }
    const traceRequestId = String(latestLanguageConsistency?.requestId || '').trim();
    if (traceRequestId) {
      printInfo(`最近 requestId 复盘: ${_buildGatewayTraceCommandHint(traceRequestId)}`);
    }
    if (preferredRoute?.routeLabel) {
      printInfo(`配置默认路由: ${preferredRoute.routeLabel}`);
    }
    if (preferredIssue) {
      if (preferredIssue.type === 'invalid') {
        printError(preferredIssue.message);
        printInfo('修复建议: 运行 khy gateway model 重新选择可执行通道');
      } else if (preferredIssue.type === 'unavailable') {
        printInfo(preferredIssue.message);
        printInfo('建议: 运行 khy gateway test <adapter> 复测，或用 khy gateway model 切换通道');
      }
    }
    _printLatencyAutoTuneSnapshot();
  }
  const envPath = _resolveEnvPathForGateway();
  const proxyFile = path.join(os.homedir(), '.khyquant', 'proxy.json');
  const apiKeysPoolFile = path.join(os.homedir(), '.khyquant', 'api_keys.json');
  const routeMode = String(process.env.GATEWAY_PROXY_ROUTE_MODE || 'auto').trim().toLowerCase() || 'auto';
  if (!asJson) {
    printInfo(`代理配置位置: ${proxyFile}`);
    printInfo(`模型/API Key 配置位置: ${envPath}`);
    printInfo(`多 Key 池位置: ${apiKeysPoolFile}`);
    printInfo(`智能代理路由: GATEWAY_PROXY_ROUTE_MODE=${routeMode} (auto=国外优先代理, 国内直连)`);
  }

  const endpointObjects = _filterEndpointObjectsByProvider(
    _collectConfiguredEndpointObjects(),
    providerFilters
  );
  if (!asJson) {
    const endpointRows = endpointObjects.map((item) => [
      `${item.displayName}${item.displayName.toLowerCase() === item.provider ? '' : ` (${item.provider})`}`,
      item.endpoint,
      String(item.keys),
      item.defaultModel,
      item.sources.join(', '),
    ]);
    if (endpointRows.length > 0) {
      console.log('');
      const providerHint = providerFilters.length > 0 ? ` (provider=${providerFilters.join(',')})` : '';
      printInfo(`已配置 Key 的 Endpoint 明细${providerHint}:`);
      printTable(['Provider', 'Endpoint', 'Keys', 'Default Model', 'Source'], endpointRows);
    }
    console.log('');
    return;
  }

  const latestGatewayPromptDebug = getGatewayDebugPromptSnapshot({ tail: 1 });
  let latestDeliveryRequest = null;
  try {
    const traceAudit = require('../../services/traceAuditService');
    if (traceAudit && typeof traceAudit.getLatestDeliveryRequestSummary === 'function') {
      latestDeliveryRequest = traceAudit.getLatestDeliveryRequestSummary();
    }
  } catch { /* best effort */ }
  if (!latestLanguageConsistency) {
    try {
      const traceAudit = require('../../services/traceAuditService');
      if (traceAudit && typeof traceAudit.getLatestLanguageConsistencySummary === 'function') {
        latestLanguageConsistency = traceAudit.getLatestLanguageConsistencySummary();
      }
    } catch { /* best effort */ }
  }
  const jsonPayload = {
    generatedAt: Date.now(),
    filters: {
      provider: providerFilters,
    },
    activeChannel: active ? { name: active.name, type: active.type } : null,
    activeKhyProtocolRisk: activeKhyProtocolRisk || null,
    environment: {
      homeRisk,
    },
    latestKhyPromptDebug: {
      file: latestGatewayPromptDebug.file,
      exists: latestGatewayPromptDebug.exists,
      entriesCount: latestGatewayPromptDebug.entriesCount,
      totalEntriesCount: latestGatewayPromptDebug.totalEntriesCount,
      latest: latestGatewayPromptDebug.latest,
    },
    latestDeliveryRequest: latestDeliveryRequest || null,
    latestLanguageConsistency: latestLanguageConsistency || null,
    preferredRoute: preferredRoute || null,
    defaultRouteRecommendation: defaultRouteRecommendation || null,
    preferredIssue: preferredIssue || null,
    files: {
      proxy: proxyFile,
      env: envPath,
      apiKeysPool: apiKeysPoolFile,
    },
    routeMode,
    adapters: tableRows.map((row) => {
      const raw = effectiveStatuses.find((s) => String(s.type || '') === String(row.type || '')) || null;
      const test = testResults[row.type];
      return {
        priority: Number(raw?.priority ?? row.priority ?? 0),
        name: row.adapter,
        type: row.type,
        enabled: !!raw?.enabled,
        available: !!raw?.available,
        status: row.status.text,
        detail: row.detail,
        khyProtocolRisk: raw?.khyProtocolRisk || row.khyProtocolRisk || null,
        connectivity: {
          summary: row.connectivity.text,
          test: test || null,
        },
      };
    }),
    endpoints: endpointObjects,
  };
  console.log(JSON.stringify(jsonPayload, null, 2));
}

module.exports = {
  handleGatewayStatus,
  setGatewayStatusViewDeps,
};
