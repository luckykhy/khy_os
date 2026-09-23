# khy-os 长任务可靠性协议 (Reliability Protocol)

> 版本: 1.0.0 | 生效: 2026-07-26
> 本文件与 `COMMUNICATION-PROTOCOL.md`、`FILE-FORMAT-PROTOCOL.md` 互补，定义「长任务交互的可靠性保障」。
> 违反本协议的变更无法通过 `release-gate.js` 的 `reliability-gate` 阶段。

---

## 目录

1. [总则](#1-总则)
2. [任务状态机（Durable Task Store）](#2-任务状态机durable-task-store)
3. [Watchdog 空闲超时](#3-watchdog-空闲超时)
4. [AbortSignal 中断传播](#4-abortsignal-中断传播)
5. [Receipt 轨迹不可遗漏](#5-receipt-轨迹不可遗漏)
6. [重试与退避](#6-重试与退避)
7. [Fail-Soft 全链路](#7-fail-soft-全链路)
8. [内存与资源保护](#8-内存与资源保护)
9. [跨进程一致性](#9-跨进程一致性)
10. [可靠性门禁](#10-可靠性门禁)

---

## 1. 总则

### 1.1 定义

**长任务** = 满足以下任一条件的交互：
- AI 生成耗时 > 30 秒（多轮 tool loop、长文档生成）
- 工具执行耗时 > 10 秒（文件读写、网络请求、编译）
- 涉及多步工具链（tool_use → tool_result → tool_use → …）
- 跨进程/跨服务通信（IPC、WebSocket、SSE 流）

### 1.2 强制约束

| 约束 | 说明 |
|------|------|
| 永不静默失败 | 任何失败必须留下可审计的痕迹（日志 / receipt / audit event） |
| 终态必达 | 任务必须落入终态（succeeded / failed / cancelled / dead_letter），不得无限期停留在 running |
| 超时必设 | 任何可能阻塞的异步操作必须有超时保护（Watchdog / hardTimeout / idleTimeout） |
| 中断必响 | ESC 用户中断必须沿调用链传播到实际执行点，不得吞掉 |
| 轨迹必全 | 每个长任务必须有完整的 Receipt（RCPT-*），包含 start → toolChain → finalize |
| 幂等必保 | 可重试操作必须携带幂等 Key（requestId / traceId / callId） |
| 资源必释 | Watchdog / timer / interval 必须在操作完成/失败/取消时清理 |

---

## 2. 任务状态机（Durable Task Store）

### 2.1 状态定义

```
queued       → 等待 worker 认领
  ↓
claimed      → worker 已认领，准备启动
  ↓
running      → 正在执行
  ↙     ↘
retry_wait   succeeded
（等待重试）   （终态 ✓）
  ↓
claimed → ...
  ↙     ↘
pausing      cancelling
  ↓           ↓
paused       cancelled（终态）
  ↓
running → ...
  ↙     ↘
failed       dead_letter（终态，重试耗尽）
```

### 2.2 合法转换

```javascript
const STATUS_TRANSITIONS = {
  queued:       ['claimed', 'cancelling', 'cancelled'],
  claimed:      ['running', 'retry_wait', 'cancelling', 'cancelled', 'failed'],
  running:      ['retry_wait', 'pausing', 'cancelling', 'succeeded', 'failed'],
  retry_wait:   ['claimed', 'dead_letter', 'cancelling', 'cancelled'],
  pausing:      ['paused', 'cancelling', 'cancelled'],
  paused:       ['running', 'cancelling', 'cancelled'],
  cancelling:   ['cancelled'],
  succeeded:    [],   // 终态
  failed:       [],   // 终态
  cancelled:    [],   // 终态
  dead_letter:  [],   // 终态
};
```

非法状态转换必须被拒绝（抛出错误或忽略）。

### 2.3 心跳保活

Detached task runner 每 **15 秒**向 store 发送 heartbeat：

```javascript
const HEARTBEAT_MS = 15_000;
const heartbeat = setInterval(() => {
  store.heartbeatTask(taskId, WORKER_ID);
}, HEARTBEAT_MS);
```

Store 据此检测 worker 存活。Worker 超时未 heartbeat → 标记任务失败。

### 2.4 Fail-Soft 原则

状态机操作失败时**不得抛到上层**，而是尽力记录终端状态：

```javascript
try { store.markFailed(taskId, ...); } catch { /* already terminal */ }
try { store.heartbeatTask(...); } catch { /* best-effort */ }
```

### 2.5 实现参考

- `services/backend/src/tasks/largeTaskRuntimeStore.js` — 状态机定义
- `services/backend/scripts/task-runner.js` — detached runner + heartbeat

---

## 3. Watchdog 空闲超时

### 3.1 原理

Watchdog 是一个**滑动窗口空闲计时器**。操作每次产生进度时调用 `.touch()`，重置超时截止。超时未 touch → 触发 `onTimeout` 回调。

```
[t=0]  startWatchdog("tool:read_file", 120000)
[t=10] touch()  ← 读到 1KB
[t=20] touch()  ← 读到 2KB
[t=120] 超时！触发 onTimeout → reject("idle timeout after 120s")
```

### 3.2 使用规则

**所有可能长时间无输出的异步操作必须挂载 Watchdog**。定量标准：**预期耗时可能超过 1 秒、且期间可能无输出的异步操作**均属于"可能长时间无输出"，必须挂载 Watchdog：

| 操作类型 | 默认超时 | 环境变量 | 定义/判断依据 |
|----------|----------|----------|----------------|
| 自然工具调用 | 120s | `KHY_WATCHDOG_MS` | 文件 I/O 与外部命令等用户可感知延迟的工具执行 |
| AI Gateway 生成 | 45s hard / 20s idle | `KHY_GATEWAY_TIMEOUT_MS` | 调用 LLM provider 的网络 + 推理过程 |
| 自检 (self-check) | 30s | 硬编码 | 本地快速检查 |
| 网络调用 | 60s | 硬编码 | 单个 HTTP/fetch 请求 |
| Shell 命令 | 30s | 硬编码 | 子进程执行 |

> 新增操作类型时，按上表"定义/判断依据"列对号入座，套用对应类别的默认超时；无法归类的应新增行并说明判断依据。

**AI Gateway 的 "45s hard / 20s idle" 双层超时说明**：

- **hard（45s）**：从发起请求到收到**任何响应字节**的绝对上限，用于防御完全无响应的死连接；
- **idle（20s）**：相邻流式分块（chunk）之间的最大间隔，用于防御中途停流（连接未断但不再产出数据）；
- 两者**同时启用**、各防一类故障：hard 保证"开始有响应"，idle 保证"响应持续推进"。

### 3.3 API

```javascript
const { startWatchdog } = require('./resourceGuard');

const guard = startWatchdog('operation-name', timeoutMs, (name, elapsedSec) => {
  // 超时回调：reject promise 或抛错
  reject(new Error(`Operation "${name}" timed out after ${elapsedSec}s`));
});

// 有进度时 touch
guard.touch();

// 完成时清理
guard.done();

// 查询已耗时
const elapsed = guard.elapsed();
```

### 3.4 强制约束

1. **每个 Watchdog 必须有 `.done()` 清理路径**（成功 / 失败 / 取消 都要调）
2. **超时回调不得吞异常**——必须向上传播（reject promise 或 throw）
3. **Watchdog timer 必须 `.unref()`**——不得阻塞进程退出
4. **内存监控每 30 秒检查一次**，超过 80% heap 触发 GC，超过 95% 告警

### 3.5 覆盖要求

**状态术语定义**：

- **✅ 有** = `startWatchdog()` 在该路径显式创建，且 `.done()` 清理覆盖成功 / 失败 / 取消所有路径；
- **⚠️ 间接有** = Watchdog 只存在于下层依赖中，上层调用方无法感知/处理其超时信号，**不满足要求**，须升级为显式挂载；
- **"需要 touch 链"** = 每次进度事件（工具完成、流式分块、迭代推进）都调用 `guard.touch()`，使 timeoutMs 从固定超时变为真正的空闲超时。

以下路径**必须**有 Watchdog 保护：

| 路径 | 当前状态 | 要求 | 具体行动 |
|------|----------|------|----------|
| `runNaturalToolCall` | ✅ 有 (120s) | 保持 | 无需改动 |
| AI gateway `generate()` | ✅ 有 (hard/idle) | 保持 | 无需改动 |
| `baseSelfCheckService` | ✅ 有 (`withTimeout`) | 保持 | 无需改动 |
| Shell 执行 (`safeExec`) | ✅ 有 (30s) | 保持 | 无需改动 |
| 工具循环 `runToolUseLoop` | ⚠️ 间接有 | 必须显式挂载 | 在循环入口显式 `startWatchdog()`，每轮迭代/工具完成时 `touch()`，循环退出（含异常）时 `.done()` |
| AgentTool 子任务 | ⚠️ 有 timeoutMs 但无 Watchdog touch | 需要 touch 链 | 在子任务迭代推进/工具完成时调用 `guard.touch()`，将固定 timeoutMs 转为空闲超时 |

### 3.6 实现参考

- `services/backend/src/services/resourceGuard.js` — Watchdog + 内存监控
- `services/backend/src/cli/aiGatewayGenerateHelpers.js:178` — 自然工具 Watchdog
- `services/backend/bin/khy.js:1054` — Gateway 超时配置

---

## 4. AbortSignal 中断传播

### 4.1 传播链

```
用户按 ESC
  → TUI ESC handler → controller.abort()
    → controller.signal.aborted = true
      → runToolUseLoop({ abortSignal: controller.signal })
        → tool 执行函数收到 abortSignal
          → 工具主动检查 signal.aborted 并退出
        → Promise.race: 执行 vs 超时拒绝
```

### 4.2 门控开关

AbortSignal 传播由 `KHY_TOOL_ABORT_SIGNAL` 控制：

```
KHY_TOOL_ABORT_SIGNAL=on  → 传播 abortSignal 到工具
KHY_TOOL_ABORT_SIGNAL=off → 不传 abortSignal（逐字节回退）
```

**默认开启**（除非显式关闭）。

### 4.3 工具执行方的责任

每个工具/异步操作**必须**尊重 `abortSignal`：

```javascript
// 模式 1: 传给子 fetch/exec
fetch(url, { signal })

// 模式 2: 定期检查
while (working) {
  if (signal.aborted) throw new Error('Aborted');
  doWork();
}

// 模式 3: Promise.race
const result = await Promise.race([
  longOperation(),
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')));
  }),
]);
```

### 4.4 ESC 中断的响应保证

| 场景 | 响应时间 | 说明 |
|------|----------|------|
| 工具执行中 | < 1s | 工具检查 `signal.aborted` |
| AI 生成中 | < 5s | Gateway 的 AbortController |
| Shell 命令中 | < 1s | `child_process.kill()` |
| 子 agent 任务中 | < 5s | IPC `kill` 消息 |

### 4.5 薄弱点与修复

**当前缺口**：
1. `toolUseLoop` 的 abortSignal 传播依赖 `KHY_TOOL_ABORT_SIGNAL` 门控，关闭时中断不会传播
2. 部分适配器（如 `relayApiAdapter`）可能忽略 `abortSignal`
3. AgentTool 子任务的 abortSignal 传递路径不够直接

**修复原则**：
- `abortSignal` 作为**加法字段**传递——有就传，没有不影响
- 每个异步边界都检查 `signal?.aborted`
- 超时拒绝的 error name 必须为 `AbortError`

### 4.6 实现参考

- `services/backend/src/cli/replSession.js:8724-8735` — ESC → AbortController
- `services/backend/src/cli/tui/hooks/useQueryBridge.js:1555-1575` — TUI abort 传播
- `services/backend/src/cli/aiMessageBuilder.js:351` — abortSignal 传给 gateway

---

## 5. Receipt 轨迹不可遗漏

### 5.1 Receipt 生命周期

```
startReceipt(sessionId, goal)
  → _open Map 中创建 receipt（status: 'running'）
  → 自动 finalize 同会话的前一个 open receipt（defensive）

[tool 调用中]
  → appendToolCall({ tool, params, result, permission, elapsedMs })
  → receipt.toolChain 累加
  → receipt.counts.tools++ / .ok++ / .failed++

[会话结束]
  → finalizeReceipt({ status, summary, error })
  → receipt.finalizedAt = ISO timestamp
  → receipt.durationMs = Date.now() - startedTs
  → 写入磁盘: .khy/receipts/<sessionId>/RCPT-<id>.json
  → 写入审计日志: tool.receipt 事件
```

### 5.2 强制约束

1. **每个长任务会话必须有 Receipt**，从 start 到 finalize 完整闭合
2. **finalizeReceipt 是幂等的**——对无 open receipt 的调用是 no-op
3. **startReceipt 自动清理前一个同会话的 open receipt**，防止遗漏
4. **Receipt 一旦写入磁盘不可变**（不得原地修改已持久化的 JSON 文件）
5. **失败的任务也必须有 Receipt**（status: 'failed' 或 'partial'）

### 5.3 Receipt 结构

```jsonc
{
  "id": "RCPT-20260726-143022-a1b2",
  "sessionId": "s1",
  "traceId": "<32-hex>",
  "requestId": "r1",
  "status": "completed",        // completed | partial | failed | interrupted
  "goal": "分析项目架构",
  "plan": "...",
  "toolChain": [
    { "tool": "read_file", "params": {...}, "result": {...}, "elapsedMs": 25, "permission": "allow" }
  ],
  "artifacts": { "files": [], "summary": "..." },
  "riskApproval": {
    "maxRisk": "safe",
    "humanGated": [],
    "denied": [],
    "permissions": {}
  },
  "error": null,
  "startedAt": "2026-07-26T14:30:22.000Z",
  "startedTs": 1690000000000,
  "finalizedAt": "2026-07-26T14:32:15.000Z",
  "durationMs": 113000,
  "counts": { "tools": 5, "ok": 4, "failed": 1 }
}
```

### 5.4 实现参考

- `services/backend/src/services/receiptService.js` — startReceipt / appendToolCall / finalizeReceipt
- `services/backend/src/services/toolCalling.js:1256` — emitWrapper 驱动 receipt 记录

---

## 6. 重试与退避

### 6.1 指数退避

```
delayMs = min(minDelayMs * 2^(attempt-1) * (1 ± jitter), maxDelayMs)
```

默认参数：
- `attempts = 3`
- `minDelayMs = 300`
- `maxDelayMs = 30000`
- `jitter = 1.0`（±100%）

### 6.2 重试分类

**可重试**：
- `timeout` — 网络超时（对应：TCP/TLS 握手超时或 read 超时）
- `network` — 连接失败（对应：`ECONNREFUSED` / `ENOTFOUND` 等 errno）
- `rate_limit` — 429 限流（对应：HTTP 429）
- `server` — 5xx 服务器错误（对应：HTTP 5xx，但 501 除外，见下方边界情况）

**不可重试**：
- `auth` / `authentication_error` — 认证失败
- `permission_denied` / `forbidden` — 权限拒绝
- `not_found` / `resource_not_found` — 资源不存在
- `validation_error` / `invalid_argument` — 参数错误
- `context_length` — 上下文超长
- `task_cancelled` — 任务已取消
- `circuit_open` — 熔断器打开

**边界情况**：

| 状态码 / 情形 | 分类 | 理由 |
|---------------|------|------|
| HTTP 408 Request Timeout | 可重试 | 与网络超时同因，归入 `timeout` |
| HTTP 502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout | 可重试 | 代理/上游瞬时故障，归入 `server` |
| HTTP 501 Not Implemented | 不可重试 | 功能恒缺失，重试无意义 |
| HTTP 500 但响应文本含 rate limit 信息 | 可重试 | 部分 provider 用 500 包装限流错误，应按 `rate_limit` 处理 |

### 6.3 持久重试模式

无人值守场景（CI）下，429/529 错误持续重试：

```
KHY_UNATTENDED_RETRY=true
  → 指数退避 capped at 5 分钟
  → 绝对上限 6 小时
  → 每 30 秒 heartbeat 保持 CI host 存活
```

### 6.4 任务级重试

大任务（large task）在状态机层面支持重试：

```
running → retry_wait（等待 3s）
  → claimed（重新认领）
  → running（重新执行）
```

重试次数上限由任务自身的 `max_attempts` 字段决定（`createTask` 默认 3，可逐任务指定）。
可重试失败且未达 `max_attempts` → `retry_wait`；重试耗尽 → `dead_letter` 终态。

以下环境变量仅控制持久化历史的环形缓冲条数（防止存储文件无界膨胀），不影响重试行为：

- `KHY_TASK_ATTEMPTS_MAX` — 每任务保留的重试历史记录条数（默认 100）
- `KHY_TASK_CHECKPOINTS_MAX` — 每任务保留的 checkpoint 条数（默认 200）
- `KHY_TASK_EVENTS_MAX` — 全局 task_events 事件条数上限（默认 10000）

### 6.5 实现参考

- `services/backend/src/services/retryWithBackoff.js` — 指数退避 + jitter + Retry-After
- `services/backend/src/tasks/largeTaskRuntimeStore.js:96-100` — 重试分类常量

---

## 7. Fail-Soft 全链路

### 7.1 原则

**任何中间层失败不得阻断上层执行**。失败被记录、降级、或跳过，但绝不静默。

```
工具执行失败
  → tool.wrapper.end 记录 error
    → receipt.appendToolCall 记录失败
      → traceAudit.logEvent 记录审计事件
        → 工具循环继续或结束（不崩）
          → 会话 Receipt finalize（记录完整轨迹）
```

### 7.2 降级模式

| 组件失败 | 降级行为 |
|----------|----------|
| 审计日志写入失败 | 跳过，不阻断执行 |
| Receipt 写入磁盘失败 | 跳过，内存中仍可查询 |
| traceAudit 不可用 | 跳过，不影响工具执行 |
| Watchdog 启动失败 | 无 Watchdog 保护（告警日志） |
| 状态机持久化失败 | 尽力记录终态后退出 |
| WebSocket 发送失败 | 忽略单个客户端，不影响其他 |

### 7.3 失败定位

每个失败必须携带：
1. **错误类型**（errorType / code）
2. **人类可读描述**（message）
3. **恢复建议**（hint，可选）
4. **可恢复标记**（recoverable, retryable）

```javascript
{
  code: "RESOURCE_NOT_FOUND",
  message: "File not found: /path/to/file",
  hint: "Check the file path or create the file first",
  recoverable: true,
  retryable: false
}
```

### 7.4 实现参考

- `services/backend/src/services/toolCalling.js:1256` — emitWrapper fail-soft
- `services/backend/src/services/receiptService.js:291-294` — 写入失败 non-critical
- `services/backend/scripts/task-runner.js:34-36` — heartbeat fail-soft

---

## 8. 内存与资源保护

### 8.1 内存监控

```
每 30 秒检查一次内存使用率
  → > 80%: 触发 GC（global.gc）或清理 expendable 模块缓存
  → > 95%: 告警 + 建议减少并发或重启
```

### 8.2 Shell 资源限制

```javascript
// 自适应容器检测
isContainer() → 跳过 ulimit（cgroup 已限制）
!isContainer() → 应用 ulimit

// 环境变量覆盖
KHY_ULIMIT_NPROC=1024    // 子进程数上限（默认 256→1024）
KHY_ULIMIT_VMEM=...       // 虚拟内存
KHY_ULIMIT_FD=...         // 文件描述符
KHY_ULIMIT_FSIZE=...      // 文件大小
```

### 8.3 进程退出保护

```
所有 timer/interval 必须 .unref()
  → 不阻止进程退出
  → 防止僵尸进程
```

### 8.4 实现参考

- `services/backend/src/services/resourceGuard.js` — 内存监控 + 容器检测 + safeExec

---

## 9. 跨进程一致性

### 9.1 多进程数据一致性

TUI 和 Web 后端是**不同进程**，共享同一份磁盘存储（`large_task_runtime.json`）。

**问题**：A 进程加载后 in-memory 永不再读盘 → 看不到 B 进程的写入。

**修复**：`KHY_TASK_STORE_RELOAD_ON_STALE`（默认开启）—— 读操作检测磁盘 mtime 前进时重新对齐。

### 9.2 单进程数据原则

- **`largeTaskRuntimeStore` 是唯一权威数据源**（SSOT）
- 所有状态变更必须通过 store 的方法（`claimTask`, `startTask`, `markSucceeded` 等）
- 不得直接读写 `large_task_runtime.json`

### 9.3 并发控制

- 状态机转换校验（非法转换被拒绝）
- Claim 操作原子性（CAS 或文件锁）
- 同一任务不能被两个 worker 同时 claimed

### 9.4 实现参考

- `services/backend/src/tasks/largeTaskRuntimeStore.js:57-67` — stale reload 机制

---

## 10. 可靠性门禁

### 10.1 发布阶段

可靠性校验已加入发布门禁：

```javascript
{
  id: 'reliability-gate',
  title: '可靠性契约校验(状态机/Watchdog/Receipt/AbortSignal)',
  tier: 'must',
  kind: 'deterministic',
  command: 'node scripts/ci/validate-reliability.js',
}
```

### 10.2 校验项

| 校验 | 规则 |
|------|------|
| 状态机合法性 | 所有状态转换在 `STATUS_TRANSITIONS` 中合法 |
| Watchdog 覆盖率 | 所有 `execSync`/`spawn`/长时间异步调用有超时保护 |
| Receipt 闭合 | 无无限期 open 的 Receipt（测试环境） |
| AbortSignal 传播 | ESC 中断链路中每个异步边界检查 `signal.aborted` |
| 重试分类 | 不可重试错误不进入重试循环 |

### 10.3 实现参考

- `scripts/ci/validate-reliability.js` — 可靠性契约校验执行器
- `scripts/release/lib/releaseGateStages.js` — 门禁阶段定义

---

## 附录 A：可靠性模式速查

| 场景 | 模式 | 关键代码 |
|------|------|----------|
| 长时间无输出 | Watchdog + touch | `resourceGuard.startWatchdog()` |
| 用户按 ESC | AbortController + signal | `controller.abort()` → `signal.aborted` |
| 网络请求 | retryWithBackoff + 退避 | `retryWithBackoff(fn, { attempts: 3 })` |
| 任务崩溃恢复 | Durable store + heartbeat | `largeTaskRuntimeStore` + 15s heartbeat |
| 工具链可追溯 | Receipt 轨迹 | `receiptService.startReceipt/finalizeReceipt` |
| 无限循环保护 | 迭代上限 + Watchdog | `loopMaxIterations` + `idleTimeoutMs` |
| 内存泄漏防护 | GC 监控 + 模块卸载 | `resourceGuard.checkMemoryPressure()` |
| 审计不可丢失 | fail-soft + 多级 fallback | try/catch 逐层降级 |

## 附录 B：关联文档

| 文件 | 关系 |
|------|------|
| `COMMUNICATION-PROTOCOL.md`（规划中，尚未创建） | 互补：消息传输协议 |
| `FILE-FORMAT-PROTOCOL.md` | 互补：文件存储格式 |
| `scripts/ci/validate-reliability.js` | 实现：可靠性校验执行器 |
| `scripts/release/lib/releaseGateStages.js` | 集成：可靠性门禁阶段 |
