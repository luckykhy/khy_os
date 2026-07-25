const axios = require('axios');
const jwt = require('jsonwebtoken');
const { toGoogleInlineData, toOpenAIVisionBlocks, toAnthropicImageBlocks } = require('./gateway/adapters/_imageCompat');
const { convertMessagesAnthropicToOpenAI } = require('./gateway/adapters/_toolSchemaConverter');
const { extractPrimaryApiKey } = require('./apiKeyFormat');
const { normalizeCacheUsage } = require('./gateway/adapters/_cacheUsage');
// Model-name SSOT: free-tier provider model choices flow from constants/models.js.
const { PRIMARY: MODELS } = require('../constants/models');

class MultiFreeService {
  constructor() {
    this.baiduToken = null;
    this.baiduTokenExpireAt = 0;
    const googleApiKey = extractPrimaryApiKey(process.env.GOOGLE_GEMINI_API_KEY)
      || extractPrimaryApiKey(process.env.GEMINI_API_KEY);
    const groqApiKey = extractPrimaryApiKey(process.env.GROQ_API_KEY);
    const openRouterApiKey = extractPrimaryApiKey(process.env.OPENROUTER_API_KEY);
    const openAiApiKey = extractPrimaryApiKey(process.env.OPENAI_API_KEY);
    const anthropicApiKey = extractPrimaryApiKey(process.env.ANTHROPIC_API_KEY);
    const traeApiKey = extractPrimaryApiKey(process.env.TRAE_API_KEY);
    const zhipuApiKey = extractPrimaryApiKey(process.env.ZHIPU_API_KEY);
    const xunfeiApiKey = extractPrimaryApiKey(process.env.XUNFEI_API_KEY);
    const baiduApiKey = extractPrimaryApiKey(process.env.BAIDU_API_KEY);
    const baiduSecretKey = extractPrimaryApiKey(process.env.BAIDU_SECRET_KEY)
      || extractPrimaryApiKey(process.env.BAIDU_API_SECRET)
      || extractPrimaryApiKey(process.env.BAIDU_SECRET);
    const alibabaApiKey = extractPrimaryApiKey(process.env.ALIBABA_API_KEY)
      || extractPrimaryApiKey(process.env.DASHSCOPE_API_KEY);
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
      }
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
      message: available.length > 0
        ? `${available.length} provider(s) configured`
        : 'No cloud providers configured, using local fallback'
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
        results: []
      };
    }

    const result = await this.generateResponse('Reply with one short sentence: connection ok.', {
      temperature: 0,
      maxTokens: 64
    });

    return {
      success: result.success,
      message: result.success ? 'LLM connection test completed' : 'LLM connection test failed',
      provider: result.provider,
      response: result.content,
      availableProviders,
      results: result.attempts || []
    };
  }

  async analyze(payload = {}) {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const stockCode = payload.stockCode || 'UNKNOWN';
    const result = await this.generateResponse(prompt, {
      temperature: payload.temperature ?? 0.4,
      maxTokens: payload.maxTokens ?? 1500
    });

    if (result.success && result.content) {
      return result.content;
    }

    return this.localFallback(payload.agentId, stockCode);
  }

  async generateResponse(prompt, options = {}) {
    const temperature = options.temperature ?? 0.4;
    const maxTokens = options.maxTokens ?? 1024;
    const requestedProvider = String(options.provider || '').trim().toLowerCase();
    const requestedModel = String(options.model || '').trim();

    if (!prompt || !prompt.trim()) {
      return {
        success: false,
        content: 'Prompt is empty',
        provider: 'none',
        attempts: []
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
          availableProviders: allProviders.map((p) => p.key)
        };
      }
    }

    if (requestedModel && providers.length > 1) {
      const scoreByModel = (provider) => {
        if (provider.model === requestedModel) return 3;
        if (Array.isArray(provider.availableModels) && provider.availableModels.some((m) => m.id === requestedModel)) return 2;
        return 0;
      };
      providers = [...providers].sort((a, b) => {
        const diff = scoreByModel(b) - scoreByModel(a);
        if (diff !== 0) return diff;
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
        const finishReason = typeof result === 'object' ? (result?.finishReason || null) : null;

        if ((typeof content === 'string' && content.trim()) || (Array.isArray(toolUseBlocks) && toolUseBlocks.length > 0)) {
          attempts.push({ provider: provider.name, success: true });
          return {
            success: true,
            content: (content || '').trim(),
            provider: provider.name,
            model: requestedModel || provider.model,
            tokenUsage: tokenUsage || null,
            thinking: thinking || undefined,
            toolUseBlocks: Array.isArray(toolUseBlocks) && toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
            finishReason: finishReason || undefined,
            attempts,
            availableProviders: providers.map((p) => p.name)
          };
        }

        // Tag empty replies explicitly. An empty HTTP-200 means the channel is
        // healthy but the model produced no text (a weak-model blip, common right
        // after a tool call) — NOT a degraded channel. aiGateway excludes `empty`
        // from the transient cooldown map; leaving errorType unset let it fall
        // through to `unknown`, which carries a ~20s cross-request cooldown and
        // forced every re-ask within the window to fast-fail. Mirrors relayApiAdapter.
        attempts.push({ provider: provider.name, success: false, error: 'Empty response', errorType: 'empty' });
      } catch (error) {
        attempts.push({ provider: provider.name, success: false, error: error.message });
      }
    }

    // If every provider returned empty (and none threw), surface the failure as
    // `empty` at the top level too: recordFailureEarly (aiGateway) reads the
    // top-level errorType to decide the cooldown, and `empty` is cooldown-free.
    const allEmpty = attempts.length > 0 && attempts.every(
      (a) => a.success === false && a.errorType === 'empty'
    );
    return {
      success: false,
      content: this.localFallback('general', 'UNKNOWN'),
      provider: 'local-fallback',
      ...(allEmpty ? { errorType: 'empty', error: 'Empty response' } : {}),
      attempts,
      availableProviders: providers.map((p) => p.name)
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
      for (const block of toGoogleInlineData(opts.images)) parts.push(block);
    }
    parts.push({ text: prompt });

    const response = await axios.post(url, {
      contents: [{ parts }],
      generationConfig: {
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens
      }
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });

    const content = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const meta = response.data?.usageMetadata;
    const tokenUsage = meta ? {
      inputTokens: meta.promptTokenCount || 0,
      outputTokens: meta.candidatesTokenCount || 0,
      totalTokens: meta.totalTokenCount || 0,
    } : null;
    return { content, tokenUsage };
  }

  async callGroq(provider, prompt, opts) {
    const model = opts.model || provider.model || MODELS.freeGroq;
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature,
      max_tokens: opts.maxTokens
    }, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data?.choices?.[0]?.message?.content || '';
    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      ...normalizeCacheUsage(usage),
    } : null;
    return { content, tokenUsage };
  }

  async callOpenRouter(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature,
      max_tokens: opts.maxTokens
    }, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': require('../constants/serviceDefaults').HTTP_REFERER,
        'X-Title': 'khy OS'
      },
      timeout: 30000
    });

    const content = response.data?.choices?.[0]?.message?.content || '';
    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      ...normalizeCacheUsage(usage),
    } : null;
    return { content, tokenUsage };
  }

  async callOpenAI(provider, prompt, opts) {
    // Support custom base URL (relay/proxy) via OPENAI_BASE_URL env
    // Strip trailing /v1 if present to prevent double /v1/v1 paths
    let baseUrl = provider.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com';
    baseUrl = baseUrl.replace(/\/v1\/?$/, '');
    const model = opts.model || provider.model;

    // Build message content: multimodal array if images present, plain string otherwise
    let messageContent;
    if (opts.images && opts.images.length > 0) {
      messageContent = [
        ...toOpenAIVisionBlocks(opts.images),
        { type: 'text', text: prompt },
      ];
    } else {
      messageContent = prompt;
    }

    // Use structured messages if available, otherwise single user message
    let messages = opts.structuredMessages && opts.structuredMessages.length > 0
      ? opts.structuredMessages.map(m => ({ ...m }))
      : [{ role: 'user', content: messageContent }];

    // 注入 system prompt（CC 通过 opts.system 传入，OpenAI 协议需要 role:'system' 消息）
    if (opts.system && messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: opts.system });
    }

    // 追加模型身份信息到 system 消息末尾，防止小模型幻觉编造身份
    if (model) {
      const sysIdx = messages.findIndex(m => m.role === 'system');
      const identityHint = `\n\n[Model Identity] You are ${model}, served through KHY gateway. Do not fabricate a different identity or claim to be running in any specific IDE environment.`;
      if (sysIdx >= 0) {
        messages[sysIdx] = { ...messages[sysIdx], content: (messages[sysIdx].content || '') + identityHint };
      } else {
        messages.unshift({ role: 'system', content: identityHint.trim() });
      }
    }

    // 当使用 structuredMessages 且有图片时，将图片注入到最后一条 user 消息
    if (opts.structuredMessages && opts.structuredMessages.length > 0
        && opts.images && opts.images.length > 0) {
      const imageBlocks = toOpenAIVisionBlocks(opts.images);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const textContent = typeof messages[i].content === 'string'
            ? messages[i].content
            : (Array.isArray(messages[i].content)
              ? messages[i].content.map(c => c.text || '').join('')
              : String(messages[i].content || ''));
          messages[i] = {
            ...messages[i],
            content: [
              ...imageBlocks,
              { type: 'text', text: textContent },
            ],
          };
          break;
        }
      }
    }

    // Convert Anthropic tool_use/tool_result content blocks to OpenAI format
    // (structuredMessages from ai.js may contain tool_use/tool_result arrays)
    const hasAnthropicToolBlocks = messages.some(m =>
      Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result')
    );
    if (hasAnthropicToolBlocks) {
      messages = convertMessagesAnthropicToOpenAI(messages, true);
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
      // 该「小模型不支持 function calling → 剥离 tools」判定单一真源在
      // modelToolingCapability(与系统提示词教学门同源,strip⟺teach 永远同步)。
      // 实测为准:measured 来自 toolCapabilityStore(live probe / 被动学习),胜过名字启发。
      // _toolCapProbe:能力探测自身必须真发 tools 才能测出结果,绝不剥离。
      // 门控 KHY_MODEL_TOOLING_CAPABILITY 关 → 字节回退到旧内联正则。
      const _toolCap = require('./gateway/modelToolingCapability');
      let _isSmallModel;
      if (opts._toolCapProbe) {
        _isSmallModel = false; // 探测必须保留 tools
      } else if (_toolCap.isEnabled()) {
        let _measured = null;
        try { _measured = require('./gateway/toolCapabilityStore').getVerdict(model); } catch { /* best effort */ }
        _isSmallModel = _toolCap.shouldStripUpstreamTools(model, { measured: _measured });
      } else {
        _isSmallModel = (/(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i.test(model)
          && !/deepseek-v[3-9]/i.test(model)
          && !/sensenova-\d/i.test(model));
      }
      if (_isSmallModel) {
        _toolsSkippedReason = `模型 ${model} 不支持工具调用 (function calling)，将以纯文本模式回答。如需使用工具，请切换到支持 function calling 的模型。`;
        if (opts.onChunk) {
          opts.onChunk({ type: 'notice', text: _toolsSkippedReason });
        }
      } else {
        requestBody.tools = opts.tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.input_schema || t.parameters || { type: 'object', properties: {} } },
        }));
      }
    }

    // ── Helper: retry after a 400 by stripping the payload bits a strict provider may reject ──
    // Fires on 400 when the body carries tools and/or stream_options; strips whichever exist so
    // the request can succeed (API key is valid — only the payload was rejected). Stripping
    // stream_options degrades usage reporting to today's behavior (ctx may stay 0), not a regression.
    const _retryWithoutTools = async (err) => {
      if (err.response?.status !== 400) return null;
      if (!requestBody.tools && !requestBody.stream_options) return null;
      const retryBody = { ...requestBody };
      if (retryBody.tools) {
        delete retryBody.tools;
        delete retryBody.tool_choice;
        if (opts.onChunk) opts.onChunk({ type: 'notice', text: `模型 ${model} 拒绝了工具调用请求 (HTTP 400)，已自动去除工具定义重试` });
      }
      // stream_options is a standard OpenAI field but some non-compliant gateways reject unknown
      // keys; drop it on retry so the request still goes through.
      if (retryBody.stream_options) delete retryBody.stream_options;
      return retryBody;
    };

    // ── Streaming path: SSE for real-time output ────────────────────
    if (typeof opts.onChunk === 'function') {
      requestBody.stream = true;
      // Opt into usage reporting on the stream. OpenAI-compatible gateways (agnes, …) only emit a
      // trailing `usage` chunk when the request carries stream_options.include_usage — without it
      // tokenUsage stays null and the TUI shows `0% ctx (0/128k)`. Gated (KHY_STREAM_USAGE),
      // fail-soft, byte-revert when off. See services/streamUsageOptions.js.
      try { require('./streamUsageOptions').applyStreamUsage(requestBody, process.env); } catch { /* leaf unavailable → no opt-in */ }

      let response;
      try {
        response = await axios.post(`${baseUrl}/v1/chat/completions`, requestBody, {
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: opts.timeoutMs || 120000,
          responseType: 'stream',
          signal: opts.signal,
        });
      } catch (err) {
        // On 400, retry without tools — API key is valid, payload was rejected
        const retryBody = await _retryWithoutTools(err);
        if (retryBody) {
          retryBody.stream = true;
          response = await axios.post(`${baseUrl}/v1/chat/completions`, retryBody, {
            headers: {
              Authorization: `Bearer ${provider.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: opts.timeoutMs || 120000,
            responseType: 'stream',
            signal: opts.signal,
          });
        } else {
          throw err;
        }
      }

      let content = '';
      const toolCallAccum = {}; // index → {name, arguments}
      let inputTokens = 0, outputTokens = 0;
      let cacheReadTokens = 0, cacheWriteTokens = 0;
      let finishReason = null; // OpenAI finish_reason (last chunk) — fed to the loop's stop_reason trust

      return new Promise((resolve, reject) => {
        let buffer = '';
        const stream = response.data;

        stream.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') continue;

            try {
              const data = JSON.parse(payload);
              // finish_reason rides the terminal chunk (stop | length | tool_calls | content_filter)
              if (data.choices?.[0]?.finish_reason) finishReason = data.choices[0].finish_reason;

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
                opts.onChunk({ type: 'cost', cost: {
                  inputTokens, outputTokens,
                  totalTokens: data.usage.total_tokens || inputTokens + outputTokens,
                }});
              }

              const delta = data.choices?.[0]?.delta;
              if (!delta) continue;

              // Text content
              if (delta.content) {
                content += delta.content;
                opts.onChunk({ type: 'text', text: delta.content });
              }

              // Tool calls (streamed incrementally)
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallAccum[idx]) toolCallAccum[idx] = { id: '', name: '', arguments: '' };
                  if (tc.id) toolCallAccum[idx].id = tc.id;
                  if (tc.function?.name) toolCallAccum[idx].name = tc.function.name;
                  if (tc.function?.arguments) toolCallAccum[idx].arguments += tc.function.arguments;
                }
              }
            } catch { /* skip malformed SSE lines */ }
          }
        });

        stream.on('end', () => {
          // Finalize accumulated tool calls → 结构化 toolUseBlocks
          const toolCalls = Object.values(toolCallAccum).filter(tc => tc.name);
          let toolUseBlocks = null;
          if (toolCalls.length > 0) {
            toolUseBlocks = toolCalls.map(tc => {
              let params;
              try { params = JSON.parse(tc.arguments); } catch { params = {}; }
              const id = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              return { id, name: tc.name, params, input: params };
            });

            // Emit full tool_use chunks so proxy SSE reconstruction has id/name/input
            for (const block of toolUseBlocks) {
              opts.onChunk({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
            }
          }

          const tokenUsage = (inputTokens || outputTokens) ? {
            inputTokens, outputTokens,
            totalTokens: inputTokens + outputTokens,
            ...(cacheReadTokens || cacheWriteTokens
              ? { cacheReadInputTokens: cacheReadTokens, cacheWriteInputTokens: cacheWriteTokens }
              : {}),
          } : null;
          resolve({ content, tokenUsage, toolUseBlocks, finishReason });
        });

        stream.on('error', reject);
      });
    }

    // ── Non-streaming fallback ──────────────────────────────────────
    let response;
    try {
      response = await axios.post(`${baseUrl}/v1/chat/completions`, requestBody, {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
    } catch (err) {
      const retryBody = await _retryWithoutTools(err);
      if (retryBody) {
        response = await axios.post(`${baseUrl}/v1/chat/completions`, retryBody, {
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        });
      } else {
        throw err;
      }
    }

    const msg = response.data?.choices?.[0]?.message;
    let content = msg?.content || '';

    // Convert native tool_calls → 结构化 toolUseBlocks
    let toolUseBlocks = null;
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
      toolUseBlocks = msg.tool_calls.map(tc => {
        const fn = tc.function;
        let params;
        try { params = JSON.parse(fn.arguments); } catch { params = {}; }
        const id = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return { id, name: fn.name, params, input: params };
      });
    }

    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      ...normalizeCacheUsage(usage),
    } : null;
    const finishReason = response.data?.choices?.[0]?.finish_reason || null;
    return { content, tokenUsage, toolUseBlocks, finishReason };
  }

  async callAnthropic(provider, prompt, opts) {
    // Support custom base URL (relay/proxy) via ANTHROPIC_BASE_URL env
    const baseUrl = (provider.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const isRelay = !baseUrl.includes('api.anthropic.com');

    // Build message content: multimodal array if images present, plain string otherwise
    let messageContent;
    if (opts.images && opts.images.length > 0 && !isRelay) {
      messageContent = [
        ...toAnthropicImageBlocks(opts.images),
        { type: 'text', text: prompt },
      ];
    } else {
      messageContent = prompt;
    }

    // Build messages: use structured messages if available
    let apiMessages;
    let systemContent = '';
    if (opts.structuredMessages && opts.structuredMessages.length > 0) {
      // Anthropic uses separate system param, extract it from messages
      const sysMsg = opts.structuredMessages.find(m => m.role === 'system');
      if (sysMsg) systemContent = sysMsg.content;
      apiMessages = opts.structuredMessages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));
      // Ensure first message is user role (Anthropic requirement)
      if (apiMessages.length > 0 && apiMessages[0].role !== 'user') {
        apiMessages.unshift({ role: 'user', content: '(context follows)' });
      }
      // 当有图片时，将图片注入到最后一条 user 消息
      if (opts.images && opts.images.length > 0 && !isRelay) {
        const imageBlocks = toAnthropicImageBlocks(opts.images);
        for (let i = apiMessages.length - 1; i >= 0; i--) {
          if (apiMessages[i].role === 'user') {
            const textContent = typeof apiMessages[i].content === 'string'
              ? apiMessages[i].content
              : (Array.isArray(apiMessages[i].content)
                ? apiMessages[i].content.map(c => c.text || '').join('')
                : String(apiMessages[i].content || ''));
            apiMessages[i] = {
              ...apiMessages[i],
              content: [
                ...imageBlocks,
                { type: 'text', text: textContent },
              ],
            };
            break;
          }
        }
      }
    } else {
      apiMessages = [{ role: 'user', content: messageContent }];
    }
    if (opts.system && !systemContent) systemContent = opts.system;

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
      body.tools = opts.tools.map(t => ({
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
      const response = await axios.post(`${baseUrl}/v1/messages`, body, {
        headers: {
          'x-api-key': provider.apiKey,
          'anthropic-version': '2024-10-22',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'Content-Type': 'application/json',
        },
        timeout: opts.timeoutMs || 120000,
        responseType: 'stream',
        signal: opts.signal,
      });

      let content = '';
      let thinkingContent = '';
      let currentToolName = '';
      let currentToolInput = '';
      let inputTokens = 0, outputTokens = 0;
      let cacheReadTokens = 0, cacheWriteTokens = 0;
      let finishReason = null; // Anthropic stop_reason (message_delta) — fed to the loop's stop_reason trust
      const toolUseBlocks = [];

      return new Promise((resolve, reject) => {
        let buffer = '';
        const stream = response.data;

        stream.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') continue;

            try {
              const event = JSON.parse(payload);

              // Anthropic SSE event types
              switch (event.type) {
                case 'content_block_start': {
                  const block = event.content_block;
                  if (block?.type === 'tool_use') {
                    currentToolName = block.name || '';
                    currentToolInput = '';
                    opts.onChunk({ type: 'tool_use', tool: currentToolName });
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
                    try { input = JSON.parse(currentToolInput); } catch { /* ignore */ }
                    toolUseBlocks.push({ name: currentToolName, input });
                    currentToolName = '';
                    currentToolInput = '';
                  }
                  break;
                }
                case 'message_delta': {
                  // stop_reason arrives on message_delta (end_turn | tool_use | max_tokens | stop_sequence)
                  if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
                  if (event.usage) {
                    outputTokens = event.usage.output_tokens || 0;
                    opts.onChunk({ type: 'cost', cost: {
                      inputTokens, outputTokens,
                      totalTokens: inputTokens + outputTokens,
                    }});
                  }
                  break;
                }
                case 'message_start': {
                  if (event.message?.usage) {
                    inputTokens = event.message.usage.input_tokens || 0;
                    const _c = normalizeCacheUsage(event.message.usage);
                    cacheReadTokens = _c.cacheReadInputTokens;
                    cacheWriteTokens = _c.cacheWriteInputTokens;
                    opts.onChunk({ type: 'cost', cost: {
                      inputTokens, outputTokens: 0,
                      totalTokens: inputTokens,
                    }});
                  }
                  break;
                }
              }
            } catch { /* skip malformed SSE lines */ }
          }
        });

        stream.on('end', () => {
          const tokenUsage = (inputTokens || outputTokens) ? {
            inputTokens, outputTokens,
            totalTokens: inputTokens + outputTokens,
            ...(cacheReadTokens || cacheWriteTokens
              ? { cacheReadInputTokens: cacheReadTokens, cacheWriteInputTokens: cacheWriteTokens }
              : {}),
          } : null;
          resolve({
            content,
            tokenUsage,
            thinking: thinkingContent || undefined,
            toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
            finishReason,
          });
        });

        stream.on('error', reject);
      });
    }

    // ── Non-streaming fallback ──────────────────────────────────────
    let response;
    try {
      response = await axios.post(`${baseUrl}/v1/messages`, body, {
        headers: {
          'x-api-key': provider.apiKey,
          'anthropic-version': '2024-10-22',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
    } catch (err) {
      if (isRelay && err.response?.status === 400) {
        const minimalBody = {
          model: opts.model || provider.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          messages: [{ role: 'user', content: messageContent }],
        };
        response = await axios.post(`${baseUrl}/v1/messages`, minimalBody, {
          headers: {
            'x-api-key': provider.apiKey,
            'anthropic-version': '2024-10-22',
            'Content-Type': 'application/json'
          },
          timeout: 30000
        });
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
        thinkingContent += (block.thinking || '');
      }
    }
    if (!content && !toolUseBlocks.length) content = response.data?.content?.[0]?.text || '';

    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    } : null;
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
      timestamp: Math.round(Date.now() / 1000)
    };

    return jwt.sign(payload, secret, {
      algorithm: 'HS256',
      header: { alg: 'HS256', sign_type: 'SIGN' }
    });
  }

  async callZhipu(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const baseUrl = (provider.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
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
      token = shape.resolveZhipuAuthMode(provider.apiKey, process.env, endpoint) === 'raw'
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
      } catch { /* fail-soft: 原图透传 */ }
      messageContent = [
        ...toOpenAIVisionBlocks(_images),
        { type: 'text', text: prompt },
      ];
    }

    // max_tokens 钳位:GLM 视觉模型(glm-4v-flash/glm-4.6v-flash)上限 [1,1024],发高值 →
    // 智谱端 400 code 1210「max_tokens参数非法」。门控 KHY_GLM_VISION_MAX_TOKENS_CLAMP 默认开,
    // 关门/异常 → 原样透传(逐字节回退)。非视觉模型不受影响。
    let _maxTokens = opts.maxTokens;
    try {
      const { clampMaxTokensForGlmVision } = require('./gateway/glmVisionMaxTokens');
      _maxTokens = clampMaxTokensForGlmVision(model, opts.maxTokens, process.env);
    } catch { /* fail-soft: 原样透传 */ }

    const requestBody = {
      model,
      messages: [{ role: 'user', content: messageContent }],
      temperature: opts.temperature,
      max_tokens: _maxTokens
    };
    // 文本预算截断:无图的大文本(磁盘扫描等工具结果,实测约 25304 token)会撞 GLM 视觉端
    // 16384 合并预算 → 400 code 1210 → 级联落剪贴板兜底。发送前对 messages 做文本侧预算截断
    // (中段截断最大块,保头保尾)。门控 KHY_GLM_VISION_TEXT_BUDGET 默认开,关门/异常 → 原样
    // 透传(逐字节回退)。仅 GLM 视觉模型触发,非视觉模型不受影响。
    try {
      const { clampTextBudgetInMessages } = require('./gateway/glmVisionTextBudget');
      clampTextBudgetInMessages(model, requestBody.messages, { maxTokens: _maxTokens }, process.env);
    } catch { /* fail-soft: 原样透传 */ }
    // reasoning_effort:GLM-5.2 招牌请求参数。门控 KHY_ZHIPU_REASONING_EFFORT 默认开——从 opts 取
    // 合法枚举透传;门关/缺失/非法 → 不写该字段(逐字节回退旧行为,只发 temperature/max_tokens)。
    try {
      const shape = require('./zhipuRequestShape');
      const effort = shape.pickReasoningEffort(opts, process.env);
      if (effort) requestBody.reasoning_effort = effort;
    } catch { /* fail-soft: 不透传 */ }

    let response;
    try {
      response = await axios.post(endpoint, requestBody, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      });
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
          if (status) parts.push(`HTTP ${status}`);
          if (upstreamCode) parts.push(`code ${upstreamCode}`);
          if (upstreamMsg) parts.push(String(upstreamMsg));
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
      } catch { /* 诊断增强绝不掩盖原始错误:任何解析失败 → 原样抛出 */ }
      throw err;
    }

    const content = response.data?.choices?.[0]?.message?.content || '';
    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      ...normalizeCacheUsage(usage),
    } : null;
    return { content, tokenUsage };
  }

  async callXunfei(provider, prompt, opts) {
    const model = opts.model || provider.model || 'lite';
    const response = await axios.post('https://spark-api-open.xf-yun.com/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: opts.temperature,
      max_tokens: opts.maxTokens
    }, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data?.choices?.[0]?.message?.content || response.data?.result || '';
    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      ...normalizeCacheUsage(usage),
    } : null;
    return { content, tokenUsage };
  }

  async callAlibaba(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const baseUrl = (provider.baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/+$/, '');

    // Use OpenAI-compatible API for newer models (qwen-max, qwen-plus, etc.)
    const useCompatible = /^qwen[2-]/.test(model) || ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long', 'qwen-vl-max', 'qwen-vl-plus', 'qwen-coder-plus'].includes(model);
    const compatibleUrl = /\/compatible-mode\/v1$/i.test(baseUrl)
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/compatible-mode/v1/chat/completions`;
    const legacyUrl = /\/api\/v1$/i.test(baseUrl)
      ? `${baseUrl}/services/aigc/text-generation/generation`
      : `${baseUrl}/api/v1/services/aigc/text-generation/generation`;

    if (useCompatible) {
      const response = await axios.post(compatibleUrl, {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
      }, {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      });

      const content = response.data?.choices?.[0]?.message?.content || '';
      const usage = response.data?.usage;
      const tokenUsage = usage ? {
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
      } : null;
      return { content, tokenUsage };
    }

    // Legacy DashScope API
    const response = await axios.post(legacyUrl, {
      model,
      input: {
        messages: [{ role: 'user', content: prompt }]
      },
      parameters: {
        result_format: 'message',
        temperature: opts.temperature,
        max_tokens: opts.maxTokens
      }
    }, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const content = response.data?.output?.choices?.[0]?.message?.content || '';
    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      totalTokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
    } : null;
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
        const tokenResponse = await axios.get(tokenUrl, { timeout: 20000 });
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
    const baseUrl = (provider.baseUrl || 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop').replace(/\/+$/, '');
    const endpoint = /\/chat\/completions$/i.test(baseUrl)
      ? baseUrl
      : `${baseUrl}/chat/completions`;
    const response = await axios.post(
      endpoint,
      {
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature,
        top_p: 0.8
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 30000
      }
    );

    const content = response.data?.result || '';
    const usage = response.data?.usage;
    const tokenUsage = usage ? {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      ...normalizeCacheUsage(usage),
    } : null;
    return { content, tokenUsage };
  }

  async callHuggingFace(provider, prompt, opts) {
    const model = opts.model || provider.model;
    const response = await axios.post(
      `https://api-inference.huggingface.co/models/${model}`,
      {
        inputs: prompt,
        parameters: {
          max_new_tokens: Math.min(opts.maxTokens, 512),
          temperature: opts.temperature
        }
      },
      {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 45000
      }
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
      risk: `【风险分析】${stockCode} 主要风险来自波动率扩张和流动性变化，建议保持保守仓位管理。`
    };

    return templates[agentId] || `【综合分析】${stockCode} 在线大模型服务暂时不可用，已返回本地规则兜底分析结果。`;
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
      if (!mid) return;
      const key = mid.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: mid, provider: String(provider || ''), supportsVision: !!supportsVision });
    };
    for (const [key, p] of Object.entries(svc.providers || {})) {
      if (!p) continue;
      const provider = p.name || key;
      if (Array.isArray(p.availableModels)) {
        for (const m of p.availableModels) {
          if (!m) continue;
          const id = typeof m === 'string' ? m : (m.id || m.model || m.name);
          push(id, provider, p.supportsVision);
        }
      }
      if (p.model) push(p.model, provider, p.supportsVision);
    }
    return out;
  } catch {
    return [];
  }
}

module.exports.enumerateKnownModels = enumerateKnownModels;
