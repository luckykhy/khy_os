<!-- 文档分类: MGMT-RPT-014 | 阶段: 项目管理 | 原路径: docs/指南/khy-qwen-差距修复清单.md -->
# KHY 与 qwen-code 差距修复清单（执行版）

更新日期：2026-05-14  
范围：CLI AI 运行时、网关模型选择、工具执行、超时与状态管线  
参考基线：`/home/kodehu03/Downloads/qwen-code-main.zip`

## 0. 目标结果（2 周）

1. `/model` 首次打开结果稳定，且与第二次打开结果接近（冷启动一致性）。
2. 对正在持续推进的长任务不做硬超时强杀；超时必须基于活动度判定。
3. 程序启动类意图（例如"打开飞书""打开 PDF 编辑器"）优先使用 `open_app`，并具备可靠的回退路径。
4. 执行器错误（例如 `fork: retry: Resource temporarily unavailable`）需被正确归类，不得误报为主机资源耗尽。
5. 状态输出始终遵循 `Action + Target + Progress`，且不出现固定的"卡在 8s"显示。

## 1. 已完成基线

- [x] AI 等待行流程中的等待状态推进不再固定冻结在 `8s`。
- [x] REPL 路径下 `ai-chat` 看门狗超时已与请求超时预算对齐。
- [x] 大任务超时预算已放宽，并在网关/codex 适配器路径中正确传递。

说明：本清单在当前基线之上继续推进，聚焦于剩余的系统性差距。

## 2. 第 1 周（P0 稳定性与正确性）

### P0-1. `/model` 首次打开一致性

目标：
- 解决"首次 `/model` 不完整、第二次 `/model` 才完整"的不一致问题。

待修改文件：
- `backend/src/cli/handlers/gateway.js`
- `backend/src/services/gateway/modelDiscovery.js`
- `backend/src/services/gateway/channelHealthBroadcaster.js`
- `backend/src/services/gateway/aiGateway.js`

实现：
1. 引入带时间戳与置信度评分的持久化探测快照（`lastStrictSnapshot`）。
2. 首次 `/model` 由 `snapshot + fast delta` 渲染，而非仅依赖快速探测。
3. 将严格探测移至后台刷新，并按 epoch/version 合并，而非盲目覆盖。
4. 在诊断输出中暴露"快照时间 + 置信度 + 探测阶段"。

验收标准：
1. 冷启动：正常网络下，首次与第二次 `/model` 的模型数量差异不超过 1 个瞬态项。
2. UI 清晰标注各项为 `snapshot`、`fast-probe` 或 `strict-verified`。
3. 任何隐藏通道都不会在无阶段/来源标签的情况下静默重现。

验证：
```bash
khy gateway status
khy gateway model
```
手动：
1. 启动全新会话，在 20 秒内运行两次 `/model`。
2. 对比模型集合与置信度标签。

### P0-2. Provider/Model 标识归一化

目标：
- 修复"codex 适配器把 `claude-*` 显示为 codex 原生模型"的问题。

待修改文件：
- `backend/src/services/gateway/modelDiscovery.js`
- `backend/src/services/gateway/modelRouter.js`
- `backend/src/services/gateway/protocolConverter/codex.js`
- `backend/src/cli/handlers/gateway.js`

实现：
1. 为发现的模型添加来源 Provider 元数据（`originProvider`、`servedByAdapter`）。
2. 拆分显示分组：`Native`、`Routed`、`Relay`。
3. 默认过滤：在适配器原生列表中隐藏跨 Provider 模型，除非用户启用"显示 routed/relay 模型"。
4. 若选中 routed 模型，在确认前显式展示执行路由。

验收标准：
1. `codex` 列表默认仅展示 codex 原生 ID。
2. 跨 Provider 模型仅在 routed/relay 区块中可见，并带清晰标签。
3. 选择确认信息包含 `adapter + upstream provider + route mode`。

验证：
```bash
cd backend && npm test -- modelRouter.test.js gatewayModelSelection.strictProbe.test.js
```

### P0-3. 执行器错误归因与恢复路径

目标：
- 避免在执行器/沙箱路径失败时得出"系统资源耗尽"的错误结论。

待修改文件：
- `backend/src/services/toolCalling.js`
- `backend/src/services/toolUseLoop.js`
- `backend/src/services/errorClassifier.js`
- `backend/src/cli/repl.js`
- `backend/src/cli/liteRepl.js`

实现：
1. 将 `executor_unavailable` 提升为一级错误类别，并附带结构化字段（`scope`、`retryable`、`suggestedAction`）。
2. 在程序启动意图 + shell 执行器不可用时：在最终失败前通过 `open_app` 自动恢复。
3. 错误输出必须显式区分：
   - 执行器/沙箱约束
   - 适配器超时
   - 已确认的主机资源压力
4. 对于超时退出，需包含"已完成步骤 vs 待处理步骤"摘要。

验收标准：
1. `fork` 失败不再输出泛化的主机资源耗尽结论。
2. 当 shell 探测失败时，程序启动请求自动尝试 `open_app` 恢复。
3. 最终失败文本包含未完成工作的披露。

验证：
```bash
cd backend && npm test -- toolCalling.shellForkClassify.test.js toolUseLoop.appLaunchRecovery.test.js
```

### P0-4. 基于活动的超时统一（禁止硬杀）

目标：
- 移除对活跃长任务的固定挂钟时间强杀逻辑。

待修改文件：
- `backend/src/services/resourceGuard.js`
- `backend/src/cli/ai.js`
- `backend/src/cli/repl.js`
- `backend/src/cli/liteRepl.js`
- `backend/src/services/gateway/aiGateway.js`
- `backend/src/services/gateway/adapters/codexAdapter.js`

实现：
1. 添加统一的活动心跳契约（`onChunk`、`onToolResult`、`onStatus`、`onLoopAdvance`）。
2. 用滑动空闲超时 + 可选的最大生命周期（用于死锁兜底）替换硬挂钟超时。
3. 让超时预算具备 Profile 感知能力（`small`、`normal`、`large`），并可由用户覆盖。
4. 超时消息必须报告：
   - 最后一次活动的时间戳
   - 已完成步骤
   - 最后一次成功的工具/模型事件

验收标准：
1. 长时间活跃任务不会仅因挂钟时间超限而被强杀。
2. 空闲超时仅在配置的空闲窗口内无任何进展事件时触发。
3. 日志包含支撑超时决策的活动证据。

验证：
```bash
cd backend && npm test -- aiGateway.stability.test.js aiGateway.stability.regressions.test.js aiCli.concurrentPreferredIsolation.test.js
```

### P0-5. 状态管线：Action + Target + Progress

目标：
- 让运行时状态透明且动态，杜绝含糊/不透明的等待文本。

待修改文件：
- `backend/src/cli/repl.js`
- `backend/src/cli/liteRepl.js`
- `backend/src/cli/aiRenderer.js`
- `backend/src/cli/agentRenderer.js`

实现：
1. 定义状态 Schema：`{action, target, progress, elapsedMs, source}`。
2. 用结构化行替换泛化文本，例如：
   - `Adapter claude probing connectivity (attempt 2/3, 6s)`
   - `Codex adapter waiting for first token (elapsed 14s)`
3. 按语义键去抖，而不仅按原始文本去抖。
4. 在支持/不支持回车符（carriage-return）的终端中，保持实时行更新稳定。

验收标准：
1. AI 运行时路径中不出现孤立的含糊状态行。
2. 等待期间进度数字/时间持续更新。
3. 混合适配器产生带来源标签的状态行。

验证：
```bash
node scripts/check-agent-rules.js --changed
```
手动：
1. 触发一个短任务和一个长任务；验证状态清晰度与推进情况。

## 3. 第 2 周（P1 能力与可运维性）

### P1-1. 程序级模糊意图路由（不只依赖模型）

目标：
- 为模糊的用户语言添加确定性的预路由，而不是仅依赖模型推理。

待修改文件：
- `backend/src/cli/router.js`
- `backend/src/cli/aliases.js`
- `backend/src/services/toolUseLoop.js`
- `backend/src/services/toolCalling.js`
- `backend/src/services/shellToToolMapper.js`

实现：
1. 在工具循环前添加轻量级意图分类器：`app_launch`、`file_edit`、`diagnosis`、`web_lookup`。
2. 对 `app_launch`，强制工具优先级：先 `open_app`，再 shell 回退。
3. 扩展模糊词库，覆盖中文错别字、拼音变体、重复字符。
4. 记录意图决策轨迹以便事后复盘。

验收标准：
1. 模糊请求仍能以高一致性映射到预期的工具路径。
2. 程序启动场景下首工具误触发率下降。
3. 调试日志中可获取意图轨迹。

验证：
```bash
cd backend && npm test -- toolUseLoop.guardrails.test.js toolUseLoop.appLaunchRewrite.test.js toolCalling.openAppAlias.test.js
```

### P1-2. 审批 / 权限 UX 对齐

目标：
- 让权限工作流具备清晰的模式语义与持久化的信任规则。

待修改文件：
- `backend/src/services/execApproval.js`
- `backend/src/services/permissionStore.js`
- `backend/src/cli/ui/permissionDialog.js`
- `backend/src/permissions/rules.js`

实现：
1. 将审批模式（`strict`、`on-failure`、`never` 等）统一为单一规范枚举。
2. 持久化按命令与按前缀的信任决策，并带作用域（`session`、`workspace`、`global`）。
3. 改进权限提示内容：操作、目标路径/命令、风险等级、复用规则。

验收标准：
1. 当作用域内已存在规则时，同一命令路径不再重复询问。
2. 提示文本明确且可审计。
3. 规则冲突解析具备确定性。

验证：
```bash
cd backend && npm test -- toolRegistryMcp.test.js hook-lifecycle.test.js
```

### P1-3. 配置分层与 Schema 迁移

目标：
- 让行为在 env/profile/session 覆盖下可复现。

待修改文件：
- `backend/src/config/env.js`
- `backend/src/config/settingsWhitelist.js`
- `backend/src/routes/settings.js`
- `backend/src/services/gateway/aiGateway.js`

实现：
1. 强制配置优先级：default < user < workspace < env < CLI override。
2. 为网关/超时/模型过滤添加 Schema 校验与迁移。
3. 提供 `khy doctor` 诊断，展示每个键的生效配置来源。

验收标准：
1. 生效的配置值始终包含来源轨迹。
2. 旧配置格式自动迁移并带警告。
3. 不存在向隐式硬编码值的静默回退。

验证：
```bash
cd backend && npm test -- proxyConfig.routing.test.js proxyConfigService.socks5Compatibility.test.js
```

### P1-4. 记忆 / 会话生命周期对齐

目标：
- 改善长会话的稳定性与可恢复性。

待修改文件：
- `backend/src/services/memoryDreaming.js`
- `backend/src/services/sessionFileRepair.js`
- `backend/src/services/sessionTraceSummary.js`
- `backend/src/services/compact/index.js`
- `backend/src/services/query/compactPipeline.js`

实现：
1. 统一会话压缩触发条件与摘要阈值。
2. 让记忆写入具备崩溃安全性（原子替换 + 完整性标记）。
3. 为部分损坏的会话文件添加恢复路径。

验收标准：
1. 长对话在压缩后仍保持回复质量。
2. 会话损坏可被自动修复或清晰隔离。
3. 压缩事件在状态日志中可见。

验证：
```bash
cd backend && npm test -- agent-context.test.js aiCli.feedback.stability.test.js
```

### P1-5. 测试矩阵与回归闸门

目标：
- 将近期事故模式转化为强制回归检查。

待修改文件：
- `backend/tests/gatewayModelSelection.strictProbe.test.js`
- `backend/tests/toolUseLoop.appLaunchRecovery.test.js`
- `backend/tests/toolCalling.shellForkClassify.test.js`
- `backend/tests/aiGateway.stability.regressions.test.js`
- `scripts/check-agent-rules.js`

实现：
1. 添加首次运行 `/model` 一致性场景。
2. 添加 executor-unavailable + open_app 自动恢复场景。
3. 添加长时间运行的活跃任务超时不强杀场景。
4. 在 CI 中对变更文件强制执行检查脚本。

验收标准：
1. 新回归可在本地复现，并在 CI 中被捕获。
2. P0 场景成为发布门禁。

验证：
```bash
cd backend && npm test -- gatewayModelSelection.strictProbe.test.js toolUseLoop.appLaunchRecovery.test.js toolCalling.shellForkClassify.test.js aiGateway.stability.regressions.test.js
node scripts/check-agent-rules.js --changed
```

## 4. 交付与签收

发布门禁：
1. 所有 P0 项均通过验收标准与验证命令。
2. 变更文件中不引入新的硬编码端点/路径违规。
3. 超时行为在至少一个长时间活跃任务和一个真正空闲停滞任务上得到验证。

跟踪规则：
1. 每一项需附带 PR 链接 + 测试证据 + 前后对比的 CLI 输出记录。
2. 任何未通过的验收检查都必须重新打开对应的清单项。
