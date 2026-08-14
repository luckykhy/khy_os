<!-- 文档分类: MGMT-RPT-003 | 阶段: 项目管理 | 原路径: docs/khy-对比-hermes-成长架构.md -->
# KHY OS vs Hermes Agent — 成长型架构对齐分析

> 分析日期：2026-05-17
> 对标版本：hermes-agent v0.14.0 (808 commits, 633 PRs, 215 contributors)
> 目的：识别 Hermes Agent 的成长型架构模式，提取 KHY OS 可借鉴的设计

---

## 1. Hermes Agent 项目定位

Hermes Agent 是 Nous Research 构建的**自进化 AI 代理**，核心卖点：
- 唯一内置学习闭环的 agent——从经验创建技能、使用中改进、主动持久化知识
- 不绑定笔记本——22 个平台(Telegram/Discord/Slack/WhatsApp 等)统一网关
- 任意模型——200+ 模型零代码切换，无锁定
- 随处运行——7 种终端后端，$5 VPS 到 GPU 集群

**规模指标**：80+ 工具、22 网关平台、8+ LLM 提供商、18+ 语言、~17k 测试、MIT 许可（Hermes）

---

## 2. 六大核心架构模式

### 2.1 零清单自动发现

```
tools/registry.py  (零依赖单例)
    ↑ 模块级 registry.register() — 导入即注册
tools/*.py
    ↑ model_tools.discover_builtin_tools() — AST 扫描
run_agent.py / cli.py / gateway
```

- 新增工具只需在文件里调 `registry.register()`，无中央清单维护
- `check_fn` + 30s TTL 缓存动态探测工具可用性
- 工具集系统 (`toolsets.py`) 把工具分组为 `web`/`terminal`/`debugging` 等，支持递归 `includes`

**KHY 对标**：`commandRegistry.js` 已有类似模式，但工具层（toolCalling/shellCommand）尚未统一到注册表。

### 2.2 七类可插拔扩展点

| 扩展类型 | 抽象接口 | 发现方式 |
|---------|---------|---------|
| 工具 | `registry.register()` | 目录扫描+AST |
| LLM 提供商 | `*_adapter.py` (8+) | 配置选择 |
| 内存提供商 | `MemoryProvider` 基类 | `plugins/memory/` 目录 |
| 上下文引擎 | `ContextEngine` 抽象类 | `plugins/context_engine/` |
| 网关平台 | `BasePlatformAdapter` | `platform_registry` 单例 |
| 技能 | `.hermes.md` 元数据 | 三目录扫描(内置/可选/用户) |
| CLI 命令 | `PluginContext.register_cli_command()` | 插件生命周期钩子 |

**核心原则**：添加任何新能力都不需要修改核心代码。插件通过 `register(ctx)` 回调注入能力，核心代码只暴露接口。

**AGENTS.md 硬性规则**："plugins MUST NOT modify core files. If a plugin needs a capability the framework doesn't expose, expand the generic plugin surface — never hardcode plugin-specific logic into core."

**KHY 对标**：skills 通过 `manifest.json` 声明但缺少统一的 `PluginContext` 注入；各 service 各自 `require()` 依赖。

### 2.3 分级故障转移 + 凭证池

```
错误分类 (error_classifier.py)
    → context_overflow   → 压缩，不故障转移
    → rate_limit/billing → 凭证轮换 (credential_pool round-robin)
    → model_not_found    → 故障转移到备用模型
    → server_error       → 指数退避 + 重试
    → auth               → 刷新 OAuth token
    → auth_permanent     → 中止
```

凭证池支持多 API Key 轮换 + OAuth 自动刷新，错误不导致会话中断。

**KHY 对标**：`aiGateway.js` 有 adapter fallback 但无错误分类枚举，单 Key 无轮换。

### 2.4 上下文分层保护

```
[保护的前 3 条] → 系统提示 + 首轮用户消息（永不压缩）
[可压缩历史]   → 当使用率 > 75% 触发压缩
[保护的后 6 条] → 最近对话（永不压缩）
```

- `protect_first_n` 可配置（v0.14 新增）
- 上下文引擎可插拔（内置摘要压缩器 vs LCM 插件）
- **Prompt 缓存保护规则**：命令默认延迟生效（下个 session），`--now` 才立即失效

**KHY 对标**：`promptCacheService.js` 有缓存但无分层保护，无延迟失效机制。

### 2.5 配置四层优先级

```
优先级: CLI 标志 > 环境变量 > ~/.hermes/config.yaml > 代码默认值
```

- 支持 `${ENV_VAR}` 插值、`~` 路径展开
- 多 Profile 隔离：`get_hermes_home()` 统一路径入口
- 三个配置加载器：`load_cli_config()`(CLI) / `load_config()`(子命令) / 直接 YAML(Gateway)

**KHY 对标**：配置通过 `.env` + 代码默认值两层，缺少 YAML 配置层和 Profile 隔离。

### 2.6 版本演进策略

- v0.2 → v0.14：每版增强抽象但保持 API 兼容
- `uv.lock` 哈希验证 + 依赖精确固定
- 特性通过配置标志渐进激活
- RELEASE_*.md 详尽记录每版变更

---

## 3. README/AGENTS.md 深度补充（8 项新发现）

### 3.1 闭环学习系统

Hermes 自称"唯一内置学习闭环的代理"，包含 5 个子系统：

| 子系统 | 实现 | KHY 现状 |
|--------|------|---------|
| 技能自创建 | 复杂任务后自动从经验创建技能 | 无 |
| 技能自改进 | Curator 后台巡检 + 使用中改进 | 无 |
| 主动持久化 | 周期性 nudge 提醒 agent 存储知识 | 无 |
| 跨会话搜索 | FTS5 全文搜索 + LLM 摘要 | 无 session 持久化 |
| 用户建模 | Honcho 辩证式画像 | 无 |

**Curator 详细设计**：
- 生命周期：`active → stale → archived`（永不删除，归档到 `~/.hermes/skills/.archive/`）
- 追踪字段：`use_count`/`view_count`/`patch_count`/`last_activity_at`/`state`/`pinned`
- Pinned 技能免除所有自动转换和 LLM review
- 配置：`stale_after_days`/`archive_after_days`/`interval_hours`/`min_idle_hours`
- CLI：`hermes curator status/run/pause/resume/pin/unpin/archive/restore/prune/backup/rollback`

### 3.2 七种终端后端

`tools/environments/` 实现：

| 后端 | 特点 |
|------|------|
| local | 本地执行 |
| Docker | 容器隔离 |
| SSH | 远程执行 |
| Singularity | HPC 容器 |
| Modal | Serverless，空闲休眠 |
| Daytona | Serverless 持久化 |
| Vercel Sandbox | 边缘计算 |

**KHY 对标**：仅 local，`remoteSsh.js` 仅骨架。应统一 `BasePlatformAdapter` 接口。

### 3.3 Cron 调度系统

| 特性 | 描述 |
|------|------|
| 格式 | 自然语言 / duration / 5-field cron / ISO 时间戳 |
| 硬中断 | 3 分钟强制终止防失控 |
| no_agent 模式 | 纯脚本监控，stdout 有输出才投递 |
| context_from | 链式——A 输出注入 B prompt |
| 跨平台投递 | 结果可发到任何已连接平台 |
| 安全 | 组装 prompt 扫描注入攻击 |

**KHY 对标**：无调度系统。`backgroundTaskManager.js` 可作为基础扩展。

### 3.4 子代理委派约束

```
delegate_task:
  role: "leaf"          # 不能再委派
  role: "orchestrator"  # 可再委派，受深度限制

约束:
  max_spawn_depth: 2           # 防递归
  max_concurrent_children: 3   # 并发上限
  child_timeout_seconds: ...   # 超时杀
  subagent_auto_approve: ...   # 自动审批
  inherit_mcp_toolsets: ...    # MCP 继承
```

**KHY 对标**：`workerAgent.js`/`processAgent.js` 无深度限制和超时杀。

### 3.5 Skin/Theme 纯数据引擎

```yaml
# ~/.hermes/skins/cyberpunk.yaml
name: cyberpunk
colors:
  banner_border: "#FF00FF"
spinner:
  thinking_verbs: ["jacking in", "decrypting"]
branding:
  agent_name: "Cyber Agent"
```

- 4 个内置 skin + 用户 `~/.hermes/skins/` 目录
- 覆盖：banner 颜色、spinner 表情/动词/翅膀、工具前缀、品牌文字
- `/skin <name>` 运行时切换，零代码变更

**KHY 对标**：`aiRenderer.js` 颜色硬编码，应抽取为 JSON/YAML 配置。

### 3.6 供应链安全策略

| 来源类型 | 固定方式 | 示例 |
|---------|---------|------|
| PyPI | `>=floor,<next_major` | `httpx>=0.28.1,<1` |
| Git URL | Commit SHA | `git+https://...@<40-char-sha>` |
| GitHub Actions | SHA + 注释 | `uses: actions/checkout@<sha>  # v4` |
| CI-only pip | `==exact` | `pyyaml==6.0.2` |

起因：litellm 供应链攻击(PR #2796) + Mini Shai-Hulud 蠕虫(2026-05)。

**KHY 对标**：`package.json` 应检查裸 `>=` 依赖，补上限。

### 3.7 AGENTS.md 工程规范

| 规范 | 描述 |
|------|------|
| 插件不修改核心 | 需要能力则扩展 plugin surface |
| Prompt 缓存不破 | 命令默认延迟生效，`--now` 立即 |
| 不写变更探测器测试 | 测试合约关系而非快照值 |
| 统一路径入口 | `get_hermes_home()` 多 Profile 安全 |
| 竞品迁移 | OpenClaw 一键迁移设置/记忆/技能/Key |
| 不用 simple_term_menu | Ghost-duplication bug，改用 curses |
| 不用 `\033[K]` | prompt_toolkit 下泄露字符 |

### 3.8 Kanban 多代理编排

v0.13 引入持久化 Kanban 看板：

| 特性 | 描述 |
|------|------|
| 持久化 | SQLite 看板 |
| 心跳检测 | worker 定期 heartbeat |
| Zombie 回收 | 自动检测僵尸 worker |
| 幻觉门控 | 检测 worker 虚假声称完成 |
| 自动阻塞 | 5 次连续失败自动 block 防 spin loop |
| 多租户 | Tenant 隔离 + Board 硬边界 |
| Dashboard | Web UI 可视化 |
| 重试 | per-task `max_retries` |

**KHY 对标**：`largeTaskOrchestrator.js` 更基础，缺少心跳/幻觉门控/自动阻塞。

---

## 4. KHY OS 对齐清单（按优先级排序）

### P0 — 立即可做，价值高

| # | 项目 | 复杂度 | KHY 现状 | 具体行动 |
|---|------|--------|---------|---------|
| 1 | 技能生命周期(Curator) | 中 | skills 静态 manifest.json | 给每个 skill 加 `use_count`/`last_activity_at`；实现 active→stale→archived；pin 保护 |
| 2 | 子代理深度限制+超时杀 | 低 | workerAgent 无约束 | 加 `maxSpawnDepth=2`/`maxConcurrentChildren=3`/`childTimeoutMs` |

### P1 — 近期应做，防止技术债

| # | 项目 | 复杂度 | KHY 现状 | 具体行动 |
|---|------|--------|---------|---------|
| 3 | Cron 调度+跨渠道投递 | 中 | 无调度 | 扩展 backgroundTaskManager，支持 cron 表达式 + 3 分钟硬中断 |
| 4 | Prompt 缓存保护 | 低 | promptCacheService 无保护 | 修改工具/技能的 system prompt 默认延迟到下个 session 生效 |
| 5 | 依赖上限固定 | 低 | package.json 未审计 | 审计所有 `>=` 依赖，补 `<next_major` 上限 |
| 6 | 错误分类枚举 | 低 | Gateway 有 fallback 无分类 | 新建 `errorClassifier.js`，区分 auth/rate_limit/context_overflow/server_error |

### P2 — 中期规划，提升竞争力

| # | 项目 | 复杂度 | KHY 现状 | 具体行动 |
|---|------|--------|---------|---------|
| 7 | 终端后端抽象 | 高 | 只有 local | 定义 `BaseTerminalBackend` 接口，先实现 Docker+SSH |
| 8 | Skin/Theme 引擎 | 低 | aiRenderer 硬编码 | 抽取颜色/spinner/品牌到 YAML 配置 |
| 9 | Session 持久化+FTS5 | 中 | 无 session 持久化 | SQLite WAL + FTS5 全文搜索 |
| 10 | 凭证池+自动轮换 | 中 | 单 Key | 多 Key round-robin + OAuth 刷新 |

### P3 — 远期目标，差异化能力

| # | 项目 | 复杂度 | KHY 现状 | 具体行动 |
|---|------|--------|---------|---------|
| 11 | Kanban 多代理编排 | 高 | largeTaskOrchestrator 基础 | SQLite 看板+心跳+幻觉门控 |
| 12 | 用户建模(Honcho式) | 高 | 无 | 辩证式用户画像 |
| 13 | PluginContext 统一注入 | 中 | 各 service 各自 require | 统一 register(ctx) 回调 |

### 4.1 Claude 会话发现统一执行映射（2026-05-17）

为避免 Hermes 相关结论分散在多份笔记中，以下把 Claude 会话新增发现统一映射到 KHY 的落地入口。

| Claude 发现 | 优先级 | 统一落点 | 执行入口 | 处理策略 |
|---|---|---|---|---|
| 闭环学习系统（技能自创建/改进/持久化/跨会话搜索/用户建模） | P0/P2/P3 | 本文 3.1、4（#1/#9/#12） | `backend/src/skills/` + `backend/src/services/sessionPersistence.js` | 分阶段推进：先做 `use_count/last_activity_at` 与 Curator 生命周期，再扩展 FTS5 与用户建模 |
| 七种终端后端抽象（local/docker/ssh/singularity/modal/daytona/vercel） | P2 | 本文 3.2、4（#7） | `backend/src/services/toolSandbox.js`、`backend/src/services/remote/` | 先统一 `BasePlatformAdapter` 接口，再按 local→docker→ssh 递进扩展 |
| Cron 调度（多格式输入、链式 context、跨渠道投递） | P1 | 本文 3.3、4（#3） | `backend/src/services/backgroundTaskManager.js`、`backend/src/services/channels/` | 采用“可观测进展 + 空闲超时”模式；Hermes 的固定硬中断做法在 KHY 需改为符合 Rule 3 的 activity-based timeout |
| 子代理委派约束（深度/并发/超时） | P0 | 本文 3.4、4（#2） | `backend/src/coordinator/workerAgent.js`、`backend/src/coordinator/processAgent.js` | 增加 `maxSpawnDepth`、`maxConcurrentChildren`、`childTimeoutMs`，并输出清晰状态日志 |
| Skin/Theme 纯数据引擎 | P2 | 本文 3.5、4（#8） | `backend/src/cli/aiRenderer.js` | 抽离颜色/文案/spinner 到 JSON/YAML，可运行时切换 |
| 供应链依赖固定策略 | P1 | 本文 3.6、4（#5） | `package.json`、`pyproject.toml`、CI workflow | 审计宽范围依赖并加上界；CI-only 依赖走精确 pin |
| AGENTS.md 工程规范迁移 | P1 | 本文 3.7、4（#4） | `backend/src/services/promptCacheService.js` + 测试规范 | 先落地“默认延迟失效，`--now` 立即生效”与合约测试导向 |
| Kanban 多代理编排（持久化+心跳+幻觉门控） | P3 | 本文 3.8、4（#11） | `backend/src/tasks/largeTaskOrchestrator.js`、`backend/src/tasks/largeTaskRuntimeStore.js` | 先补心跳与失败阻断，再演进到看板化与可视化 |

统一引用建议：
- 战略对齐与优先级：本文件（`docs/KHY_VS_HERMES_AGENT_GROWTH_ARCHITECTURE.md`）
- 可执行任务拆解：`docs/08_MGMT_项目管理/[MGMT-RPT-008] hermes-khy-p0-执行任务-2026-05-17.md`
- 代码级学习清单：`docs/08_MGMT_项目管理/[MGMT-RPT-009] hermes-成长架构-学习清单-2026-05-17.md`

---

## 5. 架构对比总结

| 维度 | Hermes Agent | KHY OS | 差距 |
|------|-------------|--------|------|
| 扩展性 | 7 类可插拔扩展点 | commandRegistry + skills | 缺 PluginContext 统一注入 |
| 学习能力 | 闭环(自创技能+Curator+FTS5) | 无 | **最大差距** |
| 故障恢复 | 分级分类+凭证池+自动重试 | 单层 fallback | 缺错误分类 |
| 调度 | Cron+跨渠道+no_agent | 无 | 完全缺失 |
| 多代理 | Kanban+心跳+幻觉门控 | largeTask 基础 | 缺持久化+可靠性 |
| 安全 | 供应链 checker+依赖固定 | 基础 | 缺审计 |
| 测试 | ~17k 测试，CI parity | 有但覆盖率待评估 | — |
| 平台 | 22 网关平台 | CLI + Web | 定位不同 |
| 部署 | 7 终端后端+Serverless | 仅 local | 待扩展 |
| 主题 | Skin 引擎，纯数据 | 硬编码 | 低成本改进 |

---

## 6. 结论

Hermes Agent 的"成长型架构"核心在于：

1. **前置抽象**：每个系统预留扩展点（接口、注册表、钩子）
2. **自动发现**：无需修改核心代码即可添加工具/平台/插件
3. **闭环学习**：技能从经验中创建、使用中改进、自动归档
4. **分级容错**：错误不导致失败，智能路由到替代方案
5. **增量部署**：版本向后兼容，特性通过标志切换

KHY OS 最大的借鉴价值在 **闭环学习(Curator)** 和 **分级故障转移(error_classifier)** 两个方向，这两个能以中等成本带来最大的架构升级。
