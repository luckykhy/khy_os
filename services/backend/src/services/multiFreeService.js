const http = require('http');
const https = require('https');

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const jwt = require('jsonwebtoken');

const { PRIMARY: MODELS } = require('../constants/models');

const { extractPrimaryApiKey } = require('./apiKeyFormat');
const { normalizeCacheUsage } = require('./gateway/adapters/_cacheUsage');
const {
  toGoogleInlineData,
  toOpenAIVisionBlocks,
  toAnthropicImageBlocks,
} = require('./gateway/adapters/_imageCompat');
const { convertMessagesAnthropicToOpenAI } = require('./gateway/adapters/_toolSchemaConverter');

// Model-name SSOT: free-tier provider model choices flow from constants/models.js.

// ── Keep-alive 连接管理与死连接免疫 ─────────────────────────────────
// 长空闲后服务端会静默关闭 keep-alive TCP 连接;下次复用该死连接会报
// socket hang up / ECONNRESET,导致新消息被错误地记成 unknown 失败。对策:
//   1. keepAlive 复用连接,但**不设 agent 级 timeout**:实测(Node v24 原生
//      http.Agent + 本地服务器,块间隔 > timeout)该 timeout 是 socket 级,
//      活跃请求期间同样触发 socket/request 的 timeout 事件——对块间隔可能
//      超过阈值的 SSE 长流(OpenAI/Anthropic 流式)是不可靠行为(当前 axios
//      恰好不因此销毁流,但属未文档化实现细节,不可依赖)。Node 原生 Agent
//      也没有 agentkeepalive 的 freeSocketTimeout(仅作用空闲池)选项,故无法
//      只对 free socket 设超时 → 选择安全方案:不设 timeout;
//   2. 用较小的 maxFreeSockets 收紧空闲池,减少可能变成死连接的存量;
//   3. 若仍撞上死连接(尚未收到任何响应数据),postWithDeadConnRetry 自动用
//      全新连接重试一次(仅一次)——死连接防护完全由该重试兜底。
const KEEP_ALIVE_MAX_FREE_SOCKETS = 5;

/**
 * 判定给定模型是否应剥离 tools 声明(小模型不支持 function calling)。
 * 单一真源在 gateway/modelToolingCapability(与系统提示词教学门同源);
 * 门控关 → 字节回退到旧内联名字正则。
 *
 * @param {string} model
 * @param {object} opts
 * @param {boolean} [opts._toolCapProbe] - 能力探测必须真发 tools,绝不剥离
 * @returns {boolean} true=应剥离 tools(消息中的工具块须内联为文本)
 */
function _decideStripTools(model, opts = {}) {
  try {
    if (opts._toolCapProbe) {
      return false;
    } // 探测必须保留 tools
    const _toolCap = require('./gateway/modelToolingCapability');
    if (_toolCap.isEnabled()) {
      let _measured = null;
      try {
        _measured = require('./gateway/toolCapabilityStore').getVerdict(model);
      } catch {
        /* best effort */
      }
      return _toolCap.shouldStripUpstreamTools(model, { measured: _measured });
    }
  } catch {
    /* capability store 不可用 → 名字启发 */
  }
  return (
    /(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i.test(String(model || '')) &&
    !/deepseek-v[3-9]/i.test(String(model || '')) &&
    !/sensenova-\d/i.test(String(model || ''))
  );
}

// ── 代理支持 ──────────────────────────────────────────────
// 配置了 HTTPS_PROXY 时，优先走代理；代理不可达时自动回退直连。
// 不配置 HTTPS_PROXY 时完全不走代理（性能零损耗）。
const _configuredProxyUrl = (process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
const _proxyAgent = _configuredProxyUrl ? new HttpsProxyAgent(_configuredProxyUrl) : null;
const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxFreeSockets: KEEP_ALIVE_MAX_FREE_SOCKETS,
});
const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: KEEP_ALIVE_MAX_FREE_SOCKETS,
});
const _directHttpsAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: KEEP_ALIVE_MAX_FREE_SOCKETS,
});

let _proxyFailedOnce = false;

// ── Per-provider 代理 ─────────────────────────────────────
// provider 配置(custom_providers.json / api_keys.json)带 proxy 字段时，该 provider
// 的请求单独经其代理发出；其余 provider 不受影响（沿用共享 keep-alive agent 直连）。
// agent 按代理 URL 缓存复用，保持 keep-alive 连接池语义。代理地址只来自配置，源码零硬编码。
const _providerProxyAgents = new Map();

function _agentForProviderProxy(proxyUrl, label) {
  const raw = String(proxyUrl || '').trim();
  // 空串/null → 直连（返回共享 keep-alive https agent，行为等同不配置代理）。
  if (!raw) {
    return sharedHttpsAgent;
  }
  let agent = _providerProxyAgents.get(raw);
  if (!agent) {
    try {
      agent = new HttpsProxyAgent(raw);
    } catch (err) {
      // 非法代理 URL 会在此同步抛错；容错回退直连，避免请求前崩溃。
      // 只打 err.code（如 ERR_INVALID_URL），不打 URL/凭据。
      console.warn(
        `[proxy] ${label || 'provider'} 代理地址无效（${(err && err.code) || 'invalid'}），回退直连`
      );
      return sharedHttpsAgent;
    }
    _providerProxyAgents.set(raw, agent);
    try {
      const u = new URL(raw);
      console.log(
        `[proxy] 连接 ${label || 'provider'} 经代理 ${u.hostname}:${u.port}（per-provider，通道已建立）`
      );
    } catch {
      /* proxyUrl 无法解析主机端口时仅跳过日志，agent 已可用 */
    }
  }
  return agent;
}

function _currentHttpsAgent() {
  if (!_proxyAgent || _proxyFailedOnce) {
    return _directHttpsAgent;
  }
  return _proxyAgent;
}

function withKeepAliveAgents(config = {}) {
  // config 展开在后 → 调用方显式传入的 httpAgent/httpsAgent 优先于共享 agent。
  return { httpAgent: sharedHttpAgent, httpsAgent: _currentHttpsAgent(), ...config };
}

// 死连接错误判定:keep-alive 连接被服务端关闭后复用所致,换新连接即可恢复。
// err.response 存在 → 已收到上游响应,不属于死连接。注意排除 axios 超时
// (code 同为 ECONNABORTED 但 message 带 timeout)——超时重试只会双倍等待。
function isDeadConnectionError(err) {
  if (!err || err.response) {
    return false;
  }
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  if (code === 'ECONNABORTED' || msg.includes('econnaborted')) {
    return !/timeout|timed?\s*out/.test(msg);
  }
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('epipe') ||
    msg.includes('broken pipe')
  );
}

// POST 封装:注入共享 keep-alive agent;遇死连接(未收到任何响应数据)时
// 用全新连接重试一次(不带 agent → 绕开池内可能残留的其他死 socket)。
// config._providerProxyUrl(内部字段,发请求前剥离)存在时走 per-provider 代理分支:
// 请求经该代理的缓存 agent 发出;死连接重试改用全新 HttpsProxyAgent(仍经代理,
// 同样绕开池内死 socket)。不带该字段的请求走原共享 agent 路径,行为逐字节不变。
async function postWithDeadConnRetry(url, data, config, label) {
  const { _providerProxyUrl, ...restConfig } = config || {};
  const providerProxyUrl = String(_providerProxyUrl || '').trim();
  if (providerProxyUrl) {
    const proxied = { ...restConfig, httpsAgent: _agentForProviderProxy(providerProxyUrl, label) };
    try {
      return await axios.post(url, data, withKeepAliveAgents(proxied));
    } catch (err) {
      if (!isDeadConnectionError(err)) {
        throw err;
      }
      console.warn(
        `连接被服务端关闭(${err.code || err.message})，正在经代理用新连接重试 ${label} (第1/1次)...`
      );
      let retryAgent;
      try {
        retryAgent = new HttpsProxyAgent(providerProxyUrl);
      } catch (e) {
        // 代理地址此刻变得非法/不可构造 → 死连接重试改用直连，绝不因构造抛错中断。
        console.warn(
          `[proxy] ${label || 'provider'} 代理地址无效（${(e && e.code) || 'invalid'}），死连接重试改用直连`
        );
        return axios.post(url, data, {
          ...restConfig,
          httpsAgent: _directHttpsAgent,
          httpAgent: sharedHttpAgent,
        });
      }
      return axios.post(url, data, { ...restConfig, httpsAgent: retryAgent });
    }
  }
  try {
    return await axios.post(url, data, withKeepAliveAgents(restConfig));
  } catch (err) {
    // 代理不可用(连接拒绝/超时) → 回退直连
    if (_proxyAgent && !_proxyFailedOnce && isProxyConnectError(err)) {
      _proxyFailedOnce = true;
      console.warn(`[proxy] 代理 ${_configuredProxyUrl} 不可达，回退直连`);
      return axios.post(url, data, {
        ...restConfig,
        httpsAgent: _directHttpsAgent,
        httpAgent: sharedHttpAgent,
      });
    }
    if (!isDeadConnectionError(err)) {
      throw err;
    }
    console.warn(
      `连接被服务端关闭(${err.code || err.message})，正在用新连接重试 ${label} (第1/1次)...`
    );
    return axios.post(url, data, { ...restConfig });
  }
}

function isProxyConnectError(err) {
  if (!err || err.response) {
    return false;
  }
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toUpperCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    msg.includes('econnrefused') ||
    msg.includes('proxy connect') ||
    msg.includes('tunnel') ||
    msg.includes('connect econnrefused')
  );
}

// Sliding idle watchdog for streaming responses. Some providers accept the
// request (headers arrive) but never emit a single data chunk, leaving the
// stream Promise pending forever and the TUI stuck on "thinking". The watchdog
// arms on creation, is reset on every data chunk, and on expiry destroys the
// stream and rejects with an honest, actionable Chinese message.
// Threshold: KHY_STREAM_IDLE_TIMEOUT_MS (default 45000ms).
//
// Timeout layering: by default the gateway idle watchdog
// (GATEWAY_WALL_CLOCK_TIMEOUT_MS) fires first; this stream-level guard
// (KHY_STREAM_IDLE_TIMEOUT_MS, 45s) and the TUI-level guard
// (KHY_CHAT_IDLE_TIMEOUT_MS, 180s) are last-resort backstops. When tuning,
// keep KHY_STREAM_IDLE_TIMEOUT_MS >= the gateway idle default.
function createStreamIdleWatchdog(stream, reject, label) {
  // Explicit parse with positivity check: a negative/zero/garbage env value
  // must fall back to the default instead of arming an instant timeout.
  const rawIdleMs = Number.parseInt(
    String(process.env.KHY_STREAM_IDLE_TIMEOUT_MS || '').trim(),
    10
  );
  const idleTimeoutMs = Number.isFinite(rawIdleMs) && rawIdleMs > 0 ? rawIdleMs : 45000;
  let timer = null;
  const onExpire = () => {
    timer = null;
    try {
      stream.destroy();
    } catch {
      /* best effort — stream may be gone */
    }
    reject(
      new Error(
        `流式响应空闲超时：${label} 已 ${Math.round(idleTimeoutMs / 1000)}s 未收到任何数据分块（可设 KHY_STREAM_IDLE_TIMEOUT_MS 调整）`
      )
    );
  };
  const touch = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(onExpire, idleTimeoutMs);
  };
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  touch(); // arm immediately — covers the "headers arrived, zero chunks" hang
  return { touch, clear };
}

class MultiFreeService {
  constructor() {
    this.baiduToken = null;
    this.baiduTokenExpireAt = 0;
    const googleApiKey =
      extractPrimaryApiKey(process.env.GOOGLE_GEMINI_API_KEY) ||
      extractPrimaryApiKey(process.env.GEMINI_API_KEY);
    const groqApiKey = extractPrimaryApiKey(process.env.GROQ_API_KEY);
    const openRouterApiKey = extractPrimaryApiKey(process.env.OPENROUTER_API_KEY);
    const openAiApiKey = extractPrimaryApiKey(process.env.OPENAI_API_KEY);
    const anthropicApiKey = extractPrimaryApiKey(process.env.ANTHROPIC_API_KEY);
    const traeApiKey = extractPrimaryApiKey(process.env.TRAE_API_KEY);
    const zhipuApiKey = extractPrimaryApiKey(process.env.ZHIPU_API_KEY);
    const xunfeiApiKey = extractPrimaryApiKey(process.env.XUNFEI_API_KEY);
    const baiduApiKey = extractPrimaryApiKey(process.env.BAIDU_API_KEY);
    const baiduSecretKey =
      extractPrimaryApiKey(process.env.BAIDU_SECRET_KEY) ||
      extractPrimaryApiKey(process.env.BAIDU_API_SECRET) ||
      extractPrimaryApiKey(process.env.BAIDU_SECRET);
    const alibabaApiKey =
      extractPrimaryApiKey(process.env.ALIBABA_API_KEY) ||
      extractPrimaryApiKey(process.env.DASHSCOPE_API_KEY);
    const huggingFaceToken = extractPrimaryApiKey(process.env.HUGGINGFACE_TOKEN);

    this.providers = {
      google: {
        name: 'Google Gemini',
        apiKey: googleApiKey,
        enabled: !!googleApiKey,
        model: MODELS.freeGoogle,
        priority: 1,
        supportsVision: true,
      },
      groq: {
        name: 'Groq',
        apiKey: groqApiKey,
        enabled: !!groqApiKey,
        model: MODELS.freeGroq,
        priority: 2,
        supportsVision: false,
      },
      openrouter: {
        name: 'OpenRouter',
        apiKey: openRouterApiKey,
        enabled: !!openRouterApiKey,
        model: 'meta-llama/llama-3.3-70b-instruct',
        priority: 3,
        supportsVision: false,
      },
      openai: {
        name: 'OpenAI',
        apiKey: openAiApiKey,
        enabled: !!openAiApiKey,
        model: 'gpt-4o-mini',
        priority: 4,
        supportsVision: true,
      },
      anthropic: {
        name: 'Anthropic',
        apiKey: anthropicApiKey,
        enabled: !!anthropicApiKey,
        model: process.env.ANTHROPIC_MODEL || MODELS.sonnet,
        priority: 4,
        supportsVision: true,
        availableModels: [
          { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'ultra' },
          { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'ultra' },
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'ultra' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'high' },
          { id: 'claude-haiku-4-5-latest', name: 'Claude Haiku 4.5', tier: 'medium' },
        ],
      },
      trae: {
        name: 'Trae API',
        apiKey: traeApiKey,
        enabled: !!traeApiKey,
        model: process.env.TRAE_MODEL || MODELS.ide,
        priority: 5,
        supportsVision: true,
        // Trae 的真实网关是加密原生协议（adaptive-api.trae.ai，CodeWhisperer 风格），
        // 不是 OpenAI 兼容接口；api.trae.ai/v1 对 /chat/completions 返回 404。
        // 因此不再默认回退到 api.trae.ai；如需自建 OpenAI 兼容代理请显式设置 TRAE_API_ENDPOINT。
        baseUrl: (process.env.TRAE_API_ENDPOINT || '').replace(/\/v1\/?$/, ''),
        availableModels: [
          { id: 'gpt-4o', name: 'GPT-4o', tier: 'high' },
          { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', tier: 'high' },
          { id: 'deepseek-v3', name: 'DeepSeek V3', tier: 'high' },
          { id: 'doubao-1.5-pro', name: 'Doubao 1.5 Pro', tier: 'high' },
        ],
      },
      zhipu: {
        name: '智谱AI',
        apiKey: zhipuApiKey,
        enabled: !!zhipuApiKey,
        model: process.env.ZHIPU_MODEL || 'glm-4-plus',
        priority: 5,
        supportsVision: true,
        availableModels: [
          { id: 'glm-4-plus', name: 'GLM-4-Plus', tier: 'ultra' },
          { id: 'glm-4-0520', name: 'GLM-4', tier: 'high' },
          { id: 'glm-4-air', name: 'GLM-4-Air', tier: 'medium' },
          { id: 'glm-4-airx', name: 'GLM-4-AirX', tier: 'high' },
          { id: 'glm-4-long', name: 'GLM-4-Long (1M tokens)', tier: 'high' },
          { id: 'glm-4-flash', name: 'GLM-4-Flash (Free)', tier: 'low' },
          { id: 'glm-4v-plus', name: 'GLM-4V-Plus (Vision)', tier: 'ultra' },
        ],
      },
      xunfei: {
        name: '讯飞星火',
        apiKey: xunfeiApiKey,
        enabled: !!xunfeiApiKey,
        model: 'lite',
        priority: 6,
        supportsVision: false,
      },
      baidu: {
        name: '百度文心',
        apiKey: baiduApiKey,
        secretKey: baiduSecretKey || '',
        enabled: !!baiduApiKey,
        model: 'ERNIE-Bot',
        priority: 7,
        supportsVision: false,
      },
      alibaba: {
        name: '通义千问',
        apiKey: alibabaApiKey,
        enabled: !!alibabaApiKey,
        model: process.env.QWEN_MODEL || 'qwen-max',
        priority: 8,
        supportsVision: true,
        availableModels: [
          { id: 'qwen-max', name: 'Qwen-Max', tier: 'ultra' },
          { id: 'qwen-plus', name: 'Qwen-Plus', tier: 'high' },
          { id: 'qwen-turbo', name: 'Qwen-Turbo', tier: 'medium' },
          { id: 'qwen-long', name: 'Qwen-Long (10M tokens)', tier: 'high' },
          { id: 'qwen-vl-max', name: 'Qwen-VL-Max (Vision)', tier: 'ultra' },
          { id: 'qwen-vl-plus', name: 'Qwen-VL-Plus (Vision)', tier: 'high' },
          { id: 'qwen-coder-plus', name: 'Qwen-Coder-Plus', tier: 'high' },
          { id: 'qwen2.5-72b-instruct', name: 'Qwen2.5-72B', tier: 'ultra' },
          { id: 'qwen2.5-32b-instruct', name: 'Qwen2.5-32B', tier: 'high' },
          { id: 'qwen2.5-14b-instruct', name: 'Qwen2.5-14B', tier: 'medium' },
          { id: 'qwen2.5-7b-instruct', name: 'Qwen2.5-7B', tier: 'low' },
        ],
      },
      huggingface: {
        name: 'HuggingFace',
        apiKey: huggingFaceToken,
        enabled: !!huggingFaceToken,
        model: 'mistralai/Mistral-7B-Instruct-v0.2',
        priority: 9,
        supportsVision: false,
      },
    };
  }

  getAvailableProviders() {
    return Object.entries(this.providers)
      .filter(([, provider]) => provider.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority)
      .map(([key, provider]) => ({ key, ...provider }));
  }

  getAvailableProvider() {
    const providers = this.getAvailableProviders();
    return providers.length > 0 ? providers[0] : null;
  }

  getStatus() {
    const available = this.getAvailableProviders();
    return {
      available: available.length > 0,
      provider: available[0]?.name || 'local-fallback',
      configuredProviders: available.map((p) => p.name),
      message:
        available.length > 0
          ? `${available.length} provider(s) configured`
          : 'No cloud providers configured, using local fallback',
    };
  }

  async testConnection() {
    const availableProviders = this.getAvailableProviders().map((p) => p.name);
    if (availableProviders.length === 0) {
      return {
        success: false,
        message: 'No LLM providers configured',
        provider: 'local-fallback',
        response: null,
        availableProviders,
        results: [],
      };
    }

    const result = await this.generateResponse('Reply with one short sentence: connection ok.', {
      temperature: 0,
      maxTokens: 64,
    });

    return {
      success: result.success,
      message: result.success ? 'LLM connection test completed' : 'LLM connection test failed',
      provider: result.provider,
      response: result.content,
      availableProviders,
      results: result.attempts || [],
    };
  }

  async analyze(payload = {}) {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const stockCode = payload.stockCode || 'UNKNOWN';
    const result = await this.generateResponse(prompt, {
      temperature: payload.temperature ?? 0.4,
      maxTokens: payload.maxTokens ?? 1500,
    });

    if (result.success && result.content) {
      return result.content;
    }

    return this.localFallback(payload.agentId, stockCode);
  }

  async generateResponse(prompt, options = {}) {
    const temperature = options.temperature ?? 0.4;
    const maxTokens = options.maxTokens ?? 1024;
    const requestedProvider = String(options.provider || '')
      .trim()
      .toLowerCase();
    const requestedModel = String(options.model || '').trim();

    if (!prompt || !prompt.trim()) {
      return {
        success: false,
        content: 'Prompt is empty',
        provider: 'none',
        attempts: [],
      };
    }

    const allProviders = this.getAvailableProviders();
    let providers = allProviders;

    if (requestedProvider) {
      providers = allProviders.filter((p) => p.key === requestedProvider);
      if (providers.length === 0) {
        return {
          success: false,
          content: `Provider not configured: ${requestedProvider}`,
          provider: 'none',
          attempts: [],
          availableProviders: allProviders.map((p) => p.key),
        };
      }
    }

    if (requestedModel && providers.length > 1) {
      const scoreByModel = (provider) => {
        if (provider.model === requestedModel) {
          return 3;
        }
        if (
          Array.isArray(provider.availableModels) &&
          provider.availableModels.some((m) => m.id === requestedModel)
        ) {
          return 2;
        }
        return 0;
      };
      providers = [...providers].sort((a, b) => {
        const diff = scoreByModel(b) - scoreByModel(a);
        if (diff !== 0) {
          return diff;
        }
        return a.priority - b.priority;
      });
    }

    const attempts = [];

    for (const provider of providers) {
      // Skip non-vision providers when images are present
      if (options.images && options.images.length > 0 && !provider.supportsVision) {
        attempts.push({ provider: provider.name, success: false, error: 'No vision support' });
        continue;
      }

      try {
        const result = await this.callProvider(provider, prompt, {
          temperature,
          maxTokens,
          images: options.images,
          model: requestedModel || provider.model,
          tools: options.tools,
          structuredMessages: options.structuredMessages,
          system: options.system,
          onChunk: options.onChunk,
          thinking: options.thinking,
        });
        // callProvider now returns { content, tokenUsage, thinking?, toolUseBlocks?, finishReason? } or a plain string (legacy)
        const content = typeof result === 'string' ? result : result?.content;
        const tokenUsage = typeof result === 'object' ? result?.tokenUsage : null;
        const thinking = typeof result === 'object' ? result?.thinking : null;
        const toolUseBlocks = typeof result === 'object' ? result?.toolUseBlocks : null;
        const finishReason = typeof result === 'object' ? result?.finishReason || null : null;

        if (
          (typeof content === 'string' && content.trim()) ||
          (Array.isArray(toolUseBlocks) && toolUseBlocks.length > 0)
        ) {
          attempts.push({ provider: provider.name, success: true });
          return {
            success: true,
            content: (content || '').trim(),
            provider: provider.name,
            model: requestedModel || provider.model,
            tokenUsage: tokenUsage || null,
            thinking: thinking || undefined,
            toolUseBlocks:
              Array.isArray(toolUseBlocks) && toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
            finishReason: finishReason || undefined,
            attempts,
            availableProviders: providers.map((p) => p.name),
          };
        }

        // Tag empty replies explicitly with finish-reason diagnostics so the
        // user sees *why* the model produced no text instead of a generic
        // "Empty response". An empty HTTP-200 means the channel is healthy but
        // the model produced no text — NOT a degraded channel. aiGateway
        // excludes `empty` from the transient cooldown map; leaving errorType
        // unset would let it fall through to `unknown`, which carries a ~20s
        // cross-request cooldown and forced every re-ask within the window to
        // fast-fail. Mirrors relayApiAdapter.
        let emptyReason = 'Empty response';
        const _fr = finishReason || null;
        if (_fr === 'content_filter' || _fr === 'SAFETY') {
          emptyReason = '内容被模型安全策略过滤，请换个表述重试';
        } else if (_fr === 'length' || _fr === 'MAX_TOKENS') {
          emptyReason =
            '模型输出长度超限（max_tokens 过小或上下文已满），请增大 max_tokens 或缩短输入';
        } else if (_fr === 'tool_calls' || _fr === 'tool_use') {
          emptyReason = '模型仅返回了工具调用，未生成文本内容';
        } else if (typeof result === 'object' && result?.refusal) {
          emptyReason = `模型拒绝回答: ${result.refusal}`;
        } else if (_fr) {
          emptyReason = `模型未生成文本内容（finish_reason=${_fr}），请重试或切换模型`;
        }
        attempts.push({
          provider: provider.name,
          success: false,
          error: emptyReason,
          errorType: 'empty',
          meta: {
            finishReason: _fr,
            hasToolCalls: !!(typeof result === 'object' && result?.toolUseBlocks?.length),
          },
        });
      } catch (error) {
        // Extract detailed API error from response body (axios stores in error.response.data)
        let detailedMsg = error.message || '';
        try {
          const respData = error.response && error.response.data;
          if (respData) {
            const apiErr = typeof respData === 'object' && respData.error;
            const apiMsg =
              typeof respData === 'string'
                ? respData
                : (apiErr && apiErr.message) || respData.message || '';
            // Include error code (e.g. 'insufficient_quota') for accurate classification
            const apiCode = (apiErr && apiErr.code) || '';
            if (apiMsg && apiCode && !apiMsg.toLowerCase().includes(apiCode.toLowerCase())) {
              detailedMsg = `${apiMsg} (${apiCode})`;
            } else if (apiMsg) {
              detailedMsg = apiMsg;
            }
          }
        } catch {
          /* ignore */
        }
        let errorType;
        try {
          const { classifyAdapterError } = require('./gateway/adapters/_errorClassifiers');
          errorType = classifyAdapterError(
            { message: detailedMsg || error.message },
            {
              statusCode:
                error.status || error.statusCode || (error.response && error.response.status) || 0,
            }
          );
        } catch {
          /* classification unavailable */
        }
        const attemptEntry = {
          provider: provider.name,
          success: false,
          error: detailedMsg || error.message,
          ...(errorType ? { errorType } : {}),
        };
        // Debug: log raw errors from providers so we can improve classification.
        // Remove or gate behind KHY_DEBUG_PROVIDER_ERRORS=1 once stable.
        if (process.env.KHY_DEBUG_PROVIDER_ERRORS) {
          console.error(
            '[multiFreeService] provider=' +
              provider.name +
              ' errorType=' +
              (errorType || '(unclassified)') +
              ' status=' +
              (error.status || error.response?.status || '?') +
              ' rawError=' +
              JSON.stringify(detailedMsg || error.message).substring(0, 200)
          );
        }
        attempts.push(attemptEntry);
      }
    }

    // If every provider returned empty (and none threw), surface the failure as
    // `empty` at the top level too: recordFailureEarly (aiGateway) reads the
    // top-level errorType to decide the cooldown, and `empty` is cooldown-free.
    const allEmpty =
      attempts.length > 0 && attempts.every((a) => a.success === false && a.errorType === 'empty');

    // Use the last failed attempt's error as the primary error. Never return
    // localFallback as `content` — that template is quant-analysis text, not a
    // chat response, and propagating it as content misleads users and the
    // circuit breaker (which reads `content` for error classification).
    const lastFailedAttempt = attempts.filter((a) => !a.success && a.error).pop();

    return {
      success: false,
      content: '', // no fake content — callers must check `success` first
      provider: 'local-fallback',
      error: lastFailedAttempt?.error || 'All providers failed',
      errorType: allEmpty ? 'empty' : lastFailedAttempt?.errorType || 'unknown',
      attempts,
      availableProviders: providers.map((p) => p.name),
    };
  }

  async callProvider(provider, prompt, opts) {
    switch (provider.key) {
      case 'google':
        return this.callGoogle(provider, prompt, opts);
      case 'groq':
        return this.callGroq(provider, prompt, opts);
      case 'openrouter':
        return this.callOpenRouter(provider, prompt, opts);
      case 'openai':
        return this.callOpenAI(provider, prompt, opts);
      case 'anthropic':
        return this.callAnthropic(provider, prompt, opts);
      case 'trae':
        return this.callOpenAI(provider, prompt, opts);
      case 'zhipu':
        return this.callZhipu(provider, prompt, opts);
      case 'xunfei':
        return this.callXunfei(provider, prompt, opts);
      case 'baidu':
        return this.callBaidu(provider, prompt, opts);
      case 'alibaba':
        return this.callAlibaba(provider, prompt, opts);
      case 'huggingface':
        return this.callHuggingFace(provider, prompt, opts);
      default:
        throw new Error(`Unsupported provider: ${provider.key}`);
    }
  }

  async callGoogle(provider, prompt, opts) {
    const model = opts.model || provider.model || MODELS.freeGoogle;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${provider.apiKey}`;

    // Build parts: images first (if any), then text
    const parts = [];
    if (opts.images && opts.images.length > 0) {
      for (const block of toGoogleInlineData(opts.images)) {
        parts.push(block);
      }
    }
    parts.push({ text: prompt });

    const response = await postWithDeadConnRetry(
      url,
      {
        contents: [{ parts }],
        generationConfig: {
          temperature: opts.temperature,
          maxOutputTokens: opts.maxTokens,
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      },
      provider.name
    );

    const content = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const finishReason = response.data?.candidates?.[0]?.finishReason || null;
    const meta = response.data?.usageMetadata;
    const tokenUsage = meta
      ? {
          inputTokens: meta.promptTokenCount || 0,
          outputTokens: meta.candidatesTokenCount || 0,
          totalTokens: meta.totalTokenCount || 0,
        }
      : null;
    return { content, tokenUsage, finishReason };
  }

  async callGroq(provider, prompt, opts) {
    const model = opts.model || provider.model || MODELS.freeGroq;
    const response = await postWithDeadConnRetry(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
      provider.name
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    const finishReason = response.data?.choices?.[0]?.finish_reason || null;
    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          ...normalizeCacheUsage(usage),
        }
      : null;
    return { content, tokenUsage, finishReason };
  }

  async callOpenRouter(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const response = await postWithDeadConnRetry(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': require('../constants/serviceDefaults').HTTP_REFERER,
          'X-Title': 'khy OS',
        },
        timeout: 30000,
      },
      provider.name
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    const finishReason = response.data?.choices?.[0]?.finish_reason || null;
    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          ...normalizeCacheUsage(usage),
        }
      : null;
    return { content, tokenUsage, finishReason };
  }

  async callOpenAI(provider, prompt, opts) {
    // Support custom base URL (relay/proxy) via OPENAI_BASE_URL env
    // Strip trailing /v1 if present to prevent double /v1/v1 paths
    let baseUrl = provider.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com';
    baseUrl = baseUrl.replace(/\/v1\/?$/, '');
    const model = opts.model || provider.model;
    // per-provider 代理:provider 配置带 proxy 字段时,本次请求经其代理发出
    // (postWithDeadConnRetry 内剥离该内部字段并注入对应 agent);不带则直连不变。
    const _proxyCfg = String(provider.proxy || '').trim()
      ? { _providerProxyUrl: String(provider.proxy).trim() }
      : {};

    // Build message content: multimodal array if images present, plain string otherwise
    let messageContent;
    if (opts.images && opts.images.length > 0) {
      messageContent = [...toOpenAIVisionBlocks(opts.images), { type: 'text', text: prompt }];
    } else {
      messageContent = prompt;
    }

    // Use structured messages if available, otherwise single user message
    let messages =
      opts.structuredMessages && opts.structuredMessages.length > 0
        ? opts.structuredMessages.map((m) => ({ ...m }))
        : [{ role: 'user', content: messageContent }];

    // 注入 system prompt（CC 通过 opts.system 传入，OpenAI 协议需要 role:'system' 消息）
    if (opts.system && messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: opts.system });
    }

    // 追加模型身份信息到 system 消息末尾，防止小模型幻觉编造身份
    if (model) {
      const sysIdx = messages.findIndex((m) => m.role === 'system');
      const identityHint = `\n\n[Model Identity] You are ${model}, served through KHY gateway. Do not fabricate a different identity or claim to be running in any specific IDE environment.`;
      if (sysIdx >= 0) {
        messages[sysIdx] = {
          ...messages[sysIdx],
          content: (messages[sysIdx].content || '') + identityHint,
        };
      } else {
        messages.unshift({ role: 'system', content: identityHint.trim() });
      }
    }

    // 当使用 structuredMessages 且有图片时，将图片注入到最后一条 user 消息
    if (
      opts.structuredMessages &&
      opts.structuredMessages.length > 0 &&
      opts.images &&
      opts.images.length > 0
    ) {
      const imageBlocks = toOpenAIVisionBlocks(opts.images);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const textContent =
            typeof messages[i].content === 'string'
              ? messages[i].content
              : Array.isArray(messages[i].content)
                ? messages[i].content.map((c) => c.text || '').join('')
                : String(messages[i].content || '');
          messages[i] = {
            ...messages[i],
            content: [...imageBlocks, { type: 'text', text: textContent }],
          };
          break;
        }
      }
    }

    // 小模型判定(单一真源):决定 (a) 是否剥离 tools 声明 (b) 工具块消息如何降级。
    // 必须在消息转换之前判定——若剥离 tools 却仍用 hasTools=true 转换,消息里会残留
    // role:'tool'/'tool_calls' 而顶层无 tools 声明,严格 OpenAI 兼容端点(stepfun
    // step_plan 等)返回 HTTP 400 "Unrecognized chat message"。
    const _isSmallModel = _decideStripTools(model, opts);

    // Convert Anthropic tool_use/tool_result content blocks to OpenAI format
    // (structuredMessages from ai.js may contain tool_use/tool_result arrays).
    // 小模型 → hasTools=false:工具块内联为纯文本,绝不产生 role:'tool' 消息。
    const hasAnthropicToolBlocks = messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')
    );
    if (hasAnthropicToolBlocks) {
      messages = convertMessagesAnthropicToOpenAI(messages, !_isSmallModel);
    }

    const requestBody = {
      model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    };

    // Inject tool definitions for native function calling.
    // Small models (flash-lite, mini, 7b, etc.) typically don't support function calling;
    // sending tools causes 400 errors on providers like sensenova.
    // Exceptions: deepseek-v4-flash, sensenova-6.7-flash-lite are full-size models with tool calling.
    let _toolsSkippedReason = '';
    if (opts.tools && opts.tools.length > 0) {
      if (_isSmallModel) {
        _toolsSkippedReason = `模型 ${model} 不支持工具调用 (function calling)，将以纯文本模式回答。如需使用工具，请切换到支持 function calling 的模型。`;
        if (opts.onChunk) {
          opts.onChunk({ type: 'notice', text: _toolsSkippedReason });
        }
      } else {
        requestBody.tools = opts.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
          },
        }));
      }
    }

    // ── Helper: retry after a 400 by stripping the payload bits a strict provider may reject ──
    // Fires on 400 when the body carries tools and/or stream_options; strips whichever exist so
    // the request can succeed (API key is valid — only the payload was rejected). Stripping
    // stream_options degrades usage reporting to today's behavior (ctx may stay 0), not a regression.
    const _retryWithoutTools = async (err) => {
      if (err.response?.status !== 400) {
        return null;
      }
      if (!requestBody.tools && !requestBody.stream_options) {
        return null;
      }
      const retryBody = { ...requestBody };
      if (retryBody.tools) {
        delete retryBody.tools;
        delete retryBody.tool_choice;
        if (opts.onChunk) {
          opts.onChunk({
            type: 'notice',
            text: `模型 ${model} 拒绝了工具调用请求 (HTTP 400)，已自动去除工具定义重试`,
          });
        }
      }
      // stream_options is a standard OpenAI field but some non-compliant gateways reject unknown
      // keys; drop it on retry so the request still goes through.
      if (retryBody.stream_options) {
        delete retryBody.stream_options;
      }
      return retryBody;
    };

    // ── Streaming path: SSE for real-time output ────────────────────
    if (typeof opts.onChunk === 'function') {
      requestBody.stream = true;
      // Opt into usage reporting on the stream. OpenAI-compatible gateways (agnes, …) only emit a
      // trailing `usage` chunk when the request carries stream_options.include_usage — without it
      // tokenUsage stays null and the TUI shows `0% ctx (0/128k)`. Gated (KHY_STREAM_USAGE),
      // fail-soft, byte-revert when off. See services/streamUsageOptions.js.
      try {
        require('./streamUsageOptions').applyStreamUsage(requestBody, process.env);
      } catch {
        /* leaf unavailable → no opt-in */
      }

      let response;
      try {
        response = await postWithDeadConnRetry(
          `${baseUrl}/v1/chat/completions`,
          requestBody,
          {
            headers: {
              Authorization: `Bearer ${provider.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: opts.timeoutMs || 120000,
            responseType: 'stream',
            signal: opts.signal,
            ..._proxyCfg,
          },
          provider.name
        );
      } catch (err) {
        // On 400, retry without tools — API key is valid, payload was rejected
        const retryBody = await _retryWithoutTools(err);
        if (retryBody) {
          retryBody.stream = true;
          response = await postWithDeadConnRetry(
            `${baseUrl}/v1/chat/completions`,
            retryBody,
            {
              headers: {
                Authorization: `Bearer ${provider.apiKey}`,
                'Content-Type': 'application/json',
              },
              timeout: opts.timeoutMs || 120000,
              responseType: 'stream',
              signal: opts.signal,
              ..._proxyCfg,
            },
            provider.name
          );
        } else {
          throw err;
        }
      }

      let content = '';
      const toolCallAccum = {}; // index → {name, arguments}
      let inputTokens = 0,
        outputTokens = 0;
      let cacheReadTokens = 0,
        cacheWriteTokens = 0;
      let finishReason = null; // OpenAI finish_reason (last chunk) — fed to the loop's stop_reason trust

      return new Promise((resolve, reject) => {
        let buffer = '';
        const stream = response.data;
        // Sliding idle timeout: reset on every chunk, reject when the remote
        // stalls (no chunks) longer than the threshold instead of hanging forever.
        const watchdog = createStreamIdleWatchdog(stream, reject, `${provider.name}/${model}`);

        stream.on('data', (chunk) => {
          watchdog.touch();
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) {
              continue;
            }
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') {
              continue;
            }

            try {
              const data = JSON.parse(payload);
              // finish_reason rides the terminal chunk (stop | length | tool_calls | content_filter)
              if (data.choices?.[0]?.finish_reason) {
                finishReason = data.choices[0].finish_reason;
              }

              // Usage rides the final chunk. With stream_options.include_usage the provider emits a
              // usage-only chunk whose `choices` is empty (delta undefined) → it MUST be read before
              // the `if (!delta) continue` guard below, otherwise the whole usage payload is dropped
              // and ctx stays 0 (the agnes `0% ctx` bug). Runs at most once per chunk, so hoisting it
              // above the guard is byte-equivalent for providers that piggyback usage on a delta chunk.
              if (data.usage) {
                inputTokens = data.usage.prompt_tokens || 0;
                outputTokens = data.usage.completion_tokens || 0;
                const _c = normalizeCacheUsage(data.usage);
                cacheReadTokens = _c.cacheReadInputTokens;
                cacheWriteTokens = _c.cacheWriteInputTokens;
                opts.onChunk({
                  type: 'cost',
                  cost: {
                    inputTokens,
                    outputTokens,
                    totalTokens: data.usage.total_tokens || inputTokens + outputTokens,
                  },
                });
              }

              const delta = data.choices?.[0]?.delta;
              if (!delta) {
                continue;
              }

              // Text content
              if (delta.content) {
                content += delta.content;
                opts.onChunk({ type: 'text', text: delta.content });
              }

              // Tool calls (streamed incrementally)
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallAccum[idx]) {
                    toolCallAccum[idx] = { id: '', name: '', arguments: '' };
                  }
                  if (tc.id) {
                    toolCallAccum[idx].id = tc.id;
                  }
                  if (tc.function?.name) {
                    toolCallAccum[idx].name = tc.function.name;
                  }
                  if (tc.function?.arguments) {
                    toolCallAccum[idx].arguments += tc.function.arguments;
                  }
                }
              }
            } catch {
              /* skip malformed SSE lines */
            }
          }
        });

        stream.on('end', () => {
          watchdog.clear();
          // Finalize accumulated tool calls → 结构化 toolUseBlocks
          const toolCalls = Object.values(toolCallAccum).filter((tc) => tc.name);
          let toolUseBlocks = null;
          if (toolCalls.length > 0) {
            toolUseBlocks = toolCalls.map((tc) => {
              let params;
              try {
                params = JSON.parse(tc.arguments);
              } catch {
                params = {};
              }
              const id = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              return { id, name: tc.name, params, input: params };
            });
            // NOTE: Do NOT emit tool_use events via onChunk here — the outer
            // native tool-use loop (toolUseLoopCore.js) owns tool lifecycle
            // events via its onToolCall callback (pushToolFromLoop in the TUI),
            // which also handles turn-ack, preface injection, progress display,
            // history flushing and LAN broadcast. Emitting here would duplicate
            // all of those side-effects because the loop re-emits onToolCall
            // for the same toolUseBlocks it receives from this resolved promise.
            // The non-streaming fallback below already follows this pattern
            // (no onChunk emission, only return toolUseBlocks).
          }

          const tokenUsage =
            inputTokens || outputTokens
              ? {
                  inputTokens,
                  outputTokens,
                  totalTokens: inputTokens + outputTokens,
                  ...(cacheReadTokens || cacheWriteTokens
                    ? {
                        cacheReadInputTokens: cacheReadTokens,
                        cacheWriteInputTokens: cacheWriteTokens,
                      }
                    : {}),
                }
              : null;
          resolve({ content, tokenUsage, toolUseBlocks, finishReason });
        });

        stream.on('error', (err) => {
          watchdog.clear();
          reject(err);
        });
        // Non-standard teardown may emit only 'close' (no 'end'/'error') —
        // clear the watchdog there too so its timer never leaks.
        stream.on('close', () => watchdog.clear());
      });
    }

    // ── Non-streaming fallback ──────────────────────────────────────
    let response;
    try {
      response = await postWithDeadConnRetry(
        `${baseUrl}/v1/chat/completions`,
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
          ..._proxyCfg,
        },
        provider.name
      );
    } catch (err) {
      const retryBody = await _retryWithoutTools(err);
      if (retryBody) {
        response = await postWithDeadConnRetry(
          `${baseUrl}/v1/chat/completions`,
          retryBody,
          {
            headers: {
              Authorization: `Bearer ${provider.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
            ..._proxyCfg,
          },
          provider.name
        );
      } else {
        throw err;
      }
    }

    const msg = response.data?.choices?.[0]?.message;
    const content = msg?.content || '';

    // Convert native tool_calls → 结构化 toolUseBlocks
    let toolUseBlocks = null;
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      toolUseBlocks = msg.tool_calls.map((tc) => {
        const fn = tc.function;
        let params;
        try {
          params = JSON.parse(fn.arguments);
        } catch {
          params = {};
        }
        const id = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return { id, name: fn.name, params, input: params };
      });
    }

    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          ...normalizeCacheUsage(usage),
        }
      : null;
    const finishReason = response.data?.choices?.[0]?.finish_reason || null;
    return { content, tokenUsage, toolUseBlocks, finishReason };
  }

  async callAnthropic(provider, prompt, opts) {
    // Support custom base URL (relay/proxy) via ANTHROPIC_BASE_URL env
    const baseUrl = (
      provider.baseUrl ||
      process.env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com'
    ).replace(/\/+$/, '');
    const isRelay = !baseUrl.includes('api.anthropic.com');

    // Build message content: multimodal array if images present, plain string otherwise
    let messageContent;
    if (opts.images && opts.images.length > 0 && !isRelay) {
      messageContent = [...toAnthropicImageBlocks(opts.images), { type: 'text', text: prompt }];
    } else {
      messageContent = prompt;
    }

    // Build messages: use structured messages if available
    let apiMessages;
    let systemContent = '';
    if (opts.structuredMessages && opts.structuredMessages.length > 0) {
      // Anthropic uses separate system param, extract it from messages
      const sysMsg = opts.structuredMessages.find((m) => m.role === 'system');
      if (sysMsg) {
        systemContent = sysMsg.content;
      }
      apiMessages = opts.structuredMessages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));
      // Ensure first message is user role (Anthropic requirement)
      if (apiMessages.length > 0 && apiMessages[0].role !== 'user') {
        apiMessages.unshift({ role: 'user', content: '(context follows)' });
      }
      // 当有图片时，将图片注入到最后一条 user 消息
      if (opts.images && opts.images.length > 0 && !isRelay) {
        const imageBlocks = toAnthropicImageBlocks(opts.images);
        for (let i = apiMessages.length - 1; i >= 0; i--) {
          if (apiMessages[i].role === 'user') {
            const textContent =
              typeof apiMessages[i].content === 'string'
                ? apiMessages[i].content
                : Array.isArray(apiMessages[i].content)
                  ? apiMessages[i].content.map((c) => c.text || '').join('')
                  : String(apiMessages[i].content || '');
            apiMessages[i] = {
              ...apiMessages[i],
              content: [...imageBlocks, { type: 'text', text: textContent }],
            };
            break;
          }
        }
      }
    } else {
      apiMessages = [{ role: 'user', content: messageContent }];
    }
    if (opts.system && !systemContent) {
      systemContent = opts.system;
    }

    const body = {
      model: opts.model || provider.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      messages: apiMessages,
    };

    // Add system prompt with cache breakpoint for Anthropic prompt caching
    // This reduces repeated system prompt costs by ~90%
    if (systemContent) {
      const cacheBoundary = '<!-- CACHE_BOUNDARY -->';
      const boundaryIdx = systemContent.indexOf(cacheBoundary);
      if (boundaryIdx > 0 && !isRelay) {
        // Split at cache boundary: stable prefix (cached) + dynamic suffix
        const stablePrefix = systemContent.slice(0, boundaryIdx).trim();
        const dynamicSuffix = systemContent.slice(boundaryIdx + cacheBoundary.length).trim();
        body.system = [
          { type: 'text', text: stablePrefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: dynamicSuffix },
        ];
      } else {
        body.system = systemContent;
      }
    }

    // Add tool definitions for native tool use
    if (opts.tools && opts.tools.length > 0 && !isRelay) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || { type: 'object', properties: {} },
      }));
    }

    // Enable thinking/extended thinking for supported models on official API
    if (!isRelay && opts.thinking) {
      // Anthropic extended thinking: { type: "enabled", budget_tokens: N }
      body.thinking = { type: 'enabled', budget_tokens: opts.thinking.budgetTokens || 10000 };
      // Extended thinking requires higher max_tokens
      body.max_tokens = Math.max(body.max_tokens || 4096, 16000);
    }

    // Relay compatibility: don't include extended_thinking or thinking fields
    if (isRelay) {
      delete body.thinking;
      delete body.extended_thinking;
      delete body.tools; // Relays may not support tools
    }

    // ── Streaming path for Anthropic ────────────────────────────────
    if (typeof opts.onChunk === 'function' && !isRelay) {
      body.stream = true;
      const response = await postWithDeadConnRetry(
        `${baseUrl}/v1/messages`,
        body,
        {
          headers: {
            'x-api-key': provider.apiKey,
            'anthropic-version': '2024-10-22',
            'anthropic-beta': 'prompt-caching-2024-07-31',
            'Content-Type': 'application/json',
          },
          timeout: opts.timeoutMs || 120000,
          responseType: 'stream',
          signal: opts.signal,
        },
        provider.name
      );

      let content = '';
      let thinkingContent = '';
      let currentToolName = '';
      let currentToolInput = '';
      let inputTokens = 0,
        outputTokens = 0;
      let cacheReadTokens = 0,
        cacheWriteTokens = 0;
      let finishReason = null; // Anthropic stop_reason (message_delta) — fed to the loop's stop_reason trust
      const toolUseBlocks = [];

      return new Promise((resolve, reject) => {
        let buffer = '';
        const stream = response.data;
        // Sliding idle timeout — same rationale as the OpenAI-format branch above.
        const watchdog = createStreamIdleWatchdog(stream, reject, `${provider.name}/${body.model}`);

        stream.on('data', (chunk) => {
          watchdog.touch();
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) {
              continue;
            }
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') {
              continue;
            }

            try {
              const event = JSON.parse(payload);

              // Anthropic SSE event types
              switch (event.type) {
                case 'content_block_start': {
                  const block = event.content_block;
                  if (block?.type === 'tool_use') {
                    currentToolName = block.name || '';
                    currentToolInput = '';
                    // NOTE: Do NOT emit tool_use via onChunk here — the outer
                    // native tool-use loop owns tool lifecycle events via its
                    // onToolCall callback. Emitting here would duplicate the
                    // event because the loop re-emits onToolCall for the same
                    // toolUseBlocks it receives from this resolved promise.
                  } else if (block?.type === 'thinking') {
                    opts.onChunk({ type: 'thinking', text: '' });
                  }
                  break;
                }
                case 'content_block_delta': {
                  const delta = event.delta;
                  if (delta?.type === 'text_delta' && delta.text) {
                    content += delta.text;
                    opts.onChunk({ type: 'text', text: delta.text });
                  } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                    thinkingContent += delta.thinking;
                    opts.onChunk({ type: 'thinking', text: delta.thinking });
                  } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                    currentToolInput += delta.partial_json;
                  }
                  break;
                }
                case 'content_block_stop': {
                  if (currentToolName) {
                    let input = {};
                    try {
                      input = JSON.parse(currentToolInput);
                    } catch {
                      /* ignore */
                    }
                    toolUseBlocks.push({ name: currentToolName, input });
                    currentToolName = '';
                    currentToolInput = '';
                  }
                  break;
                }
                case 'message_delta': {
                  // stop_reason arrives on message_delta (end_turn | tool_use | max_tokens | stop_sequence)
                  if (event.delta?.stop_reason) {
                    finishReason = event.delta.stop_reason;
                  }
                  if (event.usage) {
                    outputTokens = event.usage.output_tokens || 0;
                    opts.onChunk({
                      type: 'cost',
                      cost: {
                        inputTokens,
                        outputTokens,
                        totalTokens: inputTokens + outputTokens,
                      },
                    });
                  }
                  break;
                }
                case 'message_start': {
                  if (event.message?.usage) {
                    inputTokens = event.message.usage.input_tokens || 0;
                    const _c = normalizeCacheUsage(event.message.usage);
                    cacheReadTokens = _c.cacheReadInputTokens;
                    cacheWriteTokens = _c.cacheWriteInputTokens;
                    opts.onChunk({
                      type: 'cost',
                      cost: {
                        inputTokens,
                        outputTokens: 0,
                        totalTokens: inputTokens,
                      },
                    });
                  }
                  break;
                }
              }
            } catch {
              /* skip malformed SSE lines */
            }
          }
        });

        stream.on('end', () => {
          watchdog.clear();
          const tokenUsage =
            inputTokens || outputTokens
              ? {
                  inputTokens,
                  outputTokens,
                  totalTokens: inputTokens + outputTokens,
                  ...(cacheReadTokens || cacheWriteTokens
                    ? {
                        cacheReadInputTokens: cacheReadTokens,
                        cacheWriteInputTokens: cacheWriteTokens,
                      }
                    : {}),
                }
              : null;
          resolve({
            content,
            tokenUsage,
            thinking: thinkingContent || undefined,
            toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
            finishReason,
          });
        });

        stream.on('error', (err) => {
          watchdog.clear();
          reject(err);
        });
        // Non-standard teardown may emit only 'close' (no 'end'/'error') —
        // clear the watchdog there too so its timer never leaks.
        stream.on('close', () => watchdog.clear());
      });
    }

    // ── Non-streaming fallback ──────────────────────────────────────
    let response;
    try {
      response = await postWithDeadConnRetry(
        `${baseUrl}/v1/messages`,
        body,
        {
          headers: {
            'x-api-key': provider.apiKey,
            'anthropic-version': '2024-10-22',
            'anthropic-beta': 'prompt-caching-2024-07-31',
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        },
        provider.name
      );
    } catch (err) {
      if (isRelay && err.response?.status === 400) {
        const minimalBody = {
          model: opts.model || provider.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          messages: [{ role: 'user', content: messageContent }],
        };
        response = await postWithDeadConnRetry(
          `${baseUrl}/v1/messages`,
          minimalBody,
          {
            headers: {
              'x-api-key': provider.apiKey,
              'anthropic-version': '2024-10-22',
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          },
          provider.name
        );
      } else {
        throw err;
      }
    }

    // Extract content: handle text, thinking, and tool_use blocks
    let content = '';
    let thinkingContent = '';
    const contentBlocks = response.data?.content || [];
    const toolUseBlocks = [];
    for (const block of contentBlocks) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      } else if (block.type === 'thinking') {
        thinkingContent += block.thinking || '';
      }
    }
    if (!content && !toolUseBlocks.length) {
      content = response.data?.content?.[0]?.text || '';
    }

    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        }
      : null;
    const finishReason = response.data?.stop_reason || null;
    return {
      content,
      tokenUsage,
      thinking: thinkingContent || undefined,
      toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
      finishReason,
    };
  }

  generateZhipuJWT(apiKey) {
    const [id, secret] = apiKey.split('.');
    if (!id || !secret) {
      throw new Error('Invalid Zhipu API key format, expected id.secret');
    }

    const payload = {
      api_key: id,
      exp: Math.round(Date.now() / 1000) + 3600,
      timestamp: Math.round(Date.now() / 1000),
    };

    return jwt.sign(payload, secret, {
      algorithm: 'HS256',
      header: { alg: 'HS256', sign_type: 'SIGN' },
    });
  }

  async callZhipu(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const baseUrl = (provider.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(
      /\/+$/,
      ''
    );
    const endpoint = /\/chat\/completions$/i.test(baseUrl)
      ? baseUrl
      : `${baseUrl}/chat/completions`;
    // 鉴权:v4 端点采用标准 Bearer,直接以原始 key 作 token。门控 KHY_ZHIPU_RAW_BEARER 默认开——
    // 非 `id.secret` 形态(新版单段 key)走原始 Bearer(旧 JWT 路径本会抛错);`id.secret` 形态
    // 在**官方 v4 端点**上亦走原始 Bearer(子门 KHY_ZHIPU_V4_RAW_BEARER,默认开)——实测新版永久
    // 免费视觉模型 glm-4.6v-flash/glm-4v-flash 在 legacy JWT 鉴权上下文回 404 model_not_found,
    // 与 test-key(raw Bearer)对齐后可用;自定义/中转端点的 `id.secret` 仍走 JWT(严格超集)。
    // 门关/异常 → 逐字节回退「永远 generateZhipuJWT」。
    let token;
    try {
      const shape = require('./zhipuRequestShape');
      token =
        shape.resolveZhipuAuthMode(provider.apiKey, process.env, endpoint) === 'raw'
          ? provider.apiKey
          : this.generateZhipuJWT(provider.apiKey);
    } catch {
      token = this.generateZhipuJWT(provider.apiKey);
    }

    // Build multimodal content for vision models. 智谱视觉模型族命名含 glm-4Nv:
    // glm-4v-flash / glm-4v-plus(裸 4v)、glm-4.6v-flash / glm-4.1v-thinking-flash(带小版本号)。
    // 旧正则 /glm-4v/ 匹配不到 glm-4.6v(`4` 后跟 `.6` 非 `v`)→ 旗舰视觉模型静默丢图 → 只发文本、
    // 无法识图。放宽到 /glm-4(\.\d+)?v/i 覆盖全族,收图路径对齐。
    let messageContent = prompt;
    if (opts.images && opts.images.length > 0 && /glm-4(?:\.\d+)?v/i.test(model)) {
      // 合并预算修复:过大图片(实测 18287 token > 16384)必然 400 code 1210。收图前先等比
      // 降采样到预算内。门控 KHY_GLM_VISION_IMAGE_DOWNSCALE 默认开,关门/失败 → 原图透传。
      let _images = opts.images;
      try {
        const { downscaleGlmVisionImages } = require('./gateway/glmVisionImageDownscale');
        _images = downscaleGlmVisionImages(model, opts.images, process.env);
      } catch {
        /* fail-soft: 原图透传 */
      }
      messageContent = [...toOpenAIVisionBlocks(_images), { type: 'text', text: prompt }];
    }

    // max_tokens 钳位:GLM 视觉模型(glm-4v-flash/glm-4.6v-flash)上限 [1,1024],发高值 →
    // 智谱端 400 code 1210「max_tokens参数非法」。门控 KHY_GLM_VISION_MAX_TOKENS_CLAMP 默认开,
    // 关门/异常 → 原样透传(逐字节回退)。非视觉模型不受影响。
    let _maxTokens = opts.maxTokens;
    try {
      const { clampMaxTokensForGlmVision } = require('./gateway/glmVisionMaxTokens');
      _maxTokens = clampMaxTokensForGlmVision(model, opts.maxTokens, process.env);
    } catch {
      /* fail-soft: 原样透传 */
    }

    const requestBody = {
      model,
      messages: [{ role: 'user', content: messageContent }],
      temperature: opts.temperature,
      max_tokens: _maxTokens,
    };
    // 文本预算截断:无图的大文本(磁盘扫描等工具结果,实测约 25304 token)会撞 GLM 视觉端
    // 16384 合并预算 → 400 code 1210 → 级联落剪贴板兜底。发送前对 messages 做文本侧预算截断
    // (中段截断最大块,保头保尾)。门控 KHY_GLM_VISION_TEXT_BUDGET 默认开,关门/异常 → 原样
    // 透传(逐字节回退)。仅 GLM 视觉模型触发,非视觉模型不受影响。
    try {
      const { clampTextBudgetInMessages } = require('./gateway/glmVisionTextBudget');
      clampTextBudgetInMessages(
        model,
        requestBody.messages,
        { maxTokens: _maxTokens },
        process.env
      );
    } catch {
      /* fail-soft: 原样透传 */
    }
    // reasoning_effort:GLM-5.2 招牌请求参数。门控 KHY_ZHIPU_REASONING_EFFORT 默认开——从 opts 取
    // 合法枚举透传;门关/缺失/非法 → 不写该字段(逐字节回退旧行为,只发 temperature/max_tokens)。
    try {
      const shape = require('./zhipuRequestShape');
      const effort = shape.pickReasoningEffort(opts, process.env);
      if (effort) {
        requestBody.reasoning_effort = effort;
      }
    } catch {
      /* fail-soft: 不透传 */
    }

    let response;
    try {
      response = await postWithDeadConnRetry(
        endpoint,
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        },
        provider.name
      );
    } catch (err) {
      // 关键诊断:智谱 v4 在 HTTP 错误(尤其 404)体里回**真实原因**(结构化 { error: { code, message } }
      // 或顶层 { code, message }):code `1002/1003/1004…`=鉴权/无效 key、`1211`=模型不存在/未开通、
      // `1113`=余额/权限。axios 默认只把 `err.message` 冒泡成泛化「Request failed with status code 404」,
      // GLM 的真实 code+message 藏在 `err.response.data` 里被丢弃——历史上「识图恒 404 model_not_found」
      // 一直无法定位正因这段原因体从未被读出(智谱对**无效 key 也回 404**,故泛化 404 具误导性)。
      // 此处把上游原因体拼进抛出的 error.message(纯诊断,不改控制流/不吞异常),让上层分类器与
      // 用户可见文案拿到「智谱究竟为何拒绝」。绝不抛新类型:仍旧 throw,保持既有 catch 语义逐字节兼容。
      try {
        const status = err && err.response ? err.response.status : undefined;
        const data = err && err.response ? err.response.data : undefined;
        const upstream = data && (data.error || data);
        const upstreamCode = upstream && (upstream.code != null ? String(upstream.code) : '');
        const upstreamMsg = upstream && (upstream.message || upstream.msg || '');
        if (status || upstreamCode || upstreamMsg) {
          const parts = [];
          if (status) {
            parts.push(`HTTP ${status}`);
          }
          if (upstreamCode) {
            parts.push(`code ${upstreamCode}`);
          }
          if (upstreamMsg) {
            parts.push(String(upstreamMsg));
          }
          const detail = parts.join(' · ');
          if (detail && err && typeof err.message === 'string' && !err.message.includes(detail)) {
            err.message = `智谱AI: ${detail} (${err.message})`;
          }
          // 暴露结构化字段供上层精确分类(区分无效 key vs 模型未开通),不依赖字符串匹配。
          if (err) {
            err.zhipuStatus = status;
            err.zhipuCode = upstreamCode || undefined;
            err.zhipuMessage = upstreamMsg || undefined;
          }
        }
      } catch {
        /* 诊断增强绝不掩盖原始错误:任何解析失败 → 原样抛出 */
      }
      throw err;
    }

    const content = response.data?.choices?.[0]?.message?.content || '';
    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          ...normalizeCacheUsage(usage),
        }
      : null;
    const finishReason = response.data?.choices?.[0]?.finish_reason || null;
    return { content, tokenUsage, finishReason };
  }

  async callXunfei(provider, prompt, opts) {
    const model = opts.model || provider.model || 'lite';
    const response = await postWithDeadConnRetry(
      'https://spark-api-open.xf-yun.com/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
      provider.name
    );

    const content = response.data?.choices?.[0]?.message?.content || response.data?.result || '';
    const finishReason = response.data?.choices?.[0]?.finish_reason || null;
    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          ...normalizeCacheUsage(usage),
        }
      : null;
    return { content, tokenUsage, finishReason };
  }

  async callAlibaba(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const baseUrl = (provider.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/+$/, '');

    // Use OpenAI-compatible API for newer models (qwen-max, qwen-plus, etc.)
    const useCompatible =
      /^qwen[2-]/.test(model) ||
      [
        'qwen-max',
        'qwen-plus',
        'qwen-turbo',
        'qwen-long',
        'qwen-vl-max',
        'qwen-vl-plus',
        'qwen-coder-plus',
      ].includes(model);
    const compatibleUrl = /\/compatible-mode\/v1$/i.test(baseUrl)
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/compatible-mode/v1/chat/completions`;
    const legacyUrl = /\/api\/v1$/i.test(baseUrl)
      ? `${baseUrl}/services/aigc/text-generation/generation`
      : `${baseUrl}/api/v1/services/aigc/text-generation/generation`;

    if (useCompatible) {
      const response = await postWithDeadConnRetry(
        compatibleUrl,
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        },
        provider.name
      );

      const content = response.data?.choices?.[0]?.message?.content || '';
      const finishReason = response.data?.choices?.[0]?.finish_reason || null;
      const usage = response.data?.usage;
      const tokenUsage = usage
        ? {
            inputTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || 0,
          }
        : null;
      return { content, tokenUsage, finishReason };
    }

    // Legacy DashScope API
    const response = await postWithDeadConnRetry(
      legacyUrl,
      {
        model,
        input: {
          messages: [{ role: 'user', content: prompt }],
        },
        parameters: {
          result_format: 'message',
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      },
      provider.name
    );

    const content = response.data?.output?.choices?.[0]?.message?.content || '';
    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
        }
      : null;
    return { content, tokenUsage };
  }

  async getBaiduAccessToken(provider) {
    const now = Date.now();
    if (this.baiduToken && now < this.baiduTokenExpireAt) {
      return this.baiduToken;
    }

    // Mutex: if another call is already refreshing, wait for it
    if (this._baiduTokenPromise) {
      return this._baiduTokenPromise;
    }

    this._baiduTokenPromise = (async () => {
      try {
        if (!provider.secretKey) {
          throw new Error('Missing BAIDU_SECRET_KEY for OAuth flow');
        }

        const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${provider.apiKey}&client_secret=${provider.secretKey}`;
        let tokenResponse;
        try {
          tokenResponse = await axios.get(tokenUrl, withKeepAliveAgents({ timeout: 20000 }));
        } catch (err) {
          // 与 POST 路径语义一致：全局 HTTPS_PROXY 代理不可达时一次性回退直连重试，
          // 避免 Baidu OAuth GET 在代理挂掉时硬失败。
          if (_proxyAgent && !_proxyFailedOnce && isProxyConnectError(err)) {
            _proxyFailedOnce = true;
            console.warn(
              `[proxy] 代理 ${_configuredProxyUrl} 不可达，回退直连重试 Baidu OAuth 令牌获取 (第1/1次)...`
            );
            tokenResponse = await axios.get(tokenUrl, {
              httpsAgent: _directHttpsAgent,
              httpAgent: sharedHttpAgent,
              timeout: 20000,
            });
          } else {
            throw err;
          }
        }
        const accessToken = tokenResponse.data?.access_token;

        if (!accessToken) {
          throw new Error('Failed to obtain Baidu access token');
        }

        const expiresIn = Number(tokenResponse.data?.expires_in || 2592000);
        // Add jitter to prevent thundering herd on token expiry
        const jitter = 300 + Math.floor(Math.random() * 300);
        this.baiduToken = accessToken;
        this.baiduTokenExpireAt = now + Math.max(60, expiresIn - jitter) * 1000;
        return accessToken;
      } finally {
        this._baiduTokenPromise = null;
      }
    })();

    return this._baiduTokenPromise;
  }

  async callBaidu(provider, prompt, opts) {
    const accessToken = await this.getBaiduAccessToken(provider);
    const baseUrl = (
      provider.baseUrl || 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop'
    ).replace(/\/+$/, '');
    const endpoint = /\/chat\/completions$/i.test(baseUrl)
      ? baseUrl
      : `${baseUrl}/chat/completions`;
    const response = await postWithDeadConnRetry(
      endpoint,
      {
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        top_p: 0.8,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 30000,
      },
      provider.name
    );

    const content = response.data?.result || '';
    const usage = response.data?.usage;
    const tokenUsage = usage
      ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          ...normalizeCacheUsage(usage),
        }
      : null;
    return { content, tokenUsage };
  }

  async callHuggingFace(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const response = await postWithDeadConnRetry(
      `https://api-inference.huggingface.co/models/${model}`,
      {
        inputs: prompt,
        parameters: {
          max_new_tokens: Math.min(opts.maxTokens, 512),
          temperature: opts.temperature,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 45000,
      },
      provider.name
    );

    let content = '';
    if (Array.isArray(response.data) && response.data[0]?.generated_text) {
      content = response.data[0].generated_text;
    } else if (typeof response.data?.generated_text === 'string') {
      content = response.data.generated_text;
    }

    // HuggingFace does not return token counts; estimate
    const { estimateTokens } = require('./tokenUsageService');
    const tokenUsage = {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(content),
      totalTokens: estimateTokens(prompt) + estimateTokens(content),
    };
    return { content, tokenUsage };
  }

  localFallback(agentId = 'general', stockCode = 'UNKNOWN') {
    const templates = {
      fundamentals: `【基本面分析】${stockCode} 估值与盈利能力处于可追踪区间，建议结合季报数据和行业对比后再做加仓决策。`,
      market: `【市场分析】${stockCode} 当前处于震荡整理结构，建议等待放量突破信号确认后再积极布局。`,
      social: `【情绪分析】${stockCode} 市场情绪分歧较大，建议避免情绪化操作，严格执行既定交易规则。`,
      news: `【新闻分析】${stockCode} 当前暂无明确单边催化剂，建议密切关注官方公告及政策变化动向。`,
      strategy: `【策略分析】${stockCode} 适合采用分批建仓策略，严格设置止损位并控制风险预算。`,
      risk: `【风险分析】${stockCode} 主要风险来自波动率扩张和流动性变化，建议保持保守仓位管理。`,
    };

    return (
      templates[agentId] ||
      `【综合分析】${stockCode} 在线大模型服务暂时不可用，已返回本地规则兜底分析结果。`
    );
  }
}

module.exports = MultiFreeService;

/**
 * enumerateKnownModels — 扁平枚举所有内置 provider 的模型 id + 渠道 + 声明的 supportsVision,
 * 供「哪些模型支持视觉」这类回答层用(visionRoutingTruth)。只读 env 构造 provider 配置,
 * **不发网络**;绝不抛,任何异常 → []。返回全部已知模型(不筛 enabled),以便回答完整。
 *
 * @returns {Array<{id:string, provider:string, supportsVision:boolean}>}
 */
function enumerateKnownModels() {
  try {
    const svc = new MultiFreeService();
    const out = [];
    const seen = new Set();
    const push = (id, provider, supportsVision) => {
      const mid = String(id == null ? '' : id).trim();
      if (!mid) {
        return;
      }
      const key = mid.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push({ id: mid, provider: String(provider || ''), supportsVision: !!supportsVision });
    };
    for (const [key, p] of Object.entries(svc.providers || {})) {
      if (!p) {
        continue;
      }
      const provider = p.name || key;
      if (Array.isArray(p.availableModels)) {
        for (const m of p.availableModels) {
          if (!m) {
            continue;
          }
          const id = typeof m === 'string' ? m : m.id || m.model || m.name;
          push(id, provider, p.supportsVision);
        }
      }
      if (p.model) {
        push(p.model, provider, p.supportsVision);
      }
    }
    return out;
  } catch {
    return [];
  }
}

module.exports.enumerateKnownModels = enumerateKnownModels;
// Exposed for unit-style verification of the sliding idle timeout behavior.
module.exports.createStreamIdleWatchdog = createStreamIdleWatchdog;
