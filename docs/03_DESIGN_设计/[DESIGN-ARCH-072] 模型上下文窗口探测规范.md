# [DESIGN-ARCH-072] 模型上下文窗口探测规范

> 版本：v1.0  
> 状态：实施中  
> 关联：contextWindowDefaults.js / aiGatewayRoutingMethods.js / upstreamModelProbe.js / aiGatewayGenerateMethod.js

---

## 1. 问题背景

此前所有模型的上下文窗口统一回退为 128K（`UNKNOWN_MODEL_CONTEXT_WINDOW`），导致：
- 小上下文模型（32K）被高估 → 请求超限失败
- 大上下文模型（512K/1M）被低估 → 工具结果预算过小、压缩过早触发
- 上下文溢出后无自动压缩 → 任务中断

## 2. 探测优先级链（六级，首个命中即停）

```
┌─────────────────────────────────────────────────────────┐
│ Level 1: 运行时错误提取（最可信）                         │
│   来源：API context_length 错误消息                       │
│   时机：请求超限时自动提取并缓存                          │
│   示例："maximum context length is 512000 tokens"         │
│   精度：精确（API 返回的真实限制）                         │
├─────────────────────────────────────────────────────────┤
│ Level 2: API 模型列表上报                                │
│   来源：/v1/models 响应的 context_window 字段             │
│   时机：listModels() 探测时缓存                           │
│   字段：context_window / context_length / max_context     │
│   精度：精确（API 主动上报）                               │
├─────────────────────────────────────────────────────────┤
│ Level 3: 实际 API 请求探测                               │
│   来源：probeContextWindow() 发送最小请求                  │
│   方法：                                                  │
│     3a. 发送 1 token 请求，从响应 headers/body 提取       │
│     3b. 发送极大 max_tokens 触发错误，从错误消息提取      │
│   时机：getModelContextWindowAsync() 中 listModels 失败后 │
│   精度：精确（API 实际响应）                               │
├─────────────────────────────────────────────────────────┤
│ Level 4: 环境变量覆盖                                    │
│   来源：KHY_CONTEXT_WINDOW 环境变量                       │
│   时机：getModelContextWindow() 同步读取                   │
│   精度：用户手动配置，可信                                 │
├─────────────────────────────────────────────────────────┤
│ Level 5: 后台异步探测                                    │
│   来源：getModelContextWindowAsync() 等待 adapter 探测    │
│   时机：工具循环启动时主动触发                             │
│   超时：3秒                                               │
│   精度：取决于 adapter 响应                               │
├─────────────────────────────────────────────────────────┤
│ Level 6: 保守回退                                        │
│   来源：UNKNOWN_MODEL_CONTEXT_WINDOW = 128000             │
│   时机：所有探测均失败时                                   │
│   原则：宁可写小不可写大                                   │
│   精度：保守估计                                          │
└─────────────────────────────────────────────────────────┘

禁止：不使用模型名模式匹配推断上下文窗口。值必须来自 API 实际响应。
```

## 3. 探测时机与缓存策略

### 3.1 核心难点

| 难点 | 矛盾 | 解法 |
|------|------|------|
| **首请求延迟** | 工具循环启动时需要上下文窗口，但探测需要 3-5 秒 | 首请求用默认值，探测结果下轮生效 |
| **重复探测** | 每次请求都探测浪费资源 | TTL 缓存 + 并发去重 |
| **缓存过期** | API 可能更新上下文窗口 | stale-while-revalidate（返回旧值+后台刷新） |
| **错误恢复** | context_length 错误说明窗口不对 | 错误即探测，即时更新缓存 |

### 3.2 何时探测（触发条件）

| 触发 | 时机 | 级别 | 阻塞？ | TTL |
|------|------|------|--------|-----|
| **工具循环启动** | 首次调用该模型 | 4→2→3 | **阻塞 3 秒** | 4h |
| **请求超限** | API 返回 context_length 错误 | 1 | 不阻塞（已失败） | 24h |
| **缓存过期** | TTL 到期后下次调用 | 2→3 | **不阻塞**（返回旧值） | 4h |
| **用户切换模型** | 重启/切换 | 全部 | 阻塞 3 秒 | 4h |

### 3.3 何时不探测（复用缓存）

| 条件 | 行为 | 说明 |
|------|------|------|
| 缓存命中且未过期 | 直接返回缓存值（0 IO） | 正常路径 |
| 缓存已过期 | 返回旧值 + 后台异步刷新 | stale-while-revalidate |
| 同一模型并发请求 | 去重（只发一次探测） | `_contextWindowPending` Set |
| 探测连续失败 ≥2 次 | 冷却 10 分钟 | 避免无意义重试 |
| 上下文窗口来源为 Level 1（错误提取） | 不再探测（最可信） | TTL 24h |

### 3.4 两条路径的时序

**路径 A：工具循环启动（阻塞探测）**
```
toolUseLoop 启动
    │
    ├─ getModelContextWindowAsync(modelId, 3000)
    │   ├─ 缓存命中 → 直接返回（0ms）
    │   ├─ 缓存过期 → 返回旧值 + 后台刷新（0ms）
    │   └─ 缓存未命中 → 阻塞等待探测（最多 3s）
    │       ├─ Level 2: listModels() 探测
    │       ├─ Level 3: probeContextWindow() 实际请求
    │       └─ 写入缓存 + 返回
    │
    ├─ setDynamicContextBudget(contextWindow)
    ├─ _resolveMaxIterations(requested, contextWindow)
    └─ 开始循环（上下文预算已正确设置）
```

**路径 B：运行时错误提取（不阻塞）**
```
chat() 请求
    ├─ 成功 → 正常
    └─ context_length 错误
        ├─ parseContextOverflowTokens(errMsg) → limitTokens
        ├─ _cacheProbedContextWindow(modelId, limitTokens)
        │   └─ 写入缓存，TTL 24h，source='error-extract'
        ├─ 自动重试（maxTokens 缩减）
        └─ 下次 getModelContextWindow() 直接返回真实值
```

### 3.5 缓存状态机

```
┌─────────┐  首次探测成功  ┌──────────┐  TTL 到期  ┌──────────┐
│  未知    │ ───────────→ │  新鲜    │ ────────→ │  过期    │
│ (未缓存) │              │ (未过期) │           │ (已过期) │
└─────────┘              └──────────┘           └──────────┘
     │                        ↑                      │
     │                        │  后台刷新成功          │
     │                        └──────────────────────┘
     │                                                │
     │  context_length 错误                            │
     │  (Level 1 提取)                                 │
     │                        ┌──────────┐            │
     └──────────────────────→ │  可信    │ ←──────────┘
                              │ (TTL 24h)│
                              └──────────┘
```

### 3.6 各来源的 TTL 与可信度

| 来源 | TTL | 可信度 | 理由 |
|------|-----|--------|------|
| Level 1（错误提取） | **24h** | ★★★★★ | API 直接返回的真实限制 |
| Level 2（/v1/models） | **4h** | ★★★★ | API 主动上报，偶尔不准 |
| Level 3（probe 请求） | **4h** | ★★★★ | 实际请求探测 |
| Level 4（环境变量） | **不过期** | ★★★ | 用户手动配置 |
| Level 5（后台探测） | **4h** | ★★★ | 取决于 adapter |
| Level 6（128K 回退） | **不缓存** | ★ | 保守估计，尽快被真实值替换 |

## 4. 各级探测实现

### Level 1：运行时实际探测（context_length 错误提取）

**入口**：`aiGatewayGenerateMethod.js` → `tryContextOverflowAdjust()`

**流程**：
1. API 返回 context_length 错误（HTTP 400/413）
2. `errorClassifier.parseContextOverflowTokens(message)` 从错误消息提取 `{promptTokens, limitTokens}`
3. `_cacheProbedContextWindow(modelId, limitTokens)` 缓存到 `_contextWindowCache`
4. 后续 `getModelContextWindow(modelId)` 直接返回缓存值

**错误消息模式**（errorClassifier.js）：
| 提供商 | 模式 | 示例 |
|--------|------|------|
| OpenAI | `maximum context length is {limit} tokens ... resulted in {prompt} tokens` | "maximum context length is 128000 tokens ... resulted in 130000 tokens" |
| Anthropic | `prompt is too long: {prompt} tokens > {limit} maximum` | "prompt is too long: 210000 tokens > 200000 maximum" |
| 通用 | `{prompt} tokens > {limit}` | "150000 tokens > 128000" |

**缓存位置**：`aiGateway._contextWindowCache`（Map<modelId, number>）

### Level 2：API 模型列表上报

**入口**：`upstreamModelProbe.fetchUpstreamModels()`

**流程**：
1. 调用 provider 的 `/v1/models` 端点
2. 解析响应中每个模型的 `context_window` / `context_length` / `max_context_length` 字段
3. 缓存到 `_contextWindowCache`

**已知局限**：部分 provider（如 agnes）不返回此字段 → 回退到 Level 3+

### Level 3：环境变量覆盖

**变量**：`KHY_CONTEXT_WINDOW`（单位：tokens）

**用途**：用户手动配置特定模型的上下文窗口

### Level 4：后台异步探测

**入口**：`aiGatewayRoutingMethods.getModelContextWindowAsync(modelId, timeoutMs)`

**流程**：
1. 检查缓存（Level 1/2 已缓存 → 直接返回）
2. 触发 `_resolveContextWindowAsync()` → 调用所有 adapter 的 `listModels()`
3. 轮询缓存直到有值或超时（默认 3 秒）
4. 超时 → 返回 0（回退到 Level 5）

### Level 5：保守回退

**常量**：`UNKNOWN_MODEL_CONTEXT_WINDOW = 128000`

**原则**：宁可写小不可写大
- 写小的代价：多压缩一次（可恢复）
- 写大的代价：请求超限 400/413（不可恢复）

## 4. 探测结果的消费方

| 消费方 | 用途 | 读取方式 |
|--------|------|----------|
| `setDynamicContextBudget()` | 计算工具结果大小限制 | `clamp(窗口×5%, 8K, 40K)` |
| `_resolveMinSafeIterations()` | 计算最小迭代数 | `clamp(窗口/20000, 5, 15)` |
| `contextCompressor.compress()` | 触发上下文压缩 | `累积token > 窗口×70%` |
| TUI 状态栏 | 显示 `ctx (Xk/Y)` | `getModelContextWindow()` |
| `contextPruner.pruneContext()` | 裁剪旧消息 | `contextWindowTokens` |

## 5. 探测时序

```
用户发送消息
    │
    ├─ replSession 计算 loopMaxIterations
    │   └─ _resolveMaxIterations(requested, contextWindow)
    │       └─ getModelContextWindow(modelId)  ← Level 1→2→3→5
    │
    ├─ toolUseLoop 启动
    │   ├─ _contextWindowForBudget = getModelContextWindow()  ← 同步缓存
    │   ├─ getModelContextWindowAsync()  ← Level 4（3秒超时）
    │   ├─ setDynamicContextBudget(contextWindow)  ← 设置工具结果预算
    │   │
    │   └─ 每轮 chat() 前
    │       ├─ 检查累积 token > 窗口×70%
    │       └─ 超过 → contextCompressor.compress()
    │
    └─ chat() 请求
        ├─ 成功 → 正常处理
        └─ context_length 错误
            ├─ parseContextOverflowTokens()  ← Level 1 探测
            ├─ _cacheProbedContextWindow()  ← 缓存真实值
            └─ 下次请求使用真实窗口
```

## 6. 零硬编码原则

- 上下文窗口值**不硬编码在代码中**，必须来自 API 实际响应
- **禁止模型名模式匹配推断**——值必须从 API 响应中提取
- `UNKNOWN_MODEL_CONTEXT_WINDOW = 128000` 是**最后回退**，不是默认值
- 所有消费方通过 `getModelContextWindow()` 读取同一真源
- 探测结果缓存在 `_contextWindowCache`，同一模型只探测一次
