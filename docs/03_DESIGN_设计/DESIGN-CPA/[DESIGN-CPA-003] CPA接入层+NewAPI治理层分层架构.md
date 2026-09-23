# [DESIGN-CPA-003] CPA 接入层 + New API 治理层分层架构

> **文档类型**: 架构设计文档  
> **创建日期**: 2026-09-11  
> **状态**: 待实施（等 provider-hub 完成后执行）  
> **核心思路**: CPA 做接入层 → New API 做治理出口

---

## 1. 概述

### 1.1 设计目标

构建一个分层的 AI API 网关架构：

| 层级 | 组件 | 职责 |
|------|------|------|
| **Layer 1: 接入层** | CPA (CLI Proxy API) | CLI/OAuth → OpenAI API 转换，多账号轮询 |
| **Layer 2: 治理层** | New API | 用户管理、令牌分发、计费、权限、渠道管理 |
| **Layer 3: 应用层** | KhyOS Gateway | 路由、适配器注册、provider-hub 集成 |

### 1.2 为什么分层

| 如果不分层 | 分层后 |
|------------|--------|
| CPA 直接暴露 → 无计费/权限 | New API 提供完整治理能力 |
| New API 直接对接上游 → 需要多个 API Key | CPA 统一管理 CLI/OAuth 账号 |
| 两套系统独立 → 配置分散 | 统一配置，分层管理 |

### 1.3 核心价值

```
CPA 解决: 如何把 CLI 订阅变成 API
New API 解决: 如何管理谁在用、用多少、怎么计费
KhyOS 解决: 如何让用户方便地使用
```

---

## 2. 架构设计

### 2.1 完整架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              用户层                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  khy CLI    │  │  Web UI     │  │  IDE 插件   │  │  API 调用   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
└─────────┼────────────────┼────────────────┼────────────────┼───────────┘
          │                │                │                │
          └────────────────┼────────────────┼────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Layer 3: KhyOS Gateway (应用层)                      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  provider-hub (Card System)                                      │  │
│  │  - cc_switch.json: Provider Card 配置                            │  │
│  │  - api_keys.json: 密钥池                                         │  │
│  │  - 新增 Card: New API Gateway (指向 New API)                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  AI Gateway (aiGateway.js)                                       │  │
│  │  - newApiAdapter.js: 读取 Card → 调用 New API                    │  │
│  │  - 优先级: 在 relay_api 之后                                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  端口: 动态 (dev server)                                                │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Layer 2: New API (治理层)                             │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  核心功能                                                         │  │
│  │  - 用户管理 (注册/登录/权限)                                      │  │
│  │  - 令牌分发 (API Key 生成/撤销)                                   │  │
│  │  - 渠道管理 (Channel → 指向 CPA)                                 │  │
│  │  - 模型聚合 (多渠道模型统一)                                      │  │
│  │  - 计费系统 (按量计费/套餐)                                       │  │
│  │  - 速率限制 (用户级/渠道级)                                       │  │
│  │  - Web 管理面板                                                   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  渠道配置示例                                                     │  │
│  │  Channel 1: CPA-Codex → http://localhost:8317 (CPA)             │  │
│  │  Channel 2: CPA-Claude → http://localhost:8317 (CPA)            │  │
│  │  Channel 3: OpenAI Direct → https://api.openai.com              │  │
│  │  Channel 4: DeepSeek → https://api.deepseek.com                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  端口: 3000                                                             │
│  数据库: SQLite / MySQL / PostgreSQL                                     │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Layer 1: CPA (接入层)                                 │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  核心功能                                                         │  │
│  │  - CLI/OAuth → OpenAI API 转换                                   │  │
│  │  - 多账号轮询 (Round-robin / Fill-first)                         │  │
│  │  - 凭据生命周期管理 (OAuth 刷新/续期)                            │  │
│  │  - 协议转换 (Anthropic/Gemini → OpenAI)                          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  支持的上游                                                       │  │
│  │  - Codex (OpenAI) - 多账号轮询                                   │  │
│  │  - Claude Code (Anthropic) - OAuth 登录                          │  │
│  │  - Gemini CLI (Google) - API Key / OAuth                         │  │
│  │  - Qwen Code (Alibaba) - API Key                                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  端口: 8317                                                             │
│  配置: config.yaml                                                      │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Upstream AI Providers                                 │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │  Codex  │  │ Claude  │  │ Gemini  │  │  Qwen   │  │  ...    │    │
│  │(OpenAI) │  │(Anthropic)│ │(Google) │  │(Alibaba)│  │         │    │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流详解

```
[用户请求]
    │
    ├─→ khy ai "Hello" --adapter=newapi
    │
    ▼
[KhyOS Gateway]
    │
    ├─→ 读取 cc_switch.json: Card { baseUrl: "http://localhost:3000" }
    ├─→ newApiAdapter.generate(prompt, options)
    │
    ▼
[New API - http://localhost:3000]
    │
    ├─→ 验证令牌 (API Key)
    ├─→ 检查权限 (用户组/模型权限)
    ├─→ 检查配额 (余额/速率限制)
    ├─→ 路由到渠道
    │
    ├─→ Channel: CPA-Codex (type=openai, base_url=http://localhost:8317)
    │
    ▼
[CPA - http://localhost:8317]
    │
    ├─→ 接收 OpenAI 格式请求
    ├─→ 选择账号 (Round-robin / Fill-first)
    ├─→ 转换为 CLI/OAuth 调用
    │
    ▼
[Upstream Provider]
    │
    ├─→ Codex API (使用 OAuth token)
    │
    ▼
[响应返回]
    │
    ├─→ CPA: 转换为 OpenAI 格式
    ├─→ New API: 记录用量、扣费
    ├─→ KhyOS: 返回给用户
    │
    ▼
[用户看到结果]
```

---

## 3. 配置设计

### 3.1 CPA 配置 (config.yaml)

```yaml
# CPA Server 配置
server:
  port: 8317
  host: 127.0.0.1

# API Keys (用于 New API 连接)
api-keys:
  - your-newapi-secret-key

# 上游 Provider 配置
providers:
  # Codex 多账号
  - name: codex
    type: openai
    accounts:
      - email: user1@example.com
        token: xxx
      - email: user2@example.com
        token: yyy

  # Claude Code OAuth
  - name: claude
    type: anthropic
    oauth:
      client_id: xxx
      client_secret: yyy

  # Gemini CLI
  - name: gemini
    type: gemini
    api_keys:
      - key1
      - key2

# 负载均衡策略
load_balancing:
  strategy: fill-first  # 或 round-robin
  health_check_interval: 60
```

### 3.2 New API 配置 (环境变量)

```bash
# 数据库 (推荐 MySQL/PostgreSQL 生产环境)
SQL_DSN=root:password@tcp(localhost:3306)/new-api
# 或 SQLite (开发环境)
# SQL_DSN=  # 默认使用 one-api.db

# Redis (可选，用于缓存)
REDIS_CONN_STRING=redis://localhost:6379

# 会话密钥
SESSION_SECRET=your-random-session-secret

# 加密密钥
CRYPTO_SECRET=your-random-crypto-secret

# 服务端口
PORT=3000

# 时区
TZ=Asia/Shanghai
```

### 3.3 New API 渠道配置 (通过 Web 面板添加)

```
渠道 1: CPA-Codex
├── 渠道类型: OpenAI
├── 基础 URL: http://localhost:8317
├── 密钥: your-newapi-secret-key
├── 模型: gpt-4, gpt-4o, gpt-4-turbo
└── 其他: codex

渠道 2: CPA-Claude
├── 渠道类型: OpenAI
├── 基础 URL: http://localhost:8317
├── 密钥: your-newapi-secret-key
├── 模型: claude-3-opus, claude-3-sonnet
└── 其他: claude

渠道 3: OpenAI Direct
├── 渠道类型: OpenAI
├── 基础 URL: https://api.openai.com
├── 密钥: sk-xxx
└── 模型: gpt-4, gpt-4o

渠道 4: DeepSeek
├── 渠道类型: OpenAI
├── 基础 URL: https://api.deepseek.com
├── 密钥: sk-xxx
└── 模型: deepseek-chat, deepseek-coder
```

### 3.4 KhyOS Card 配置 (provider-hub)

```json
{
  "cards": [
    {
      "id": "c_newapi_gateway",
      "name": "New API Gateway",
      "baseUrl": "http://localhost:3000",
      "protocol": "openai",
      "apps": ["newapi"],
      "models": ["gpt-4", "gpt-4o", "claude-3-opus", "claude-3-sonnet"],
      "defaultModel": "gpt-4",
      "enabled": true
    }
  ],
  "active": {
    "newapi": "c_newapi_gateway"
  }
}
```

---

## 4. 实现步骤

### 4.1 Phase 1: 基础设施部署

#### 步骤 1.1: 部署 CPA Server

```bash
# 1. 克隆 CPA
git clone https://github.com/router-for-me/CLIProxyAPI.git
cd CLIProxyAPI

# 2. 配置
cp config.example.yaml config.yaml
# 编辑 config.yaml 添加账号

# 3. 启动
docker compose up -d

# 4. 验证
curl http://localhost:8317/v1/models
```

#### 步骤 1.2: 部署 New API

```bash
# 1. 克隆 New API
git clone https://github.com/Calcium-Ion/new-api.git
cd new-api

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 配置数据库等

# 3. 启动
docker compose up -d

# 4. 访问管理面板
# http://localhost:3000
# 默认账号: root, 密码: 123456
```

#### 步骤 1.3: 配置 New API 渠道

1. 登录 New API 管理面板
2. 进入「渠道管理」→「添加渠道」
3. 添加 CPA 渠道:
   - 名称: CPA-Codex
   - 类型: OpenAI
   - 基础 URL: `http://localhost:8317`
   - 密钥: CPA 的 api-key
   - 模型: gpt-4, gpt-4o
4. 重复添加其他 CPA 渠道 (Claude, Gemini 等)
5. 添加其他直连渠道 (OpenAI, DeepSeek 等)

### 4.2 Phase 2: KhyOS 集成 (等 provider-hub 完成后)

#### 步骤 2.1: 注册 newapi 到 APPS 常量

**修改文件**: `services/backend/src/services/domain/config/ccSwitch/constants.js`

```javascript
const APPS = Object.freeze({
  // ... 现有 apps
  NEWAPI: 'newapi',  // 新增
});

const APP_LABELS = Object.freeze({
  // ... 现有 labels
  [APPS.NEWAPI]: 'New API Gateway',  // 新增
});
```

#### 步骤 2.2: 创建 newApiWriter.js

**新建文件**: `services/backend/src/services/domain/config/ccSwitch/newApiWriter.js`

```javascript
/**
 * newApiWriter — New API 配置写入器
 *
 * 职责：
 *   - 应用 Provider Card 到 New API 配置
 *   - 探测 New API 运行状态
 *   - 生成 New API 配置
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { APPS } = require('./constants.js');

const NEWAPI_APP = APPS.NEWAPI;

/**
 * 应用卡片到 New API 配置
 */
async function applyCardToNewApi(card, opts = {}) {
  try {
    const endpoint = card.baseUrl;
    const key = opts.key || '';

    // 生成 New API 环境变量配置
    const envConfig = {
      NEWAPI_ENDPOINT: endpoint,
      NEWAPI_API_KEY: key,
    };

    // 写入到配置目录
    const configDir = _findNewApiConfigDir();
    if (configDir) {
      await _writeEnvFile(configDir, envConfig);
    }

    // 设置进程环境变量
    Object.assign(process.env, envConfig);

    return {
      success: true,
      detail: {
        endpoint,
        hasKey: !!key,
        configDir,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `New API 配置写入失败: ${error.message}`,
    };
  }
}

/**
 * 探测 New API 配置
 */
function detectNewApiConfig(app) {
  if (app !== NEWAPI_APP) {
    return { success: false, providers: [], error: `不支持的应用: ${app}` };
  }

  const providers = [];

  // 从环境变量探测
  const endpoint = process.env.NEWAPI_ENDPOINT;
  if (endpoint) {
    providers.push({
      id: 'env',
      name: 'Environment Config',
      endpoint,
      kind: 'openai',
    });
  }

  // 从配置文件探测
  const configPath = _findNewApiConfigFile();
  if (configPath) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      if (config && config.endpoint) {
        providers.push({
          id: 'file',
          name: 'Config File',
          endpoint: config.endpoint,
          kind: 'openai',
        });
      }
    } catch {
      // 配置文件读取失败
    }
  }

  return { success: true, providers };
}

/**
 * Preflight 校验
 */
function preflightCardForNewApi(card, app) {
  if (app !== NEWAPI_APP) {
    return { ok: false, reason: `不支持的应用: ${app}` };
  }

  if (card.protocol !== 'openai') {
    return {
      ok: false,
      reason: `New API 仅支持 OpenAI 协议，当前协议: ${card.protocol}`,
    };
  }

  if (!card.baseUrl) {
    return { ok: false, reason: 'New API 端点不能为空' };
  }

  return { ok: true };
}

// ── 内部辅助函数 ─────────────────────────────────────────────

function _findNewApiConfigDir() {
  const candidates = [
    process.env.NEWAPI_CONFIG_DIR,
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.new-api'),
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

function _findNewApiConfigFile() {
  const dir = _findNewApiConfigDir();
  if (!dir) return null;

  const candidates = ['.env', 'config.json'];
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

async function _writeEnvFile(dir, config) {
  const envFile = path.join(dir, '.env');
  const lines = Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.writeFileSync(envFile, lines, 'utf-8');
}

module.exports = {
  applyCardToNewApi,
  detectNewApiConfig,
  preflightCardForNewApi,
};
```

#### 步骤 2.3: 注册到 appWriters.js

**修改文件**: `services/backend/src/services/domain/config/ccSwitch/appWriters.js`

```javascript
// 在导入部分添加
const newApiWriter = require('./newApiWriter.js');

// 在 applyCardToApp 函数中添加
async function applyCardToApp(card, app, opts = {}) {
  // ... 现有代码

  // New API 应用
  if (app === APPS.NEWAPI) {
    return newApiWriter.applyCardToNewApi(card, opts);
  }

  // ... 其他应用
}

// 在 detectCardInApp 函数中添加
function detectCardInApp(app) {
  // ... 现有代码

  // New API 应用
  if (app === APPS.NEWAPI) {
    return newApiWriter.detectNewApiConfig(app);
  }

  // ... 其他应用
}

// 在 preflightCardForApp 函数中添加
function preflightCardForApp(card, app) {
  // ... 现有代码

  // New API 应用
  if (app === APPS.NEWAPI) {
    return newApiWriter.preflightCardForNewApi(card, app);
  }

  // ... 其他应用
}
```

#### 步骤 2.4: 创建 newApiAdapter.js

**新建文件**: `services/backend/src/services/gateway/adapters/newApiAdapter.js`

```javascript
/**
 * New API Adapter — 从 ccSwitch 读取活跃卡片，调用 New API Gateway
 *
 * 设计原则：
 *   - 复用 ccSwitch Card 系统获取配置
 *   - 使用 OpenAI 协议调用 New API
 *   - New API 负责治理（计费/权限/限流）
 */
'use strict';

const { PRIMARY: MODELS } = require('../../../constants/models');
const { createAdapterRuntimeDiagnosticsStore } = require('../runtimeDiagnosticsStore');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { isAbortLikeError } = require('./_abortHelpers');

const DEFAULT_MODEL = MODELS.newapi || 'gpt-4';
const TIMEOUT_MS = parseInt(process.env.NEWAPI_TIMEOUT_MS || '120000', 10);

const _runtimeDiagnosticsStore = createAdapterRuntimeDiagnosticsStore('newapi');
let _runtimeDiagnostics = _runtimeDiagnosticsStore.createEmptyDiagnostic();

let _available = null;
let _configCache = null;

// ── 从 ccSwitch 读取配置 ─────────────────────────────────────

async function _loadConfig() {
  if (_configCache) return _configCache;

  try {
    const store = require('../../domain/config/ccSwitch/store.js');
    const { APPS } = require('../../domain/config/ccSwitch/constants.js');

    const { cards, active } = store.listCards();
    const activeCardId = active[APPS.NEWAPI];

    if (activeCardId) {
      const card = cards.find((c) => c.id === activeCardId);
      if (card) {
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
    endpoint: process.env.NEWAPI_ENDPOINT || 'http://localhost:3000',
    key: process.env.NEWAPI_API_KEY || '',
    model: process.env.NEWAPI_MODEL || DEFAULT_MODEL,
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

  _available = !!(process.env.NEWAPI_ENDPOINT || _configCache?.endpoint);
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
      provider: 'newapi',
      description: 'New API Gateway',
    },
  ];

  // 尝试从 New API 获取模型列表
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
        provider: 'newapi',
        description: m.description || '',
      }));
    }
  } catch {
    // New API 不可用
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
      return buildFailure(`New API request failed: ${response.status} ${errorText}`, {
        adapter: 'newapi',
        provider: 'New API',
        attempts: [{ provider: 'New API', success: false, error: `${response.status}` }],
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
      return buildFailure('New API request timeout', {
        adapter: 'newapi',
        provider: 'New API',
        attempts: [{ provider: 'New API', success: false, error: 'timeout' }],
      });
    }

    return buildFailure(error.message, {
      adapter: 'newapi',
      provider: 'New API',
      attempts: [{ provider: 'New API', success: false, error: error.message }],
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
  _loadConfig,
  _resetState() {
    _available = null;
    _configCache = null;
  },
};
```

#### 步骤 2.5: 注册到 aiGateway.js

**修改文件**: `services/backend/src/services/gateway/aiGateway.js`

```javascript
// 在导入部分添加
const newApiAdapter = require('./adapters/newApiAdapter');

// 在 adapters 数组中注册（优先级 19，在 cpa 之后）
this._adapters = [
  // ... 现有适配器
  { key: 'newapi', adapter: newApiAdapter, priority: 19, enabled: true },
];
```

### 4.3 Phase 3: 使用和测试

#### 步骤 3.1: 添加 New API Card

```bash
# 通过 CLI
khy cc-switch add \
  --name="New API Gateway" \
  --endpoint="http://localhost:3000" \
  --protocol=openai \
  --apps=newapi

# 或通过 provider-hub UI
```

#### 步骤 3.2: 配置 API Key (New API 的令牌)

```bash
# 在 New API 管理面板创建令牌
# 或通过 API
curl -X POST http://localhost:3000/api/token/ \
  -H "Authorization: Bearer root-token" \
  -d '{"name": "khy-token", "expired_at": -1}'
```

#### 步骤 3.3: 绑定密钥到 Card

```bash
# 添加密钥到池
khy cc-switch key add \
  --provider=newapi \
  --key=your-newapi-token \
  --label="New API Token"

# 绑定密钥到卡片
khy cc-switch update <card-id> --keyId=<key-id>
```

#### 步骤 3.4: 激活卡片

```bash
khy cc-switch apply <card-id> newapi
```

#### 步骤 3.5: 使用

```bash
# 通过网关使用
khy ai "Hello, world!" --adapter=newapi

# 或在 REPL 中
khy
> /adapter newapi
> Hello, world!
```

---

## 5. 验证清单

### 5.1 基础设施验证

```bash
# 1. CPA 运行状态
curl http://localhost:8317/v1/models

# 2. New API 运行状态
curl http://localhost:3000/api/status

# 3. New API → CPA 连通性
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "test"}]}'
```

### 5.2 KhyOS 集成验证

```bash
# 1. Card 状态
khy cc-switch list

# 2. New API 适配器状态
khy gateway status newapi

# 3. 端到端测试
khy ai "Hello" --adapter=newapi
```

### 5.3 治理功能验证

```bash
# 1. 用户管理 (New API 面板)
# http://localhost:3000 → 用户管理

# 2. 令牌管理
# http://localhost:3000 → 令牌管理

# 3. 用量统计
# http://localhost:3000 → 数据看板

# 4. 渠道状态
# http://localhost:3000 → 渠道管理
```

---

## 6. 文件清单

### 6.1 新建文件

| 文件 | 位置 | 说明 |
|------|------|------|
| `newApiWriter.js` | `services/backend/src/services/domain/config/ccSwitch/` | New API 配置写入器 |
| `newApiAdapter.js` | `services/backend/src/services/gateway/adapters/` | New API Gateway 适配器 |

### 6.2 修改文件

| 文件 | 修改内容 |
|------|----------|
| `constants.js` | 添加 `APPS.NEWAPI` 和 `APP_LABELS[NEWAPI]` |
| `appWriters.js` | 注册 `newApiWriter` |
| `aiGateway.js` | 注册 `newApiAdapter` |

### 6.3 复用文件（无需修改）

| 文件 | 复用内容 |
|------|----------|
| `providers.ts` | Card CRUD、Key Pool |
| `modelCatalog.ts` | 模型目录拉取 |
| `store.js` | ccSwitch 数据存储 |
| `ccSwitch.js` | CLI 命令 |

---

## 7. 运维指南

### 7.1 启动顺序

```
1. 启动 CPA Server (port 8317)
   ↓
2. 启动 New API (port 3000)
   ↓
3. 启动 KhyOS Gateway
   ↓
4. 验证连通性
```

### 7.2 停止顺序

```
1. 停止 KhyOS Gateway
   ↓
2. 停止 New API
   ↓
3. 停止 CPA Server
```

### 7.3 故障排查

| 问题 | 排查步骤 |
|------|----------|
| CPA 不可用 | `curl http://localhost:8317/v1/models` |
| New API 不可用 | `curl http://localhost:3000/api/status` |
| KhyOS 连接失败 | `khy cc-switch list` 检查 Card 配置 |
| 401 错误 | 检查令牌配置 |
| 429 错误 | 检查速率限制配置 |
| 500 错误 | 查看 New API / CPA 日志 |

### 7.4 日志位置

| 组件 | 日志位置 |
|------|----------|
| CPA | `docker logs cli-proxy-api` |
| New API | `docker logs new-api` 或 `./logs/` |
| KhyOS | 终端输出 |

---

## 8. 路线图

### 8.1 Phase 1: 基础设施 (当前)

- [ ] 部署 CPA Server
- [ ] 部署 New API
- [ ] 配置 New API 渠道指向 CPA
- [ ] 验证端到端连通性

### 8.2 Phase 2: KhyOS 集成 (等 provider-hub 完成后)

- [ ] 注册 `newapi` 到 APPS 常量
- [ ] 实现 `newApiWriter.js`
- [ ] 注册到 `appWriters.js`
- [ ] 实现 `newApiAdapter.js`
- [ ] 注册到 `aiGateway.js`
- [ ] 单元测试

### 8.3 Phase 3: 增强功能

- [ ] CPA 内置启动脚本
- [ ] New API 自动配置脚本
- [ ] 监控告警集成
- [ ] 文档完善

---

## 9. 参考资料

- [CLIProxyAPI 官方文档](https://github.com/router-for-me/CLIProxyAPI)
- [New API 官方文档](https://doc.newapi.pro)
- [provider-hub 架构](../DESIGN-ARCH/[DESIGN-ARCH-094] Provider卡片枢纽（CardHub）GUI设计规范.md)
- [ccSwitch 系统](../../17_AI协作预设包/skills/README.md)

---

## 10. 变更记录

| 日期 | 版本 | 变更内容 | 作者 |
|------|------|----------|------|
| 2026-09-11 | 1.0 | 初始设计文档（CPA + New API 分层架构） | AI Assistant |

