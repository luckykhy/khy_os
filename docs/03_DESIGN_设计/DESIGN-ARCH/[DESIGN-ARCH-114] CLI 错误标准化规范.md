# [DESIGN-ARCH-114] CLI 错误标准化规范

<!-- RULES-REGISTRY: RUNTIME-002, RUNTIME-005 -->

> **定位**：补齐 `[DESIGN-API-002]`（GOV-API-003 统一错误信封）与 `[DESIGN-ACP-001]`（GOV-ACP-004 终态错误码）
> 的**第三个面**——**面人（CLI/TUI）**。前两者冻结的是机器面（REST/SSE/WS）与进程面（ACP JSON-RPC）；
> 本文冻结人面：同一失败在终端上「长什么样、有几个字段、谁能翻译成什么」。
>
> **触发背景**：2026-09-17 用户实测报告——一次网关级联耗尽后，TUI 只显示
> 「⚠ 本次请求未能完成，AI 服务没有返回回答。失败信息: 所有 AI 通道均不可用。」+ 一张静态推广清单，
> 看不到**是哪条通道、什么机器码失败、本轮路由是否被钉死**。根因是同一失败在两处被**各自格式化**：
> gateway 的 `guidanceContent`（含真实诊断）被 CLI 的 `errorMsg` 包装成**一段散文**，
> 结构化字段（`errorType`/`attempts`/`preferredAdapter`/`resumable`）虽已存在却未进入展示契约。

## 1. 现状：三条独立的错误出口（缺口所在）

| 面 | 出口代码 | 形状 | 契约 |
|---|---|---|---|
| REST/SSE/WS | `services/backend/src/routes/**` | `{ok:false, error:{code,…}}` | ✅ API-003 已冻结 |
| ACP JSON-RPC | `services/backend/src/contracts/acp/` | `{error:{code:-320xx}}` | ✅ COMMS-004 已冻结 |
| **CLI / TUI** | `src/cli/aiChatCore.js:3273`、`src/cli/aiGatewayGenerateHelpers.js:802` | **中文散文 + 手拼清单** | ❌ **无契约（本文补齐）** |

### 1.1 实证链路（2026-09-17 事故）

```
gateway generate 级联耗尽
  └─ aiGatewayGenerateMethod.js:6370  guidanceContent
       ├─ _visionExhaustionNote      （视觉专项诊断，仅带图）
       ├─ _channelAdviceNote         （通用通道诊断：5xx/auth/限流/网络/404/钉选）
       ├─ _jitterRoundsNote          （整轮自愈轮次）
       ├─ _resumeNote                （断网续传）
       └─ [静态推广清单：Kiro / Trae / Ollama / Claude / OpenAI / …]
  └─ 结果对象：{ success:false, errorType:'unavailable', attempts:[…], preferredAdapter:'windsurf', resumable, continueHint }
       │
       ▼  aiChatCore.js:3237  失败分支
  ┌──────────────────────────────────────────────────────────┐
  │ const rawFailureText = result.content   ← 整段诊断被当成「失败信息」一行       │
  │ errorMsg = '⚠ 本次请求未能完成，AI 服务没有返回回答。'                        │
  │          + '\n\n失败信息: ' + rawFailureText（截断 180 字符 → 只剩第一句）      │
  │ + _formatGatewayFailureDetails(result) ← 又拼一份「真实失败原因」             │
  │ + _buildRecoveryAttemptsNote(result)   ← 再拼一份「处理方法」                 │
  └──────────────────────────────────────────────────────────┘
```

**四个具体缺陷**（均可在截图中复现）：

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| F1 | **真实原因被截断淹没** | `aiChatCore.js:3243` `.slice(0, 180)` | 诊断正文前 180 字符恰是「`⚠ 通道失败原因与下一步:`」表头，**机器码与通道名全被切掉** |
| F2 | **同一事实三处重复** | `guidanceContent` + `_formatGatewayFailureDetails` + `_buildRecoveryAttemptsNote` | 用户看到三段近义散文，找不到「到底哪个通道、什么码」 |
| F3 | **机器码不可检索** | 全链路只有中文散文，无稳定 `code` | 用户无法 grep、无法提交可复现的 bug、支持无法归因 |
| F4 | **推广清单抢占首要位置** | 静态清单长度 > 实际诊断 | 首屏被 12 行推广占据，真正的「按代理/密钥/钉选去修」被压到屏外 |

> ⚠️ 注意 `errorType:'unavailable'` 与真实根因**不一致**：本次事故根因是
> `services/backend/.env` 中 `GATEWAY_PREFERRED_ADAPTER=windsurf` + `GATEWAY_PREFERRED_STRICT=true`
> 钉死在**本机未安装**的 windsurf 通道上（`aiGatewayGenerateMethod.js:3695` 的 strict 前置块会
> 直接对未注册/未启用通道返回 `unavailable`，**不回退**）。这与 09-13→15 连续三天误诊为
> 「密钥失效」是**同一个 bug 换了通道名**——而 CLI 出口恰好把这个元原因排在最末，且被 180 字符截断吃掉。

## 2. 目标态：CLI 失败块契约（GOV-CLI-ERR-001）

CLI/TUI 的失败展示**必须**由**一个结构化对象**渲染，禁止再对 `result.content` 做字符串截断拼接。

```json
{
  "ok": false,
  "code": "CHANNEL_UNAVAILABLE",
  "severity": "error",
  "title": "本次请求未能完成",
  "cause": { "adapter": "windsurf", "statusCode": 0, "errorType": "unavailable",
             "detail": "windsurf disabled by configuration" },
  "routing": { "mode": "pinned-strict", "preferred": "windsurf", "fallbackSuppressed": true,
               "triedAdapters": ["windsurf"], "jitterRounds": 0 },
  "hint": ["解除钉选：把 GATEWAY_PREFERRED_ADAPTER 清空或设为 auto",
           "设 GATEWAY_PREFERRED_STRICT=false（services/backend/.env 或 ~/.khy/.env）",
           "运行 `khy gateway status` 复核实测通道"],
  "attempts": [ { "adapter": "windsurf", "statusCode": 0, "errorType": "unavailable",
                  "error": "windsurf disabled by configuration", "virtualSkip": false } ],
  "resumable": false,
  "traceId": "…"
}
```

### 2.1 字段规约

| 字段 | 必填 | 约束 |
|---|---|---|
| `code` | ✅ | **稳定机器码**，枚举见 §3 表；新增码先入表再用（与 API-003 §2 同制） |
| `title` | ✅ | 人话一句话，遵循 `AGENTS.md` 规则 2.2（问题 + 识别码 + 修复建议） |
| `cause` | ✅（有 attempts 时） | **一个**主因（按 `failureReasonRanking` 的 live-优先排序取首条），非一份清单 |
| `routing` | ✅ | `mode ∈ {auto, pinned-strict, user-pinned}`；`fallbackSuppressed` 为真时 `hint` **必须**首条给解钉方法 |
| `hint` | ✅ | 可执行命令数组，每条 ≤ 1 行；**推广清单不得进入 `hint`**（见 §2.2） |
| `attempts` | 选 | 完整逐通道记录（内部字段），默认折叠，`khy --verbose` 展开 |
| `resumable` | 选 | 决定是否追加 `_CONTINUE_HINT`（沿用现状语义） |
| `traceId` | 选 | 与 API-003 §5 最小披露一致；**不得**外露堆栈、绝对路径、密钥 |

### 2.2 渲染秩序（首屏可见性硬约束）

```
第 1 屏（必现，≤ 8 行）
  ⚠ 本次请求未能完成 —— 被钉选的通道不存在或未启用
  [CHANNEL_ABSENT_PINNED]
  通道: windsurf [unavailable] — windsurf disabled by configuration
  路由: 钉选 strict（GATEWAY_PREFERRED_ADAPTER=windsurf），本轮不回退
  → 该通道在本机不存在或未启用，且 strict 抑制了回退
  → 把 GATEWAY_PREFERRED_ADAPTER 清空或设为 auto，并设 GATEWAY_PREFERRED_STRICT=false
  → 改完运行 `khy gateway status` 复核实测通道

第 2 屏（`khy --verbose` 或用户按 V 展开）
  真实失败原因:（逐通道，沿用 _formatGatewayFailureDetails）
  内部已尝试: N 次请求（…）

第 3 屏（**仅在无任何 hint 可给时**才出现）
  🆓 免费方案 / 💰 付费订阅 / ⚡ 快速配置
```

**红线 R-GW-1**：静态推广清单**永不**出现在第 1 屏。它的定位是「用户确实没有任何可用通道且不知从何配起」的
**末位兜底**，不是每次失败的默认装饰。判定：`hint.length === 0` → 才允许渲染。

**红线 R-GW-2**：`result.content` **禁止**做长度截断后当作「失败信息」直接展示（废止 `aiChatCore.js:3243`
的 `.slice(0, 180)` 语义）。若要摘要，必须从结构化字段取，不截断自然语言。

## 3. CLI 机器码登记表（初版）

**分类真源**：`services/backend/src/services/gateway/gatewayErrorClassifier.js` 的 `errorType`；
本表只做 `errorType → CLI code` 的**单射**映射，不新增分类口径。

| CLI code | errorType | 触发 | 首屏 hint 模板 |
|---|---|---|---|
| `CHANNEL_ABSENT_PINNED` | `unavailable` + `statusCode===0`（strict 且 `fallbackSuppressed`） | **被钉的通道本机不存在/未启用** | 解钉（置 auto）+ `GATEWAY_PREFERRED_STRICT=false` + `khy gateway status` |
| `AUTH_FAILED_PINNED` | `auth`/`permission`（strict 且 `fallbackSuppressed`） | 被钉通道真实 401/403 | `ai config` 更新 key；若本不该钉则一并解钉 |
| `AUTH_FAILED` | `auth` / `permission` | 401/403/密钥无效（非钉选） | 运行 `ai config` 更新该通道 key |
| `CHANNEL_UNAVAILABLE` | `unavailable`（非钉选） | 通道未注册/未启用/未安装 | `khy gateway status` 查看实测；`khy gateway model` 改选通道 |
| `RATE_LIMITED` | `rate_limit` | 429/限流 | 降并发、稍后重试 |
| `UPSTREAM_ERROR` | `server_error` | 5xx | 稍后重试；`khy gateway status`；`/proxy` |
| `NETWORK_ERROR` | `network` | 传输层不可达 | `/proxy` 配代理；稍后重试 |
| `TIMEOUT` | `timeout` | 网关链路超时 | 稍后说「继续」；检查网络/代理 |
| `MODEL_NOT_FOUND` | `model_not_found` | 404/模型未领取 | `/model` 查看可用模型 |
| `CONTEXT_TOO_LONG` | `context_length` | 上下文超限 | `/compact` 压缩或新建会话 |
| `CHANNEL_EXHAUSTED` | 兜底 | 穷尽所有通道且无更具体信号 | 见 §2.2 第 3 屏（推广清单） |
| `CANCELLED` | `cancelled` | 用户取消 | 无（静默） |
| `NONE` | 其余 | 未分类 | `khy doctor` 自检 + traceId |

**互斥性**：一次失败只落**一个** `code`（按上表自上而下首次命中即停），与 API-003 §3 四终态同构。

### 3.1 钉选优先的严格边界（⚠️ 本规范最容易做错的一处）

「钉选是元原因」**不可无条件前置**。必须区分两种情形：

| 情形 | 判据 | 正确 code | 理由 |
|---|---|---|---|
| 被钉通道**本机不存在/未启用** | `errorType==='unavailable'` 且 `statusCode===0`，或文本含 `not registered` / `disabled by configuration` / `not installed` | `CHANNEL_ABSENT_PINNED` | 通道压根没被调用到；解钉才是唯一正解 |
| 被钉通道**存在但真实拒绝** | `statusCode∈{401,403,404,429,5xx}` | 照实报 `AUTH_FAILED_PINNED` / 对应码 | 这是**通道侧事实**，用「是钉选问题」掩盖会掩盖真实故障 |

> **为什么必须写死这条边界**：2026-09-13→15 连续三天的误诊，源于**把钉选误读为密钥问题**；
> 而若为修它就把「钉选」无条件前置，会立刻制造**反向的同类错误**——把真实的密钥失效
> 误诊为「只是钉选问题」。两个方向都是同一个病：**用一个元原因覆盖已观测到的事实**。
> 正确做法是让**证据**（`statusCode` 是否真为非 0）决定谁解释谁。

两种情形都**保留**「本轮回退被抑制」的披露（`routing.mode === 'pinned-strict'` 恒渲染路由行），
只是码与首条 hint 不同。

## 4. 落地改造点（按依赖序）

| # | 文件 | 改动 | 复用（不重写） | 状态 |
|---|---|---|---|---|
| 1 | `services/backend/src/services/gateway/cliFailureEnvelope.js` | **新增**：纯叶子，`buildCliFailureEnvelope(result, env) → §2 对象`。零 IO、确定性、绝不抛、门控 `KHY_CLI_FAILURE_ENVELOPE`（默认开） | `gatewayErrorClassifier.classifyError`、`buildChannelFailureAdvice`、`failureReasonRanking`、`visionExhaustionDiagnostic` | ✅ 已落地 |
| 2 | `src/cli/aiChatCore.js:3259-3317` | 失败分支改为「先渲染信封」；信封不可用/门关 → 逐字节回退旧 `errorMsg` 拼接；`failureDetails` 保留为第 2 屏；返回值新增 `failureCode` | `_formatGatewayFailureDetails`、`_buildRecoveryAttemptsNote`（降为第 2 屏） | ✅ 已落地 |
| 3 | `src/cli/aiChatCore.js`（同处） | 推广清单门控（R-GW-1）：`showPromoPanel` 为假时按行剔除 🆓/💰/⚡ 三段及各自链接行 | 清单文本不动，仅决定是否保留 | ✅ 已落地 |
| 4 | `services/backend/tests/gateway/cliFailureEnvelope.test.js` | **新增**：27 个用例，覆盖 §5 A1–A4 与 §3.1 钉选边界 | — | ✅ 已落地 |
| 5 | `docs/10_规范/registry/RULES-REGISTRY.json` | 登记 `RUNTIME-005`，gate=commit | 登记表 + `check-gov-rules.js` | ✅ 已登记 |
| 6 | `scripts/ci/check-agent-rules.js` | 新增 finding `cli-raw-error-truncate`（检测对失败文本做 `.slice()` 截断） | 既有检查框架 | ⏳ 待实现 |
| 7 | `src/cli/aiGatewayGenerateHelpers.js` | `_buildRecoverySuggestions` 输出并入 `hint[]`（当前仍是独立第 2 屏） | 现有 `_buildRecoverySuggestions` | ⏳ 待收敛 |

> **注**：第 6/7 项不阻塞验收——信封已接管首屏，`failureCode` 已随返回值外露，
> A1–A4 判据均已满足。剩余两项是把第 2 屏也收进同一契约的收敛工作。

**逐字节回退**：门关（`KHY_CLI_FAILURE_ENVELOPE=0`）或叶子不可用 → 完全走今日 `errorMsg` 拼接路径，不改变任何输出。

## 5. 验收标准

| # | 判据 | 验证方式 |
|---|---|---|
| A1 | 首屏 ≤ 8 行，含 `code` + 主因通道 + 解钉/修复 hint | 快照测试 + 用户实测截图 |
| A2 | 钉选 + 通道不存在（本仓 `.env` 现状）→ code 为 `CHANNEL_ABSENT_PINNED`，hint 首条为解钉 | 夹具：`{preferredAdapter:'windsurf', attempts:[unavailable/0]}` |
| A3 | 钉选 + 真实 401 → code 为 `AUTH_FAILED_PINNED`（**不得**被钉选掩盖），且仍披露回退被抑制 | 夹具：`{preferredAdapter:'api', attempts:[auth/401]}` |
| A4 | `hint.length > 0` 时，输出中**不含**「🆓 免费方案」 | 断言 `!/免费方案/.test(rendered)` |
| A5 | 任何失败路径均不出现截断后自然语言（无 `…` 结尾的失败信息行） | finding `cli-raw-error-truncate` 归零 |
| A6 | 门关时输出与 2026-09-17 前逐字节一致 | 门开/门关双快照 diff |

## 6. 与既有规则的关系

| 规则 | 关系 |
|---|---|
| `RUNTIME-002`（状态透明，子规则 2.2） | **本文是其可执行化**：2.2 要求「问题 + 识别码 + 修复建议」，本文把「识别码」落成 §3 表、把「修复建议」落成 `hint[]` |
| `API-003`（统一错误信封） | 同构、不重叠：API-003 管机器面信封，本文管人面渲染；§3 表与 API-003 §2 表**共用机器码语义**，可互译 |
| `COMMS-004` | 同构：四终态互斥 → 本文 `code` 单射互斥 |
| `GW-002`（降级与熔断） | 本文消费其降级链结果（`attempts`），不改变降级策略 |
| `RUNTIME-001`（零硬编码） | §3 表为**登记表驱动**，编码入表而非散落代码 |
