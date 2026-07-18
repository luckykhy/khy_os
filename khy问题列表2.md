# KHY OS 问题列表 [2]

> 生成时间：2026-07-17
> 审查范围：`bundled/` 全量快照（services/backend、services/ai-backend、apps/ai-frontend、software/khyquant、kernel、scripts、根目录产物）
> 审查方法：**证据优先**——每项必须有精确文件+行号+亲验代码原文，附「成立把握」与「反证检查」。宁可少列不臆断（吸取列表 [1] 多个 🔴 被反证推翻的教训）。
> 状态说明：🔴 严重 | 🟠 高 | 🟡 中 | 🟢 低
> 已知项排除：`.env` 密钥为占位、legacy JWT 已过期、`verifyExportPassword` 恒 true（有意移除密码门）、双网关两套实现、API Key Pool 成功路径 token 漏记（已在列表 [1] P-016 修复）——本列表不重复上报。

---

## 一、安全与凭据（3项）

### Q-001 🟡 scan_test.js：打印本地明文凭据的调试残留脚本
- **位置**：`scan_test.js`（包根目录）L1-3
- **证据**：
  ```js
  const { collectTraeOfficialArtifacts, resolveTraeOfficialCredential } = require('./backend/src/services/gateway/adapters/traeOfficialArtifacts');
  const cred = resolveTraeOfficialCredential();
  console.log(JSON.stringify(cred, null, 2));
  ```
- **成立把握**：高
- **反证检查**：核验 `traeOfficialArtifacts.js` 的 `resolveTraeOfficialCredential()` **不含**硬编码密钥，凭据来自本地运行时 artifacts（桥接 token 文件）——故**非**密钥泄露。真实问题：会把用户本地 Trae 明文 token `console.log` 出来的调试脚本被打进分发包；且其 `require('./backend/src/...')` 路径断裂（根 `backend/` 无 `src`，真实代码在 `services/backend/src/`），属孤儿脚本。
- **建议**：从发布产物中删除

### Q-002 🟢 _tmp_check_bridge.ps1：临时探活脚本随包分发
- **位置**：`_tmp_check_bridge.ps1`（包根）L2-9
- **证据**：`Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health'`、`.../v1/chat/completions`
- **成立把握**：高
- **反证检查**：无密钥、仅 loopback 探活，非运行时源码模块，故不按规则1运行时硬编码定级；属 `_tmp_` 调试残留 + 写死端点的发布产物污染。
- **建议**：删除

### Q-003 🟢 ml-test.html：测试页硬编码后端地址
- **位置**：`software/khyquant/frontend/ml-test.html` L357（及 L362/L446 fetch）
- **证据**：`const API_BASE = 'http://localhost:3000/api/trading-agents';`
- **成立把握**：高
- **反证检查**：一次性测试 HTML，不进主构建（生产前端走 `serviceDefaults.js` + `VITE_*`）；AGENTS.md 规则1 明将"含测试 html"纳入红线，故列出，但影响面小。
- **建议**：删除测试页或改动态配置

---

## 二、并发与持久化（4项）

### Q-004 🟡 oauthTokenStore 非原子写（已修复）
- **位置**：`services/backend/src/services/mcp/oauthTokenStore.js` L436-462（修复后）
- **原问题**：`_fileSaveAll` 裸 `writeFileSync` 全量覆盖写整个 token 库，无 tmp+rename；写入中途崩溃/断电会截断文件，`_fileLoadAll`(L427-433) 的 catch 把损坏文件当空 `{}` 返回 → **全部 OAuth token 丢失**。
- **修复（2026-07-17）**：改用 `tmp + fsync + rename` 原子写（完全对齐同仓基线 `utils/dataHome.js` `_writePointer`）：
  - 先写入 `${filePath}.tmp-${process.pid}`，mode 0o600（Linux）
  - `fs.openSync('r+')` + `fs.fsyncSync(fd)` + `fs.closeSync(fd)` 确保数据刷盘（Linux ext4/XFS reorder 防护；fsync 在某些 fs 可能 no-op，best-effort swallow）
  - `fs.renameSync(tmp, file)` 原子替换
  - 异常时清理孤立 tmp（best-effort）；错误**上抛**不吞（token 持久化必须让用户感知，不同于 dataHome 的吞掉模式）
  - `_fileStore`/`_fileDelete` 两个调用方无需改动（接口保持）
  - `node --check` 语法通过
- **剩余风险**：tmp 命名仅含 `process.pid`，同进程内并发写入可能互相覆盖——但 `_fileSaveAll` 仅在 MCP OAuth 授权/注销时调用（单进程、串行），无并发问题。
- **建议**：Q-005/Q-006 同类问题（ConfigTool/mcp 配置非原子写）可复用同一模式

### Q-005 🟡 ConfigTool 用户设置非原子写
- **位置**：`services/backend/src/tools/ConfigTool/index.js` L81-84
- **证据**：`fs.writeFileSync(SETTINGS_FILE, JSON.stringify(config, null, 2), 'utf-8')`（全量覆盖）
- **成立把握**：高
- **反证检查**：全量覆盖写、无 tmp+rename，崩溃中途损坏用户设置。对照 dataHome 基线确认可修。
- **建议**：统一采用原子写

### Q-006 🟡 MCP 用户配置非原子写
- **位置**：`services/backend/src/services/mcp/index.js` L925
- **证据**：`fs.writeFileSync(CONFIG_PATHS.user, JSON.stringify(clean, null, 2), 'utf-8')`
- **成立把握**：高
- **反证检查**：同类非原子全量写。另 `mcp/mcpConfigStore.js` L55、`permissionPolicy/config.js` L128 亦为直接写 JSON——同类模式，未逐一确认是否有上层 rename 包裹，标注**需进一步核验**故不单列。
- **建议**：统一原子写入口

### Q-007 🟢 daemonEntry fallback 健康端点未处理 EADDRINUSE
- **位置**：`services/backend/src/services/daemonEntry.js` L148-150
- **证据**：`server.listen(PORT, '127.0.0.1', () => { log(...) })`，无 `server.once('error')`
- **成立把握**：中
- **反证检查**：主路径走 `aiManagementServer.start(PORT)`，后者在 `aiManagementServer.js` L2218 有端口自增重试；本 `listen` 仅在 mgmtServer 无 start/createServer 的极少 fallback 分支触发，故低危。
- **建议**：补 `server.once('error')` 兜底

---

## 三、AI 网关 / 计费 / 限流（3项）

### Q-008 🟡 tokenUsageService 价格表按 provider 粒度、取最便宜档、覆盖不全
- **位置**：`services/backend/src/services/tokenUsageService.js` L18-31（表）、L385-390（计算）
- **证据**：
  ```js
  const TOKEN_PRICING = {
    'OpenAI': { input: 0.15, output: 0.60 },     // gpt-4o-mini
    'Anthropic': { input: 3.00, output: 15.00 }, // claude-3-5-sonnet
    ...
    'default': { input: 0.10, output: 0.30 },
  };
  const pricing = TOKEN_PRICING[provider] || TOKEN_PRICING['default'];
  ```
- **成立把握**：中
- **反证检查**：计价键是 provider 非 model，且每 provider 只取一个最便宜档（OpenAI 取 gpt-4o-mini），同 provider 下贵模型系统性低估；覆盖不全（无 DeepSeek/Kimi/xAI）。**但**全仓 grep 该模块导出函数**0 命中**——`tokenUsageService` 当前未被任何文件引用，属孤立/未接线代码，故无实时计费影响，降为 🟡。
- **建议**：价格表外置配置、按 model 定价；若确废弃则移除

### Q-009 🟢 USD→CNY 汇率硬编码，注释称"定期更新"但无更新入口
- **位置**：`services/backend/src/services/tokenUsageService.js` L14-15
- **证据**：`// USD to CNY exchange rate (approximate, updated periodically)` / `const USD_TO_CNY = 7.25;`
- **成立把握**：高
- **反证检查**：模块级常量，无 env 覆盖/远端拉取/setter；同受 Q-008 "模块未被引用"约束，故 🟢。
- **建议**：env 可覆盖或移除

### Q-010 🟢 Redis 限流内存兜底：空 key 从不回收
- **位置**：`services/backend/src/services/gateway/redisRateLimiter.js` L58-77
- **证据**：`const memoryStore = {}`；`memoryConsume` 裁剪时间戳数组但从不 `delete memoryStore[key]`
- **成立把握**：中
- **反证检查**：兜底确在用（`aiGateway.js` L1650 创建、`aiGatewayRoutingMethods.js` L1016 调 consume）；但对照它对齐的 `rateLimiter.js` `createKeyedRateLimiter` 同样只在显式 reset 删除——**行为一致属既定设计**，且 `adapterKey` 基数受配置适配器数量约束（有限、非用户可控爆量），故 🟢。
- **建议**：可选加 TTL 清理空条目

---

## 四、路由 / 后端服务（1项）

### Q-011 🟢 /backtest/save 直接信任客户端上报的回测指标落库
- **位置**：`software/khyquant/routes/backtest.js` L168-227
- **证据**：`router.post('/save', ...)` 将 body 中 `totalReturn/annualizedReturn/maxDrawdown/winRate` 原样 `Backtest.create({..., status:'completed'})`，无引擎复核
- **成立把握**：中
- **反证检查**：`/run` 由服务端 `backtestEngine.run()` 产出权威结果，而 `/save` 信任前端任意数据；核对 `/run` 与 `/save` 写**同一张 Backtest 表**（非双库双轨）——故"持久化双轨"不成立，仅剩数据完整性问题，且记录归属用户自身、影响有限，故 🟢。
- **建议**：`/save` 校验/复算或标注数据来源

---

## 五、服务启动 / 端口（1项）

### Q-012 🟡 ai-backend 无 EADDRINUSE 自动探测（已修复）
- **位置**：`services/ai-backend/server.js` L85-148（修复后）
- **原问题**：裸 `app.listen(PORT)` 未注册 `server.on('error')`；EADDRINUSE 由 Node 异步 emit，不被 `start().catch` 捕获 → 无监听者 → 进程未捕获异常崩溃，无端口回退。与 backend `server.js listenWithAutoPort`（L1333-1395）的落差属实。
- **修复（2026-07-17）**：改用 `http.createServer(app)` + `tryListen` 模式（完全镜像 `services/backend/src/services/aiManagementServer.js` L2206-2231）：
  - 捕获 `EADDRINUSE` 后自动 +1 端口重试，最多 10 次（env `AI_MGMT_PORT_RETRY` 可调）
  - 非 EADDRINUSE 错误走 `reject` → `start().catch` 捕获 → 正常退出
  - 实际端口通过 `server.address().port` 读出，控制台输出真实端口
  - WebSocket 绑定同一 server 实例，不受端口变化影响
  - `node --check` 语法校验通过
- **剩余风险**：若上游（前端/反向代理）硬编码 9090 则自动改口后连不上——已 grep 全仓确认 `9090`/`AI_MGMT_PORT` 在 ai-backend 外 **0 命中**，无硬编码消费方。
- **建议**：可选加 `process.env.AI_MGMT_PORT_ACTUAL` 导出供子进程/上游发现

---

## 六、AGENTS.md 规则（1项）

### Q-013 🟡 规则3违规：剪贴板中继硬墙钟超时
- **位置**：`services/backend/src/services/gateway/adapters/clipboardRelayAdapter.js` L328-344
- **证据**：
  ```js
  const startTime = Date.now();
  const pollTimer = setInterval(() => {
    if (Date.now() - startTime > MAX_WAIT_MS) { clearInterval(pollTimer); resolve(buildFailure('剪贴板中继超时 ...')); }
  ```
- **成立把握**：中
- **反证检查**：正是规则3所禁的 `Date.now() - start > LIMIT` 硬墙钟。内层有 `settleTimer` 在剪贴板内容变化时重置（局部感知），但外层 `startTime` 上限**不因 AI 正在流式产出而重置**，且这是分钟级等待活跃 AI 回复的场景，不符合"短 I/O 握手"例外，故判软违规；因属人在环 I/O 边界情形，把握中。
- **建议**：外层超时改为空闲/滑动超时（有剪贴板变化即重置）
- **反证补充**：规则1（运行时源码）、规则2（含糊文案）、规则4（滚动区）经全量 grep + 上下文核验**均无成立违规**。

---

## 七、前端（3项）

### Q-014 🟢 Trading.vue updateStrategyStats 为死代码（原 🔴 经自我对抗推翻，撤销）
- **位置**：`software/khyquant/frontend/src/views/Trading.vue` L2361-2397（`updateStrategyStats`）、L2843-2871（`updateStrategyStatsLocal`）、L1206（`strategyRealTimeStats` ref）、L2529-2539（30s 定时器）
- **证据**：代码确实用 `Math.random()` 编造 totalReturn/winRate/sharpeRatio 等，注释自认"实际项目中应该从后端获取"
- **反证检查（推翻原结论）**：`strategyRealTimeStats`、`totalReturn`、`todayReturn`、`winRate`、`maxDrawdown`、`sharpeRatio`、`totalTrades` 这七个关键字在 `<template>` 中**一次也没出现**（已用 grep 对 L1 起 `<template>` 开始的全模板交叉核验）。→ **用户根本看不到**这些随机数据。
- **结论**：原"量化终端向用户展示随机绩效"的 🔴 断言**不成立**。实际情况：`updateStrategyStats()` 是一段死代码 + 每 30s 计算一次的无用 CPU，等待后端接线接入（注释自白）。降为 🟢（死代码 + 无用计算）
- **建议**：接入真实后端或删除占位代码与无用 30s 定时器

### Q-015 🟠 generateMockMarketData：随机行情作为静默回退
- **位置**：`software/khyquant/frontend/src/views/Trading.vue` L3448-3480
- **证据**：`// 四级回退的第四级 ... 使用随机算法生成一条仿真行情`；`change = (Math.random() - 0.5) * (basePrice * 0.02)`、`volume: Math.floor(Math.random() * 10000000) + 1000000`
- **成立把握**：中
- **反证检查**：注释表明是"四级回退的第四级"的**有意设计**，且项目有 `DataSourceIndicator.vue` 数据源指示组件——非纯缺陷。但随机行情价与真实价混用仍有误导风险；**用户端是否明确触发数据源降级提示需进一步核验**该函数消费处。
- **建议**：确认第四级回退时 UI 强制显示"模拟行情"标识

### Q-016 🟡 前端状态多头（Pinia + reactive + localStorage）
- **位置**：`software/khyquant/frontend/src/stores/strategyStore.js`（L26-30 `reactive(new Map())`×3、L303-407 反复 localStorage）；`Trading.vue` L1206 `strategyRealTimeStats` 为独立本地 ref 不走 store；后端 URL 又分散在 `connectionMode.js`/`clientMode.js` 各自 localStorage
- **成立把握**：中
- **反证检查**：localStorage 有成对 save/load（部分同步），并非完全无同步；属结构性技术债非硬缺陷。
- **建议**：统一状态管理入口

---

## 八、打包 / 清理（1项）

### Q-017 🟡 空目录随包分发
- **位置**：`frontend/`、`packages/`、`quant/`（`list_dir` 确认三者内容均为 0 项）
- **成立把握**：高
- **反证检查**：可能为占位目录，但作为 pip 安装产物随包分发空目录属冗余。
- **建议**：清理或打包配置排除
- **备注**：临时/孤儿脚本（`_tmp_check_bridge.ps1`、`scan_test.js`）见 Q-001/Q-002，同属应清理的发布产物。

---

## 九、文档与实现脱节（3项）

### Q-018 🟠 训练数据实为合成占位，非真实采集
- **位置**：`software/khyquant/ml/data_collector.py` L35-47
- **证据**：
  ```python
  def collect_historical_data(self, days: int = 365) -> pd.DataFrame:
      # Placeholder: use synthetic generation in this repository build.
      data = self._generate_sample_data(days)
  def _generate_sample_data(self, days: int) -> pd.DataFrame:
      rng = np.random.default_rng(42)  # 固定种子合成数据
  ```
- **成立把握**：高（代码行为）
- **反证检查**：注释明确"Placeholder: use synthetic generation"，名为"采集历史数据"实为固定种子合成器，DB 配置仅占位；AGENTS.md 描述训练能力时未标注数据为合成 → 脱节成立。
- **建议**：修正文档或实现真实数据采集

### Q-019 🟠 文档所述 pip 启动器 platform/khy_platform/ 在本快照不存在
- **位置**：AGENTS.md L31/L41/L100 反复引用 `platform/khy_platform/`、`cli.py`、`__init__.py`
- **证据**：`Glob **/khy_platform/**` 在 bundled/ 及上级 khy_os/ **均 0 命中**；`platform/` 下仅 `packages/{moonbit-plugin-sdk, shared}`；实际 Python 启动器是 `software/khyquant/khy_quant/cli.py`（khyquant 专用）
- **成立把握**：中
- **反证检查**：本为已安装分发载荷，`platform/khy_platform` 可能在 khy-os 主包（非本 bundled 载荷）单独分发，**是否整体缺失需核验源码仓**；但就本分发树，AGENTS.md 指向路径确不存在。
- **建议**：核验 pip 安装完整性或修正文档路径

### Q-020 🟡 kernel/WASM 宣称与代码不符（已部分修复）
- **位置**：
  - `README.md` L211（kernel 目录描述）— **已修复**
  - `scripts/moonbit/run-wasm-indicators-tests-offline.sh` L54/L58 — **已修复**
  - `AGENTS.md` 架构速查（L59 后）— **已补标注**
  - `apps/ai-frontend/src/views/KhyOsTerminal.vue` L100-115 — 网页终端 `/ws` 消息未实现后端 handler（未修，改动面大）
- **原问题**：顶层 README 宣称 `kernel/ ... MoonBit WASM, ISO build`，但 kernel 内 MoonBit 模块实际目标为 `native`（生成 C，由 kernel/Makefile L114 和 `main.mbt` 自我标注 "Vision: Minimal kernel + WASM components" 证实）；run-wasm 脚本路径 `${ROOT_DIR}/backend/wasm-indicators` 指向不存在目录；AGENTS.md 架构速查表完全不提 kernel（与 README 宣称冲突）
- **修复（2026-07-17，文档/脚本路径修正）**：
  1. `README.md` L211 `MoonBit WASM` → `MoonBit (native/C output)`（与 kernel/Makefile 与 main.mbt Vision 表述对齐）
  2. `scripts/moonbit/run-wasm-indicators-tests-offline.sh` L54/L58 路径 `${ROOT_DIR}/backend/wasm-indicators` → `${ROOT_DIR}/services/backend/wasm-indicators`（实证：新路径存在，旧路径不存在）
  3. `AGENTS.md` 关键入口点表后增一行「内核控制面」条目 + 「实验性组件提示」说明，明确 kernel 不在主线关键路径上、定位为教学/实验/爱好级
- **自我对抗核验结论**：原"kernel/WASM 未与主线集成"表述**部分不成立** —— CLI 已集成（`KhyOsRunner`/`isoProvisioner`/`khy os` 命令），真脱节在于：① WASM 宣称不实（已修）；② 前端网页终端未接通（未修）；③ 构建脚本路径错（已修）；④ 文档宣称与 AGENTS.md 漏写撕裂（已修）；⑤ backend npm `files` 不含 kernel/（未修，发布治理）
- **剩余风险/未修**：
  - 前端 `/khyos` 网页终端向 `/ws` 发 `khyos_start`/`khyos_input`/`khyos_stop` 消息，ai-backend `/ws` 仅回 `{ type: 'connected' }`、无对应 handler（改动面大，留待专项）
  - backend npm `files` 不含 kernel/，与 `khy os build` 假设冲突（需根级 pyproject/package.json 治理，留待发布专项）
- **建议**：前端网页终端内核功能作为专项任务跟进；发布清单治理随版本发布流程一并核验

---

## 十、代码质量（2项）

### Q-021 🟠 超大源文件（行数实证）
- **位置**：`services/backend/src/cli/replSession.js` **9832 行**；`services/backend/src/services/toolUseLoopCore.js` **8061 行**；`software/khyquant/frontend/src/views/Trading.vue` **4940 行**；`.../components/IntelligentStrategySelector.vue` **2646 行**
- **成立把握**：高
- **反证检查**：行数由 Glob 实测；单文件近万行严重超出可维护阈值。
- **建议**：优先拆分 replSession.js / toolUseLoopCore.js

### Q-022 🟡 治理脚本在分发包内无 CI/hooks 接入证据
- **位置**：AGENTS.md L91-93/L332-334 声称"由 check-version-sync.js 强制(pre-commit/CI/bootstrap)"
- **证据**：脚本确存在（`scripts/check-agent-rules.js` 457 行、`scripts/ci/check-version-sync.js` 88 行、`scripts/install-git-hooks.js` 从 `.githooks` 安装）；但 `Glob .githooks/**` **0 命中**、`Glob **/.github/workflows/**` **0 命中**
- **成立把握**：中
- **反证检查**：pip 分发包通常剥离 `.git/.githooks/.github`，本分发树缺失**不能证明**上游未 enforce；仅能确认分发包内无 hooks/CI 可执行。**需在源码仓核验**。
- **建议**：确认上游 CI/hooks 接入，或调整文档措辞

---

## 系统性模式总结

| 模式 | 涉及问题 |
|------|---------|
| 前端/后端展示或落库假数据（随机/合成/信任客户端） | Q-011, Q-014, Q-015, Q-018 |
| 非原子文件写（无 tmp+rename） | Q-004, Q-005, Q-006 |
| 服务启动缺 EADDRINUSE 韧性 | Q-007, Q-012 |
| 发布产物污染（临时脚本/空目录/测试页） | Q-001, Q-002, Q-003, Q-017 |
| 文档声称超出/偏离代码实现 | Q-019, Q-020, Q-022 |
| 孤立/未接线代码 | Q-008, Q-009 |
| 超大文件维护风险 | Q-021 |

---

## 统计

| 严重级别 | 数量 |
|---------|------|
| 🔴 严重 | 0 |
| 🟠 高 | 4 |
| 🟡 中 | 11 |
| 🟢 低 | 7 |
| **总计** | **22** |

> 方法论说明：本列表所有条目均经亲自 Read 验证文件+行号+代码原文，并附「成立把握」和「反证检查」。三项最高危（Q-014 随机绩效、Q-004 OAuth 非原子写、Q-012 ai-backend 无端口韧性）由主审二次亲验代码确认。标注"需进一步核验"的子项（Q-006 mcpConfigStore/permissionPolicy、Q-015 数据源提示、Q-019 主包分发、Q-020 WASM 宣称、Q-022 上游 CI）未计入成立定级。
>
> 修订记录（2026-07-17 自我对抗轮）：Q-014 原为全列表唯一 🔴（量化终端向用户展示随机绩效），自我对抗时对"是否真的展示"做模板交叉核验——grep 确认 `strategyRealTimeStats`/`totalReturn`/`winRate`/`sharpeRatio` 等六个关键字在 `<template>` 中**零次出现**，证明数据从不渲染给用户。原断言不成立，降为 🟢（死代码 + 无用 30s 定时器，等待后端接线）。至此本列表 🔴 清零。本次自我对抗再次证明：凡"对用户展示"类结论，必须核对模板实际渲染路径，不能只看变量赋值。
>
> 修订记录（2026-07-17 自我对抗修复轮 #2）：Q-004 已修复 — `services/backend/src/services/mcp/oauthTokenStore.js` `_fileSaveAll` 改用 `tmp + fsync + rename` 原子写（对齐同仓基线 `utils/dataHome.js` `_writePointer`）；fsync 在 open/fsync/close 三步中均 try/catch 包裹，best-effort 且始终关闭 fd（防止泄漏）；异常时清理孤立 tmp，错误上抛不吞；`node --check` 语法通过。Q-004 降为 🟡（仅剩 Q-005/Q-006 同类问题待复用同一模式）。
>
> 修订记录（2026-07-17 自我对抗修复轮 #3）：Q-020 部分修复 — `README.md` L211 `MoonBit WASM` 改为 `MoonBit (native/C output)`（与 kernel/Makefile `moon build --target native` 及 main.mbt Vision 表述对齐）；`scripts/moonbit/run-wasm-indicators-tests-offline.sh` L54/L58 路径修正（实证：新路径 `services/backend/wasm-indicators` 存在，旧 `backend/wasm-indicators` 不存在）；`AGENTS.md` 架构速查表后增「内核控制面」条目 + 「实验性组件提示」说明。剩余未修项：前端网页终端未接通（改动大）、backend npm files 不含 kernel/（发布治理）。Q-020 降为 🟡。
