# [DESIGN-CPA-001] KhyOS CPA 反代集成方案（与 provider-hub 集成版）

> **文档类型**: 架构设计文档  
> **创建日期**: 2026-09-11  
> **状态**: 草案  
> **适用场景**: 个人自用、CLI 开发工具链  
> **集成目标**: 复用 provider-hub 和 ccSwitch 系统，避免重复实现

---

## 1. 概述

### 1.1 背景

CPA (CLI Proxy API) 是一个开源的 AI API 反向代理网关，主要功能：
- 将 Gemini CLI、Codex、Claude Code 等 CLI/OAuth 账号转换为标准 OpenAI 兼容 API
- 支持多账号轮询负载均衡
- 统一管理多个 AI 平台的访问

### 1.2 现有架构分析

KhyOS 已有完善的 Provider 管理系统：

```
┌─────────────────────────────────────────────────────────────┐
│                    provider-hub (apps/provider-hub)         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Card System (cc_switch.json)                        │  │
│  │  - 卡片 CRUD (providers.ts)                          │  │
│  │  - 密钥池 (api_keys.json)                            │  │
│  │  - 模型目录 (modelCatalog.ts)                         │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    ccSwitch 系统                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  APPS 常量 (constants.js)                            │  │
│  │  - claude-code, codex, opencode, gemini, ...         │  │
│  │  - 协议: openai, anthropic, openai_responses, gemini │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  App Writers (appWriters.js)                         │  │
│  │  - per-app 配置写入器                                 │  │
│  │  - preflight 校验                                     │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Route Resolver (routeResolver.js)                   │  │
│  │  - 活跃卡片路由                                       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 设计目标

**核心原则：复用现有系统，避免重复实现**

1. **复用 Card System**: CPA 作为一个 Provider Card，使用现有的 `cc_switch.json` 存储
2. **复用 Key Pool**: CPA 使用现有的 `api_keys.json` 密钥池
3. **复用 App Writer 模式**: 创建 `cpaWriter.js` 作为 CPA 的配置写入器
4. **复用 Gateway Adapter 模式**: 创建 `cpaAdapter.js` 读取 Card 配置

---

## 2. 架构设计

### 2.1 集成架构

```
┌─────────────────────────────────────────────────────────────┐
│                    KhyOS CLI Layer                           │
│  (khy cc-switch add / khy cc-switch apply cpa)              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    provider-hub (Card System)                │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  cc_switch.json                                      │  │
│  │  {                                                   │  │
│  │    "cards": [                                        │  │
│  │      {                                               │  │
│  │        "id": "c_xxx",                                │  │
│  │        "name": "My CPA Server",                      │  │
│  │        "baseUrl": "http://localhost:8317",           │  │
│  │        "protocol": "openai",                         │  │
│  │        "apps": ["cpa"],                              │  │
│  │        ...                                           │  │
│  │      }                                               │  │
│  │    ]                                                 │  │
│  │  }                                                   │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    ccSwitch System                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  cpaWriter.js (新建)                                  │  │
│  │  - applyCardToCpa(): 应用卡片到 CPA 配置              │  │
│  │  - detectCpaConfig(): 探测 CPA 运行状态               │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    AI Gateway (aiGateway.js)                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  cpaAdapter.js (新建)                                 │  │
│  │  - 从 ccSwitch 读取活跃卡片配置                        │  │
│  │  - 调用 CPA Server 的 OpenAI 兼容 API                 │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    CPA Server (External)                     │
│  http://localhost:8317/v1/chat/completions                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
用户请求 → KhyOS Gateway → cpaAdapter → 读取 ccSwitch 活跃卡片 → CPA Server
                                         ↓
                                    Card { baseUrl, keyId }
                                         ↓
                                    Key Pool { api_keys.json }
                                         ↓
                                    实际 API Key
```

### 2.3 配置复用

| 配置项 | 存储位置 | 复用方式 |
|--------|----------|----------|
| CPA 端点 | `cc_switch.json` → Card.baseUrl | 直接复用 |
| API 密钥 | `api_keys.json` → PoolEntry.key | 直接复用 |
| 默认模型 | `cc_switch.json` → Card.defaultModel | 直接复用 |
| 协议类型 | `cc_switch.json` → Card.protocol | 固定为 `openai` |

---

## 3. 实现方案

### 3.1 注册 CPA 为新 App (constants.js)

**修改位置**: `services/backend/src/services/domain/config/ccSwitch/constants.js`

```javascript
// 在 APPS 常量中添加 CPA
const APPS = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  GEMINI: 'gemini',
  DEEPSEEK: 'deepseek',
  REASONIX: 'reasonix',
  COMMAND_CODE: 'command-code',
  YCODE: 'ycode',
  ZCODE: 'zcode',
  CPA: 'cpa',  // 新增
});

// 在 APP_LABELS 中添加
const APP_LABELS = Object.freeze({
  [APPS.CLAUDE_CODE]: 'Claude Code',
  [APPS.CODEX]: 'Codex CLI',
  [APPS.OPENCODE]: 'OpenCode CLI',
  [APPS.GEMINI]: 'Gemini CLI',
  [APPS.DEEPSEEK]: 'DeepSeek TUI',
  [APPS.REASONIX]: 'Reasonix',
  [APPS.COMMAND_CODE]: 'Command Code',
  [APPS.YCODE]: 'YCode',
  [APPS.ZCODE]: 'ZCode',
  [APPS.CPA]: 'CPA (CLI Proxy API)',  // 新增
});
```

### 3.2 创建 CPA App Writer (cpaWriter.js)

**位置**: `services/backend/src/services/domain/config/ccSwitch/cpaWriter.js`

```javascript
/**
 * cpaWriter — CPA (CLI Proxy API) 配置写入器
 *
 * 职责：
 *   - 应用 Provider Card 到 CPA Server 配置
 *   - 探测 CPA Server 运行状态
 *   - 生成 CPA 配置文件
 *
 * 设计原则：
 *   - 复用 ccSwitch Card 系统
 *   - CPA 使用 OpenAI 协议
 *   - 配置通过环境变量或 config.yaml 管理
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { APPS } = require('./constants.js');

const CPA_APP = APPS.CPA;

/**
 * 应用卡片到 CPA 配置
 * @param {Card} card - Provider Card
 * @param {Object} opts - 选项
 * @param {string} opts.key - API Key (明文)
 * @returns {Promise<{success: boolean, error?: string, detail?: unknown}>}
 */
async function applyCardToCpa(card, opts = {}) {
  try {
    const endpoint = card.baseUrl;
    const key = opts.key || '';
    const model = card.defaultModel || 'gpt-4';

    // 生成 CPA 环境变量配置
    const envConfig = {
      CPA_ENDPOINT: endpoint,
      CPA_API_KEY: key,
      CPA_MODEL: model,
    };

    // 写入到 CPA 配置目录（如果存在）
    const cpaConfigDir = _findCpaConfigDir();
    if (cpaConfigDir) {
      await _writeCpaEnvFile(cpaConfigDir, envConfig);
    }

    // 同时设置进程环境变量（立即生效）
    Object.assign(process.env, envConfig);

    return {
      success: true,
      detail: {
        endpoint,
        model,
        hasKey: !!key,
        configDir: cpaConfigDir,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `CPA 配置写入失败: ${error.message}`,
    };
  }
}

/**
 * 探测 CPA 配置
 * @param {string} app - 应用名
 * @returns {{success: boolean, providers: Array<Record<string, unknown>>, error?: string}}
 */
function detectCpaConfig(app) {
  if (app !== CPA_APP) {
    return { success: false, providers: [], error: `不支持的应用: ${app}` };
  }

  const providers = [];

  // 从环境变量探测
  const endpoint = process.env.CPA_ENDPOINT;
  if (endpoint) {
    providers.push({
      id: 'env',
      name: 'Environment Config',
      endpoint,
      kind: 'openai',
      models: process.env.CPA_MODEL ? [process.env.CPA_MODEL] : [],
      defaultModel: process.env.CPA_MODEL || '',
    });
  }

  // 从 CPA 配置文件探测
  const configPath = _findCpaConfigFile();
  if (configPath) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      // 解析 YAML 或 JSON 配置
      const config = _parseCpaConfig(content);
      if (config && config.endpoint) {
        providers.push({
          id: 'file',
          name: 'Config File',
          endpoint: config.endpoint,
          kind: 'openai',
          models: config.models || [],
          defaultModel: config.model || '',
        });
      }
    } catch {
      // 配置文件读取失败，忽略
    }
  }

  return {
    success: true,
    providers,
  };
}

/**
 * Preflight 校验
 * @param {Card} card - Provider Card
 * @param {string} app - 应用名
 * @returns {{ok: boolean, reason?: string, warning?: string}}
 */
function preflightCardForCpa(card, app) {
  if (app !== CPA_APP) {
    return { ok: false, reason: `不支持的应用: ${app}` };
  }

  // 校验协议
  if (card.protocol !== 'openai') {
    return {
      ok: false,
      reason: `CPA 仅支持 OpenAI 协议，当前协议: ${card.protocol}`,
    };
  }

  // 校验端点
  if (!card.baseUrl) {
    return { ok: false, reason: 'CPA 端点不能为空' };
  }

  // 警告：无密钥
  if (!card.keyId) {
    return {
      ok: true,
      warning: '未配置 API 密钥，CPA 可能需要密钥才能访问',
    };
  }

  return { ok: true };
}

// ── 内部辅助函数 ─────────────────────────────────────────────

function _findCpaConfigDir() {
  // 尝试查找 CPA 配置目录
  const candidates = [
    process.env.CPA_CONFIG_DIR,
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cli-proxy-api'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cpa'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

function _findCpaConfigFile() {
  const dir = _findCpaConfigDir();
  if (!dir) return null;

  const candidates = ['config.yaml', 'config.json', '.env'];
  for (const file of candidates) {
    const fullPath = path.join(dir, file);
    try {
      if (fs.existsSync(fullPath)) return fullPath;
    } catch {
      continue;
    }
  }
  return null;
}

async function _writeCpaEnvFile(dir, config) {
  const envFile = path.join(dir, '.env');
  const lines = Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.writeFileSync(envFile, lines, 'utf-8');
}

function _parseCpaConfig(content) {
  // 简单的 YAML/JSON 解析
  try {
    return JSON.parse(content);
  } catch {
    // 尝试简单的 YAML 解析
    const endpointMatch = content.match(/endpoint:\s*(.+)/);
    const modelMatch = content.match(/model:\s*(.+)/);
    if (endpointMatch) {
      return {
        endpoint: endpointMatch[1].trim().replace(/['"]/g, ''),
        model: modelMatch ? modelMatch[1].trim().replace(/['"]/g, '') : '',
      };
    }
    return null;
  }
}

module.exports = {
  applyCardToCpa,
  detectCpaConfig,
  preflightCardForCpa,
};
```

### 3.3 注册到 App Writers (appWriters.js)

**修改位置**: `services/backend/src/services/domain/config/ccSwitch/appWriters.js`

```javascript
// 在导入部分添加
const cpaWriter = require('./cpaWriter.js');

// 在 applyCardToApp 函数中添加 CPA 分支
async function applyCardToApp(card, app, opts = {}) {
  // ... 现有代码

  // CPA 应用
  if (app === APPS.CPA) {
    return cpaWriter.applyCardToCpa(card, opts);
  }

  // ... 其他应用
}

// 在 detectCardInApp 函数中添加 CPA 分支
function detectCardInApp(app) {
  // ... 现有代码

  // CPA 应用
  if (app === APPS.CPA) {
    return cpaWriter.detectCpaConfig(app);
  }

  // ... 其他应用
}

// 在 preflightCardForApp 函数中添加 CPA 分支
function preflightCardForApp(card, app) {
  // ... 现有代码

  // CPA 应用
  if (app === APPS.CPA) {
    return cpaWriter.preflightCardForCpa(card, app);
  }

  // ... 其他应用
}
```

### 3.4 创建 CPA Gateway Adapter (cpaAdapter.js)

**位置**: `services/backend/src/services/gateway/adapters/cpaAdapter.js`

```javascript
/**
 * CPA Adapter — 从 ccSwitch 读取活跃卡片，调用 CPA Server
 *
 * 设计原则：
 *   - 复用 ccSwitch Card 系统获取配置
 *   - 使用 OpenAI 协议调用 CPA
 *   - 支持多账号轮询（由 CPA Server 处理）
 */
'use strict';

const { PRIMARY: MODELS } = require('../../../constants/models');
const { createAdapterRuntimeDiagnosticsStore } = require('../runtimeDiagnosticsStore');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { isAbortLikeError } = require('./_abortHelpers');

const DEFAULT_MODEL = MODELS.cpa || 'gpt-4';
const TIMEOUT_MS = parseInt(process.env.CPA_TIMEOUT_MS || '120000', 10);

const _runtimeDiagnosticsStore = createAdapterRuntimeDiagnosticsStore('cpa');
let _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();

let _available = null;
let _configCache = null;

// ── 从 ccSwitch 读取配置 ─────────────────────────────────────

async function _loadConfig() {
  if (_configCache) return _configCache;

  try {
    // 尝试从 ccSwitch store 读取活跃卡片
    const store = require('../../domain/config/ccSwitch/store.js');
    const { APPS } = require('../../domain/config/ccSwitch/constants.js');

    const { cards, active } = store.listCards();
    const activeCardId = active[APPS.CPA];

    if (activeCardId) {
      const card = cards.find((c) => c.id === activeCardId);
      if (card) {
        // 从密钥池获取 API Key
        let key = '';
        if (card.keyId) {
          key = await _resolveKeyFromPool(card.keyId);
        }

        _configCache = {
          endpoint: card.baseUrl,
          key,
          model: card.defaultModel || DEFAULT_MODEL,
        };
        return _configCache;
      }
    }
  } catch {
    // ccSwitch 不可用，回退到环境变量
  }

  // 回退到环境变量
  _configCache = {
    endpoint: process.env.CPA_ENDPOINT || 'http://localhost:8317',
    key: process.env.CPA_API_KEY || '',
    model: process.env.CPA_MODEL || DEFAULT_MODEL,
  };
  return _configCache;
}

async function _resolveKeyFromPool(keyId) {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { keyIdFor } = require('../../domain/config/ccSwitch/store.js');

    const dataHome = process.env.KHY_DATA_HOME || path.join(os.homedir(), '.khy');
    const poolFile = path.join(dataHome, 'api_keys.json');

    if (!fs.existsSync(poolFile)) return '';

    const doc = JSON.parse(fs.readFileSync(poolFile, 'utf-8'));
    for (const [provider, entries] of Object.entries(doc)) {
      for (const e of entries || []) {
        if (keyIdFor(provider, e.key) === keyId) {
          return e.key;
        }
      }
    }
  } catch {
    // 密钥池不可用
  }
  return '';
}

// ── Detection ─────────────────────────────────────────────────

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) {
    return _available;
  }

  // 检查环境变量或 ccSwitch 配置
  _available = !!(process.env.CPA_ENDPOINT || _configCache?.endpoint);
  return _available;
}

async function detectAsync(forceRefresh = false) {
  const config = await _loadConfig();
  _available = !!config.endpoint;
  return _available;
}

// ── Model Listing ─────────────────────────────────────────────

async function listModels() {
  const config = await _loadConfig();

  const fallback = [
    {
      id: config.model,
      name: config.model,
      isDefault: true,
      provider: 'cpa',
      description: 'CPA reverse proxy',
    },
  ];

  // 尝试从 CPA Server 获取模型列表
  try {
    const endpoint = config.endpoint.replace(/\/+$/, '');
    const url = `${endpoint}/v1/models`;

    const headers = {};
    if (config.key) {
      headers['Authorization'] = `Bearer ${config.key}`;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      return (data.data || []).map((m) => ({
        id: m.id,
        name: m.id,
        isDefault: m.id === config.model,
        provider: 'cpa',
        description: m.description || '',
      }));
    }
  } catch {
    // CPA Server 不可用，使用默认模型
  }

  return fallback;
}

// ── Generation ────────────────────────────────────────────────

async function generate(prompt, options = {}) {
  const config = await _loadConfig();
  const model = options.model || config.model;
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const url = `${endpoint}/v1/chat/completions`;

  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: !!options.onChunk,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
  };

  try {
    const headers = {
      'Content-Type': 'application/json',
      ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return buildFailure(`CPA request failed: ${response.status} ${errorText}`, {
        adapter: 'cpa',
        provider: 'CPA',
        attempts: [{ provider: 'CPA', success: false, error: `${response.status}` }],
      });
    }

    // 处理流式响应
    if (options.onChunk) {
      return await _handleStreaming(response, options, model);
    }

    // 非流式响应
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    return buildSuccess({
      text: content,
      model: data.model || model,
      tokenUsage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
      },
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      return buildFailure('CPA request timeout', {
        adapter: 'cpa',
        provider: 'CPA',
        attempts: [{ provider: 'CPA', success: false, error: 'timeout' }],
      });
    }

    return buildFailure(error.message, {
      adapter: 'cpa',
      provider: 'CPA',
      attempts: [{ provider: 'CPA', success: false, error: error.message }],
    });
  }
}

async function _handleStreaming(response, options, model) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') break;

        try {
          const chunk = JSON.parse(data);
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            options.onChunk({ type: 'text', text: content });
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }

  return buildSuccess({
    text: fullText,
    model,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
  });
}

// ── Status ────────────────────────────────────────────────────

async function getStatus() {
  const config = await _loadConfig();
  return {
    configured: !!config.endpoint,
    endpoint: config.endpoint,
    model: config.model,
    hasApiKey: !!config.key,
  };
}

// ── Runtime Diagnostics ───────────────────────────────────────

function getRuntimeDiagnostics(options = {}) {
  return _runtimeDiagnosticsStore.get(_runtimeDiagnostics, options);
}

// ── Cleanup ───────────────────────────────────────────────────

function destroy() {
  _available = null;
  _configCache = null;
}

// ── Exports ───────────────────────────────────────────────────

module.exports = {
  detect,
  detectAsync,
  listModels,
  generate,
  getStatus,
  getRuntimeDiagnostics,
  destroy,
  // Test seams
  _loadConfig,
  _resetState() {
    _available = null;
    _configCache = null;
  },
};
```

### 3.5 注册到 Gateway (aiGateway.js)

**修改位置**: `services/backend/src/services/gateway/aiGateway.js`

```javascript
// 在导入部分添加
const cpaAdapter = require('./adapters/cpaAdapter');

// 在 adapters 数组中注册（优先级 18，在 openclaw 之后）
this._adapters = [
  // ... 现有适配器
  { key: 'cpa', adapter: cpaAdapter, priority: 18, enabled: true },
];
```

---

## 4. 使用流程

### 4.1 添加 CPA Provider Card

```bash
# 方式一：通过 CLI
khy cc-switch add \
  --name="My CPA Server" \
  --endpoint="http://localhost:8317" \
  --protocol=openai \
  --apps=cpa

# 方式二：通过 provider-hub UI
# 1. 打开 provider-hub
# 2. 点击 "添加卡片"
# 3. 填写名称、端点
# 4. 选择协议: OpenAI
# 5. 勾选应用: CPA
```

### 4.2 配置 API Key

```bash
# 添加密钥到池
khy cc-switch key add \
  --provider=cpa \
  --key=your-api-key \
  --label="CPA Access Key"

# 绑定密钥到卡片
khy cc-switch update <card-id> --keyId=<key-id>
```

### 4.3 应用卡片到 CPA

```bash
# 激活卡片
khy cc-switch apply <card-id> cpa

# 或在 UI 中点击 "应用到 CPA"
```

### 4.4 使用 CPA

```bash
# 通过网关使用
khy ai "Hello, world!" --adapter=cpa

# 或在 REPL 中
khy
> /adapter cpa
> Hello, world!
```

---

## 5. CLI 命令（复用现有）

### 5.1 卡片管理（复用 cc-switch）

```bash
# 查看所有卡片
khy cc-switch list

# 添加 CPA 卡片
khy cc-switch add --name="CPA" --endpoint="http://localhost:8317" --protocol=openai --apps=cpa

# 应用到 CPA
khy cc-switch apply <card-id> cpa

# 查看 CPA 状态
khy cc-switch status cpa
```

### 5.2 密钥管理（复用 cc-switch）

```bash
# 添加密钥
khy cc-switch key add --provider=cpa --key=xxx

# 查看密钥（脱敏）
khy cc-switch key list
```

---

## 6. 测试策略

### 6.1 单元测试

位置: `services/backend/tests/adapters/cpaAdapter.test.js`

```javascript
describe('cpaAdapter', () => {
  describe('detect', () => {
    it('should detect from ccSwitch config', async () => {
      // Mock ccSwitch store
      const cpaAdapter = require('../../src/services/gateway/adapters/cpaAdapter');
      expect(await cpaAdapter.detectAsync()).toBe(true);
    });
  });

  describe('generate', () => {
    it('should call CPA endpoint', async () => {
      // Mock fetch
      const cpaAdapter = require('../../src/services/gateway/adapters/cpaAdapter');
      const result = await cpaAdapter.generate('test prompt');
      expect(result.success).toBe(true);
    });
  });
});
```

### 6.2 集成测试

```bash
# 启动 CPA Server
docker compose up -d

# 运行测试
npm run test:integration -- --grep="cpa"

# 清理
docker compose down
```

---

## 7. 文件清单

### 7.1 新建文件

| 文件 | 位置 | 说明 |
|------|------|------|
| `cpaWriter.js` | `services/backend/src/services/domain/config/ccSwitch/` | CPA 配置写入器 |
| `cpaAdapter.js` | `services/backend/src/services/gateway/adapters/` | CPA Gateway 适配器 |
| `cpaAdapter.test.js` | `services/backend/tests/adapters/` | 单元测试 |

### 7.2 修改文件

| 文件 | 修改内容 |
|------|----------|
| `constants.js` | 添加 `APPS.CPA` 和 `APP_LABELS[CPA]` |
| `appWriters.js` | 注册 `cpaWriter` 到应用写入器 |
| `aiGateway.js` | 注册 `cpaAdapter` 到适配器列表 |

### 7.3 复用文件（无需修改）

| 文件 | 复用内容 |
|------|----------|
| `providers.ts` | Card CRUD、Key Pool |
| `modelCatalog.ts` | 模型目录拉取 |
| `store.js` | ccSwitch 数据存储 |
| `routeResolver.js` | 活跃卡片路由 |

---

## 8. 优势总结

### 8.1 避免重复实现

| 功能 | 原方案 | 集成方案 |
|------|--------|----------|
| 存储 | 新建配置文件 | 复用 `cc_switch.json` |
| 密钥管理 | 新建密钥存储 | 复用 `api_keys.json` |
| CLI 命令 | 新建 `khy cpa` | 复用 `khy cc-switch` |
| UI 界面 | 新建管理界面 | 复用 provider-hub UI |
| 模型目录 | 新建拉取逻辑 | 复用 `modelCatalog.ts` |

### 8.2 一致性

- 与现有 Provider 管理方式一致
- 与现有 App Writer 模式一致
- 与现有 Gateway Adapter 模式一致

### 8.3 可维护性

- 单一数据源（cc_switch.json）
- 统一的配置管理
- 统一的审计日志

---

## 9. 路线图

### 9.1 Phase 1 - 基础集成 (v1.0)

- [ ] 注册 CPA 到 APPS 常量
- [ ] 实现 `cpaWriter.js`
- [ ] 注册到 `appWriters.js`
- [ ] 实现 `cpaAdapter.js`
- [ ] 注册到 `aiGateway.js`
- [ ] 单元测试

### 9.2 Phase 2 - 增强功能 (v1.1)

- [ ] CPA Server 状态监控
- [ ] 多 CPA 实例支持
- [ ] 集成测试
- [ ] 文档完善

### 9.3 Phase 3 - 高级特性 (v2.0)

- [ ] CPA 内置启动
- [ ] Web 管理面板集成
- [ ] 与 khyquant 交易系统集成

---

## 10. 参考资料

- [provider-hub 架构](../DESIGN-ARCH/[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.md)
- [ccSwitch 系统](../../17_AI协作预设包/skills/README.md)
- [CLIProxyAPI 官方文档](https://github.com/router-for-me/CLIProxyAPI)
- [AI 网关适配器协议架构](../DESIGN-ARCH/[DESIGN-ARCH-006] ai-gateway-适配器协议架构.md)

---

## 11. 变更记录

| 日期 | 版本 | 变更内容 | 作者 |
|------|------|----------|------|
| 2026-09-11 | 1.0 | 初始设计文档（与 provider-hub 集成版） | AI Assistant |

