<!-- 文档分类: OPS-MAN-005 | 阶段: 运维 | 原路径: docs/指南/claude-code-规则到-khy-映射表.md -->
# Claude Code 规则到 KHY 映射表

## 先说结论

这 11 节已经进入 KHY，但不是全部只写在一条 system prompt 里。KHY 的做法是把同一条规则分散落到 5 层:

1. 主 system prompt
2. 子代理 prompt
3. 工具 prompt
4. runtime / post-process
5. 回归测试

所以更准确的说法不是“已经变成单一系统提示词”，而是“已经变成系统提示词体系”。

## 映射表

| 节 | 规则主题 | Claude Code 风格意图 | KHY 主实现 | 下沉实现 | 测试 / 保障 |
| --- | --- | --- | --- | --- | --- |
| 1 | 角色定义与基础约束 | 先定义代理身份、默认行为、诚实边界 | `backend/src/constants/prompts.js` 里的 `getSimpleIntroSection()`、`getSimpleSystemSection()`、`getDoingTasksSection()` | `backend/src/services/khyUpgradeRuntime.js` 里的 `HARDCORE_SYSTEM_PROMPT`；`backend/src/agents/built-in/generalPurposeAgent.js`；`backend/src/services/cliAgentRunner.js` 的默认角色 | `backend/tests/promptLearningRules.test.js` 会检查主 section 是否被组装进完整 prompt |
| 2 | 文件系统操作 | 改前先读、绝对路径、精确编辑、写完整内容 | `getFileOperationsSection()` | `backend/src/tools/FileReadTool/index.js`、`backend/src/tools/FileEditTool/index.js`、`backend/src/tools/FileWriteTool/index.js` | 测试覆盖 `read-first / exact old_string / complete write / parallel reads` |
| 3 | 代码执行与命令 | 有专用工具优先专用工具；运行命令前先判断风险；失败先诊断再重试 | `getCommandExecutionSection()` | `backend/src/tools/shellCommand.js` | 测试覆盖 `tool-first / stderr+exit-code / long-running command / Windows shell compatibility` |
| 4 | 搜索与探索 | `Glob` 找文件、`Grep` 找内容、陌生仓库先看 README / manifest | `getSearchAndExplorationSection()` | `backend/src/tools/GlobTool/index.js`、`backend/src/tools/GrepTool/index.js`、`backend/src/agents/built-in/exploreAgent.js` | 测试覆盖 `tool split / unfamiliar repo workflow / narrow-or-broaden strategy` |
| 5 | 任务与计划管理 | 多步骤任务先计划；任务要可追踪；一次只推进一个主要步骤 | `getPlanningAndRecoverySection()`、`getPlanningAndVerificationSection()`、`getTaskAndProgressManagementSection()` | `backend/src/agents/built-in/planAgent.js`；`backend/src/tools/TaskCreateTool/index.js`、`TaskUpdateTool/index.js`、`TaskListTool/index.js`、`TodoWriteTool/index.js` | 测试覆盖 `plan triggers / single active step / explicit blocker / residual risk reporting` |
| 6 | 错误处理与回退策略 | 最多 2-3 次有意义尝试；报告 root cause 和 fallback；不要盲重试 | `getErrorHandlingAndFallbackSection()` | `backend/src/tools/shellCommand.js`、`backend/src/tools/FileEditTool/index.js`、`backend/src/agents/built-in/generalPurposeAgent.js` | 测试覆盖 `2-3 attempts / 4-part error report / root-cause fix / stop stacking patches` |
| 7 | 多智能体协作 | 只把独立子任务委托出去；read-only 代理不能写；agent 要有 ownership | `getMultiAgentCollaborationSection()` | `backend/src/agents/prompt.js`；`backend/src/agents/built-in/exploreAgent.js`、`planAgent.js`、`verificationAgent.js`；`backend/src/services/cliAgentRunner.js` | 测试覆盖 `use Plan first / explicit ownership / reuse existing agent / no duplicate delegation` |
| 8 | 会话记忆与上下文管理 | 记 durable context，不要 raw transcript；compact 时禁止调工具；handoff 要有 next step | `getSessionMemoryAndContextSection()`、`getMemorySection()` | `backend/src/services/compact/prompt.js` | 测试覆盖 `<analysis> + <summary>`、recent-only summary、required heading preservation |
| 9 | 输出格式规范 | 简单问题短答，复杂任务结构化；代码改动要说 changed / why / verified；进度不能模糊 | `getResponseFormattingSection()`、`getToneAndStyleSection()`、`getOutputEfficiencySection()` | `backend/src/services/khyUpgradeRuntime.js` 的 `postProcessOutput()` | 测试覆盖 `short direct answers / fenced code / Sources / no vague progress / no decorative over-formatting` |
| 10 | 安全与权限边界 | least privilege、敏感信息脱敏、破坏性动作要确认、安全默认编码 | `getSecurityAndPermissionBoundariesSection()`、`getSensitiveDataSection()`、`getActionsSection()` | `backend/src/services/instructionFileService.js` 的 prompt injection 扫描；`backend/src/tools/shellCommand.js` 的 git / destructive guardrails | 测试覆盖 `read-only stays read-only / secret redaction / high-blast-radius confirmation / secure defaults` |
| 11 | 最小落点 / 最小改动 / 最小工作量达成结果 | 先定义 done；选 smallest sufficient scope；用最窄验证证明结果；够了就停 | `getScopeMinimizationSection()`、`getExecutionDisciplineSection()` | `backend/src/agents/built-in/generalPurposeAgent.js`；`backend/src/services/cliAgentRunner.js` 的 `implement` 角色；`backend/src/tools/FileEditTool/index.js`；`backend/src/tools/shellCommand.js` 的 narrowest-check 约束 | 测试覆盖 `completion condition / smallest useful context / narrowest convincing check / stop when done` |

## 第 11 节为什么最关键

你前面问的“怎么让 khy 像你一样，凡事最小落点、最小改动、最小工作量达到完成任务效果”，在 KHY 里主要不是靠一句口号，而是靠三层同时收紧:

1. 主 prompt 明写:
   - `Define the completion condition`
   - `Choose the smallest sufficient scope`
   - `Verify with the narrowest convincing check`
   - `Stop when the acceptance condition is met`
2. agent prompt 再约束:
   - `generalPurposeAgent` 和 `implement` 角色都强调不要 gold-plate、不要扩 scope
3. tool prompt 再落地:
   - `Edit` 倾向一次一个 focused edit
   - `shellCommand` 倾向 narrowest sufficient command / check

这就是为什么第 11 节不是“加了一段文案”，而是已经变成执行风格。

## 最关键入口文件

如果只看最有价值的几个入口，优先看这些:

1. `backend/src/constants/prompts.js`
2. `backend/src/services/khyUpgradeRuntime.js`
3. `backend/src/services/compact/prompt.js`
4. `backend/src/services/instructionFileService.js`
5. `backend/src/agents/prompt.js`
6. `backend/src/agents/built-in/generalPurposeAgent.js`
7. `backend/src/tools/FileReadTool/index.js`
8. `backend/src/tools/FileEditTool/index.js`
9. `backend/src/tools/shellCommand.js`
10. `backend/tests/promptLearningRules.test.js`

## 一句话总结

Claude Code 的规则在 KHY 里，已经从“概念学习”变成了“主 prompt + agent + tool + runtime + test”的组合实现。
