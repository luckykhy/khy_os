# [DESIGN-API-002] 外部错误信封与版本弃用政策

<!-- RULES-REGISTRY: API-001, API-002, API-003, API-004 -->


> **定位**：`[DESIGN-GOV-001]` GOV-API-001–004 的契约冻结真源 + UC-005 裁决。
> 上位 `[DESIGN-API-001]` 管「API 怎么设计」；本文管「对外错误与生命周期长什么样」。
> 冻结的是**目标态契约**：存量接口按 §6 分阶段迁移，迁移期新旧并存、以本文为准，本文不改任何业务路由。

## 1. 内部/外部边界（GOV-API-001）

内部 adapter 的 canonical 形状（`services/backend/src/services/gateway/adapters/_responseBuilder.js`）：
`{ success, content, provider, adapter, model, tokenUsage, toolUseBlocks, stopReason, attempts }`。

**红线**：该形状是**内部契约**，禁止以任何形式（含字段子集）直接作为公开 REST/SSE/WS 响应体；
公开响应一律经 §2 信封转换；内部字段（`attempts`、`toolUseBlocks`、adapter 名）只允许出现在 §5 最小披露白名单内。

## 2. 统一外部错误信封（GOV-API-003 目标态）

```json
{ "ok": true,  "data": { … }, "traceId": "…" }
{ "ok": false, "error": { "code": "RATE_LIMITED", "httpStatus": 429,
  "message": "限流 (429)：请求过多", "hint": "稍后重试或运行 khy gateway config 切换通道",
  "traceId": "…", "details": {} } }
```

- `code`：稳定机器码——**新增机器码必须先入下表再用**；`message`/`hint` 遵循 `AGENTS.md` 规则 2.2（中文、可执行）；`details` 只放 §5 白名单字段，不放堆栈/内部对象。

**机器码登记表（初版，随迁移逐端点覆盖；分类依据沿用 `gatewayErrorClassifier` 的 errorType 映射）**

| code | 触发 | 人话模板（AGENTS.md 2.2） |
|---|---|---|
| `RATE_LIMITED` | 上游 429 / 本地限流 | 限流 (429)：请求过多，稍后重试或运行 khy gateway config 切换通道 |
| `UNAUTHORIZED` | 401 | 认证失败 (401)：API key 无效或过期，请运行 khy gateway config 更新密钥 |
| `FORBIDDEN` | 403 | 权限不足 (403)：无权访问该模型，请检查订阅或更换密钥 |
| `MODEL_NOT_FOUND` | 404/模型不存在 | 模型不存在 (404)：请用 /model 查看可用模型 |
| `CONTEXT_TOO_LONG` | 413/超长 | 上下文超限：对话过长，请 /compact 压缩或新建会话 |
| `CREDITS_EXHAUSTED` | 额度不足 | 额度已用完：请充值或更换模型通道 |
| `UPSTREAM_ERROR` | 上游 5xx | 上游异常 ({status})：模型服务暂不可用，请稍后重试 |
| `TIMEOUT` | 请求超时 | 请求超时：网络或服务响应慢，请稍后重试 |
| `NETWORK_ERROR` | 连接失败 | 网络连接失败：请检查网络代理设置 |
| `OUTPUT_TRUNCATED` | 输出截断 | 输出被截断：请说「继续」续写，或调大 maxTokens |
| `CONTENT_BLOCKED` | 安全拦截 | 内容安全拦截：模型拒绝生成，请调整措辞后重试 |
| `INTERNAL` | 未分类服务端错误 | 服务端异常：请运行 khy doctor 自检，或查 traceId {traceId} 的网关日志 |

## 3. SSE/WS 终态（GOV-API-003）

流式通道**必须**以且仅以一个终态事件收尾，四终态互斥（与 `[DESIGN-ACP-001]` §3 同构）：

| 终态事件 | 载荷 | 语义 |
|---|---|---|
| `done` | `{ ok:true, summary, usage? }` | 正常完成 |
| `degraded` | `{ ok:false, code:"DEGRADED", message, hint }` | 降级完成（结果仍可用，如视觉池失败回退 OCR） |
| `cancelled` | `{ ok:false, code:"CANCELLED" }` | 用户/系统主动取消 |
| `failed` | 完整 §2 错误信封 | 失败（超时/上游异常/拦截） |

**红线**：上游异常后只允许 `failed`/`degraded`，不得再发 `done`（v1 反例：upstream 异常后仍发 `stop` + 成功标记）；取消后只允许 `cancelled`。

## 4. 版本与弃用政策（GOV-API-002）

- **版本化**：公开路径按大版本分段（`/api/v1/…`）；破坏性变更（删字段/改语义/改鉴权）只进**新大版本**；非破坏变更不升版；
- **弃用**：被弃端点继续可用期携带响应头 `Deprecation: true` + `Sunset: <RFC 1123 日期>`，并在 `CHANGELOG.md` 写一行迁移说明；最短兼容期 = 一个 khy-os 发布大版本（与 `[DESIGN-TOOL-001]` §2 同窗）；
- **登记制**：新增/变更公开 API 必须登记五要素——版本、请求/响应字段、认证方式、错误码（§2 表内）、迁移说明；登记位置：§7 目录表（先登记后实现）。

## 5. 跨 transport 最小披露（GOV-API-004）

`traceId` 自 HTTP 入口生成，经 gateway → ACP（字段见 `[DESIGN-ACP-001]` §2）→ SSE/WS 全程传播。

| 可外露 | 不可外露 |
|---|---|
| `traceId` | 堆栈、内部文件路径、adapter 尝试日志（`attempts`） |
| 信封 `code`/`httpStatus` | 上游供应商原始响应体、密钥、token |
| `deadline` 是否超时的布尔摘要 | 内部服务名、端口、进程拓扑 |

日志侧可见性仍由 `[DESIGN-ARCH-031]`（网关日志租界隔离）管，本节只管响应体侧。

## 6. 迁移排期（登记，不阻塞冻结）

1. **建目录**：管理 REST/SSE/WS/兼容 API 端点清点进 §7 表（含认证方式与现行错误形状）；
2. **信封落地**：新端点直接用 §2/§3 形态；存量端点逐端点改写，旧响应体兼容一个发布周期；
3. **守卫**：目录表 + 信封校验做成 `scripts/ci/` 守卫并入 `check:structure` 与 PR gate（GOV-TOOL-005），同步 `scripts/tests/` 用例（070 §7 条款）。

## 7. API 目录（占位表，迁移第 1 步填实）

| 面 | 端点/通道 | 认证 | 现行错误形状 | 目标 |
|---|---|---|---|---|
| 管理 REST | `services/backend` Express 路由 | JWT | 分裂（逐路由自带） | §2 信封 |
| 网关 SSE | 流式完成通道 | session | 分裂（v1 `stop` 语义） | §3 四终态 |
| 网关 WS | 实时共享（9222 bridge 等） | session | 失败被吞 | §3 四终态 |
| 兼容 API | OpenAI 协议兼容端点 | API key | 200 + 内嵌 error | §2 表（兼容面保留 200+error 双形态，文档标注） |
