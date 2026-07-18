# KHY OS 问题列表 [1]

> 生成时间：2026-07-17
> 审查范围：`bundled/` 全量快照（含 services/backend、apps/ai-frontend、software/khyquant、kernel、scripts）
> 审查依据：AGENTS.md 工程规则 + 七轮 ultra-review 贯穿式审查 + 独立深入审计
> 状态说明：🔴 严重 | 🟠 高 | 🟡 中 | 🟢 低

---

## 一、安全与凭据（6项）

### P-001 🟢 .env 密钥经核验：legacy 已过期 / 活跃值为占位（原严重定级撤销）
- **位置**：`services/.env`、`backend/.env.legacy-unused`、`.env.legacy-unused`
- **核验结论**：**原「🔴 有效凭据泄露」定级不成立，已撤销。**
- **证据**：
  - 两个 `.env.legacy-unused` 的 `RELAY_API_KEY` 是 trae.ai JWT，payload `exp=1780611064`（约 2026-06-05）已早于当前时间过期 → 失效历史值
  - `services/.env` 的 `GLM_API_KEY`/`DEEPSEEK_API_KEY` 格式真实但**未经有效性验证**；经项目所有者确认为写代码时的占位/测试值
- **修正说明**：原判断「任何人可获取有效 API 密钥」属未经验证的武断断言，撤销
- **残留建议（🟢 低）**：仍建议活跃 `.env` 不随发布包分发、legacy 文件清理，属卫生问题非安全风险

### P-002 🟢 verifyExportPassword() 恒返回 true：经核验为有意设计（原严重定级撤销）
- **位置**：`services/backend/src/services/modelTrainingService.js` L709-711
- **核验结论**：**原「🔴 导出无访问控制漏洞」定级不成立，已撤销。**
- **证据**：
  - 代码注释 L703-705 明确："Model export is no longer password-gated — this always authorizes. The function is kept so existing call sites and the public export stay stable."
  - 当前 AGENTS.md 安全须知明确：导出密码门已**有意移除**，改为在部署/网络层控制访问
- **修正说明**：文档与代码完全一致，属有意设计决策，非 bug；原判断基于旧版 ultra-review 记忆，未与当前 AGENTS.md 核对
- **残留建议（🟢 低）**：若模型导出端点暴露于网络，确保部署/中间件层确实有访问控制（符合 AGENTS.md 指引）

### P-003 🟠 会话撤销未跨服务强制（原「JWT_SECRET 不一致」经核验重写）
- **位置**：`services/ai-backend/` 认证中间件、`services/backend/src/services/authSessionService.js` L297-315
- **核验结论**：**原「JWT_SECRET 值不同」定级不成立** —— 不一致的 secret 仅存在于失效的 legacy 文件，活跃部署的 backend 与 ai-backend 都从同一 `process.env.JWT_SECRET` 读取，签名可互验。
- **真实缺陷**：ai-backend 使用简化中间件，仅校验 JWT 签名/过期，**不查会话撤销表**（AuthSession / tokenVersion）。backend 侧主动撤销（登出/踢下线）的 token 在 ai-backend 仍被接受。
- **风险**：跨服务会话撤销失效，已注销 token 可继续访问 ai-backend（端口 9090）网关
- **建议**：ai-backend 认证中间件接入 `authSessionService` 的撤销校验，或改为向 backend 转发鉴权

### P-004 🟠 scan_test.js 泄露凭据解析逻辑
- **位置**：`scan_test.js`（项目根目录）
- **问题**：4 行临时调试脚本调用 `traeOfficialArtifacts` 并打印 credential
- **风险**：随包分发暴露凭据获取路径
- **建议**：立即删除此临时文件

### P-005 🟡 sourceSnapshotCrypto.js 硬编码加密密钥
- **位置**：`services/backend/src/services/sourceSnapshotCrypto.js`
- **问题**：加密密钥 `'khy2026'` 硬编码在源码中随包分发
- **风险**："加密"实为"防误传播"而非真正安全保护
- **建议**：明确标注其非安全性质，或改用用户提供的密钥

### P-006 🟢 .env.legacy-unused 文件保留历史配置（凭据已失效）
- **位置**：`.env.legacy-unused`、`backend/.env.legacy-unused`
- **核验结论**：其中 `RELAY_API_KEY`(trae.ai JWT) 已于约 2026-06-05 过期（与 P-001 同一证据）；`JWT_SECRET`=`62894...` 属不活跃 legacy 文件
- **风险**：失效凭据无实际安全风险，仅为文件卫生问题
- **建议**：清理 legacy 文件以减少认知负担

---

## 二、架构与设计缺陷（9项）

### P-007 🟠 AI 网关核心逻辑两套并行实现（原 🔴 精化降级）
- **位置**：`services/backend/`（端口 3001）与 `services/ai-backend/`（端口 9090）
- **核验结论**：**双进程分离本身是有意设计**（有文档/注释支撑的职责分离：交易主服务 vs AI 管理网关），不构成缺陷。
- **真实缺陷**：AI 网关核心（adapters + cascade 失败转移 + generate + token 记账）确为两套独立实现，需并行维护 —— 修一处 bug 或加一个 adapter 需两边同步，构成实际维护性风险。
- **风险**：逻辑漂移、修复/新增能力需双份改动、配置需同步
- **建议**：抽取共享网关核心为公共模块被两服务复用，而非各自维护整套实现

### P-008 🟡 两套 cron 调度器重复实现（原 🟠 经核验降级）
- **位置**：`services/backend/src/jobs/cronScheduler.js`（持久化 `scheduled_tasks.json`）与 `services/backend/src/services/cronScheduler.js`（持久化 `growth/cron_jobs.json`）
- **核验结论**：两者服务**不同场景**（jobs=用户定时任务，services=growth 增长任务），持久化文件不同、无运行时冲突 —— 原「同一时间重复执行」为高估。
- **真实缺陷**：两套各自实现 cron 解析器，属重复代码 → 维护性缺陷（非功能冲突）
- **建议**：抽取共享 cron 解析器工具，两调度器复用

### P-009 🟡 定时任务两条触发路径能力不一（原 🟠 经核验降级）
- **位置**：`services/backend/src/jobs/cronScheduler.js` 触发链路
- **核验结论**：**非硬断裂** —— jobs 路径经 `ai.chat` 的 agent 工具链可间接触发真实 backtest（`tools/backtest.js` 有 `defineTool` 注册），prompt→工具调用链路存在。
- **真实缺陷**：`services/` 侧的 generate 路径确只产出文本、不落地执行；两条路径能力不对等，取决于触发入口
- **建议**：统一定时触发入口走带工具链的 agent 路径，或明确文档标注两路径差异

### P-010 🟠 Node/Python 两套 ML 训练体系从未协同
- **位置**：Node 侧 `modelTrainingService.js`（LoRA 微调/蒸馏）与 Python 侧 `software/khyquant/ml/`（交易预测模型）
- **问题**：两套系统数据不共享、训练不联动；Node 侧训练数据从未被消费用于再训练
- **风险**：ML 能力碎片化，"自动收集数据持续改进模型"叙事在实现层不存在
- **建议**：明确统一训练 pipeline 或移除冗余实现

### P-011 🟠 数据库无版本化迁移系统
- **位置**：全局
- **问题**：依赖 Sequelize `sync()` lazy 创建表，无正式 migration 流程；Schema 变更靠 model 级 sync 或手动 ALTER
- **风险**：生产环境表结构不一致，`alter: true` 可能丢数据
- **建议**：引入 Sequelize Migrations / Umzug，建立版本化迁移流程

### P-012 🟠 kernel 微内核与主线零集成
- **位置**：`kernel/`（121 个 src 文件 + 37 个 userland 程序）
- **问题**：完整的 x86_64 内核与 khy-os 主线零集成；pip/npm 安装不包含 kernel 构建；backend 不消费 kernel IPC 协议
- **风险**：文档描述的 capability 位模型 + IPC 服务化架构只停留在文档层
- **建议**：要么集成到主线，要么明确标注为独立实验项目

### P-013 🟡 WASM 性能优化从未在生产生效
- **位置**：`services/backend/src/services/chainWasm.js`、`build-khy-os.sh`
- **问题**：MoonBit 编译依赖硬编码本地开发者路径，标准打包永远只有 JS fallback
- **风险**：文档声称的 WASM 性能优化在生产中不存在
- **建议**：修正文档描述，或实现可复现的 WASM 编译流程

### P-014 🟡 .khy/evo_engine 设计良好但维护成本高
- **位置**：`.khy/evo_engine/`
- **问题**：SelfBootstrapEngine 自举进化闭环实现完整（六阶段编排+哈希链不可篡改日志），但复杂度高
- **风险**：非核心路径的复杂系统可能成为维护负担
- **建议**：定期审查其活跃使用状态

### P-015 🟡 .khy/memory "split-brain" 设计缺陷
- **位置**：`.khy/memory` 相关代码
- **问题**：recall 侧默认解析到 `getProjectDataHome()/memory`，dream/consolidation 侧写入 `getDataHome()/memory`，pip 安装时两路径可能不同
- **风险**：AI "记不住刚说的话"
- **建议**：已通过 `KHY_MEMORY_UNIFIED_HOME`/`KHY_MEMORY_MERGE_LEGACY` 门控缓解，但需简化架构

---

## 三、计费与限流（4项）

### P-016 🟡 token 记账漏记（子问题 1 已修复，子问题 2 待办）
- **位置**：`services/backend/src/services/gateway/aiGatewayGenerateMethod.js`
- **核验结论**：原「所有失败都漏记扣费」为高估 —— 多数失败类型（连接失败/404/门关）上游根本不产生 token，无费用可记。
- **真实缺陷（两处）**：
  1. **✅ 已修复 — API Key Pool 成功路径漏记（更严重）**：L2557 成功出口直接 `return finishResult(...)`，而 `finishResult`(L637) 不调 `usageTracker.record`；唯一记账点在常规路径 L3134。→ 凡走 API Key Pool 的成功请求 token 全部漏记。**修复（2026-07-17）**：在 L2557 `return` 前补上与常规路径同形的 `usageTracker.record` + `diagnostics.emitModelResponse`，fail-soft 包裹（telemetry 不影响结果）；`node --check` 通过。
  2. **⏳ 待办 — 窄类失败漏记**：上游已生成内容后被判失败（语言不一致拒绝 L3080 / 流式中断），此时 token 已消耗但失败 push（L2597）不含 `tokenUsage`。— 尚未修复。
- **风险**：子问题 1 修复后，API Key Pool 场景对账黑洞已堵；子问题 2 仅影响已生成后被拒的窄类场景，影响面小
- **建议（剩余）**：语言拒绝块（L3080）与失败 push（L2597）在已消耗 token 时补记

### P-017 🟠 tokenUsageService 价格表硬编码且不完整
- **位置**：`services/backend/src/services/tokenUsageService.js` L18-31
- **问题**：11 个 provider 的价格硬编码，汇率 `USD_TO_CNY = 7.25` 硬编码无更新机制；网关 16+ adapter 中大量未映射，fallback 到 default 价格
- **风险**：费用估算不准，不支持按具体模型区分（如 gpt-4o vs gpt-4o-mini）
- **建议**：价格表外置为配置文件，支持按模型级别定价，汇率定期更新

### P-018 🟡 限流按 adapter key 而非 provider 隔离
- **位置**：`services/backend/src/services/gateway/redisRateLimiter.js` L79
- **问题**：`api` adapter 背后可能代理多个 provider，但共享同一个限流桶
- **风险**：当 `api` 桶满时，所有云端 provider 全部被限流
- **建议**：限流 key 细化到 provider 级别

### P-019 🟡 内存限流 fallback 无上限防护
- **位置**：`services/backend/src/services/gateway/redisRateLimiter.js` L57-77
- **问题**：内存 `memoryStore` 对象在大量不同 key 场景下会无限增长
- **风险**：内存泄漏
- **建议**：增加 LRU 淘汰或最大条目数限制

---

## 四、AGENTS.md 规则违规（6项）

### P-020 🟡 规则1违规：gettingStartedService 硬编码域名
- **位置**：`services/backend/src/services/gettingStartedService.js` L92
- **问题**：`khyquant.top` 未从 `constants/serviceDefaults.js` 导入
- **建议**：改为从 serviceDefaults 导入

### P-021 🟡 规则1违规：useDashboardLanAccess 硬编码端口
- **位置**：`apps/ai-frontend/src/composables/useDashboardLanAccess.js` L18
- **问题**：`:8080` 端口字面量
- **建议**：从环境变量或配置导入

### P-022 🟡 规则2违规：含糊状态文案
- **位置**：`noiseFilter.js` L85、`remoteSsh.js` L423 等多处
- **问题**：`'模型服务处理中…'`、`'正在处理中'` 等缺少"动作+目标+进度"
- **建议**：替换为具体进度描述

### P-023 🟡 规则3违规：strategyRecommender 硬墙钟超时
- **位置**：`services/backend/src/services/strategyRecommender.js` L83-87
- **问题**：回测 5s 硬墙钟杀死，无活动重置机制
- **建议**：切换为空闲/滑动超时模式

### P-024 🟡 规则3违规：AgentTool 循环硬墙钟超时
- **位置**：`services/backend/src/tools/AgentTool/index.js` L828-868
- **问题**：AI agent 循环硬墙钟超时，无活动重置
- **建议**：增加基于活动的超时重置

### P-025 🟢 规则4：未发现滚动区违规
- **状态**：合规 ✅

---

## 五、前端问题（5项）

### P-026 🟠 khyquant 前端模拟数据静默展示
- **位置**：`software/khyquant/frontend/src/views/Trading.vue` L2369
- **问题**：`updateStrategyStats()` 始终使用 `Math.random()` 生成模拟统计数据，无任何 UI 标记告知用户
- **风险**：用户可能基于模拟统计数据做出真实交易决策
- **建议**：在 UI 上明确标记数据来源（真实/模拟）

### P-027 🟡 khyquant 前端状态管理多头
- **位置**：Pinia strategyStore、dataSourceService 独立 reactive 状态、localStorage
- **问题**：三处并行维护回测结果和数据源状态，无同步保证
- **建议**：统一状态管理入口

### P-028 🟡 khyquant 前端服务发现能力弱
- **位置**：`software/khyquant/frontend/src/utils/connectionMode.js`
- **问题**：无 LAN 自动探测，本地部署需手动配置后端地址；与 ai-frontend 的动态发现机制差距大
- **建议**：引入服务发现能力或统一两前端的服务发现策略

### P-029 🟢 ai-frontend 架构健康
- **位置**：`apps/ai-frontend/`
- **状态**：22 个 composables 调用的 API 端点在后端路由中均有对应，无 mock 假数据，错误处理统一 fail-soft ✅

### P-030 🟡 khyquant 前端 ml-test.html 硬编码
- **位置**：`software/khyquant/frontend/ml-test.html`
- **问题**：测试文件硬编码 `http://localhost:3000/api/trading-agents`，无覆盖机制
- **建议**：删除测试文件或改为动态配置

---

## 六、并发与持久化（3项）

### P-031 🟠 多处 JSON 配置写入无原子保护
- **位置**：`cronScheduler.js`(jobs)、`cronScheduler.js`(services)、`ConfigTool`、`skillGapRecorder.js`、`vim/settings.js`、`TodoWriteTool`
- **问题**：至少 6 处使用裸 `fs.writeFileSync` 写入 JSON 配置，无 tmp+rename 模式，无文件锁
- **风险**：进程崩溃时可能丢文件或文件截断
- **建议**：统一采用 tmp + fsync + rename 原子写入模式

### P-032 🟡 ai-backend 启动无 EADDRINUSE 处理
- **位置**：`services/ai-backend/server.js` L91
- **问题**：AI 后端（端口 9090）使用裸 `app.listen(PORT)`，端口被占用时直接崩溃
- **建议**：复用 backend 的 `listenWithAutoPort()` 模式

### P-033 🟡 sessions.db 来源不明
- **位置**：`.khy/sessions.db`（29.8MB SQLite+WAL）
- **问题**：代码中 `sessionSearchIndex.js` 引用 `sessions.db` 作为 FTS5 搜索索引，但项目目录下的实例与代码引用路径可能不同
- **建议**：确认并清理历史遗留实例

---

## 七、代码质量与维护性（7项）

### P-034 🟠 超大文件维护风险
- **位置**：`replSession.js`（9,833 行）、`toolUseLoopCore.js`（8,062 行）、`flagRegistry.js`（2,500 行）
- **问题**：`replSession.js` 尤其严重，9800+ 行的 REPL 状态机包含所有模式逻辑
- **建议**：优先拆分 replSession.js，继续提取 toolUseLoopCore.js 子模块；flagRegistry.js 作为声明式 SSOT 可保留

### P-035 🟡 治理脚本从未接入 CI/hooks
- **位置**：`scripts/check-version-sync.js`、`scripts/check-agent-rules.js`、`scripts/check-duplication.js`、`scripts/check-tool-contract.js` 等
- **问题**：所有治理脚本功能完整但均未接入 CI/pre-commit 流程，与 AGENTS.md "enforced by" 声明矛盾
- **建议**：将关键检查脚本接入 CI pipeline 或 git hooks

### P-036 🟡 版本同步机制在当前环境不完整
- **位置**：`scripts/ci/check-version-sync.js`
- **问题**：要求同步的三个文件中，`pyproject.toml`（顶层）和 `packaging/npm/package.json` 在当前 bundled 快照中不存在
- **建议**：在 bundled 打包流程中确保版本信息完整，或调整检查脚本适配 bundled 场景

### P-037 🟡 .env 读写逻辑多处重复实现
- **位置**：全局
- **问题**：.env 读写逻辑至少 4 处重复实现，dotenv 加载顺序不统一
- **建议**：统一 .env 加载/读写入口

### P-038 🟡 策略监控无自动数据源
- **位置**：`services/backend/src/services/strategyEngine.js`（StrategyMonitor 部分）
- **问题**：纯内存 Map + 回调机制，依赖外部手动调用 `updateMarketData()` 喂数据，无自动市场数据轮询
- **建议**：增加调度驱动的市场数据自动轮询

### P-039 🟡 回测结果持久化双轨
- **位置**：`software/khyquant/routes/backtest.js` 与 `services/backend/src/routes/strategy.js`
- **问题**：khyquant 侧保存回测结果到 Backtest 表，主后端侧的 `POST /:id/backtest` 不保存结果只即时返回
- **风险**：同一功能一半有历史记录一半没有
- **建议**：统一回测结果持久化策略

### P-040 🟢 路由占位符实际为 re-export 代理
- **位置**：`services/backend/src/routes/` 下的 1 行文件（backtest.js、trade.js 等）
- **状态**：确认不是空占位符，而是指向 `software/khyquant/routes/` 的 re-export，目标文件均存在且有实质内容 ✅

---

## 八、打包与清理（4项）

### P-041 🟡 空目录随包分发
- **位置**：`frontend/`、`packages/`、`quant/`
- **问题**：完全为空的目录被打进发布快照
- **建议**：清理或在打包配置中排除

### P-042 🟡 临时文件未清理
- **位置**：`_tmp_check_bridge.ps1`、`scan_test.js`
- **问题**：带 `_tmp` 前缀的测试脚本和临时调试文件随包分发
- **建议**：删除这些临时文件

### P-043 🟡 孤儿目录/文件
- **位置**：根目录多个空孤儿目录、临时调试文件
- **问题**：不影响功能但增加发布包体积和认知负担
- **建议**：定期运行 orphan sweep 清理

### P-044 🟢 moonbit-plugin-sdk 零引用
- **位置**：`extensions/` 下的 moonbit-plugin-sdk
- **问题**：设计合理但零引用的孤儿包
- **建议**：标注为 WIP 或从主线排除

---

## 九、文档与实现脱节（5项）

### P-045 🟢 AGENTS.md 导出密码描述：经核验文档与代码一致（原项撤销）
- **位置**：`AGENTS.md` 安全须知章节
- **核验结论**：**原「🔴 文档与代码矛盾」不成立，已撤销。** 当前 AGENTS.md 已明确声明密码门被有意移除，与 `verifyExportPassword()` 代码实现一致，不存在矛盾
- **修正说明**：原判断基于旧版 ultra-review 记忆（旧 AGENTS.md 声称 khy20026 生效），当前版本已修正，与 P-002 同源

### P-046 🟠 pip launcher 在 bundled 快照中不存在
- **位置**：`platform/khy_platform/`（文档声称的入口）
- **问题**：文档反复描述的 pip 安装入口 `cli.py` 在当前安装环境中完全不存在
- **建议**：确认 pip 安装流程的完整性，或修正文档

### P-047 🟠 训练数据自动收集叙事不真实
- **位置**：`software/khyquant/ml/data_collector.py`
- **问题**：`collect_historical_data()` 实际调用 `_generate_sample_data()` 生成合成数据，非真实市场数据
- **建议**：修正文档描述，或实现真实数据收集

### P-048 🟢 跨环境端口差异经核验为正常（原 🟠/🟡 撤销）
- **位置**：alpine 配置(3000)、backend .env(3001)、ai-frontend Dockerfile(9090)、deploy-server.sh UFW(3000+5000)
- **核验结论**：**原「严重不一致会连接失败」不成立，已撤销。** 不同服务/不同场景用不同端口本就正常（3000/3001 主服务、9090 AI 网关）；同场景内 9090 一致，且有动态服务发现兜底端口占用。
- **残留建议（🟢 低）**：端口默认值集中到 `serviceDefaults.js` 单一真源，属卫生优化非缺陷

### P-049 🟡 运维文档显著超出代码实现水平
- **位置**：`docs/07_OPS_运维/`（143 个文档）
- **问题**：文档描述的运维体系显著超出代码实际实现，无跨服务错误聚合、无告警通知通道
- **建议**：文档与实现对齐，标注 WIP 部分

---

## 系统性模式总结

| 模式 | 出现次数 | 涉及问题 |
|------|---------|---------|
| 两套独立实现从未同步 | 7+ | P-007, P-008, P-010, P-011 等 |
| 能力声称与实现断裂 | 4+ | P-009, P-012, P-013, P-047 |
| 治理脚本未接入 CI/hooks | 3+ | P-035 |
| 失败/异常分支被忽略 | 3+ | P-016, P-009 |
| 文档与代码脱节 | 5+ | P-045, P-046, P-047, P-048, P-049 |
| 配置/部署治理缺失 | 4+ | P-003, P-048, P-037 |
| 前端静默降级为模拟数据 | 2+ | P-026 |

---

## 统计

| 严重级别 | 数量 |
|---------|------|
| 🔴 严重 | 0 |
| 🟠 高 | 10 |
| 🟡 中 | 30 |
| 🟢 低/合规 | 9 |
| **总计** | **49** |

> 修订记录（2026-07-17）：P-001 经实文件核验，legacy JWT 已过期、活跃值经所有者确认为占位，原 🔴 定级撤销降为 🟢；P-006 同步降级。
> 修订记录（2026-07-17 自我对抗轮）：P-002 经代码注释 + 当前 AGENTS.md 双重核验，导出密码门为有意移除的设计决策，非漏洞，原 🔴 撤销降为 🟢；P-045（声称文档矛盾）与之同源，同步撤销。两项均因引用旧版 ultra-review 记忆而误判。
> 修订记录（2026-07-17 自我对抗修复轮）：P-016 子问题 1（API Key Pool 成功路径 token 漏记）已修复 — 在 `aiGatewayGenerateMethod.js` L2557 `return` 前补上与常规路径 L3134 同形的 `usageTracker.record` + `diagnostics.emitModelResponse`，均 fail-soft 包裹；node --check 语法校验通过。P-016 降为 🟡（仅剩子问题 2 窄类失败漏记待办）。 —— P-007（双网关）🔴→🟠：双进程分离为有意设计，真缺陷是网关核心两套并行需同步维护；P-016（计费）🔴→🟠 重写：定位真 bug 为 API Key Pool 成功路径(L2557)不调 usageTracker.record，成功用量漏记比失败漏记更严重；P-003 保 🟠 重写：JWT_SECRET 仅 legacy 文件不一致，真缺陷是 ai-backend 不校验会话撤销表；P-008 🟠→🟡：两套 cron 无运行时冲突，仅解析器重复；P-009 🟠→🟡：jobs 路径经 agent 工具链可间接触发真实回测，非硬断裂；P-048 🟠→🟢 撤销：跨环境端口差异为正常。至此 🔴 项清零。
