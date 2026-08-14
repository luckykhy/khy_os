<!-- 文档分类: OPS-MAN-020 | 阶段: 运维 | 原路径: docs/指南/openagent-对齐日志.md -->
# oh-my-openagent 对齐学习日志

本日志对每一次 oh-my-openagent 对齐研究会话都是强制要求。

## 2026-05-15 会话 1

- 关注点：
  - 主要：D2 技能系统（Skills System）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [能力][高] 基线拥有明确的技能评测资产（`.agents/skills/work-with-pr-workspace/evals/`、迭代基准产物），而 KHY 目前缺少标准化的逐技能评测闭环。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/.agents/skills/work-with-pr-workspace/evals/evals.json`
     - KHY 现状：`backend/src/skills/` 具备加载/执行能力，但没有强制的评测产物约定。
     - 决策：采纳（引入技能评测约定 + 最小基准 schema）。
  2. [流程][中] 基线使用多层级 AGENTS 文档（根目录 + `src/AGENTS.md` + `web/AGENTS.md`）并生成清单；KHY 目前只有一份强有力的根指南，但没有强制的层级化刷新机制。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/AGENTS.md`、`src/AGENTS.md`、`web/AGENTS.md`
     - KHY 现状：仅有仓库根目录的 `AGENTS.md`。
     - 决策：适配（为高变更子树添加选择性的层级化 AGENTS，暂不做完整的自动生成）。
  3. [质量][中] 基线 AGENTS 包含量化的架构清单（文件数、hook 数、工具矩阵）；KHY 文档清晰但在漂移跟踪上量化不足。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/AGENTS.md` 的 OVERVIEW/HOOK COMPOSITION 章节。
     - KHY 现状：架构与规则齐备，但没有周期性的数值清单基线。
     - 决策：适配（为关键子系统添加周期性清单快照脚本/报告）。
- 已提交动作：
  - 代码：更新了 `AGENTS.md`，加入强制的对齐闭环、评分模型、退出标准与日志契约。
  - 验证：从 zip 进行手工基线检查并采集路径证据；下一步需要脚本化的清单/检查自动化。
- 评分更新：
  - D2: 1 -> 1
  - D5: 1 -> 2
- 下一最高影响差距：
  - 构建可重复的技能评测工作流（schema + runner + 通过/失败阈值）并将其接入 CI。

## 2026-05-15 会话 2

- 关注点：
  - 主要：D2 技能系统（Skills System）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [流程][高] 基线评测资产将机器可读的评测用例（prompt + 断言）定义为稳定契约，而 KHY 当时没有形式化的技能评测配置 schema。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/.agents/skills/work-with-pr-workspace/evals/evals.json`
     - KHY 现状：新增 `backend/src/skills/evals/skill-eval-config.schema.json` + `backend/src/skills/evals/skill-eval-baseline.json`
     - 决策：采纳（引入带阈值门禁的显式评测配置契约）。
  2. [质量][高] 基线保留迭代基准产物以便审计；KHY 之前没有针对技能质量检查的持久化运行报告。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/.agents/skills/work-with-pr-workspace/iteration-1/benchmark.json`
     - KHY 现状：新增 runner 报告输出 `docs/reports/skill-eval-latest.json` + 报告 schema `backend/src/skills/evals/skill-eval-report.schema.json`
     - 决策：采纳（持久化分数/失败详情以便趋势跟踪）。
  3. [能力][中] 基线流程假设技能元数据使用一致；KHY 清单当前混用 `trigger/command` 与 `userInvocable/user_invocable`，在缺乏显式归一化的情况下造成兼容性漂移风险。
     - 基线证据：基线评测断言依赖按产物契约保持稳定、可预测的技能行为
     - KHY 现状：`backend/src/skills/index.js` 现已对两种键风格的 trigger 与可调用标志进行归一化
     - 决策：适配（在保持向后兼容的同时，稍后再收敛到单一规范格式）。
- 已提交动作：
  - 代码：新增 `scripts/ci/check-skill-evals.js`、`backend/src/skills/evals/` 下的评测 schema/baseline 文件、`.github/workflows/ci.yml` 中的 CI 钩子、`package.json` 中的 npm 脚本、`backend/src/skills/index.js` 中的加载器兼容性加固，以及回归测试 `backend/tests/services/skillsManifestCompat.test.js`。
  - 验证：
    - `node --check scripts/ci/check-skill-evals.js`
    - `node --check backend/src/skills/index.js`
    - `node scripts/ci/check-skill-evals.js --report docs/reports/skill-eval-latest.json`
    - `npm run check:quality-gates`
    - `npm run --workspace backend test -- --runInBand backend/tests/services/skillsManifestCompat.test.js`
    - `node scripts/check-agent-rules.js --changed`（本对齐切片之外、预先存在的已修改文件中仍有告警）
- 评分更新：
  - D2: 1 -> 2
  - D5: 2 -> 2
- 下一最高影响差距：
  - 将静态的技能元数据评测提升为场景评测（prompt 级断言 + 通过率增量），并通过标准化内置清单中缺失的 `category`/`platforms` 字段来降低告警基线。

## 2026-05-15 会话 3

- 关注点：
  - 主要：D2 技能系统（Skills System）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [质量][高] 基线评测产物假设技能元数据一致且完整；KHY 仍存在元数据漂移（缺失 `category`/`platforms`），导致质量信号噪声。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/.agents/skills/work-with-pr-workspace/iteration-1/benchmark.json`（稳定的断言计数）
     - KHY 现状：本次会话之前有 12 份内置清单缺失 `category/platforms`；现已归一化。
     - 决策：采纳（强制元数据完整性以提升评测信号质量）。
  2. [能力][高] 基线使用面向场景、带显式断言列表的评测用例；KHY 此前仅有元数据级检查，缺少用于技能行为引导的场景断言。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/.agents/skills/work-with-pr-workspace/evals/evals.json`
     - KHY 现状：新增 `backend/src/skills/evals/skill-scenario-suite.json` + `scripts/ci/check-skill-scenarios.js`，带 prompt 级断言与阈值。
     - 决策：采纳（增加场景式评测契约与自动化 runner）。
  3. [流程][中] 基线存储迭代产物以便持续比较；KHY 有静态报告输出但没有用于场景级跟踪的第二报告通道。
     - 基线证据：`/tmp/oh-my-openagent-dev/oh-my-openagent-dev/.agents/skills/work-with-pr-workspace/iteration-1/eval-1/eval_metadata.json`
     - KHY 现状：现已持久化 `docs/reports/skill-scenario-eval-latest.json` 并定义 `backend/src/skills/evals/skill-scenario-report.schema.json`。
     - 决策：适配（先采用最新报告契约；后续再扩展到历史迭代快照）。
- 已提交动作：
  - 代码：
    - 归一化内置清单中缺失的元数据：
      - `backend/src/skills/built-in/batch/manifest.json`
      - `backend/src/skills/built-in/claude-api/manifest.json`
      - `backend/src/skills/built-in/debug/manifest.json`
      - `backend/src/skills/built-in/dream/manifest.json`
      - `backend/src/skills/built-in/hunter/manifest.json`
      - `backend/src/skills/built-in/keybindings/manifest.json`
      - `backend/src/skills/built-in/loop/manifest.json`
      - `backend/src/skills/built-in/remember/manifest.json`
      - `backend/src/skills/built-in/skillify/manifest.json`
      - `backend/src/skills/built-in/stuck/manifest.json`
      - `backend/src/skills/built-in/update-config/manifest.json`
      - `backend/src/skills/built-in/verify/manifest.json`
    - 新增场景评测套件与 runner：
      - `backend/src/skills/evals/skill-scenario-suite.json`
      - `scripts/ci/check-skill-scenarios.js`
      - `backend/src/skills/evals/skill-scenario-report.schema.json`
    - CI/质量集成：
      - `package.json`（`check:skill-scenario-eval`，扩展 `check:quality-gates`）
      - `.github/workflows/ci.yml`（新增场景评测步骤）
    - 文档/报告更新：
      - `backend/src/skills/evals/README.md`
      - `docs/reports/skill-eval-latest.json`
      - `docs/reports/skill-scenario-eval-latest.json`
  - 验证：
    - `node scripts/ci/check-skill-evals.js --report docs/reports/skill-eval-latest.json` -> PASS（`overall=1.000`，`warning-failures=0`）
    - `node scripts/ci/check-skill-scenarios.js --report docs/reports/skill-scenario-eval-latest.json` -> PASS（`15/15 assertions`）
    - `npm run --workspace backend test -- --runInBand backend/tests/services/skillsManifestCompat.test.js` -> PASS
    - `node scripts/check-agent-rules.js --changed` -> 预先存在的无关文件中仍有告警
    - `npm run check:quality-gates` -> PASS（版本同步 + 语法检查 + 技能评测 + 技能场景评测）
- 评分更新：
  - D2: 2 -> 3
  - D5: 2 -> 3
- 下一最高影响差距：
  - 为场景评测报告添加历史迭代存储与趋势比较（最新 vs 之前 N 次运行），然后将场景套件覆盖范围扩展到 5 个以上技能。

## 2026-05-15 会话 4

- 关注点：
  - 主要：D1 Agent 框架（Agent Harness）
  - 次要：D3 MCP 与工具（MCP & Tooling）
- 新增差异：
  1. [能力][高] Hashline LINE#ID 编辑工具——基于内容哈希的校验可防止过期编辑。基线对行内容计算 xxh32 哈希 → 从 `ZPMQVRWSNKTXJBYH` 字母表生成 2 字符 ID；在应用前校验，以拒绝对已变更行的编辑。
     - 基线证据：`src/tools/hashline-edit/hash-computation.ts`、`src/tools/hashline-edit/validation.ts`（HashlineMismatchError 带上下文显示 + suggestLineForHash 恢复）
     - KHY 现状：没有内容哈希编辑保护。`toolCalling.js` 在不做过期校验的情况下应用编辑。
     - 决策：适配——在 toolCalling.js 或 toolSandbox.js 中实现一个更简单的内容指纹守卫，当目标行内容自上次读取后发生变化时拒绝编辑。
  2. [能力][高] IntentGate 关键词检测器——通过魔法词（ultrawork、search、analyze、team、hyperplan）切换模式。先剥离代码块，再用正则匹配关键词，从而注入系统 prompt 覆盖并激活专用模式。
     - 基线证据：`src/hooks/keyword-detector/detector.ts`、`src/hooks/keyword-detector/constants.ts`（6 种关键词类型）
     - KHY 现状：`capabilityAssessment.js` 做基础的能力预评估，但没有基于关键词动态改变 agent 行为的意图触发式模式注入。
     - 决策：采纳——在 agentic 框架中加入 IntentGate 层，检测能力关键词并注入相应的系统 prompt 段落。
  3. [能力][高] Ralph Loop——带会话状态跟踪的持久化续行循环。让 agent 在工具失败、上下文溢出和会话边界之间保持运行。跨会话工作状态被持久化为 "Boulder State"（计划进度、会话来源、任务会话）。
     - 基线证据：`src/hooks/ralph-loop/ralph-loop-hook.ts`、`src/features/boulder-state/types.ts`
     - KHY 现状：`agenticHarnessService.js` 对瞬态错误有带退避的重试，但没有持久化的跨会话续行循环。除会话 trace 外没有 boulder/工作状态跟踪。
     - 决策：采纳——扩展 agenticHarnessService，加入会话级持久化续行机制与工作状态快照。
  4. [能力][高] 按 agent 提供模型专属 prompt 变体。Sisyphus agent 为 Claude Opus 4.7、Gemini、GPT-5.4、GPT-5.5、Kimi K2.6 分别构建独立 prompt，各自针对该模型的行为怪癖调优（例如 Gemini 的激进倾向、GPT 的块结构化引导）。
     - 基线证据：`src/agents/sisyphus/index.ts`——导出模型专属构建器，`src/agents/sisyphus/gemini.ts` 含纠正性覆盖层
     - KHY 现状：`compact/prompt.js` 提到模型专属 prompt，但 KHY 的 agent 循环没有按模型的 prompt 变体系统。
     - 决策：适配——引入以模型族为键的 prompt 变体注册表，先在网关适配器层做 Claude/Gemini/GPT 的区分。
  5. [质量][中] 编辑错误恢复 hook——当 Edit 工具失败（oldString 未找到）时，自动注入"先读取文件"的提醒。减少因过期编辑尝试浪费的轮次。
     - 基线证据：`src/hooks/edit-error-recovery/hook.ts`
     - KHY 现状：工具调用错误原样冒泡给 agent，没有注入恢复引导。
     - 决策：采纳——在 toolCalling.js 中加入错误恢复提示，对常见失败（文件未找到、编辑不匹配、权限拒绝）注入可操作的引导。
  6. [质量][中] 5 层 hook 组合——Session hooks、ToolGuard hooks（16 种）、Transform hooks、Continuation hooks、Skill hooks。每个 hook 通过 `isHookEnabled()` 做配置门禁，并用 `safeCreateHook` 包裹以做故障隔离。
     - 基线证据：`src/plugin/hooks/create-tool-guard-hooks.ts`（16 种守卫类型）、`AGENTS.md` 记录总计 54-61 个 hook
     - KHY 现状：没有形式化的 hook 组合系统。工具行为在 toolCalling.js / toolSandbox.js 中内联修改。没有故障隔离的 hook 包裹器。
     - 决策：适配——设计一个至少 3 层（pre-tool、post-tool、error-recovery）且带配置门禁的 hook 注册表，不复制完整的 5 层复杂度。
- 已提交动作：
  - 代码：`agenticHarnessService.js` 已提供框架入口。下一个具体代码动作：在 `backend/src/services/` 中加入 `intentGate` 模块，用于检测能力关键词并返回 prompt 注入载荷（差异 #2）。占位文件：`backend/src/services/intentGate.js`。
  - 验证：运行 `node -e "require('./backend/src/services/agenticHarnessService')"` 确认框架可加载，然后为 intentGate 关键词检测添加单元测试，至少覆盖 6 种关键词类型。
- 评分更新：
  - D1: 1 -> 1（agenticHarnessService 已存在，带重试/上下文路由，但缺少持久化循环/boulder state——需要 Ralph Loop 等价物）
  - D3: 1 -> 1（toolSandbox + toolCalling 可用，但无 hashline 校验、无 hook 组合、无编辑错误恢复）
  - D4: 1 -> 1（coordinatorMode + agentCommunicationService 已存在并带消息队列，但无 mailbox 协议或背压）
- 下一最高影响差距：
  - D1：在 agenticHarnessService 中实现 IntentGate 关键词检测器 + 持久化续行循环（Ralph Loop 等价物）。这两项以最少的代码改动解锁最大的行为改进。

## 2026-05-19 会话 5

- 关注点：
  - 主要：D1 Agent 框架（Agent Harness）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [能力][高] 基线的后台任务契约面向操作者（显式 `background_task_id`、续行元数据，以及 stop/monitor 流程），而 KHY CLI 的 `/tasks` 之前只渲染扁平列表，缺少直接的检查/控制入口。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/background-task.ts`、`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/tool-description.ts`
     - KHY 现状：本次会话之前，`backend/src/cli/repl.js` 中的 `/tasks` 路径只从 `_taskStore` 打印 `[status] id: description`。
     - 决策：采纳（将 `/tasks` 升级为对规范运行时任务的 summary/filter/detail/control）。
  2. [质量][高] 基线的规划姿态强调执行前纪律（执行前进入 planner 模式），而 KHY 默认计划审批在空闲 20 秒后静默自动批准，削弱了用户意图边界。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/README.md`（Prometheus planner：执行前的访谈模式）
     - KHY 现状：`backend/src/services/planModeService.js` 将 `KHY_PLAN_AUTO_APPROVE_MS` 默认为 `20000`。
     - 决策：采纳（默认改为显式批准；保留通过环境变量启用自动批准的选项）。
  3. [流程][中] 基线保留机器可读的后台任务状态快照以便交接/调试；KHY 运行时有丰富的审计记录，但 CLI 没有暴露 attempts/events，降低了恢复期间的操作者可观测性。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/.agents/background-tasks.json`
     - KHY 现状：`backend/src/tasks/largeTaskRuntimeStore.js` 已存储 attempts/events，但旧的 `/tasks` 命令没有展示它们。
     - 决策：适配（在 `/tasks <taskId>` 详情视图中复用已有的运行时审计数据）。
- 已提交动作：
  - 代码：
    - `backend/src/cli/repl.js`
      - 新增 `_handleTasksCommand()`，用于 `/tasks` 的 summary/filter/detail 和控制动作（`cancel/pause/resume`）。
      - 将两个入口切换到共享处理器：斜杠选择器 `selected.flag === 'tasks'` 与直接的 `/tasks ...` 命令。
      - 任务操作现在优先走来源感知的控制路径（`backgroundTaskManager`、`_taskStore`、`taskStore`），再回退到原始运行时。
    - `backend/src/services/planModeService.js`
      - 将 `KHY_PLAN_AUTO_APPROVE_MS` 的默认回退值从 `20000` 改为 `0`（默认需要显式确认）。
    - `backend/tests/services/planModeService.approval.test.js`
      - 为"默认不自动批准"和"环境变量启用自动批准"行为添加回归测试。
  - 验证：
    - `node --check backend/src/cli/repl.js`
    - `node --check backend/src/services/planModeService.js`
    - `node --check backend/tests/services/planModeService.approval.test.js`
    - `npm run --workspace backend test -- --runInBand backend/tests/services/planModeService.approval.test.js backend/tests/services/planModeService.idleTimeout.test.js`
    - `node scripts/check-agent-rules.js --changed`（预先存在的无关文件中仍有告警）
- 评分更新：
  - D1: 1 -> 2
  - D5: 3 -> 3
- 下一最高影响差距：
  - 添加统一的任务控制 API 覆盖测试（CLI + 路由在 cancel/pause/resume/detail 上的一致性），防止跨任务来源的行为漂移。

## 2026-05-19 会话 6

- 关注点：
  - 主要：D1 Agent 框架（Agent Harness）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [能力][高] 基线的任务控制流实现为单一的控制面契约，而 KHY 之前在 REPL 与 HTTP 路由处理器中重复了任务变更逻辑，造成漂移风险。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/background-task.ts`
     - KHY 现状：本次会话之前，`backend/src/cli/repl.js` 与 `backend/src/routes/largeTasks.js` 各有独立的 `cancel/pause/resume` 逻辑；现已通过 `backend/src/services/taskControlService.js` 统一。
     - 决策：采纳（路由与 CLI 现在都调用同一个服务契约）。
  2. [质量][高] 基线的后台任务控制行为在设计上是来源感知的，而 KHY 路由端点之前直接施加运行时状态转换，跳过了来源专属适配器（`background_task_manager`、`tool_task_store`、`legacy_task_store`）。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/tool-description.ts`
     - KHY 现状：`backend/src/routes/largeTasks.js` 现在委托给 `taskControlService`，由其按任务来源路由控制并返回归一化的结果码。
     - 决策：采纳（在单一路径中强制来源感知控制）。
  3. [流程][中] 基线强调围绕后台执行控制的契约级可靠性检查；KHY 缺少针对来源专属任务控制与错误码一致性的专门服务级覆盖。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/README.md`（明确的长运行任务/操作控制预期）
     - KHY 现状：新增 `backend/tests/services/taskControlService.test.js`，并扩展 `backend/tests/routes/largeTasks.route.test.js`，覆盖 `already_*`、`invalid_state`、`terminal_task` 和 `task_not_found` 的一致性。
     - 决策：适配（用针对性的契约测试作为防止控制面回归的护栏）。
- 已提交动作：
  - 代码：
    - `backend/src/cli/repl.js`：`/tasks` 的 action/detail/list 路径现在使用 `taskControlService`，而非内联的逐来源分支。
    - `backend/src/routes/largeTasks.js`：`/:taskId/cancel|pause|resume` 与 `GET /:taskId` 现在使用共享的任务控制契约，并透传归一化的错误码。
    - `backend/tests/services/taskControlService.test.js`：新增单元测试，覆盖缺失/无效输入、运行时状态冲突、来源感知控制和审计详情。
    - `backend/tests/routes/largeTasks.route.test.js`：扩展路由一致性测试，覆盖重复 pause/resume 的 no-op 标志与冲突码一致性。
  - 验证：
    - `node --check backend/src/services/taskControlService.js`
    - `node --check backend/src/routes/largeTasks.js`
    - `node --check backend/src/cli/repl.js`
    - `node --check backend/tests/services/taskControlService.test.js`
    - `node --check backend/tests/routes/largeTasks.route.test.js`
    - `npm run --workspace backend test -- --runInBand backend/tests/services/taskControlService.test.js backend/tests/routes/largeTasks.route.test.js backend/tests/services/planModeService.approval.test.js backend/tests/services/planModeService.idleTimeout.test.js`
- 评分更新：
  - D1: 2 -> 2
  - D5: 3 -> 3
- 下一最高影响差距：
  - 添加 CLI 级的 `/tasks` 契约回归测试（命令输入 -> 打印的控制结果映射），使 REPL UX 文案与 HTTP `code` 语义在未来重构中保持对齐。

## 2026-05-19 会话 7

- 关注点：
  - 主要：D1 Agent 框架（Agent Harness）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [质量][高] 基线式的长任务操作得益于稳定的操作者反馈契约，而 KHY 缺少针对 `/tasks` 控制结果（success/info/error 消息映射）的专门命令文案契约测试。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/tool-description.ts`
     - KHY 现状：新增 `backend/src/cli/tasksControlContract.js`，并在 `backend/tests/cli/tasksControlContract.test.js` 中进行测试驱动的消息映射。
     - 决策：采纳（将消息契约形式化为可测试的 CLI 表面）。
  2. [流程][高] 基线鼓励可复用契约而非 UI 内联分支；KHY 之前把控制消息映射嵌在 REPL 函数作用域内，降低了可测试性并增加漂移风险。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/background-task.ts`
     - KHY 现状：`backend/src/cli/repl.js` 中的 `/tasks` 控制分支现在委托给可复用的契约助手（`runTasksControlContract`），再按级别打印。
     - 决策：适配（最小提取，不做完整的 REPL 重构）。
  3. [能力][中] 基线的操作者人体工程学依赖别名/意图容错；KHY 有别名但没有回归锁定，确保别名输入解析保留 cancel/pause/resume 的 reason 载荷与动作路由。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/README.md`（操作者优先的工作流可靠性预期）
     - KHY 现状：新测试断言命令文本输入（`cancel|pause|resume`）映射到预期事件，并验证 cancel reason 的透传。
     - 决策：采纳（用确定性测试守护别名解析与 reason 传播）。
- 已提交动作：
  - 代码：
    - `backend/src/cli/tasksControlContract.js`：新增用于 `/tasks` 控制动作的纯 CLI 契约 runner。
    - `backend/src/cli/repl.js`：将内联的 `/tasks` 控制反馈映射替换为契约助手调用。
    - `backend/tests/cli/tasksControlContract.test.js`：新增针对命令输入到消息输出映射以及 cancel reason 透传的回归测试。
  - 验证：
    - `node --check backend/src/cli/tasksControlContract.js`
    - `node --check backend/tests/cli/tasksControlContract.test.js`
    - `node --check backend/src/cli/repl.js`
    - `npm run --workspace backend test -- --runInBand backend/tests/cli/tasksControlContract.test.js backend/tests/services/taskControlService.test.js backend/tests/routes/largeTasks.route.test.js`
- 评分更新：
  - D1: 2 -> 2
  - D5: 3 -> 3
- 下一最高影响差距：
  - 添加端到端 REPL 交互测试（mock 的 readline 会话），覆盖 `/tasks help`、`/tasks <taskId>` 以及中英文混合别名，将完整的命令循环行为锁定在契约级单元测试之外。

## 2026-05-19 会话 8

- 关注点：
  - 主要：D1 Agent 框架（Agent Harness）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [质量][高] 基线的操作者工作流质量依赖命令循环可靠性，而 KHY 之前主要在服务/契约级验证 `/tasks`，缺少 REPL 事件循环回归覆盖。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/background-task.ts`
     - KHY 现状：在 `backend/tests/cli/repl.tasks.interaction.test.js` 中新增 mock readline 的交互测试，执行真实的 `rl.emit('line', ...)` 流程。
     - 决策：采纳（直接覆盖 REPL 交互层）。
  2. [流程][高] 基线式的任务操作在多个用户可见路径上得到验证；KHY 有路由/服务测试，但没有显式守护确保 REPL 斜杠输入（`/tasks ...`）派发到相同语义。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/README.md`（面向操作者的执行路径）
     - KHY 现状：新测试通过 REPL line handler 验证 `/tasks help`、`/tasks <taskId>` 以及混合别名控制输入。
     - 决策：采纳（防止静默的 UI 路径回归）。
  3. [能力][中] 基线的操作 UX 强调灵活的命令意图；KHY 需要针对交互模式下混合语言控制别名的显式回归。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/tool-description.ts`
     - KHY 现状：REPL 交互测试现在断言 `/tasks 暂停`、`/tasks resume`、`/tasks 取消 ...` 都映射到预期的控制动作与用户可见的成功字符串。
     - 决策：适配（将双语别名兼容性作为受测契约保留）。
- 已提交动作：
  - 代码：
    - `backend/tests/cli/repl.tasks.interaction.test.js`：新增 mock readline 的 REPL 交互测试，覆盖 `/tasks` 命令循环行为。
    - `backend/src/cli/repl.js`：复用已有命令路径与此前引入的契约助手（`runTasksControlContract`），并通过交互测试验证行为。
    - `backend/src/cli/tasksControlContract.js`：保留为供 REPL 使用的可测试消息映射单元。
  - 验证：
    - `node --check backend/tests/cli/repl.tasks.interaction.test.js`
    - `npm run --workspace backend test -- --runInBand backend/tests/cli/repl.tasks.interaction.test.js`
    - `npm run --workspace backend test -- --runInBand backend/tests/cli/repl.tasks.interaction.test.js backend/tests/cli/tasksControlContract.test.js backend/tests/services/taskControlService.test.js backend/tests/routes/largeTasks.route.test.js`
- 评分更新：
  - D1: 2 -> 2
  - D5: 3 -> 3
- 下一最高影响差距：
  - 添加一项全路径一致性检查，对相同任务 fixtures 比较 REPL `/tasks` 控制结果与 HTTP `largeTasks` 端点码（单一黄金矩阵），减少重复断言的维护。

## 2026-05-19 会话 9

- 关注点：
  - 主要：D1 Agent 框架（Agent Harness）
  - 次要：D5 治理与质量（Governance & Quality）
- 新增差异：
  1. [质量][高] 当 REPL 与 HTTP 变体共享单一黄金矩阵时，基线式的控制语义最易维护；KHY 之前有断言重叠的独立路由测试与 CLI 测试。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/background-task.ts`
     - KHY 现状：新增 `backend/tests/cli/tasksControl.parity.matrix.test.js`，对 `/tasks` 与 `/largeTasks` 断言相同的控制 fixture 集。
     - 决策：采纳（减少重复断言并锁定语义一致性）。
  2. [流程][高] 基线的操作者工作流得益于一张关于控制行为的规范真值表；KHY 现在有一张共享矩阵，覆盖缺失 taskId、未找到、无效状态、`already_*` 标志、终态冲突和成功路径。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/README.md`
     - KHY 现状：该一致性矩阵在单一 fixture 表中显式检查 REPL 契约输出与 HTTP 响应码。
     - 决策：采纳（在一张测试矩阵中规范化控制结果）。
  3. [能力][中] 基线的任务工具一致地展示动作专属的边界情况；KHY 的矩阵现在验证双语别名输入与 reason 传播，同时匹配相同任务状态的 HTTP 语义。
     - 基线证据：`/tmp/ohmyopenagent_ref/oh-my-openagent-dev/src/tools/delegate-task/tool-description.ts`
     - KHY 现状：一致性矩阵在匹配的任务 fixtures 上验证 `/tasks 暂停|恢复|取消` 行为与 HTTP 路由码并行。
     - 决策：适配（保持双语 CLI 意图与路由语义对齐）。
- 已提交动作：
  - 代码：
    - `backend/tests/cli/tasksControl.parity.matrix.test.js`：用于 REPL `/tasks` 契约与 HTTP `/largeTasks` 控制码的单一黄金矩阵。
  - 验证：
    - `node --check backend/tests/cli/tasksControl.parity.matrix.test.js`
    - `npm run --workspace backend test -- --runInBand backend/tests/cli/tasksControl.parity.matrix.test.js`
- 评分更新：
  - D1: 2 -> 2
  - D5: 3 -> 3
- 下一最高影响差距：
  - 若想继续推进，将同样的黄金矩阵风格扩展到 `/tasks <taskId>` 详情 vs `/largeTasks/:taskId` 详情/审计，使检查语义与控制语义共享同一份一致性契约。
