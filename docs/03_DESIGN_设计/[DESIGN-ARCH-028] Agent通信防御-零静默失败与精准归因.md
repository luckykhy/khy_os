# DESIGN-ARCH-028 · Agent 通信防御：零静默失败与精准归因

> 状态：已实现（services/backend）
> 关联代码：`services/backend/src/services/failsafe/`、`services/toolUseLoop.js`、`services/aiManagementServer.js`
> 关联测试：`tests/services/failsafe/failsafe.test.js`（32 用例绿）
> 关联规范：[DESIGN-ARCH-027] 依赖自愈（E05 来源）、[DESIGN-ARCH-026] 审批网关（E07 来源）

## 1. 问题陈述

用户对 Agent 的最高诉求之一：**绝不出现模糊的"AI 未返回有效回复 / 未知错误 / 请求失败"**。
此前存在三类"静默失败"：

1. **空响应丢归因**：`toolUseLoop` 空回复分支返回的对象**不带** `errorType`，前端只能显示固定
   兜底文案。`aiManagementServer` SSE 空内容分支只发 `{type:'error', message:'AI 未返回有效回复'}`，
   **无错误码**。
2. **原始错误直抛**：catch 分支 `sendEvent({type:'error', message: err.message})` 把未脱敏、未归类的
   原始错误甩给前端。
3. **进程被杀即无声**：流式过程中进程崩溃 / 被信号杀掉，连接直接断开，前端只看到"卡住"。

## 2. 设计目标（铁律）

1. **零空响应**：任何 LLM / 工具 / 外部通信的返回若为空 / 非法，必被转换为结构化错误，绝不透传空值。
2. **零模糊归因**：所有非正常终止落到 **E01–E08** 之一并携带必填字段；reason 文案固定取自单一真源。
3. **兜底不可绕过**：即便进程被 `SIGTERM`/`SIGINT` 杀掉或 `uncaughtException`，流式拦截器也在
   最后一刻补写 E04/E06。

## 3. 架构

单一子系统 `services/failsafe/`，门面 `index.js`：

```
errorCodes.js     E01–E08 单一真源：reason 文案 / 必填字段 / 脱敏标记 / 兜底回落
classifier.js     ErrorClassifier：任意原始信号 → E0x 标准结构（E02/E07 脱敏）
safeResponse.js   SafeResponseWrapper：拦截 LLM/工具/外部通信返回，空值/非法 → 结构化错误
streamInjector.js StreamFailSafeInjector：三层兜底注入（应用层 / 流意外结束 / 进程级）
types.d.ts        TS 类型契约（运行时为纯 JS，避免死代码；契约供 IDE / 未来 TS 消费方）
```

## 4. 错误字典（E01–E08，单一真源）

| 码 | 分类 | 必填字段 | 可重试 | 脱敏 |
|---|---|---|---|---|
| E01 | 模型静默空响应 | model, prompt_tokens | ✓ | |
| E02 | 模型强制中断（安全） | model, finish_reason | | ✓ |
| E03 | 上下文溢出 | model, ctx_limit, required_tokens | | |
| E04 | 工具执行崩溃 | tool_name, raw_error_stack | | |
| E05 | 依赖缺失阻断 | tool_name, missing_dep | ✓ | |
| E06 | 网络层熔断 | endpoint, timeout_ms, retry_count | ✓ | |
| E07 | 权限拦截 | tool_name, approval_level, deny_reason | | ✓ |
| E08 | 格式校验失败 | expected_schema, raw_output_snippet | ✓ | |

输出统一结构：
```json
{ "status": "failed", "error_code": "E04", "reason": "工具内部抛出未捕获异常",
  "detail": "工具 WebBrowser 执行时抛出未捕获异常：Browser closed unexpectedly",
  "suggestion": "请检查该工具的依赖与参数，或改用功能相近的替代工具。",
  "retryable": false, "sensitive": false, "category": "工具执行崩溃",
  "fields": { "tool_name": "WebBrowser", "raw_error_stack": "…" },
  "attribution_complete": true }
```

## 5. 归因映射（classifier，按优先级）

```
已带 error_code(E0x)        → 幂等沿用
errorType:'empty_reply'     → E01
errorType:'schema'          → E08
审批裁决 {allow:false,…}     → E07   （权限拦截优先）
MissingDependencyError/code → E05
finish_reason ∈ 安全停止     → E02
ToolError code              → MISSING_DEPENDENCY→E05 / PERMISSION_DENIED→E07 /
                              TIMEOUT|NETWORK→E06 / 其余→E04
expected_schema 在场         → E08
errorClassifier.kind         → refusal→E02 / context_length→E03 / permission→E07 /
                              timeout|network|rate_limit|overloaded|server_error→E06
兜底                         → E04（绝不返回空）
```

复用既有 `errorClassifier.detectErrorKindDeep`（深链探测 + HTTP 状态）与 `redactSensitiveText`
（密钥脱敏），不重复造轮子。必填字段逐项填充，缺失填 `'unknown'` 并置 `attribution_complete=false`
（归因仍可用，但显式标注不完整）。

## 6. 防呆（硬约束）

- **①catch 绝不空 return**：`SafeResponseWrapper.guard` 捕获的异常一律 `classify()` 归因，
  返回结构化错误或抛出携带 `.failure` 的错误；从结构上禁止"只 console.error 然后空 return"。
- **②原始 Error 不直抛前端**：所有对外错误都经 `classifier` 脱敏（密钥）+ 归类（E0x），
  detail/stack 经 `redactSensitiveText` 后截断。
- **③E02/E07 脱敏**：sensitive 码从**采集源头**就只取白名单字段——E02 仅 `model+finish_reason`；
  E07 仅 `tool_name+approval_level`，`deny_reason` 归一化为 `[已触发系统管控策略]`。detail 用
  固定安全模板，**绝不**含系统 Prompt / 内部审批 reasons / 命中策略。
- **④兜底协议不可绕过**：`StreamFailSafeInjector` 三层——应用层 `fail()`、流意外结束 `finalize()`、
  进程级 `uncaughtException`/`unhandledRejection`→E04 与 `SIGTERM`/`SIGINT`→E06 全局清扫。
- **⑤幂等终结**：每个注入器只终结一次（`finalized` 闸门），重复调用 no-op，杜绝双写终态。
- **⑥失败兜底之上再兜底**：`classify` 自身异常 → 兜底码 E04；`_safeClassify` 再包一层，
  绝不让兜底协议自身失败而无输出。

## 7. 接入点（最小侵入）

- `toolUseLoop.js` 空回复分支：附 `error_code:'E01'`（安全停止则 `content_filter`）+ `attribution`，
  保留人读 `finalResponse`，fail-soft（归因失败不影响降级返回）。
- `aiManagementServer.js` SSE：`sendEvent` 外包 `StreamFailSafeInjector`；done→`markDone`、
  空内容→`fail(E01/E02)`、catch→`fail(归类 err)`、finally→`finalize()`（未终结即注入兜底）。
  注入事件携带 `error_code/reason/detail/suggestion/fields`，并保留 `message="[E0x] reason"`
  向后兼容旧前端（内容为精准 reason，而非"未返回有效回复"）。

## 8. 开关与可调项

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `KHY_FAILSAFE_PROCESS_GUARD` | 开 | `=off` 关闭进程级 uncaughtException/信号兜底守卫 |

## 9. 验收（32 用例绿，零网络/零真实进程/零真实 FS）

- 字典单一真源（八码 + 必填字段 + 脱敏标记 + 未知码回落）；
- 八类信号各归正确码 + 必填字段填充 + `attribution_complete`；幂等；无法归类 → E04 非空；
- 脱敏：E02/E07 detail/fields 不含敏感关键词 / 系统 Prompt / 原始 reasons；
- `SafeResponseWrapper`：空 LLM→E01、工具 null→E04、权限软失败→E07、异常→E04、`_safeCall` 抛带 `.failure`；
- `StreamFailSafeInjector`：流意外结束注入 E04（partial 标记）、`sweepActive` 进程清扫补写 E06、
  幂等终结、`markDone` 出册、`res.end` 调用。

全量 node:test 回归 574/574 绿。
