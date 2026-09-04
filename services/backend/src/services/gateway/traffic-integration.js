'use strict';

/**
 * traffic-integration.js — 智能触发流量记录。
 *
 * 触发策略（"合适的时候"）：
 *   1. 错误请求：statusCode >= 400 或调用抛异常 → 必记
 *   2. 慢请求：耗时超过阈值（默认 5000ms）→ 必记
 *   3. 慢响应首字节：TTFB 超过阈值（默认 2000ms）→ 必记
 *   4. 特定 provider：用户在 watchlist 中配置的 provider → 必记
 *   5. 大 token 请求：input+output 超过阈值（默认 10000）→ 记
 *   6. 采样模式：高流量时按采样率记录（默认 100%，可调）
 *   7. 用户主动：khy traffic watch 触发时全量记录
 *   8. 健康检查/心跳：跳过（不记录）
 *
 * 门控：
 *   KHY_TRAFFIC_CAPTURE=1 总开关（默认开）
 *   KHY_TRAFFIC_SLOW_MS=5000 慢请求阈值
 *   KHY_TRAFFIC_SAMPLE_RATE=1.0 采样率 0-1
 *   KHY_TRAFFIC_WATCHLIST=claude,deepseek 全量记录的 provider
 *
 * @module gateway/traffic-integration
 */

const { trafficLogger } = require('./traffic-logger');
const { credentialHarvester } = require('./credential-harvester');

// ── 触发配置（从 env 读取，有默认值）────────────────────────────
function getTriggerConfig() {
  return {
    enabled: String(process.env.KHY_TRAFFIC_CAPTURE || '1') !== '0',
    slowThresholdMs: parseInt(process.env.KHY_TRAFFIC_SLOW_MS || '5000', 10),
    ttfbThresholdMs: parseInt(process.env.KHY_TRAFFIC_TTFB_MS || '2000', 10),
    sampleRate: Math.min(1, Math.max(0, parseFloat(process.env.KHY_TRAFFIC_SAMPLE_RATE || '1.0'))),
    watchlist: String(process.env.KHY_TRAFFIC_WATCHLIST || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    skipHealthCheck: String(process.env.KHY_TRAFFIC_SKIP_HEALTH || '1') !== '0',
    largeTokenThreshold: parseInt(process.env.KHY_TRAFFIC_LARGE_TOKENS || '10000', 10),
  };
}

// ── 判断是否为健康检查/心跳请求（应跳过）────────────────────────
function isHealthCheckRequest(options) {
  // 健康检查通常有特定标记
  if (options?._isHealthCheck) return true;
  if (options?._isProbe) return true;
  // 极短 prompt（< 5 字符）通常是心跳
  if (typeof options?.userMessage === 'string' && options.userMessage.length < 5) return true;
  if (typeof options?.system === 'string' && options.system.length < 5 && !options?.userMessage) return true;
  return false;
}

// ── 核心：判断是否应该记录本次请求 ──────────────────────────────
function shouldRecordTraffic({ entry, result, error, statusCode, durationMs, ttfbMs, options }) {
  const cfg = getTriggerConfig();

  // 总开关关闭
  if (!cfg.enabled) return false;

  // 健康检查跳过
  if (cfg.skipHealthCheck && isHealthCheckRequest(options)) return false;

  // 错误请求：必记
  if (error || (statusCode && statusCode >= 400)) return true;

  // 慢请求：必记
  if (durationMs >= cfg.slowThresholdMs) return true;

  // 慢首字节：必记
  if (ttfbMs && ttfbMs >= cfg.ttfbThresholdMs) return true;

  // Watchlist 中的 provider：必记
  const providerName = (entry?.key || '').toLowerCase();
  if (cfg.watchlist.includes(providerName)) return true;

  // 大 token 请求：必记
  const totalTokens = result?.tokenUsage?.totalTokens || 0;
  if (totalTokens >= cfg.largeTokenThreshold) return true;

  // 用户主动 watch 模式：全量记录
  if (trafficLogger._watchMode) return true;

  // 采样模式：按概率记录
  if (cfg.sampleRate < 1) {
    return Math.random() < cfg.sampleRate;
  }

  // 默认记录
  return true;
}

// ── 端点 URL 解析 ────────────────────────────────────────────────
function resolveEndpointUrl(adapterKey, adapter) {
  if (adapter && typeof adapter.getEndpoint === 'function') {
    try {
      return adapter.getEndpoint();
    } catch {
      /* fall through */
    }
  }
  try {
    const { resolveAdapterEndpoint } = require('./adapters/_endpointResolver');
    return resolveAdapterEndpoint(adapterKey);
  } catch {
    return '';
  }
}

// ── 从 adapter 状态提取 provider 名称 ───────────────────────────
function resolveProviderName(adapter, entry) {
  if (adapter && typeof adapter.getStatus === 'function') {
    try {
      return adapter.getStatus().name || entry.key;
    } catch {
      /* fall through */
    }
  }
  return entry.key || 'unknown';
}

// ── 构建请求体预览 ──────────────────────────────────────────────
function buildRequestBodyPreview(prompt, options) {
  return {
    model: options?.model,
    messages: options?.messages || [{ role: 'user', content: prompt }],
    max_tokens: options?.maxTokens,
    temperature: options?.temperature,
    stream: true,
  };
}

// ── 构建响应体预览 ──────────────────────────────────────────────
function buildResponseBodyPreview(result) {
  if (!result) return null;
  return {
    content: typeof result.content === 'string' ? result.content.slice(0, 500) : null,
    model: result.model,
    tokenUsage: result.tokenUsage,
    stopReason: result.stopReason || result.finishReason,
  };
}

// ── 记录一次成功的 AI 调用 ──────────────────────────────────────
function recordSuccessTraffic({ entry, result, startTime, ttfbMs, options, adapter, prompt }) {
  if (!shouldRecordTraffic({
    entry,
    result,
    statusCode: 200,
    durationMs: Date.now() - startTime,
    ttfbMs,
    options,
  })) {
    return null; // 被触发策略跳过
  }

  const endpointUrl = resolveEndpointUrl(entry.key, adapter);
  const providerName = resolveProviderName(adapter, entry);

  // 提取凭据
  const credentials = credentialHarvester.harvestFromRequest({
    url: endpointUrl,
    method: 'POST',
    headers: options?._requestHeaders || {},
    body: buildRequestBodyPreview(prompt, options),
    sessionId: options?.sessionId || 'default',
  });

  return trafficLogger.record({
    sessionId: options?.sessionId || 'default',
    provider: result.provider || providerName,
    model: result.model || options?.model || 'unknown',
    adapterKey: entry.key,
    url: endpointUrl,
    method: 'POST',
    requestHeaders: options?._requestHeaders || {},
    requestBody: buildRequestBodyPreview(prompt, options),
    statusCode: 200,
    responseHeaders: {},
    responseBody: buildResponseBodyPreview(result),
    durationMs: Date.now() - startTime,
    success: true,
    traceId: options?._diagTraceId || '',
    credentials: credentials.length,
  });
}

// ── 记录一次失败的 AI 调用 ──────────────────────────────────────
function recordFailureTraffic({ entry, error, statusCode, startTime, ttfbMs, options, adapter, prompt }) {
  if (!shouldRecordTraffic({
    entry,
    error,
    statusCode,
    durationMs: Date.now() - startTime,
    ttfbMs,
    options,
  })) {
    return null;
  }

  const endpointUrl = resolveEndpointUrl(entry.key, adapter);
  const providerName = resolveProviderName(adapter, entry);

  // 提取凭据
  const credentials = credentialHarvester.harvestFromRequest({
    url: endpointUrl,
    method: 'POST',
    headers: options?._requestHeaders || {},
    body: buildRequestBodyPreview(prompt, options),
    sessionId: options?.sessionId || 'default',
  });

  return trafficLogger.record({
    sessionId: options?.sessionId || 'default',
    provider: providerName,
    model: options?.model || 'unknown',
    adapterKey: entry.key,
    url: endpointUrl,
    method: 'POST',
    requestHeaders: {},
    requestBody: buildRequestBodyPreview(prompt, options),
    statusCode: statusCode || 0,
    responseHeaders: {},
    responseBody: null,
    durationMs: Date.now() - startTime,
    success: false,
    errorMessage: error?.message || String(error),
    traceId: options?._diagTraceId || '',
    credentials: credentials.length,
  });
}

// ── 安装补丁到 gateway 实例 ─────────────────────────────────────
function installTrafficRecording(gateway) {
  if (!gateway || !gateway._generateWithAdapterIsolation) {
    return;
  }

  const originalGenerate = gateway._generateWithAdapterIsolation.bind(gateway);

  gateway._generateWithAdapterIsolation = async function patchedGenerate(
    entry,
    prompt,
    options
  ) {
    const startTime = Date.now();
    let ttfbMs = null;
    let firstChunkTime = null;

    // 拦截 onChunk 以测量 TTFB
    const originalOnChunk = options?.onChunk;
    if (originalOnChunk) {
      options.onChunk = (chunk) => {
        if (firstChunkTime === null) {
          firstChunkTime = Date.now();
          ttfbMs = firstChunkTime - startTime;
        }
        originalOnChunk(chunk);
      };
    }

    try {
      const result = await originalGenerate(entry, prompt, options);
      if (result && result.success) {
        recordSuccessTraffic({
          entry,
          result,
          startTime,
          ttfbMs,
          options,
          adapter: entry.adapter,
          prompt,
        });
      } else if (result && !result.success) {
        recordFailureTraffic({
          entry,
          error: { message: result.error || 'adapter failed' },
          statusCode: result.statusCode,
          startTime,
          ttfbMs,
          options,
          adapter: entry.adapter,
          prompt,
        });
      }
      return result;
    } catch (err) {
      recordFailureTraffic({
        entry,
        error: err,
        statusCode: err?.status || err?.statusCode,
        startTime,
        ttfbMs,
        options,
        adapter: entry.adapter,
        prompt,
      });
      throw err;
    }
  };
}

// ── 导出 ────────────────────────────────────────────────────────
module.exports = {
  installTrafficRecording,
  recordSuccessTraffic,
  recordFailureTraffic,
  shouldRecordTraffic,
  getTriggerConfig,
  isHealthCheckRequest,
};
