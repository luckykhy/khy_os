# [DESIGN-ARCH-031] 网关日志租界隔离 — 按需可见与净味翻译

状态：已实现（Goal「Agent 日志隔离架构师」闭环）
依赖前序：[DESIGN-ARCH-025] 元规划 · [DESIGN-ARCH-027] 依赖自愈 · [DESIGN-ARCH-028] 通信防御零静默 · [DESIGN-ARCH-029] 有限窗口降级
实现位置：`services/backend/src/services/gatewayLogLease/`
验收测试：`services/backend/tests/services/gatewayLogLease/gatewayLogLease.test.js`（22 例全绿）

---

## 1. 问题：适配器日志越界泄漏

AI 网关挂着 17 个适配器（kiro / codex / claude / trae / cursor / windsurf / vscode /
warp / localllm / ollama / api / relay …）。它们的内部维护动作——Token 刷新、降级、
重试、探活、依赖缺失——会在**与该适配器无关的任务执行期间**把机器味日志直接打到主输出流。

典型坏味：

- 用户正用 DeepSeek 写代码，后台 Kiro 的 Token 定时刷新失败，主流里突然冒出
  `[kiroAdapter] Token refresh failed, falling back to alternate token source`。
- 未选中的适配器后台异步 reject，冒泡成全局 `UnhandledRejection`，污染主流甚至崩进程。
- 底层 `API Error: 400 Invalid Request` / `requires puppeteer` 直接透给用户，暴露内幕、
  状态码、适配器名、Token 串、URL、文件路径。

### 自查发现的泄漏点（leak-site map）

| 层 | 位置 | 泄漏形态 |
| --- | --- | --- |
| 适配器内部 | `src/services/gateway/adapters/*`（17 个） | Token 刷新 / 降级 / 重试直接 `console.*` 到主流，带 `[xxxAdapter]` 前缀 |
| 网关路由 | `aiGateway.js` `emitStatus`(:3137) / `forwardGatewayChunk`(:3119) | 模型选举/切换时把适配器名+错误细节并入用户流 |
| 失败归因 | `aiGateway.js` `_buildFailureReasonSection`(:213) / `_sanitizeFailureMessage`(:193) / `_normalizeAdapterSig`(:201) | 失败原因段落含原始适配器签名 |
| 全局处理器 | `daemonEntry.js`(:19/:201/:206) / `crashRecovery.js`(:234/:274) / `failsafe/streamInjector.js`(:147/:150) | 未选中适配器的异步报错经全局 handler 落主流 |
| 缺中央 logger | 全后端无统一日志出口（仅 `credentialWatcherService.js:284` 有环形缓冲先例） | 无处可做集中裁决 |

---

## 2. 设计：网关日志租界（Gateway Log Lease）

「租界」= 给每一条执行路径发一张**临时可见性凭照**。日志在落地前反查这张凭照，决定去哪。
凭照随 `AsyncLocalStorage` 调用栈携带，任何深处的适配器日志都能反查到「我现在属于谁、什么模式」。

### 2.1 按需可见规则表（四象限）

| 触发场景 | 可见? | 去向 | 示例 |
| --- | --- | --- | --- |
| 当前任务**未使用**该适配器 | ❌ 绝对不可见 | L1（开发日志）/ DROP | 用 DeepSeek 时 Kiro Token 刷新失败 → 主流无输出 |
| 当前任务**正在使用**该适配器 | ✅ 可见（净味后） | L0 用户流（友好句）/ 纯噪音→DROP | 用 Kiro 时 API 报错 → 「当前模型响应异常，正在自动修复…」 |
| 用户**查网关状态** | ✅ 全量可见 | L0（脱敏摘要，保留适配器名） | `/gateways` → 显示 `kiro: Token 过期` |
| **静默沙箱**（init/Token 刷新） | ❌ 不可见 | BUFFER（上下文缓冲，可回放） | Token 刷新内部输出 → 全部进 buffer，主流寂静 |
| 进程崩溃 / 全局异常 | ⚠️ 仅结构化摘要 | L1（debug.log / 内存环） | UnhandledRejection（适配器可归因）→ 写 L1 |

通道（channel）取值：`L0`=用户流（净味后）· `L1`=开发日志 · `BUFFER`=沙箱缓冲 · `DROP`=/dev/null。

### 2.2 两个正交的 AsyncLocalStorage 上下文

| 上下文 | 文件 | 携带 | 回答 |
| --- | --- | --- | --- |
| 租界（lease） | `context.js` `_store` | `{activeAdapter, mode, buffer, seq}` | 「这条路径属于哪个活跃适配器、什么模式」 |
| 来源（provenance） | `sandbox.js` `_sourceStore` | `adapterId` | 「这条日志是谁打的」 |

二者正交：一次 DeepSeek 请求里，lease.activeAdapter=`deepseek`；若 Kiro 的后台日志带
`[kiroAdapter]` 标记在同一异步树里触发，则它的来源经文本标记判为 `kiro` ≠ 活跃 `deepseek` → 落 L1。

> 关键裁决（`sandbox._resolveSource`）：**显式带源 > 文本标记嗅探 > provenance 上下文**。
> 文本里显式带 `[xxxAdapter]` 时，即便它出现在别的适配器的 provenance 块内，也归到被点名者，
> 否则跨适配器后台日志会被误判为当前活跃适配器而错误放行 L0。

---

## 3. 实现：四件套

```
src/services/gatewayLogLease/
  context.js      AsyncLocalStorage 租界上下文（地基）
  noiseFilter.js  净味翻译层（NoiseFilter）：底层错误→友好句 / 脱敏
  logLease.js     GatewayLogLease：四象限可见性决策引擎
  sandbox.js      AdapterLogSandbox：拦截底层输出 + 静默沙箱 + 后台守卫 + 全局安全网
  devLog.js       L1 开发日志接收端（内存环 + 可选 debug.log，永不抢占 stdout）
  index.js        门面
```

### 3.1 NoiseFilter（净味翻译）

`translate(raw) → string|null`：有序规则匹配，第一条命中即返回。
- `user:'友好句'` → 翻译；`user:null` → 纯内部噪音，吞掉。
- 未命中任何规则**绝不返回机器味原文**，给脱敏兜底句「模型服务处理中…」。

| 底层 | → 用户可见 |
| --- | --- |
| `[kiroAdapter] Token refresh failed, falling back...` | 模型服务正在切换… |
| `✗ news(...) 本地依赖不完整` | 正在尝试其他方式获取… |
| `API Error: 400 Invalid Request` | 当前模型响应异常，正在自动修复… |
| `this action requires puppeteer` | 正在降级到轻量模式… |
| `[kiro:debug] probe heartbeat ok` | （吞掉，null） |

`sanitize(text)`：抹 Bearer/Token/hash/URL/路径/`[xxxAdapter]`/适配器名 → `[token]`/`[url]`/`[path]`。
`sanitizeForStatus(raw, maxLen)`：查询态用，保留可读错误，仅抹 Token/URL/hash，**保留适配器名**（状态查询里它是合法信息）。

### 3.2 GatewayLogLease（决策引擎）

`decide({sourceAdapter, level, text}) → {visible, channel, output, raw}`，规则写死在此不可绕过：
- 无上下文 → `{false, L1}`（游离日志绝不上主流）
- `status-query` → `{true, L0}`（`sanitizeForStatus`）
- `sandbox` → `{false, BUFFER}`
- `task` & 源===活跃 → `translate`（null→DROP，否则 L0）
- `task` & 源≠活跃 → `{false, L1}`

### 3.3 AdapterLogSandbox（拦截 + 沙箱 + 守卫）

- `install({force, userSink})`：幂等、env `KHY_GATEWAY_LOG_LEASE` 门控，补丁
  `console.{log,info,warn,error,debug}` + `process.stdout/stderr.write`；返回 `uninstall()`。
  **非适配器、非租界内的普通日志原样放行（最小爆破半径，绝不接管全局日志）。**
- `runForAdapter(id, fn)`：请求绑定活跃适配器（task 模式）。
- `runStatusQuery(fn)`：查询态全量放行。
- `runSandboxed(id, fn) → {result, buffer, error}`：init/Token 刷新整体静默，内部输出进 buffer，
  抛错不外泄（结构化 error + 摘要下沉 L1）。
- `guardBackground(id, fnOrPromise)`：包裹「发射后不管」后台异步，rejection 就地捕获→L1，
  **永不 reject**（失败 resolve(null)），绝不冒泡成全局 UnhandledRejection。
- `installProcessGuards()`：保守全局安全网——只认领**适配器可归因**且**源≠活跃**的
  `unhandledRejection`，写 L1；其余交还既有处理器，绝不越权。
- `emit(id, level, …args)`：适配器显式带源打日志（推荐，不依赖文本嗅探）。

### 3.4 devLog（L1 接收端）

内存环（`RING_MAX=500`）始终在；env `KHY_GATEWAY_LOG_LEASE_FILE` 指定时附加结构化 JSON 行。
**写文件失败绝不抛错、绝不回退 stdout**（回退=又污染主流）。

---

## 4. 接入接缝（最小侵入，对齐 ARCH-025/027/029 先例）

本子系统自带闭环 + 文档化接缝，不外科改写 6k 行的 `aiGateway.js`：

```js
const lease = require('.../gatewayLogLease');
lease.install();                                  // 进程启动一次（env 门控）
lease.installProcessGuards();                      // 全局安全网

await lease.runForAdapter('kiro', () => gateway.chat(...));      // 请求路径绑定活跃适配器
const { result, error } = await lease.runSandboxed('kiro', () => refreshToken());  // Token 刷新静默
lease.guardBackground('kiro', () => probeHealth());             // 后台 rejection 不冒泡
lease.emit('kiro', 'warn', 'Token refresh failed, falling back'); // 适配器显式打日志
await lease.runStatusQuery(() => buildGatewayStatus());          // /gateways 全量可见
```

建议落点：网关请求入口包 `runForAdapter`；适配器 init/refresh 包 `runSandboxed`；
探活/定时刷新包 `guardBackground`；状态端点 `aiManagementServer.js:1545` 包 `runStatusQuery`。

---

## 5. 防呆铁律（与 Goal 原文逐条对应）

1. **绝不允许适配器内部直接原生输出到主流** → 必须经 Sandbox 路由；`install` 补丁 console/stdout，
   `runSandboxed` 把内部输出重定向 buffer。
2. **绝不允许底层原始 Error 暴露给用户** → 必须经 NoiseFilter；`translate` 产物只可能是预置友好句或
   脱敏兜底句，未命中绝不返回机器味原文。
3. **未被选中的适配器内部异步报错必须被吞掉或重定向到文件** → `guardBackground` 永不 reject、
   `installProcessGuards` 把适配器可归因的 unhandledRejection 下沉 L1，绝不触发全局未处理异常。
4. 拦截器自身任何异常都 fail-safe 回退「原样放行」，绝不吞掉真正该见的输出、绝不抛错。
5. `install`/`installProcessGuards` 幂等、env 门控（缺省关，显式开），可完整 `uninstall` 还原。

---

## 6. 验收

`node --test tests/services/gatewayLogLease/gatewayLogLease.test.js` → 22/22 绿。覆盖：

- 净味翻译：底层错误→友好句 / 纯噪音→吞掉 / 脱敏抹 Token·URL·路径·适配器名。
- 四象限决策：未用适配器零泄漏 / 在用净味可见 / 查网关全量可见 / 沙箱重定向缓冲 / 游离落 L1。
- **核心端到端**：用 DeepSeek 执行任务时 Kiro 后台 `console` 报错 → 用户流零泄漏（无 `kiro`/无
  `token refresh` 字样），错误下沉 L1。
- 静默沙箱：Token 刷新内部输出绝不上 L0、落 buffer；沙箱内抛错不外泄、摘要脱敏。
- 后台守卫：`guardBackground` 吞 rejection 下沉 L1 永不冒泡；`installProcessGuards` 幂等可还原。
- emit 显式带源优先于嗅探。
