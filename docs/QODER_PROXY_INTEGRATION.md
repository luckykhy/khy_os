# Qoder 代理接入 khy 网关说明

> 本文档说明如何将 Qoder 额度通过 qoder-proxy 本地反代接入 khy AI 网关。
> khy 已内置完整接入能力，无需开发新代码，仅需配置启用。

---

## 一、架构概览

```
khy AI 网关
  ├── qoder 池 (OpenAI 兼容线)
  │     POST http://127.0.0.1:3000/v1/chat/completions
  │     模型路由: api:qoder:<model-id>
  │
  └── qoder-anthropic 池 (Anthropic 兼容线)
        POST http://127.0.0.1:3000/v1/messages
        模型路由: api:qoder-anthropic:<model-id>
              │
              ▼
       qoder-proxy (本地 HTTP 反代, 默认 127.0.0.1:3000)
              │
              ▼
       qoder CLI (qodercli) → 实际 AI 模型
```

qoder-proxy 是一个独立的本地 HTTP 反向代理服务，把 qoder CLI 包装成同时兼容 OpenAI（`/v1/chat/completions`）和 Anthropic（`/v1/messages`）两种协议的接口。khy 网关通过注册两个自定义 Provider 池来消费这两条线。

### 核心文件

| 文件 | 职责 |
|------|------|
| `services/backend/src/services/gateway/qoderProxyModels.js` | 模型目录、opt-in 门控、端点派生（单一真源） |
| `services/backend/src/services/customProviderRegistrar.js` | `ensureBuiltinQoder()` — 将 Qoder 注册为两个自定义 Provider |
| `services/backend/src/services/flagRegistry.js` | `KHY_QODER_PROXY` flag 定义（opt-in，默认关） |
| `services/backend/src/cli/handlers/init.js` | `khy init` 时自动 seed（opt-in 未开则静默跳过） |
| `services/backend/src/services/gateway/aiGatewayRoutingMethods.js` | 网关启动时的 seed 调用点 |

### 设计原则

- **Opt-in 默认关**：qoder-proxy 是本地服务，未运行时 seed 出来的模型会变成 `ECONNREFUSED` 死条目。只有用户显式启用才注册。
- **单一根派生**：两条线的端点从同一个 root 派生，避免 `/v1/v1/messages` 类拼接错误。
- **零硬编码密钥**：`QODER_DUMMY_KEY = 'qoder-local'` 是本地哨兵（反代默认忽略鉴权头），非凭据；真实 key 只在 runtime env。

---

## 二、可用模型

共 13 个模型，默认 `qoder-cn`。数据来源对齐 qoder-proxy 的 `clean/models.js`。

| 模型 ID | 说明 |
|---------|------|
| `qoder-cn` | 默认模型，国内路由 |
| `auto` | 自动选择最优模型 |
| `qwen3.7-max` | 通义千问 3.7 Max |
| `qwen3.7-max-effort-low` | 通义千问 3.7 Max（低推理） |
| `qwen3.7-max-effort-medium` | 通义千问 3.7 Max（中推理） |
| `qwen3.7-max-effort-high` | 通义千问 3.7 Max（高推理） |
| `qwen3.7-max-effort-max` | 通义千问 3.7 Max（最大推理） |
| `glm-5.1` | 智谱 GLM 5.1 |
| `kimi-k2.6` | Kimi K2.6 |
| `qwen3.6-plus` | 通义千问 3.6 Plus |
| `qwen3.6-flash` | 通义千问 3.6 Flash |
| `deepseek-v4-pro` | DeepSeek V4 Pro |
| `deepseek-v4-flash` | DeepSeek V4 Flash |

> `effort` 后缀（`qwen3.7-max-effort-{low,medium,high,max}`）由 qoder-proxy 服务端 `resolveModelRoute` 剥离并映射为 `reasoningEffort`，khy 只需原样发送模型 ID，无需额外透传参数。

---

## 三、启用步骤

### 前提：qoder-proxy 服务在本机运行

确认 qoder-proxy 在 `127.0.0.1:3000` 上监听：

```bash
# 测试连通性
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn","messages":[{"role":"user","content":"hi"}]}'
```

如果端口不同，后续用 `QODER_PROXY_ENDPOINT` 指定。

### 方式 A：最简启用（推荐）

在 `.env` 中加一行：

```bash
KHY_QODER_PROXY=true
```

然后重新初始化网关：

```bash
khy init
# 输出中应看到: 已配置 Qoder 反代 Provider (OpenAI + Anthropic)
```

### 方式 B：指定端点和密钥

如果 qoder-proxy 不在默认端口，或需要鉴权：

```bash
QODER_PROXY_ENDPOINT=http://127.0.0.1:3000
QODER_PROXY_API_KEY=<your-key>
```

设置后运行 `khy init` 或重启 khy 即可生效。

> `QODER_PROXY_API_KEY` 非必填——qoder-proxy 默认不校验鉴权头，khy 会用本地哨兵 `qoder-local` 占位。

### 方式 C：通过 `khy gateway config` 交互配置

```bash
khy gateway config
# 选择「添加自定义 Provider」
# Provider ID 输入: qoder
# Base URL 输入: http://127.0.0.1:3000/v1
# 默认模型输入: qoder-cn
# 模型列表输入: qoder-cn,auto,qwen3.7-max,glm-5.1,kimi-k2.6,...
```

> **注意**：方式 C 只注册 OpenAI 线，不注册 Anthropic 线。方式 A/B 会同时注册两条线。

### Opt-in 判定逻辑

```
qoderOptedIn = KHY_QODER_PROXY 为 'true'/'1'
             OR QODER_PROXY_ENDPOINT 非空
             OR QODER_PROXY_API_KEY 非空
```

任一条件满足即视为用户已表态启用。

---

## 四、启用后的效果

### 注册的 Provider 池

| 池键 | 显示名 | 协议 | 端点 | 默认模型 |
|------|--------|------|------|---------|
| `qoder` | Qoder | OpenAI | `http://127.0.0.1:3000/v1` | `qoder-cn` |
| `qoder-anthropic` | Qoder (Anthropic) | Anthropic | `http://127.0.0.1:3000` | `qoder-cn` |

### 写入 .env 的路由配置

```json
// GATEWAY_API_POOL_SERVICE_MAP（新增 qoder 两条线）
{
  "qoder": "openai",
  "qoder-anthropic": "anthropic"
}

// GATEWAY_API_POOL_DEFAULT_MODEL_MAP
{
  "qoder": "qoder-cn",
  "qoder-anthropic": "qoder-cn"
}

// PROXY_MODEL_ROUTE_MAP（每个模型一条，strict 路由）
{
  "qoder-cn": {"target": "api:qoder:qoder-cn", "strict": true},
  "auto": {"target": "api:qoder:auto", "strict": true},
  "qwen3.7-max": {"target": "api:qoder:qwen3.7-max", "strict": true},
  // ... 其余模型同理
}
```

---

## 五、使用方式

### 设为默认 Provider

```bash
# 交互式配置
khy gateway config
# 选择「高级: API 池默认 provider (GATEWAY_API_POOL_PROVIDER)」→ 选择 qoder

# 或直接在 .env 中设置
GATEWAY_API_POOL_PROVIDER=qoder
GATEWAY_PREFERRED_MODEL=api:qoder:qoder-cn
```

### 对话

```bash
# 使用默认模型
khy chat "你好"

# 指定模型
khy chat --model qwen3.7-max "分析这段代码的性能瓶颈"

# 使用 effort 变体（高推理深度）
khy chat --model qwen3.7-max-effort-high "设计一个高并发微服务架构"

# 使用 DeepSeek
khy chat --model deepseek-v4-pro "写一个 Redis 分布式锁的实现"
```

### 查看网关状态

```bash
khy gateway status
# 应显示 qoder 和 qoder-anthropic 两个池及其模型列表
```

### 查看可用模型

```bash
khy gateway models
# 或
khy model list
```

---

## 六、端点派生规则

khy 从**单一根**派生两条线的端点，避免拼接错误：

```
root = QODER_PROXY_ENDPOINT 去尾斜杠 + 去尾部 /v1

OpenAI 线端点   = root + "/v1"     ← callOpenAI 内部会归一化
Anthropic 线端点 = root              ← callAnthropic 自接 /v1/messages
```

### 端点示例

| `QODER_PROXY_ENDPOINT` 值 | OpenAI 线端点 | Anthropic 线端点 |
|---------------------------|---------------|------------------|
| `http://127.0.0.1:3000` | `http://127.0.0.1:3000/v1` | `http://127.0.0.1:3000` |
| `http://127.0.0.1:3000/v1` | `http://127.0.0.1:3000/v1` | `http://127.0.0.1:3000` |
| `http://127.0.0.1:3000/v1/` | `http://127.0.0.1:3000/v1` | `http://127.0.0.1:3000` |
| `http://localhost:8080` | `http://localhost:8080/v1` | `http://localhost:8080` |

> **关键**：Anthropic 线端点不能带 `/v1`，否则 `callAnthropic` 会拼成 `/v1/v1/messages` 导致 404。派生逻辑已自动处理此问题。

---

## 七、排障

| 症状 | 原因 | 解决 |
|------|------|------|
| `khy init` 无 Qoder 相关输出 | opt-in 未开 | 确认 `.env` 中 `KHY_QODER_PROXY=true`，重新运行 `khy init` |
| 模型列表中无 Qoder 模型 | seed 未执行或失败 | `khy init --force` 重新初始化 |
| 调用报 `ECONNREFUSED 127.0.0.1:3000` | qoder-proxy 未运行 | 启动本地 qoder-proxy 服务 |
| 调用报 `/v1/v1/messages` 404 | 端点配置错误 | 确认 `QODER_PROXY_ENDPOINT` 值正确（派生逻辑会自动去 `/v1`） |
| Anthropic 线调用失败 | qoder-proxy 版本不支持 | 确认 qoder-proxy 支持 `/v1/messages` 端点 |
| `gateway status` 显示 Qoder 但调用超时 | qoder CLI 凭证过期 | 检查 qoder CLI 登录状态，重新认证 |
| 重复 `khy init` 后模型重复 | 幂等性保护未生效 | `khy init --force` 强制重建，或手动编辑 `custom_providers.json` |

### 验证清单

```bash
# 1. 确认 opt-in 已开
grep KHY_QODER_PROXY .env
# 期望: KHY_QODER_PROXY=true

# 2. 确认 qoder-proxy 可达
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn","messages":[{"role":"user","content":"ping"}]}' | head -c 200

# 3. 确认 Provider 已注册
khy gateway status | grep -i qoder
# 期望: qoder 和 qoder-anthropic 两个池

# 4. 确认模型可用
khy gateway models | grep qoder
# 期望: 13 个模型 ID

# 5. 测试对话
khy chat --model qoder-cn "你好"
```

---

## 八、安全说明

| 项目 | 说明 |
|------|------|
| `QODER_DUMMY_KEY = 'qoder-local'` | 本地哨兵值，**不是密钥**。qoder-proxy 默认不校验鉴权头，此值仅让池条目可被 `pick()` 选中。 |
| `QODER_PROXY_API_KEY` | 真实 API key（如果需要），通过环境变量传入，不写入源码、不落盘到 `custom_providers.json`。 |
| `strict: true` 路由 | 所有 Qoder 模型路由标记为 `strict`，不会回退到其他 Provider，确保额度消耗可追踪。 |
| 本地回环 | 默认端点 `127.0.0.1:3000` 仅本机可访问，不暴露到网络。 |

---

## 九、关闭 Qoder 接入

如需关闭：

```bash
# 方式 1：移除 .env 中的启用变量
# 删除或注释掉 KHY_QODER_PROXY、QODER_PROXY_ENDPOINT、QODER_PROXY_API_KEY

# 方式 2：显式关闭
KHY_QODER_PROXY=false

# 然后清理已注册的 Provider
khy gateway config
# 选择「移除自定义 Provider」→ 选择 qoder 和 qoder-anthropic
```

关闭后重启 khy，Qoder 模型不再出现在模型列表中。

---

## 十、附录：源码定位

| 功能点 | 文件 | 关键函数/常量 |
|--------|------|-------------|
| 模型目录 | `qoderProxyModels.js` | `QODER_MODELS` (L50) |
| Opt-in 门控 | `qoderProxyModels.js` | `qoderOptedIn()` (L112) |
| 端点派生 | `qoderProxyModels.js` | `qoderProxyRoot()` (L126) |
| 池注册规格 | `qoderProxyModels.js` | `qoderProxySpecs()` (L176) |
| Provider 注册 | `customProviderRegistrar.js` | `ensureBuiltinQoder()` (L320) |
| Flag 定义 | `flagRegistry.js` | `KHY_QODER_PROXY` (L2060) |
| Init 调用点 | `cli/handlers/init.js` | L716 |
| 网关启动 seed | `aiGatewayRoutingMethods.js` | L1090 |
