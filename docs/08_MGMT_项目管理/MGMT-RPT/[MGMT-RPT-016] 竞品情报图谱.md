<!-- 文档分类: MGMT-RPT-016 | 阶段: 项目管理 | 原路径: docs/指南/竞品情报图谱.md -->
# KHY OS 竞品分析图谱 — 全项目对标发现汇总

> 最后更新: 2026-05-26
> 目的: 汇总历次对标分析的全部发现，避免重复探索，为 KHY 指明路径

---

## 一、分析过的项目全景

共计分析 **12 个项目**，覆盖 5 种语言、4 种架构范式：

| # | 项目 | 语言/框架 | 分析日期 | 定位 | KHY 最关键收获 |
|---|------|----------|---------|------|---------------|
| 1 | **Claude Code** | TS/Ink | 2026-05 持续 | Anthropic 官方 CLI | 流协议/重试/beta头/stop_reason行为 |
| 2 | **OpenClaw** | TS | 2026-05-10 | CC 开源替代 | 41 项能力全量移植（压缩/修复/守卫/诊断） |
| 3 | **Qwen Code** | TS strict | 2026-05-15 | 阿里 CLI | Arena/Follow-up/LSP/IDE插件/i18n |
| 4 | **oh-my-openagent** | TS | 2026-05-15 | 社区 Agent 框架 | Hashline/IntentGate/RalphLoop/TeamMode/Hook体系 |
| 5 | **DeepSeek-TUI** | Rust/ratatui | 2026-05-19 | 高性能终端 | Actor模型/Cycle-restart/LoopGuard/SeamManager/i18n bookend |
| 6 | **Hermes Agent** | Python/prompt_toolkit | 2026-05-21 | Nous Research Agent | 迭代预算/子代理/凭证池/三策略守卫/Prompt缓存/16语言 |
| 7 | **OpenCode** | TS/SolidJS | 2026-05-21 | 轻量 CLI | Leader键/命令面板/Doom Loop/模型专属prompt/动态SDK |
| 8 | **LibreChat** | TS/React | 2026-05-20 | 开源 ChatGPT | 多模态渲染/插件市场/Preset系统 |
| 9 | **Abu-Cowork** | TS/Tauri | 2026-05-26 | 桌面协作 Agent | 4层压缩/max_tokens恢复/异步子代理/Prompt缓存分区 |
| 10 | **opencode-dev** | TS/Effect | 2026-05-26 | 极简 CLI | 结构化压缩+尾部保护/Doom Loop/工具名修复/Verify工具 |
| 11 | **DeepSeek-TUI** (交付维度) | Rust | 2026-05-26 | 同上深度分析 | CapacityController 4级干预/工具批计划/类型化子代理角色 |
| 12 | **Hermes Agent** (交付维度) | Python | 2026-05-26 | 同上深度分析 | ToolCallGuardrailController/delegate_task/checkpoint快照/错误分类器 |

---

## 二、按维度汇总：每个项目教了 KHY 什么

### 2.1 工具循环引擎

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| OpenClaw | tool-loop-detection 基于内容hash检测重复 | ✅ toolLoopDetector.js | memory/reference_openclaw_analysis.md |
| oh-my-openagent | IntentGate 3模式(ultrawork/coding/analyze) + 迭代提升 | ✅ intentGate.js + toolUseLoop | memory/reference_ohmyopenagent_architecture.md |
| oh-my-openagent | Ralph Loop 跨会话续行 + Boulder State 工作追踪 | ✅ boulderState.js | memory/project_alignment_dimensions_status.md |
| Hermes | IterationBudget(max=90) + grace call | ❌ 缺失 | memory/reference_four_project_delivery_benchmark.md |
| Hermes | finish_reason=length 续传(3次重试) | ❌ 缺失 | 同上 |
| Abu-Cowork | max_tokens 自动翻倍 + 续传 prompt | ❌ 缺失 | 同上 |
| DeepSeek-TUI | Actor model(Op/Event channels) 非阻塞循环 | — 架构不同，不适用 | memory/reference_three_project_deep_learning.md |

### 2.2 循环守卫 / 死循环防护

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| OpenClaw | tool-loop-detection 连续相同调用检测 | ✅ toolLoopDetector.js | memory/reference_openclaw_analysis.md |
| OpenCode | Doom Loop: 3次完全相同工具调用 → 暂停请求用户确认 | 部分 (dedup>=2退出) | memory/reference_three_project_deep_learning.md |
| DeepSeek-TUI | LoopGuard canonical JSON hash + 3重复block/3连续失败warn/8停止 | ❌ 无hash精确检测 | memory/reference_four_project_delivery_benchmark.md |
| Hermes | ToolCallGuardrailController 三策略 + 4级决策(allow/warn/block/halt) | ❌ 无分级响应 | 同上 |
| CC R6修复 | dedup门槛>=1→>=2 + 进度检测扩展 | ✅ toolUseLoop.js | memory/project_cc_alignment_round6.md |

### 2.3 上下文压缩

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| OpenClaw | preemptive-compaction 预防性溢出路由 | ✅ contextRouter.js | memory/reference_openclaw_analysis.md |
| OpenClaw | context-window-guard 窗口守卫 | ✅ contextWindowGuard.js | 同上 |
| Abu-Cowork | 4层压缩(语义+微压缩+硬截断+缓存) | 部分 (有3阶段pipeline) | memory/reference_four_project_delivery_benchmark.md |
| DeepSeek-TUI | Cycle-restart 原子替换 + carry-forward 简报 | ✅ compactPipeline cycle模式 | memory/reference_three_project_deep_learning.md |
| DeepSeek-TUI | Compaction经济学: 缓存命中价值评估 | ❌ 无缓存经济学 | 同上 |
| Hermes | 工具输出预裁剪(类型化1行摘要) + 头尾保护 + 去重 + 防抖 | ❌ 缺预裁剪和防抖 | memory/reference_four_project_delivery_benchmark.md |
| OpenCode | 结构化压缩 + 尾部保护(2轮, 25% token预算) | 部分 | 同上 |
| CC R6修复 | 增量摘要12K分段 + effort medium + carry-forward 4000token | ✅ contextCompressor.js | memory/project_cc_alignment_round6.md |

### 2.4 子代理 / 并行执行

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| oh-my-openagent | Team Mode: mailbox + backpressure + ACK | ✅ processAgent + taskBoard | memory/project_alignment_dimensions_status.md |
| Qwen Code | Fork Subagent + AsyncLocalStorage 隔离 + Prompt Cache 共享 | 部分 (有promptCacheService) | memory/reference_qwen_code_full_gap_2025.md |
| Hermes | delegate_task: single/batch模式 + 编排者角色 + spawn深度 + 心跳 | ❌ 无任务委派 | memory/reference_four_project_delivery_benchmark.md |
| Abu-Cowork | fire-and-forget 异步子代理 + `<agent-result>` 注入 + 5并发 | ❌ 同上 | 同上 |
| DeepSeek-TUI | 7种类型化角色(General/Explore/Plan/Review/Implement/Verify/Custom) | ❌ 无类型化子代理 | 同上 |
| OpenCode | 后台子任务 + 结果注入父对话 | ❌ 同上 | 同上 |

### 2.5 Prompt 工程

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| oh-my-openagent | 模型专属 prompt 构建器(Opus/Gemini/GPT-5.x/Kimi) | ❌ 单一prompt | memory/reference_ohmyopenagent_architecture.md |
| OpenCode | 模型专属文件(anthropic.txt/gpt.txt/beast.txt/gemini.txt/codex.txt) | ❌ 同上 | memory/reference_three_project_deep_learning.md |
| Hermes | 3层缓存优化(Stable/Context/Volatile) + cache_control 断点 | ❌ 无缓存分区 | memory/reference_four_project_delivery_benchmark.md |
| Hermes | GPT: XML执行纪律; Gemini: 绝对路径+先验证 | ❌ 同上 | 同上 |
| Abu-Cowork | cacheable/volatile 分区 ~50% 成本节省 | ❌ 同上 | 同上 |
| DeepSeek-TUI | bookend i18n(目标语言包裹英文核心) + turn元数据在user消息中 | ❌ 无bookend | memory/reference_three_project_deep_learning.md |
| Hermes | Context File 注入前安全扫描(prompt injection检测) | ❌ 无注入扫描 | memory/reference_four_project_delivery_benchmark.md |
| CC R6修复 | Prompt噪音原则：单层不重复、信任模型、适配器不注入行为指导 | ✅ 已遵循 | memory/feedback_prompt_noise_principles.md |

### 2.6 模型路由 / 降级

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| KHY 原生 | 16适配器级联 + 4层防护(fast-fail/暂态冷却/断路器/自愈) | ✅ aiGateway.js | memory/reference_adapter_cascade_cooldown.md |
| Abu-Cowork | 运行时能力发现(从API错误解析) + 持久化 | ❌ 无动态发现 | memory/reference_four_project_delivery_benchmark.md |
| Hermes | 70+ provider + fallback链 + turn-scoped恢复 + 凭证池轮换(4策略) | 部分 (有级联，无凭证池) | 同上 |
| Hermes | ClassifiedError 18类 { retryable, should_compress, should_rotate, should_fallback } | 部分 (有errorClassifier 13类) | 同上 |
| OpenCode | 动态 SDK provider 安装(运行时下载适配器) | — 不适用(KHY用JS) | 同上 |
| CC | 529过载→3次后FallbackTriggeredError→模型降级 | ✅ 已对齐 | memory/reference_claude_code_internals.md |

### 2.7 交付反馈

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| CC R6修复 | toolCallLog暴露 + _buildDeliverySummary + 黑箱兜底 + 结论nudge | ✅ 刚实现 | memory/project_cc_alignment_round6.md |
| Hermes | housekeeping过滤(memory/todo/skill不算交付) | ❌ 缺失 | memory/reference_four_project_delivery_benchmark.md |
| oh-my-openagent | Delivery Gate 交付门禁 | ✅ deliveryGate.js | memory/project_alignment_dimensions_status.md |

### 2.8 显示 / 渲染

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| CC/DeepSeek/Qwen/LibreChat | 流式增量渲染 + Thinking块 + 工具耗时 + CJK宽度 | ✅ 16项全部完成 | memory/reference_ai_display_benchmark.md |
| DeepSeek-TUI | 8主题三级色深 + 迟滞控制器帧率限制 | 部分 (有代码高亮,缺主题) | memory/reference_three_project_deep_learning.md |
| OpenCode | 33主题 + System推导 + Leader键 + 命令面板 | 部分 | 同上 |
| Hermes | KawaiiSpinner 动画进度 + emoji工具消息 | ✅ 有spinner | memory/reference_four_project_delivery_benchmark.md |

### 2.9 UX 交互

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| OpenCode/CC/DeepSeek/Hermes | 10项: 拼写纠错/模糊建议/风险分级/Tab补全/steer注入/意图预分类 | ✅ G1-G10全部完成 | memory/reference_ux_interaction_benchmark.md |
| Hermes | 3模式忙碌输入(queue/interrupt/steer) | ✅ 已完全对齐 | 同上 |
| Qwen Code | Follow-up 智能建议(收到回复后推荐2-3条跟进) | ✅ followupSuggestionService.js | memory/reference_qwen_code_full_gap_2025.md |
| Qwen Code | Session 自动标题 + Recap 摘要 | ✅ sessionTitleService.js | 同上 |

### 2.10 安全 / 权限

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| oh-my-openagent | 5层Hook(Session/ToolGuard/Transform/Continuation/Skill) | ✅ 9个ToolGuard | memory/project_alignment_dimensions_status.md |
| oh-my-openagent | Hashline content-fingerprint 防stale编辑 | ✅ fileStaleGuard TOCTOU | memory/project_task_delivery_gap.md |
| oh-my-openagent | Comment Checker 拦截AI slop注释 | ❌ 缺失 | memory/reference_ohmyopenagent_architecture.md |
| OpenCode | 权限通配符 + diff预览 | ✅ 已实现 | memory/reference_three_project_deep_learning.md |
| Hermes | Context File注入扫描(prompt injection/exfiltration/Unicode) | ❌ 缺失 | memory/reference_four_project_delivery_benchmark.md |
| CC | tool_use block的input必须是有效JSON | ✅ 已对齐 | memory/reference_claude_code_internals.md |

### 2.11 状态持久化

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| OpenClaw | session-file-repair 损坏修复 | ✅ sessionFileRepair.js | memory/reference_openclaw_analysis.md |
| DeepSeek-TUI | 原子会话写入 + 检查点 | ✅ checkpointService | memory/reference_three_project_deep_learning.md |
| Hermes | SQLite WAL + FTS5全文搜索 + checkpoint文件系统快照 + 增量保存 | 部分 (有JSON持久化,缺FTS5) | memory/reference_four_project_delivery_benchmark.md |
| Qwen Code | 配置版本迁移(v1→v4自动) | ✅ configMigration.js | memory/reference_qwen_code_full_gap_2025.md |

### 2.12 流管理

| 来源 | 学到的设计 | KHY 是否已实现 | 参考位置 |
|------|-----------|:-------------:|---------|
| CC | 流空闲90s看门狗 + 45s告警 + 孤儿tool_use合成tool_result | ✅ sseKeepalive对齐 | memory/reference_claude_code_internals.md |
| CC | ECONNRESET→粘性关闭Keep-Alive + 重建SDK客户端 | ✅ 已对齐 | 同上 |
| Abu-Cowork | 心跳 + 崩溃恢复checkpoint | 部分 | memory/reference_four_project_delivery_benchmark.md |
| DeepSeek-TUI | Actor非阻塞 + 透明重试(仅无内容时) | — 架构不同 | 同上 |
| Hermes | stale检测(per-provider阈值) + chunk级中断 + flood-control | ❌ 缺stale检测 | 同上 |
| KHY 原生 | sseBackpressure 反压 + sseKeepalive | ✅ | — |

---

## 三、设计模式精华库

从 12 个项目中提取的 **30 个可复用设计模式**：

### 循环与控制

| # | 模式名 | 来源 | 核心思想 | KHY 状态 |
|---|--------|------|---------|---------|
| 1 | 迭代预算 | Hermes | `IterationBudget(max, consume, refund, grace)` 线程安全计数器 | ❌ 待实现 |
| 2 | 迟滞控制器 | DeepSeek | 上/下阈值分离，避免反复触发(如渲染帧率) | ❌ 待实现 |
| 3 | 三策略守卫 | Hermes | exact_failure + same_tool_failure + no_progress，4级决策 | ❌ 待实现 |
| 4 | Doom Loop | OpenCode | 3次完全相同调用→暂停请求确认 | 部分 |
| 5 | Cycle-restart | DeepSeek | 上下文满时原子替换为carry-forward简报，非渐进压缩 | ✅ |
| 6 | Grace Call | Hermes | 预算耗尽后允许最后1次生成回复 | ❌ 待实现 |

### 压缩与上下文

| # | 模式名 | 来源 | 核心思想 | KHY 状态 |
|---|--------|------|---------|---------|
| 7 | 工具输出预裁剪 | Hermes | 执行后立即替换为类型化1行摘要 | ❌ 待实现 |
| 8 | 压缩防抖 | Hermes | 连续2次节省<10%→跳过；摘要失败→600s冷却 | ❌ 待实现 |
| 9 | 缓存经济学 | DeepSeek | 评估压缩前缀cache命中价值，避免浪费cache投资 | ❌ 待实现 |
| 10 | 截断恢复 | Hermes+Abu | finish_reason=length → 续传prompt → 3次重试 + maxOutput翻倍 | ❌ 待实现 |
| 11 | Seam Manager | DeepSeek | append-only保留prefix cache，L1/L2/L3三级缝合 | ✅ |

### Prompt 与模型

| # | 模式名 | 来源 | 核心思想 | KHY 状态 |
|---|--------|------|---------|---------|
| 12 | Prompt 缓存分区 | Hermes+Abu | Stable/Context/Volatile三层 + cache_control断点 | ❌ 待实现 |
| 13 | 模型专属 Prompt | Hermes+OpenCode | GPT(XML纪律)/Gemini(先验证)/Anthropic(简洁) | ❌ 待实现 |
| 14 | Bookend i18n | DeepSeek | 目标语言包裹英文核心prompt | ❌ 待实现 |
| 15 | Turn 元数据 | DeepSeek | 放user消息而非system prompt，保护prefix cache | ❌ 待实现 |

### 子代理与并行

| # | 模式名 | 来源 | 核心思想 | KHY 状态 |
|---|--------|------|---------|---------|
| 16 | 任务委派 | Hermes | single+batch模式，隔离子agent，禁止递归delegate | ❌ 待实现 |
| 17 | 并行安全分类 | Hermes | PARALLEL_SAFE / PATH_SCOPED / NEVER_PARALLEL 三集合 | ✅ isConcurrencySafe声明 |
| 18 | 编排者角色 | Hermes | 子agent保留delegate工具，可再派生，spawn深度限制 | ❌ 待实现 |
| 19 | 心跳监控 | Hermes | 30s心跳 + idle/in-tool 分离stale阈值 | ❌ 待实现 |
| 20 | Mailbox 协议 | oh-my-openagent | 有界队列 + 单调递增seq + ACK + 背压 | ✅ |

### 安全与稳定

| # | 模式名 | 来源 | 核心思想 | KHY 状态 |
|---|--------|------|---------|---------|
| 21 | 错误分类器 | Hermes | ClassifiedError 18类 + { retryable, should_compress, should_rotate, should_fallback } | 部分 (13类) |
| 22 | 凭证池轮换 | Hermes | 4策略(fill_first/round_robin/random/least_used) + per-key冷却 | ❌ 待实现 |
| 23 | Turn-scoped 恢复 | Hermes | fallback在当前turn生效，下一turn尝试恢复primary | ❌ 待实现 |
| 24 | Context 注入扫描 | Hermes | 注入AGENTS.md前正则检测prompt injection/exfiltration/Unicode | ❌ 待实现 |
| 25 | Comment Checker | oh-my-openagent | 外部二进制拦截AI在Write/Edit中插入的废话注释 | ❌ 待实现 |

### UX 与显示

| # | 模式名 | 来源 | 核心思想 | KHY 状态 |
|---|--------|------|---------|---------|
| 26 | Leader 键序列 | OpenCode | `<leader>+key` 组合替代长命令 | ❌ 待实现 |
| 27 | 命令面板 | OpenCode | Ctrl+K 唤出模糊搜索命令列表 | ❌ 待实现 |
| 28 | 三级色深 | DeepSeek | 4bit/8bit/24bit 自动适配终端能力 | ❌ 待实现 |
| 29 | Toast 通知 | OpenCode | 自动消失的非阻塞提示 | ❌ 待实现 |
| 30 | Housekeeping 过滤 | Hermes | memory/todo/skill操作不计入交付摘要 | ❌ 待实现 |

---

## 四、综合评分矩阵

### 4.1 交付能力 (11 维度 / 满分 110)

| 维度 | Abu | OpenCode | DS-TUI | Hermes | CC | Qwen | KHY |
|------|:---:|:--------:|:------:|:------:|:--:|:----:|:---:|
| D1 工具循环 | 8 | 7 | 9 | 9 | 9 | 7 | 6 |
| D2 循环守卫 | 3 | 6 | 8 | 10 | 8 | 5 | 4 |
| D3 上下文压缩 | 9 | 7 | 8 | 9 | 8 | 8 | 5 |
| D4 截断恢复 | 9 | 0 | 0 | 8 | 7 | 3 | 0 |
| D5 子代理 | 7 | 5 | 7 | 10 | 9 | 6 | 0 |
| D6 交付反馈 | 3 | 3 | 3 | 6 | 7 | 3 | 5 |
| D7 模型路由 | 7 | 6 | 3 | 10 | 5 | 5 | 7 |
| D8 Prompt工程 | 7 | 7 | 7 | 10 | 8 | 6 | 3 |
| D9 流管理 | 7 | 4 | 7 | 8 | 9 | 5 | 5 |
| D10 状态持久化 | 4 | 4 | 4 | 9 | 6 | 5 | 5 |
| D11 并行工具 | 6 | 3 | 7 | 9 | 8 | 4 | 0 |
| **总分** | **70** | **52** | **63** | **98** | **84** | **57** | **40** |

### 4.2 用户体验 (22 维度 / Qwen对标)

综合评分: **KHY 8.7/10** vs Qwen 7.9/10 — KHY 在 SDK/工具/安全/领域特化领先，测试覆盖率是唯一弱项。

### 4.3 UX 交互 (10 维度)

综合得分: **KHY 4.75/5** — G1-G10 全部完成 + Hermes 3模式忙碌输入完全对齐。

### 4.4 AI 显示 (16 维度)

综合得分: **P0-P3 全部完成** — 流式渲染/Thinking/工具耗时/CJK/截断/高亮/状态栏/菜单/图标全部对齐。

---

## 五、KHY 独有优势（竞品均无）

这些能力是 KHY 的护城河，任何修改不得退化：

| 能力 | 规模 | 说明 |
|------|------|------|
| 22 路 Gateway 适配器 | 16 个云端/IDE + 8 种协议格式 | 无竞品匹配的适配器广度 |
| 4 层防护级联 | fast-fail/暂态冷却/断路器/自愈 | 最完善的适配器容错 |
| 量化交易引擎 | backtestEngine + strategyEngine + 9 种交易 Agent | 完整回测+策略推荐 |
| OS 模式 | Alpine ISO + OpenRC + 内核引导 | 可作为独立操作系统启动 |
| WASM 沙箱 | wasm-sandbox + wasm-chain + wasm-indicators | WebAssembly 隔离执行 |
| 租约制任务编排 | taskBoard CAS原子claim + workerAgent | 独有协调模式 |
| 中文自然语言快捷映射 | inputPreprocessor 20 条 intentRoutes | 最佳中文交互 |
| SSRF 防护 | ssrfGuard 11.4K LOC | 独立防护层 |
| 杀毒集成 | antivirusService 11.4K LOC | 恶意代码扫描 |
| 模型训练管线 | modelTrainingService 53.8K LOC | LoRA/微调/本地训练 |
| 崩溃恢复 | crashRecovery 10.4K LOC | 自动故障恢复 |

---

## 六、路径指引：优先实施路线图

基于所有分析的综合结论，按投入/产出比排序：

### Phase 1: 核心交付能力（40→65 分）

目标：解决"CC 能交付、KHY 不能交付"的根本问题。

| 序号 | 任务 | 最优来源 | 影响维度 | 预估工作量 |
|------|------|---------|---------|-----------|
| 1.1 | 截断恢复(finish_reason=length续传) | Hermes+Abu | D4: 0→7 | 0.5天 |
| 1.2 | 迭代预算+Grace Call | Hermes | D1: 6→8 | 0.5天 |
| 1.3 | 三策略循环守卫 | Hermes | D2: 4→8 | 1天 |
| 1.4 | 模型专属Prompt(GPT/Gemini/通用) | Hermes+OpenCode | D8: 3→7 | 1天 |
| 1.5 | 工具输出预裁剪 | Hermes | D3: 5→7 | 0.5天 |
| 1.6 | 并行工具执行(读并行/写串行) | Hermes | D11: 0→6 | 1天 |

### Phase 2: 子代理体系（65→80 分）

目标：复杂任务可委派拆分。

| 序号 | 任务 | 最优来源 | 影响维度 | 预估工作量 |
|------|------|---------|---------|-----------|
| 2.1 | delegate_task 单任务委派 | Hermes | D5: 0→6 | 2天 |
| 2.2 | batch 并行子代理 | Hermes | D5: 6→8 | 1天 |
| 2.3 | spawn深度控制+心跳监控 | Hermes | D5: 8→9 | 1天 |
| 2.4 | Prompt缓存分区(Stable/Context/Volatile) | Hermes+Abu | D8: 7→9 | 1天 |

### Phase 3: 稳定性与效率（80→90 分）

目标：生产环境级别可靠性。

| 序号 | 任务 | 最优来源 | 影响维度 | 预估工作量 |
|------|------|---------|---------|-----------|
| 3.1 | 压缩防抖(连续低效→跳过+冷却) | Hermes | D3: 7→8 | 0.5天 |
| 3.2 | 凭证池轮换(4策略) | Hermes | D7: 7→9 | 1天 |
| 3.3 | Turn-scoped fallback恢复 | Hermes | D7: 9→10 | 0.5天 |
| 3.4 | Stale流检测+per-provider超时 | Hermes | D9: 5→7 | 0.5天 |
| 3.5 | 错误分类器升级(13→18类) | Hermes | D7+D9 | 0.5天 |
| 3.6 | Context注入安全扫描 | Hermes | D8安全 | 0.5天 |

### Phase 4: 打磨（90→98 分）

| 序号 | 任务 | 最优来源 |
|------|------|---------|
| 4.1 | Housekeeping 过滤(memory/todo不计入交付) | Hermes |
| 4.2 | Leader 键序列 | OpenCode |
| 4.3 | 命令面板(Ctrl+K) | OpenCode |
| 4.4 | 三级色深适配 | DeepSeek |
| 4.5 | Comment Checker | oh-my-openagent |
| 4.6 | Bookend i18n | DeepSeek |
| 4.7 | SQLite WAL+FTS5会话搜索 | Hermes |
| 4.8 | Checkpoint 文件系统快照 | Hermes |

---

## 七、更新日志

| 日期 | 事件 | 新增项目 | 发现数 |
|------|------|---------|--------|
| 2026-05-10 | OpenClaw 全量分析 | OpenClaw | 41项移植 |
| 2026-05-15 | Qwen Code 全面对标 | Qwen Code | 22维度 |
| 2026-05-15 | oh-my-openagent 架构分析 | oh-my-openagent | 8项关键创新 |
| 2026-05-19 | 六工具CLI对比 | DeepSeek-TUI, LibreChat | 18项差距G1-G18 |
| 2026-05-20 | AI显示系统四项目对标 | (Claude/DeepSeek/Qwen/LibreChat) | 16项P0-P3 |
| 2026-05-21 | 三项目深度学习 | DeepSeek-TUI, Hermes, OpenCode | 30项G1-G30 + 24模式 |
| 2026-05-21 | UX交互四项目对标 | (OpenCode/Claude/DeepSeek/Hermes) | 10项G1-G10 |
| 2026-05-26 | CC对标第六轮 | (Claude Code) | 15项修复 |
| 2026-05-26 | 四项目交付能力对标 | Abu-Cowork, opencode-dev | 11维度+12项最优方案 |

---

*本文档为持续更新的活文档。每次新增竞品分析时，在对应维度表格中追加行，并更新更新日志。*
