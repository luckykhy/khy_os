<!-- 文档分类: DESIGN-ARCH-016 | 阶段: 设计 | 原路径: docs/03_DESIGN_设计/[DESIGN-ARCH-016] AI_Agent显示规范.md（新建） -->
# khyos 生态 AI Agent 显示规范

> 版本 v1.0（2026-06-12）。本规范定义 khyos 生态内**所有** AI Agent（含 khyos 内置
> agent 与 khyquant 等生态应用）在运行期如何向**开发者**与**用户**呈现信息。
> 规范遵循 khyos 三条架构原则：**按需加载**、**零待机噪音**、**双模运行（独立 / 嵌入）**。
>
> 关键词 **必须 / 严禁 / 应 / 可** 按 RFC 2119 语义理解。
> 本规范是**硬约束**：新增或重构任何涉及 Agent 运行、LLM 调用、工具调用的代码，
> 其日志与提示输出必须符合本规范，否则视为缺陷。

---

## 0. 设计目标与分层

一次 Agent 运行同时面向两类受众，二者**物理隔离、互不污染**：

| 层 | 受众 | 通道 | 形态 | 触发时机 |
|---|---|---|---|---|
| **开发者可观测层** | 开发者 / 运维 / 排障 | 结构化日志（stderr / 日志文件 / khyos 上报） | 单行 JSON（NDJSON） | 仅任务执行期间 |
| **用户交互层** | 终端用户 | stdout（独立）/ khyos UI（嵌入） | 自然语言短句 | 仅任务执行期间 |

**核心红线**：
- 用户交互层**严禁**出现任何 JSON、trace_id、step 序号、token 数等内部字段。
- 开发者层**严禁**在没有任务运行时（待机、初始化、等待输入）产生任何输出。
- 两层共享同一个 `trace_id`，但**仅开发者层**可见它。

---

## 1. 开发者结构化日志标准（可观测层）

### 1.1 格式

开发者日志**必须**为**单行 JSON（NDJSON）**，一事件一行，便于 `grep` / `jq` /
日志管道消费。**严禁**多行美化 JSON，**严禁**自由文本穿插。

### 1.2 字段契约

| 字段 | 类型 | 必填 | 说明 |
|---|---|:--:|---|
| `ts` | string(ISO8601) | ✅ | 事件时间戳 |
| `trace_id` | string(32hex) | ✅ | 单次 Agent 运行的全局关联 id，贯穿所有 step |
| `span_id` | string(16hex) | ◐ | 子步骤 id（并行工具/子 agent 时用） |
| `app` | string | ✅ | 产生方，如 `khyos` / `khyquant` |
| `agent` | string | ✅ | agent 角色名，如 `technical` / `general-purpose` |
| `step` | number | ✅ | 步骤序号，从 1 递增 |
| `phase` | string | ✅ | `start` / `llm` / `tool` / `result` / `error` / `end` |
| `thought` | string | ◐ | 思考**摘要**（见 §1.4 截断），**严禁**全量 |
| `action` | string | ◐ | 当前动作，如 `llm.analyze` / `tool.getStockData` |
| `tokens` | object | ◐ | `{in, out, total}`，无则省略 |
| `duration_ms` | number | ◐ | 该 step 耗时 |
| `status` | string | ◐ | `ok` / `fallback` / `error` |
| `detail` | string | ◐ | 补充信息**摘要**（见 §1.4） |

示例（一行）：

```json
{"ts":"2026-06-12T03:14:00.123Z","trace_id":"a1b2...","app":"khyquant","agent":"technical","step":2,"phase":"llm","action":"llm.analyze","tokens":{"in":812,"out":156,"total":968},"duration_ms":1340,"status":"ok","thought":"MACD 金叉，量能温和放大…"}
```

### 1.3 脱敏（必须）

开发者日志在写出前**必须**对以下内容打码，**严禁**明文落盘：

- API Key / Token / Bearer / Secret / Password / Cookie：保留前 4 + 后 2 字符，
  其余以 `***` 代替（如 `sk-1***-2`）；无法判断长度时整体替换为 `***REDACTED***`。
- 形如 `sk-…`、`khy-…`、`Bearer …`、`Authorization: …`、`token=…`、`api_key=…`
  的子串**必须**命中脱敏。
- 邮箱/手机号等 PII **应**按需打码（最小化原则）。

### 1.4 大文本摘要（必须）

任何进入日志的字符串字段（`thought` / `action` / `detail` / prompt / completion /
工具输入输出）**必须**截断：

- 默认上限 **100 字符**；超出则取前 100 字符 + `…(+N chars)` 后缀。
- **严禁**把完整 prompt、完整 LLM 回复、完整 DataFrame、完整工具结果打进日志。
- 需要全量留存时**应**写入专门的 trace/audit 落盘通道，**不得**进常规日志流。

### 1.5 输出去向

- **独立模式**：写 **stderr**（保持 stdout 纯净，供数据/JSON-RPC 管道使用）。
- **嵌入模式**：见 §3，经 khyos 上报通道。
- 开发者层**默认开启**但**仅在任务期间**产生事件；**可**经环境变量
  `KHY_AGENT_LOG=0` 关闭（用于极致静默场景）。

---

## 2. 用户 UI 提示标准（交互层）

### 2.1 三类提示

| 类型 | 内容 | 形态 | 反例（严禁） |
|---|---|---|---|
| **进度提示** | 把内部步骤翻译成自然语言 | `正在分析技术面…` | `Step 2: tool_call getStockData` |
| **结果汇报** | 结论 + 简要资源消耗 | `分析完成，耗时 12 秒，建议：观望` | 直接打印结果 JSON |
| **错误降级** | 用户能懂的安抚 + 可选动作 | `数据源暂时不可用，已用缓存结果继续` | 抛出堆栈 / 打印 error 对象 |

### 2.2 硬规则

- **严禁**向用户暴露任何内部 JSON、trace_id、step 序号、token 原始数字、堆栈、
  类名 / 方法名 / 文件路径。
- 进度提示**应**为简短现在进行时短句（"正在 X…"），**不应**逐条罗列工具调用。
- 结果汇报**必须**附**简要**资源消耗（至少耗时；**可**含 token 概数），
  用人话表达（"耗时 12 秒 / 消耗约 1.2k tokens"），**严禁**裸露 `tokens:{in,out}`。
- 错误**必须**降级为自然语言，并尽量给出**已采取的兜底**（"已切换备用数据源"），
  **严禁**把异常对象直接 `console.error(error)` 暴露给用户通道。

### 2.3 通道

- **独立模式**：进度/错误写 **stderr**，最终结果**可**走 stdout（结构化交付）或 stderr（纯交互）；二者择一并保持一致。
- **嵌入模式**：经 khyos UI 通道（§3），由底座决定如何渲染（spinner / 折叠组 / 通知）。

---

## 3. 与 khyos 底座的集成（双模运行）

Agent **必须**在启动时判定运行模式，并据此选择通道。**严禁**两种模式混用通道。

### 3.1 模式判定

按优先级（khyquant 既有约定，见 `khy_quant/cli.py` `_detect_mode`）：

1. 显式环境变量：`KHYQUANT_MODE=eco|standalone`（Node 侧）/ `KHYOS_ECO_MODE`（Python 侧）；
2. 能 `import khy_platform.app_protocol` / 检测到 khyos 注入的环境 → **嵌入（eco）**；
3. 默认 → **独立（standalone）**。

### 3.2 嵌入模式（eco）

- 用户进度/结果/错误**必须**通过 **khyos 上报通道**交给底座，由底座统一渲染，
  **不得**直接 `console.log` 抢占终端（会破坏 khyos TUI 布局）。
- 上报通道约定（当前实现，向后兼容）：
  - 若宿主提供 `khyos.api.report_status(event)`（Python `app_protocol` ctx 注入）→ 调用之；
  - 否则降级为向 **`KHYOS_REPORT_FD`** 指定的文件描述符写 **NDJSON 状态事件**
    （事件含 `{type:"agent.status", trace_id, phase, message}`），由底座排空；
  - 再降级（无 fd）→ 写 stderr 并打 `khyos.status` 前缀，供底座解析。
- 开发者结构化日志同样经该通道（`type:"agent.log"`），与用户事件同 `trace_id`。

> 集成点尚未由宿主提供具体 API 时，实现**必须**优雅降级到 stderr，并以
> `# TODO: [Agent-Display-Unresolved]` 标注真正的 `khyos.api` 绑定位置，
> **严禁**直接调用不存在的 API 导致 Agent 崩溃。

### 3.3 独立模式（standalone）

- 进度/错误 → stderr；开发者日志 → stderr（或 `KHY_AGENT_LOG` 控制）。
- 不依赖任何 khyos 运行时；缺失 `khy_platform` **必须**静默降级，**严禁**报错。

---

## 4. 反模式 — 严禁项（硬红线）

| # | 严禁 | 原因 | 正确做法 |
|---|---|---|---|
| R1 | **心跳/轮询日志**：定时器每 N 秒吐 "still alive / checking…" | 污染日志、淹没真实事件 | 仅在**状态跃迁**时记录（参考 `networkDetector._record`） |
| R2 | **待机吐日志**：无任务时打印（初始化、等待输入、空闲轮询） | 违反零待机噪音 | 待机绝对静默；日志只在任务 `start`→`end` 之间产生 |
| R3 | **全量打印大文本**：完整 prompt / LLM 回复 / DataFrame / 工具结果 | 撑爆日志、泄露、性能 | 一律摘要（§1.4，≤100 字符 + 长度标注） |
| R4 | **明文密钥**：API Key / Token 进日志 | 安全事故 | 强制脱敏（§1.3） |
| R5 | **向用户暴露 JSON/内部字段**：step、trace_id、tokens 裸值、堆栈 | 体验灾难 | 翻译成自然语言（§2） |
| R6 | **嵌入模式直接 console.log** | 破坏 khyos TUI | 走 khyos 上报通道（§3.2） |
| R7 | **吞掉错误后静默**或**把 error 对象丢给用户** | 难排障 / 吓用户 | 开发者层记 `phase:error`，用户层降级为人话 |

---

## 5. 落地检查清单

任何 Agent 相关代码合入前，逐条自检：

- [ ] 一次运行有唯一 `trace_id`，贯穿所有 step（§1.2）
- [ ] 开发者日志为单行 JSON，字段齐全（§1.2）
- [ ] 密钥/Token 已脱敏（§1.3 / R4）
- [ ] 大文本已摘要 ≤100 字符（§1.4 / R3）
- [ ] 用户提示是自然语言，无任何内部字段（§2 / R5）
- [ ] 结果汇报含简要耗时/资源（§2.2）
- [ ] 已判定双模，嵌入走 khyos 通道、独立走 stderr（§3 / R6）
- [ ] 待机/初始化期间零输出（§4 R1/R2）
- [ ] 错误已降级为人话且记录了兜底动作（R7）
- [ ] 不确定如何改的代码**保持原状**并标 `# TODO: [Agent-Display-Unresolved]`

---

## 6. 参考实现

- **khyquant**：`software/khyquant/services/agentDisplay.js`（本规范的生态应用侧参考实现：
  trace_id、NDJSON 开发者日志、脱敏、摘要、双模上报、资源汇报、idle 静默）。
- **khyos**：`services/backend/src/services/agentDevLog.js`（本规范的**底座侧参考实现**：
  以监听者身份消费 `diagnosticEvents.js` 的 `diagnostics` 单一事件源——贯穿调度 /
  LLM / 工具链路的 choke-point——在序列化边界完成 trace_id、NDJSON 单行、字段级
  脱敏、大文本摘要、双模上报、step 计数与 idle 静默，**绝不**改写既有事件对象）；
  由 `services/backend/src/services/toolUseLoop.js` 的 `runToolUseLoop` 起点幂等挂载。
  用户自然语言层见 `cli/aiRenderer.js` / `cli/repl.js`（已对工具轨迹做归一化，
  不向用户暴露任何内部字段）。
