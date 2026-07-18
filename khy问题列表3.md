# KHY OS 问题列表 [3]

> 生成时间：2026-07-17
> 审查范围：`bundled/`（聚焦前两轮未深入的盲区：安全增强、CLI 命令完整性、WebSocket、依赖管理、测试覆盖、数据库模型层）
> 审查方法：**证据优先**——每项有精确文件+行号+亲验代码原文，附「成立把握」与「反证检查」。三项最高危（Q-023/Q-024/Q-025）由主审二次亲验。
> 状态说明：🔴 严重 | 🟠 高 | 🟡 中 | 🟢 低
> 已知项排除：列表 [1]/[2] 已覆盖的全部不重复上报。

---

## 一、安全增强（3项）

### Q-023 🟠 ai-backend CORS 默认 `*` + credentials 不安全组合
- **位置**：`services/ai-backend/server.js` L29-32（亲验）
- **证据**：`origin: process.env.AI_MGMT_CORS_ORIGINS || '*'` + `credentials: true`
- **成立把握**：高
- **反证检查**：cors 库在 `origin:'*'` + `credentials:true` 时，对每个带 Origin 的请求回 `ACAO: <origin>` + `ACAC: true` → 任意网站可带 cookie 跨域。生产可 env 修正，但默认值不安全。
- **建议**：默认值改为 `false`，或 origin 为 `*` 时去掉 credentials

### Q-024 🟡 news.js Python 代码拼接注入（已修复）
- **位置**：`software/khyquant/routes/news.js` L16/L40/L46（亲验）
- **证据**：`const { keyword } = req.query` → `const sym = keyword || '000001'` → `'df = ak.stock_news_em(symbol="' + sym + '")'` → `spawn(pythonPath, ['-c', script])`
- **成立把握**：高
- **反证检查**：spawn 用 `['-c', script]` 参数传递（非 shell），但 script 内部字符串拼接让 Python 代码注入成立——`keyword='");import os;os.system("rm -rf /')` 闭合 symbol 字符串并执行任意 Python。需登录但任何用户可触发。无白名单/转义。
- **建议**：改用参数传递 `spawn(pythonPath, [scriptPath, sym, limit])`，或 keyword 白名单

### Q-025 🟠 auth.js admin 后门密码兼容逻辑（硬编码明文）
- **位置**：`services/ai-backend/src/routes/auth.js` L22-52（亲验）
- **证据**：L23 `const candidates = ['admin123.']`；L36 `password === 'admin123'` 明文比较；L44 `user.update({ password: 'admin123' })` 明文 update；L79 错误消息泄露重置命令
- **成立把握**：高
- **反证检查**：注释说是"Compatibility"兼容层。env 可覆盖候选（L24-26），但 L36/L44 的 `'admin123'` 明文字面量不可通过 env 移除。定 🟠（非 🔴，因需登录且是兼容设计）。
- **建议**：后门密码完全 env 化，移除明文字面量

---

## 二、CLI 命令完整性（3项）

### Q-026 🟡 `gateway vertex` 子命令未注册（已修复）
- **位置**：`services/backend/src/cli/router.js` L1212 + `constants/commandSchema.js` L111 + `handlers/gateway.js` L2220
- **证据**：router.js 有 `else if (subCommand === 'vertex')`，但 `ROUTER_SUB_COMMANDS.gateway` 不含 `'vertex'` → parseInput 不剥离 → 分支永不可达
- **成立把握**：高
- **反证检查**：静态克隆自 SSOT；aliases.js 无 vertex 别名；handleGatewayVertex 全局仅 router.js 一处调用。docstring 写"给它一个真实 CLI 消费者"但从未接通。
- **建议**：在 `ROUTER_SUB_COMMANDS.gateway` 补入 `'vertex'`

### Q-027 🟡 `proxy core` 子命令未注册（已修复）
- **位置**：`router.js` L1790 + `commandSchema.js` L114 + `handlers/proxy.js` L2424
- **证据**：同型问题。`ROUTER_SUB_COMMANDS.proxy` 不含 `'core'`。docstring 自承 'core' 是"unknown subcommand"
- **成立把握**：高
- **反证检查**：handleProxyCore 全局仅 router.js 一处调用。
- **建议**：在 `ROUTER_SUB_COMMANDS.proxy` 补入 `'core'`

### Q-028 🟡 `bridge nginx` 未注册 + restArgs 未定义（已修复）
- **位置**：`services/backend/src/cli/routerDispatchTail.js` L1098-1112 + `commandSchema.js` L193
- **证据**：`ROUTER_SUB_COMMANDS.bridge` 不含 `'nginx'`；分支内 `restArgs` 在函数作用域从未声明（0 处定义、7 处使用）→ 纵使注册也会 `ReferenceError`；usage 字符串还把 nginx 列为可用选项
- **成立把握**：高
- **反证检查**：grep 全文件 restArgs 0 处定义；函数签名解构 `_ctx` 无 restArgs。`bridge start/stop/status/token` 已注册正常，仅 nginx 受影响。
- **建议**：① 补注册 `'nginx'`；② 将 `restArgs` 改为 `args`

---

## 三、工具链脚本（1项）

### Q-029 🟡 build-khy-os.sh moonbit 脚本硬编码开发者本地路径
- **位置**：`scripts/build-khy-os.sh` L181-182
- **证据**：`local moon_linux="${MOONBIT_LINUX_TAR:-/home/kodehu03/Downloads/moonbit-linux-x86_64.tar(1).gz}"`
- **成立把握**：低
- **反证检查**：与列表[2] Q-020 已修的 `run-wasm-indicators-tests-offline.sh` L7-8 同源默认值副本；该脚本经 `maybe_fail_or_warn` 优雅降级，env 可覆盖。
- **建议**：统一默认值改为相对路径或要求 env 必设

---

## 四、数据库模型层（1项）

### Q-030 🟡 多个 Sequelize 模型缺少外键列索引
- **位置**：`platform/packages/shared/src/models/Backtest.js` L133-137（主例）；同类：`AISuggestion.js` L58-61、`Signal.js` L49-52、`ApiKey.js` L50-53
- **证据**：Backtest 的 `user_id`/`strategy_id` 为外键但无 `indexes`；对比 `Trade.js` L119-129 有完整 indexes
- **成立把握**：中
- **反证检查**：`bootstrap.js` L128 `sequelize.sync({force:false})` 按模型 indexes 建索引 → 缺失实际生效；无对应 migration。单机 SQLite 影响小，Postgres 明显。全仓无 `sync({alter:true})` 或 `sync({force:true})` ✅
- **建议**：为 Backtest/AISuggestion/Signal 补充 FK 索引

---

## 五、WebSocket / 实时通信（4项）n
### Q-031 🟠 Slack Socket Mode 断线后无自动重连
- **位置**：`services/backend/src/services/channels/slackChannel.js` L158-165
- **证据**：`this._ws.on('close', () => { this._ws = null; })` — 仅置 null，无重连
- **成立把握**：高
- **反证检查**：Slack 官方要求自动重连。`_connected` 仍为 true 形成“假连接”。事件静默丢失。
- **建议**：close 事件中加指数退避重连

### Q-032 🟡 bridgeServer 缺少服务端主动心跳探测
- **位置**：`services/backend/src/bridge/bridgeServer.js` L310-339
- **证据**：无 `setInterval(ping)` 或 `ws.ping()`
- **成立把握**：高
- **反证检查**：对比 aiManagementServer.js gcSweep（30s 定时扫描 + idle timeout），bridgeServer 无等价机制。半开 TCP 不触发 close → 客户端永久留在 `_clients` Map。
- **建议**：加服务端 ping + idle timeout 清理

### Q-033 🟢 aiManagementServer cleanupSession 泄漏 authTimer
- **位置**：`services/backend/src/services/aiManagementServer.js` L1703/L2001-2012
- **证据**：authTimer 是局部变量，cleanupSession 无法访问 → 未认证断连时 30s 定时器泄漏
- **成立把握**：高
- **反证检查**：wsSend try/catch 静默吞异常不崩溃。每个未认证断连泄漏一个 30s 定时器，正常负载下影响微乎其微。
- **建议**：将 authTimer 挂到 session 对象，cleanupSession 中 clearTimeout

### Q-034 🟡 KhyFloatBall 任务同步 WebSocket 无断线重连
- **位置**：`apps/ai-frontend/src/components/KhyFloatBall.vue` L498-503
- **证据**：`ws.onclose` 中只清状态不重连。`startTaskSync` 只在 `openTasks()` 时调用一次
- **成立把握**：高
- **反证检查**：对比 relayPage.js（L127 `setInterval(connect, 3000)` 重连），此处省略。面板关闭即 stopTaskSync 正确，但打开期间应有重连。
- **建议**：onclose 中加指数退避重连

---

## 六、依赖管理（4项）n
### Q-035 🟠 ai-backend 缺少 package-lock.json
- **位置**：`services/ai-backend/`（Glob 确认 0 结果）
- **证据**：对比 backend（12947行）和 ai-frontend（2300行）均有锁文件
- **成立把握**：高
- **反证检查**：独立部署单元（有 Dockerfile），不是 monorepo workspace 子包。无锁文件 → CI 不可复现。
- **建议**：生成并提交 package-lock.json

### Q-036 🟡 services/backend moment 和 redis 为孤儿依赖
- **位置**：`services/backend/package.json` L110/L120
- **证据**：`grep require('moment')` 和 `grep require('redis')` 在 backend/src 0 命中
- **成立把握**：高
- **反证检查**：moment 是 legacy 包（官方标注不推荐）；redis 拉到生产但未使用。
- **建议**：从 dependencies 移除

### Q-037 🟡 ai-backend ioredis/bcryptjs/pg 无直接引用
- **位置**：`services/ai-backend/package.json` L13/L20/L23
- **证据**：ioredis 0 require；bcryptjs 0 require；pg 0 require（可能被 sequelize 间接加载）
- **成立把握**：高（ioredis/bcryptjs）/ 中（pg）
- **反证检查**：ioredis 仅在 rateLimiter.js 注释出现；pg 可能是 sequelize dialect peerDependency。
- **建议**：移除 ioredis/bcryptjs；pg 核验 shared package.json

### Q-038 🟡 ai-frontend 构建工具错放 dependencies
- **位置**：`apps/ai-frontend/package.json` L15-26
- **证据**：vite、@vitejs/plugin-vue 在 dependencies；devDependencies 为空
- **成立把握**：高
- **反证检查**：对比 khyquant/frontend 正确地将 vite 等放在 devDependencies。
- **建议**：将构建工具移至 devDependencies

---

## 七、测试覆盖（4项）n
### Q-039 🟠 ai-backend 19 个测试文件无法运行
- **位置**：`services/ai-backend/package.json` L6-9（无 test 脚本、无 jest 配置、devDependencies 空）
- **证据**：19 个 .test.js 全部使用 Jest API，但无 test 脚本、无 jest 依赖声明
- **成立把握**：高
- **反证检查**：写了测试但跑不起来。CI 中不会执行。
- **建议**：添加 jest 配置 + test 脚本 + devDependencies

### Q-040 🟠 ai-frontend 12 个测试文件无法运行
- **位置**：`apps/ai-frontend/package.json` L6-13
- **证据**：11 个 .test.js + 1 个 .test.mjs，但无测试框架配置
- **成立把握**：高
- **反证检查**：项目用 Vite，自然选 vitest，但既无配置也无 test 脚本。
- **建议**：添加 vitest 配置 + test 脚本

### Q-041 🟡 khyquant 前端零测试文件
- **位置**：`software/khyquant/frontend/`（Glob 0 结果）
- **证据**：无 .test/.spec 文件，无 test 脚本，无测试框架
- **成立把握**：高
- **反证检查**：完整量化交易前端应用零测试覆盖。
- **建议**：至少为核心交易逻辑添加单元测试

### Q-042 🟡 khyquant Python 后端零测试文件
- **位置**：`software/khyquant/`（Glob tests/**/*.py 0 结果）
- **证据**：47 个 service 文件、20 个 route 文件，但无测试
- **成立把握**：中
- **反证检查**：需进一步核验 software/khyquant/tests/ 下 2 个文件是否为有意义测试
- **建议**：为核心回测/交易逻辑添加 Python 测试

---

## 统计

| 严重级别 | 数量 |
|---------|------|
| 🔴 严重 | 0 |
| 🟠 高 | 6 |
| 🟡 中 | 13 |
| 🟢 低 | 1 |
| **总计** | **20** |

> 三项最高危（Q-023 CORS / Q-024 Python 注入 / Q-025 admin 后门密码）均由主审二次亲验代码确认。CLI 三项（Q-026/027/028）为同一根因模式：handler case 引用了未在 commandSchema 注册的子命令。
>
> 修订记录（2026-07-17 自我对抗修复轮）：
> - Q-024 已修复 — `software/khyquant/routes/news.js` L17-20 加 keyword 白名单校验 `/^[A-Za-z0-9.\-_]{1,20}$/`，拒绝含引号/分号/括号的输入，从源头阻断 Python 代码注入。`node --check` 通过。
> - Q-026 已修复 — `commandSchema.js` L111 `ROUTER_SUB_COMMANDS.gateway` 补入 `'vertex'`，`khy gateway vertex` 不再落入 status。
> - Q-027 已修复 — `commandSchema.js` L114 `ROUTER_SUB_COMMANDS.proxy` 补入 `'core'`。
> - Q-028 已修复 — `commandSchema.js` L193 `ROUTER_SUB_COMMANDS.bridge` 补入 `'nginx'`；`routerDispatchTail.js` L1101-1108 全部 `restArgs` 改为 `args`（函数签名已解构的变量）。`node --check` 通过。
>
