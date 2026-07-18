<!-- 文档分类: DESIGN-OTHER-003 | 阶段: 设计 | 原路径: docs/指南/khy-系统提示词结构图.md -->
# KHY 系统提示词结构图

## 结论

`khy` 现在不是“只有一段 system prompt”，而是一个分层的 prompt 体系。真正决定行为的，不只有主 system prompt，还包括 runtime 选择逻辑、目录指令注入、compact / handoff prompt、子代理 prompt、工具 prompt，以及最终输出后处理。

## 总体结构图

```text
khy prompt stack
├─ 1. Main system prompt
│  ├─ static sections (cacheable)
│  ├─ __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
│  └─ dynamic sections (per-session)
├─ 2. Runtime assembly and fallback
│  ├─ modular prompt for cloud models
│  └─ legacy HARDCORE_SYSTEM_PROMPT for local/small models
├─ 3. Instruction injection
│  ├─ khy.md (4 levels)
│  ├─ CLAUDE.md compatibility
│  └─ AGENTS.md compatibility
├─ 4. Compaction and handoff prompt
├─ 5. Agent prompt layer
└─ 6. Tool prompt layer
```

## 1. 主 system prompt

- 主入口文件: `backend/src/constants/prompts.js`
- 主组装函数: `getSystemPrompt()`
- 扁平化输出函数: `assembleSystemPrompt()`
- cache boundary 标记: `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`

### 静态区顺序

`getSystemPrompt()` 里的静态区按下面顺序拼装:

1. `getSimpleIntroSection()`
2. `getSimpleSystemSection()`
3. `getDoingTasksSection()`
4. `getExecutionDisciplineSection()`
5. `getScopeMinimizationSection()`
6. `getPlanningAndRecoverySection()`
7. `getPlanningAndVerificationSection()`
8. `getTaskAndProgressManagementSection()`
9. `getErrorHandlingAndFallbackSection()`
10. `getMultiAgentCollaborationSection()`
11. `getSessionMemoryAndContextSection()`
12. `getSecurityAndPermissionBoundariesSection()`
13. `getActionsSection()`
14. `getSensitiveDataSection()`
15. `getFileOperationsSection()`
16. `getCommandExecutionSection()`
17. `getSearchAndExplorationSection()`
18. `getResponseFormattingSection()`
19. `getUsingYourToolsSection()`
20. `getToneAndStyleSection()`
21. `getOutputEfficiencySection()`
22. `getGitOperationsSection()`

这说明前面学的“11 节规则”并不是全部 prompt；它们只是静态区里最核心的一层。

### 动态区顺序

动态区在 cache boundary 之后，按 session / cwd / model / tools 实时注入:

1. `memory`
2. `env_info`
3. `language`
4. `output_style`
5. `mcp_instructions`
6. `project_instructions`
7. `git_status`
8. `khy_specific`
9. `model_guidance`

其中:

- `language` 决定默认中文回复
- `project_instructions` 注入仓库内 `khy.md / CLAUDE.md / AGENTS.md`
- `git_status` 把当前分支、状态、最近提交带进 prompt
- `model_guidance` 会按 `GPT / Gemini / DeepSeek / generic` 注入额外执行纪律

## 2. Runtime 选择逻辑

- 入口文件: `backend/src/services/khyUpgradeRuntime.js`
- 关键函数: `makeSystemPrompt()`

运行时不是无脑只用一套 prompt，而是按模型和适配器选路:

- 云模型 / 云适配器优先走 modular prompt
- 本地模型 / 小模型保留 `HARDCORE_SYSTEM_PROMPT` 作为 legacy 外壳
- 环境变量可强制切换:
  - `KHY_MODULAR_PROMPT=1`
  - `KHY_CLAUDE_PROMPT=1`
  - `KHY_LEGACY_PROMPT=1`

重要的是，legacy 路径并不等于“老 prompt 完全独立”。`makeSystemPrompt()` 里仍会同步拼装同一批核心 section，只是给小模型保留更短、更硬的外层壳。

## 3. 指令注入链

- 入口文件: `backend/src/services/instructionFileService.js`

`khy.md` 指令发现顺序是四层:

1. `~/.khyquant/khy.md` / `KHY.md`
2. `<git-root>/khy.md` / `KHY.md`
3. `<git-root>/.khy/rules/*.md`
4. `<cwd>/khy.md` / `KHY.md`

兼容层再补:

- `CLAUDE.md`
- `.claude/CLAUDE.md`
- `AGENTS.md`

冲突优先级固定为:

```text
KHY instructions > CLAUDE instructions > AGENTS instructions
```

这里还有两层关键保护:

- 如果高优先级 `khy.md` 已定义语言规则，会剥离低优先级文件里的 English-only lock
- `scanForPromptInjection()` 会扫描注入内容，命中危险行时改写为 `[REDACTED: ...]`

## 4. Compact / Handoff Prompt

- 入口文件: `backend/src/services/compact/prompt.js`

这里不是主 system prompt，而是“长会话压缩”和“续接”专用 prompt:

- `getCompactPrompt()`：压缩整段历史
- `getPartialCompactPrompt()`：只压缩 recent messages
- `getAnchoredCompactPrompt()`：基于旧摘要增量更新

这层的硬约束非常明确:

- 开头先注入 `NO_TOOLS_PREAMBLE`
- 明确禁止调用任何工具
- 输出必须是纯文本
- 固定要求 `<analysis>` + `<summary>` 结构

`getAnchoredCompactPrompt()` 还额外引入 anchored summary 模板，要求保留:

- Goal
- Constraints & Preferences
- Progress
- Key Decisions
- Next Steps
- Critical Context
- Relevant Files

## 5. Agent Prompt 层

### Agent tool prompt

- 入口文件: `backend/src/agents/prompt.js`

这一层负责告诉主代理:

- 什么时候该委托
- 什么时候不该委托
- 怎么给子代理明确 ownership
- 已有 agent 有上下文时应继续复用，而不是重复 spawn

### 内建代理

- `backend/src/agents/built-in/generalPurposeAgent.js`
  - 默认执行代理
  - 强调“完整交付，但不 gold-plate”
  - 强调 smallest sufficient scope、focused verification、least privilege
- `backend/src/agents/built-in/exploreAgent.js`
  - 严格只读
  - 禁止创建 / 修改 / 删除文件
  - 搜索优先走 `Glob / Grep / Read`
- `backend/src/agents/built-in/planAgent.js`
  - 严格只读
  - 输出 goal、impacted files、implementation steps、risks、validation strategy
- `backend/src/agents/built-in/verificationAgent.js`
  - 目标不是“证明它能跑”，而是“尽量把它打坏”
  - 输出必须以 `VERDICT: PASS|FAIL|PARTIAL` 结束

### 运行时角色模板

- 入口文件: `backend/src/services/cliAgentRunner.js`

这里除了 built-in agent，还维护了运行时角色模板，例如:

- `explore`
- `planner`
- `coder`
- `implement`
- `verify`
- `general-purpose`

也就是说，KHY 的“多智能体规则”并不是只写在一处，而是同时下沉到了 agent tool prompt、built-in agent prompt、runtime role prompt 三层。

## 6. Tool Prompt 层

真正把“文件读写 / 搜索 / 命令执行纪律”钉死的，很多时候不是主 system prompt，而是具体工具 prompt。

### 文件工具

- `backend/src/tools/FileReadTool/index.js`
  - 绝对路径
  - 先做最小必要读取
  - 大文件优先 offset / limit 或先 Grep
  - 支持 `.ipynb`、图片 OCR / base64
- `backend/src/tools/FileEditTool/index.js`
  - 必须先 Read
  - `old_string` 必须精确匹配
  - 倾向一次一个 focused edit
  - 禁止借修 bug 顺手做无关 cleanup
- `backend/src/tools/FileWriteTool/index.js`
  - 已存在文件必须先 Read 再覆盖
  - 修改现有文件时优先 `Edit`
  - 新文件必须写完整 UTF-8 内容
  - 未明确要求时禁止主动创建文档文件

### 搜索工具

- `backend/src/tools/GlobTool/index.js`
  - 只负责按路径 / 文件名模式找文件
  - 明确禁止把 Glob 当内容搜索
- `backend/src/tools/GrepTool/index.js`
  - 明确要求搜索任务走 Grep，而不是 shell `grep/rg`
  - 用于找函数、类、路由、标识符、配置键
  - 结果过多时要缩小 path / glob / type

### 命令工具

- `backend/src/tools/shellCommand.js`
  - 有专用工具时，禁止把搜索 / 读文件 / 改文件绕回 shell
  - 强调 destructive check、stderr / exit code 诊断、git safety
  - 自带 build error summary、危险 git 命令警告、commit message 注入防护

## 7. 输出后处理

- 入口函数: `postProcessOutput()`
- 位置: `backend/src/services/khyUpgradeRuntime.js`

这层不再增加 token，而是直接在本地收口输出:

- 去掉开头 filler
- 把嵌套 bullet 压平
- 清理泄漏的 `<think>` 或内部推理文本

所以有些“回复格式规则”并不只靠 prompt 约束，而是 prompt + runtime 后处理双保险。

## 8. 测试与保障

- 测试文件: `backend/tests/promptLearningRules.test.js`

这组测试已经把以下内容固化成可回归检查:

- execution discipline
- scope minimization
- planning / verification
- task tracking
- error handling
- multi-agent collaboration
- session memory / compaction
- security boundaries
- file operations
- command execution
- search and exploration
- response formatting
- agent / tool prompt 联动

## 结论

如果只问一句话，当前 `khy` 的答案是:

```text
“这 11 节已经不只是聊天里的原则，而是被拆进了主 system prompt、agent prompt、tool prompt、runtime fallback、compact prompt 和测试里。” 
```

所以它现在更像“prompt architecture”，而不是“单条超长系统提示词”。
