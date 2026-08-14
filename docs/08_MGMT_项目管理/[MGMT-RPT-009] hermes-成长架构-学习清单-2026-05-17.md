<!-- 文档分类: MGMT-RPT-009 | 阶段: 项目管理 | 原路径: docs/报告/hermes-成长架构-学习清单-2026-05-17.md -->
# Hermes Growth Architecture → KHY 学习清单 (2026-05-17)

## 范围

- 审阅的基线产物：`/home/kodehu03/Downloads/hermes-agent-main.zip`
- 解压路径：`/tmp/hermes-agent-main/hermes-agent-main`
- 本笔记的目标：总结 **KHY-OS 可以从 Hermes 的成长导向架构中直接学习之处**，并给出具体的采纳行动。

## 执行摘要

KHY 已经具备稳固的基础构件（带空闲超时的工具循环、插件加载器、工具自动发现、大任务运行时存储）。
最大的学习机会在于 **架构收敛**：减少重复的注册表/生命周期，使扩展点单一来源且可组合，并将发布/测试纪律正式化。

## 统一参考笔记 (2026-05-17)

关于 Hermes 成长架构的 Claude 会话发现已合并至：

- `docs/08_MGMT_项目管理/[MGMT-RPT-003] khy-对比-hermes-成长架构.md` 的 `4.1 Claude 会话发现统一执行映射（2026-05-17）` 一节

请将该节作为唯一的、整合后的跨文档入口，用于查阅：

- 优先级对齐（`P0/P1/P2/P3`），
- KHY 文件级落地区域，
- 以及采纳策略（`Adopt / Adapt` 理由，包括超时策略的适配）。

## KHY 学习清单

### 1) P0 — 跨所有界面的命令单一事实来源

- Hermes 证据：
  - `hermes_cli/commands.py` 的中央 `COMMAND_REGISTRY` 及其派生消费者（`resolve_command`、网关 help/menu/autocomplete）。
- KHY 现状：
  - `backend/src/cli/router.js` 维护 `COMMANDS` + `SUB_COMMANDS`。
  - `backend/src/cli/commandRegistry.js` 单独维护斜杠命令注册表。
  - `backend/src/cli/aliases.js` 是另一个命令映射界面。
- KHY 可学习：
  - 收敛为单一规范的命令定义模型，并由其生成 router/help/autocomplete/slash 映射。
  - 将别名表仅作为数据保留，而不是又一个路由权威来源。
- 验证：
  - 添加一致性测试，断言 route/help/completion/slash 全部派生自同一命令键集合。

### 2) P0 — 用适配器注册表替代静态网关适配器列表

- Hermes 证据：
  - `gateway/platform_registry.py` 基于注册表的适配器创建/校验。
  - `hermes_cli/plugins.py` 的 `register_platform(...)` 用于插件平台注入。
- KHY 现状：
  - `backend/src/services/gateway/aiGateway.js` 在构造函数中硬编码 `this._adapters` 列表。
- KHY 可学习：
  - 引入 `gateway/adapterRegistry.js`（`register`、`unregister`、`list`、`create`），并将静态列表移入引导阶段的注册。
  - 让插件加载器通过稳定契约注册适配器。
- 验证：
  - 添加一个测试适配器夹具，断言无需编辑 `aiGateway.js` 即可被发现/选择。

### 3) P0 — 收敛插件生命周期（避免三条并行的插件路径）

- Hermes 证据：
  - `hermes_cli/plugins.py` 支持多来源发现 + 启用/禁用策略 + 生命周期钩子（`VALID_HOOKS`）。
- KHY 现状：
  - `backend/src/plugin-loader/index.js`（清单/插件包加载器），
  - `backend/src/cli/plugins.js`（用户命令插件），
  - `backend/src/services/gateway/pluginChain.js`（仅网关的钩子插件）。
- KHY 可学习：
  - 定义一个宿主级插件生命周期，具备分层能力（commands/tools/gateway hooks）和共享的启用/禁用策略。
  - 在迁移期间为旧插件格式保留向后兼容的适配器。
- 验证：
  - 添加集成测试：一个插件在同一包中注册 command + tool + gateway hook，且全部生效。

### 4) P0 — 面向长会话成长的上下文引擎接口

- Hermes 证据：
  - `agent/context_engine.py` 定义了可插拔的上下文引擎生命周期（`should_compress`、`compress`、`update_model`、会话钩子）。
- KHY 现状：
  - 上下文/token 行为大多内嵌在循环/UI 路径中（`backend/src/services/toolUseLoop.js`、`backend/src/cli/hudRenderer.js`）。
- KHY 可学习：
  - 在 KHY 中创建 `contextEngine` 抽象，至少包含 `noop` + `compressor` 两种实现。
  - 将策略从临时的循环代码移入策略对象。
- 验证：
  - 在 `noop` 与 `compressor` 下对同一长提示序列做 A/B 测试，比较 token 预算行为 + 最终答案质量。

### 5) P1 — 调度器从会话内存迈向持久化自动化

- Hermes 证据：
  - `cron/scheduler.py` 具备锁保护的 tick 循环、平台投递桥接以及插件平台扩展路径。
- KHY 现状：
  - `backend/src/tools/ScheduleCronTool/index.js` 将作业存储在内存 map（`_cronJobs`）中，仅限会话作用域。
- KHY 可学习：
  - 将 cron 作业和运行状态持久化到耐久存储。
  - 支持显式投递目标（CLI/home-channel/webhook），并具备回退与审计追踪。
- 验证：
  - 进程重启恢复测试：调度作业在重启后仍存活，并在预期时间窗口内执行一次。

### 6) P1 — 发布纪律：dry-run 变更日志 + 打标签 + 产物流水线

- Hermes 证据：
  - `scripts/release.py` 提供 dry-run/publish 模式、semver 版本递增、变更日志生成、标签创建、产物构建、GitHub release。
- KHY 现状：
  - `backend/src/cli/handlers/publish.js` 很好地处理了构建/检查/上传，但发布说明/标签编排仍为手动。
- KHY 可学习：
  - 添加 release dry-run 命令，在发布前输出分类的变更日志以及计划中的版本/标签变更。
  - 保留当前 `publish` 路径作为产物上传执行器。
- 验证：
  - CI release 模拟：dry-run 必须生成确定性的发布说明文件和版本差异摘要。

### 7) P1 — 打包中的供应链加固策略

- Hermes 证据：
  - `pyproject.toml` 记录了精确锁定（exact-pin）策略，并将特定提供方依赖保留在 extras/惰性路径中。
- KHY 现状：
  - `pyproject.toml` 在核心/可选依赖中仍使用多个宽泛的版本范围。
- KHY 可学习：
  - 将依赖分类为：
    - 核心精确锁定，
    - 可选的提供方 extras，
    - 适当情况下的惰性安装路径。
  - 在打包文档中添加明确的策略说明。
- 验证：
  - 锁文件可复现性检查 + CI 中的依赖漂移告警。

### 8) P1 — 会话状态 + 可检索记忆作为成长基底

- Hermes 证据：
  - `hermes_state.py` 使用 SQLite + FTS5 + 来源标记以及 WAL 回退逻辑，实现稳健的跨会话召回。
- KHY 现状：
  - 会话与成长数据机制已存在，但尚未围绕单一可检索的状态基底统一。
- KHY 可学习：
  - 定义一个规范的会话状态存储，带有可检索的对话索引和来源标记。
  - 向 AI 循环和 skill 层暴露召回原语。
- 验证：
  - 查询基准测试：在合成的多会话历史上测量召回延迟与命中质量。

### 9) P2 — 工具可用性评估缓存与刷新契约

- Hermes 证据：
  - `tools/registry.py` 包含注册表级可用性检查 + TTL 缓存失效。
- KHY 现状：
  - `backend/src/tools/index.js` 具备强大的自动发现/注册，但可用性探测策略仍是逐工具各自实现。
- KHY 可学习：
  - 添加标准的可用性检查契约 + 短 TTL 缓存 + 配置变更时的失效 API。
- 验证：
  - 工具可用性翻转测试（env/config 切换），并具备确定性的传播延迟边界。

### 10) P2 — 测试分层作为架构反馈回路

- Hermes 证据：
  - `tests/` 按领域拆分（`agent`、`gateway`、`plugins`、`e2e`、`stress` 等）。
- KHY 现状：
  - `backend/tests` 具备良好的 service/gateway 覆盖，但针对架构特性的专用 stress/e2e 切片仍有限。
- KHY 可学习：
  - 为以下方面添加显式测试套件：
    - 长循环稳定性，
    - 插件生命周期兼容性，
    - 发布流水线完整性，
    - 调度器持久性。
- 验证：
  - 带有 unit/integration/e2e/stability 多通道的 CI 矩阵，并附带失败归因标签。

## 建议的采纳顺序

### 阶段 A（1-2 周，最高 ROI）

1. 命令单一来源收敛（清单 #1）
2. 适配器注册表重构（清单 #2）
3. 插件生命周期收敛设计 + 兼容性垫片（清单 #3）

### 阶段 B（2-4 周，成长能力）

1. 上下文引擎抽象落地（清单 #4）
2. 持久化调度器基础（清单 #5）
3. 发布 dry-run + 变更日志自动化（清单 #6）

### 阶段 C（4+ 周，规模加固）

1. 依赖策略加固（清单 #7）
2. 规范的可检索会话状态（清单 #8）
3. 可用性缓存 + 分层测试通道（清单 #9、#10）

## KHY 仓库的即时后续行动

1. 创建一个 `command schema` 模块，替换重复的命令列表。
2. 引入 `adapterRegistry`，并将 `aiGateway` 静态列表迁移到注册式。
3. 起草一份统一的插件生命周期契约，映射现有的：
   - `plugin-loader`，
   - `cli/plugins`，
   - `gateway/pluginChain`。
