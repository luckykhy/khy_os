# [DESIGN-ARCH-112] khyos-Harness 架构对照

> **单一真源声明**：本文档是**对照盘点**（现状快照 + 映射关系），不是规则语义真源。
> 规则语义仍以 `CLAUDE.md`（红线 R1–R4）、`AGENTS.md`（RUNTIME-001~004）、
> [`../10_规范/registry/RULES-REGISTRY.json`](../../10_规范/registry/RULES-REGISTRY.json)（67 条登记）为准。
> 本文档的作用是提供一张「书中机制 → khyos 文件路径」的可检索地图，
> 使后续章节的施工不必重新盘点全仓。
>
> 来源语料：《Claude Code实战：Harness工程之道》第 1 章
> （`.research-tmp/cc-book-harness/split/ch01.txt`）。学习-落地计划真源为
> `.khy/plans/learn-claude-code-book.json`（step 1）。
>
> 本文档所有「现状」判定均附 `文件:行号` 实测证据（2026-09-16 实测）。
>
> **版本控制注意**：`.khy/` 目录被 `.gitignore:54` 排除，其中的技能 manifest、
> hooks 配置、权限设置等均**不进入版本控制**，属本地运行时状态。本文档 §8.2
> 的数据改动因此不可从 git 恢复——代码改动（§8.1）才受追踪。

---

## 一、定位与范围

本文档回答一个问题：**Claude Code 的四层架构与 Harness 五要素，在 khyos 中分别
对应哪个文件、实现到什么程度、缺口归哪一章修。**

不在本文档范围内：

| 排除项 | 归属 |
| --- | --- |
| 五层记忆分级的具体实现与条件化加载 | 第 2 章 / `[DESIGN-ARCH-113]` |
| Skills 的 description 质量、allowed-tools 配置、匹配真源收敛 | 第 3 章 / `[DESIGN-PROCESS-001]` |
| 用户级子智能体定义格式与委派链路 | 第 4 章 / `[DESIGN-ARCH-115]` |
| hooks.json 配置落地、危险命令拦截、审计 | 第 5 章 / `[DESIGN-ARCH-116]`（高风险章，需 dry-run） |
| MCP 作用域分层与信任评估 | 第 6 章 / `[DESIGN-ARCH-117]` |
| Headless 参数与 CI 编排 | 第 7 章 / `[DESIGN-ARCH-118]` |
| Agent SDK 双语言接口设计 | 第 8 章 / `[DESIGN-ARCH-119]` |
| plugin.json 清单与分发 | 第 9 章 / `[DESIGN-ARCH-120]` |

---

## 二、Agent = Model + Harness

Anthropic 官方定义：

> "Claude Code serves as the agentic harness around Claude: it provides the tools,
> context management, and execution environment that turn a language model into a
> capable coding agent."

原生模型只具备生成文本的能力；Harness 赋予它读文件、写代码、检索代码库、在终端
执行命令的能力。**Agent = Model + Harness。**

Harness 改变的不是模型的能力本身，而是**能力的传导与控制方式**——如同马具不增加
马力，只决定力量如何转化为牵引。

### 2.1 关键洞察

> 同一模型在不同 Harness 下的表现差异，远大于不同模型在同一 Harness 下的表现差异。

TerminalBench 基准中，仅优化 Harness 即使同一模型从基线以下跃升至 Top 5。

**对 khyos 的含义**：khyos 的多供应商 AI 网关（`services/backend/src/services/gateway/aiGateway.js`）
意味着模型可替换，但 Harness（`toolUseLoopCore.js` + hooks 运行时 + `contextCompressor.js`
+ `sessions.db`）是 khyos 自有资产。因此把工程投入放在 Harness 精雕上，
其收益不随模型选择变化——模型升级时 Harness 的投入不会贬值。

### 2.2 三性刻度

「可编程、可扩展、可组合」是框架的性质，不是症状的解药。

| 三性 | 含义 | khyos 刻度 |
| --- | --- | --- |
| 可编程 | 用代码驱动，不必人守终端 | CLI 级已通（`-p`/`--output-format`/`--max-turns`/`--allowed-tools`/`--disallowed-tools` 全在 `services/backend/src/cli/printOutputFormat.js`）；**代码级空白**（无可 `require` 的 SDK 入口） |
| 可扩展 | 加能力不碰核心代码 | 扩展**面**齐（技能目录 + settings + hooks 运行时）；扩展**质**差（触发预算饥荒、0/48 allowed-tools、hooks 零挂载） |
| 可组合 | 模块间可自由编排 | **接缝在代码里**（11 个 hook 事件含 `SubAgentStart`/`SubAgentEnd`/`ToolPermission`/`PromptSection`，且 `hookContribSeams.tighten` 强制单调收紧）；**封装层没有**（无 plugin.json） |

### 2.3 性质 ≠ 工件

框架三性齐备是症状**可被修复**的前提，不是**已被修复**的状态。三个痛点各需具体工件：

| 痛点 | 所需工件 | khyos 现状 |
| --- | --- | --- |
| 失忆 | 自动加载的项目指令 | ✅ 已解决（三文件加载，见 3.1） |
| 风格飘忽 | 可被自动触发的代码规范载体 | ⚠️ 未解决（描述预算饥荒，见 3.2） |
| 上下文溢出 | 子智能体定义与委派 | ⚠️ 部分（内置 agent 已在用，用户级定义目录为空） |

---

## 三、四层架构 → khyos 映射

书以摩天大楼为喻：记忆层是深埋地下的地基，扩展层是承载日常运营的主体楼层，
集成层是维系运转的水电管网，编程层是顶楼的建筑师工作室。

> 自下而上审视是**构建视角**（关注基石与支撑）；自上而下俯瞰是**使用视角**
> （聚焦功能与体验）。

**注意区分**：四层架构描述 Agent 能力的组织方式，与 khyos 的技术栈层级
（Python launcher → Node.js backend → Vue.js frontend）不是一回事。第 8 章设计
SDK 时这个区分会直接影响封装边界。

### 3.1 记忆层 —— CLAUDE.md

书的模型：模型无状态，新对话对项目背景一无所知；CLAUDE.md 是「给 AI 的员工手册」，
每次会话启动自动加载；核心是 **5 级记忆体系**，层级越具体优先级越高，同构于 CSS
层叠优先级与「全局-用户-项目-本地」四级覆盖。上层所有配置都构建于记忆层之上。

**khyos 实现（四层中最强）**：

| 书的机制 | khyos 实现 | 证据 |
| --- | --- | --- |
| 项目级 CLAUDE.md 自动加载 | 三文件加载：`khy.md` / `CLAUDE.md` / `AGENTS.md` | `services/backend/src/constants/prompts.js:1733` 段 |
| 层级优先级 | **KHY > CLAUDE > AGENTS**；cwd 优先于 homedir | `prompts.js:1746` 注释「顺序即冲突时的优先级」 |
| 5 级记忆体系 | 兼容 8 种 AI 工具生态指令文件：Codex / Cursor / Copilot / Windsurf / Cline / Roo / Gemini / Qwen，各分 home 与 project | `services/backend/src/services/instructionEcosystemRegistry.js` |
| 层级覆盖语义 | **section 级覆盖**（非文件级）：khy.md 定义语言行为时，剥掉低优先级文件的 Language 段，其余段落保留 | `_hasKhyLanguageDirective` + `_stripCompatLanguageSections`（`prompts.js:1763` 起） |
| 改配置即时生效 | 鲜度键折入全部已发现指令文件的 `mtime:size`，改文件**当轮即生效** | `constants/promptSectionTaxonomy.js:226`；原始 bug 记录于 `constants/promptFreshness.js:11` |
| 个人长期记忆 | `.khy/memory/MEMORY.md` + `feedback/` `project/` `reference/` `user/` + `services/memoryEngine/` + `memoryDreaming.js` / `memoryCompressor.js` / `memoryContentDedup.js` | 目录实测 |
| 规则登记 | `docs/10_规范/registry/RULES-REGISTRY.json`，67 条 | 实测 |

**section 级覆盖比书的模型更细**：书里「每一级覆盖上一级」通常理解为整文件覆盖。
khyos 做到部分覆盖——同一份 CLAUDE.md 只剥 Language 段、保留其余段落。
第 2 章做五层分级时这是现成基座，不必从零建。

**真缺口**：

1. 5 级里的**「规则级」与「本地级」未成体系**——规则散在 RULES-REGISTRY、CLAUDE.md
   红线、AGENTS.md 工程规则三处，缺统一的条件化加载键。
2. `.khy/preferences.json` 仅含 `theme` 一个键，用户级偏好近乎空。
3. 无按路径的条件化注入（第 2 章范围）。

### 3.2 扩展层 —— 四大组件

书的模型：Commands（斜杠命令，命令模式 Command Pattern）、Skills
（SKILL.md + YAML frontmatter，模型语义自动触发）、SubAgents（上下文隔离 + 最小权限）、
Hooks（唯一具备拦截能力，同构于 Web 中间件）。两要点：**正交性**与 **SRP 单一职责**。
书另注明 Commands 已并入 Skills 成「任务型 Skill」，架构图保留它是为强调
「手动显式触发」与「语义自动触发」的范式区别。

| 组件 | khyos 现状 | 证据 |
| --- | --- | --- |
| Commands | ❌ 空（历史遗留目录） | `.khy/commands/` 仅 `README.md`（716 字节） |
| Skills | ⚠️ 部分，见下 | 43 目录 + builtin/bridge 共 **48** 个 |
| SubAgents | ⚠️ **用户级空，内置已在用** | `.khy/agents/` 0 文件；`src/agents/built-in/` 有 5 个内置 agent |
| Hooks | ⚠️ 运行时完整、零挂载 | `.khy/hooks.json` 不存在 |

**Skills 现状详解**：

| 维度 | 状态 | 证据 |
| --- | --- | --- |
| 元数据真源 | `manifest.json` + `prompt.md`，**43/43 齐备** | `services/backend/src/cli/handlers/initVerifiers.js:13-15`、`services/domain/skills/skills/verifierScaffoldPlan.js:28`（`DEFAULT_SKILLS_DIR = '.khy/skills'`，注释「绝不写 .claude/skills」） |
| SKILL.md 兼容导入 | **0 个**（原 `frontend-beautify` 已删除，§3.2.4）；非平级，是**被导入方** | `skills/index.js:153-161` 回调 `discoverSkillsDeep`，`if (!skills.has(id))` 才添加 |
| 字段映射 | 几乎无语义损失：`when_to_use`→`whenToUse`、`allowed-tools`→`allowedTools`、`layer`→`category`、`context==='fork'`、`model`；但 `handlerPath` 硬编码 `null` | `skills/index.js:701` `_convertLegacySkill` |
| 语义触发 | ⚠️ 线通、信号被削，见「§3.2.1 预算饥荒」 | `services/skillSearch.js:202` → `skills/index.js:243` |
| 死代码 | `matchSkills`（`skillLoader.js:228` 定义、`:450` 导出）全仓零调用 —— **已删除（2026-09-16）** | `grep -rn matchSkills services/backend/` 零命中 |
| allowed-tools | 闸门就绪、**0/48 配置**；**且对 prompt 型技能是空操作**（见下注） | `toolCalling.js:212` `_checkActiveSkillPolicy`；激活点仅 `skills/index.js:568`（handler 块内） |

**双轨已确认不对称**：manifest 侧是超集，SKILL.md 是被导入方。反向迁移会丢功能
（`trigger`、`aliases`、`user_invocable`、`handlerPath` 只有 manifest 能表达；
`frontend-beautify` 的中文别名 `/美化`、`/ui` 就在 manifest 里）。

**⚠️ 真源选择：以 manifest.json 为准，SKILL.md 仅作兼容导入。**

#### 3.2.1 预算饥荒（本章新发现）

`formatSkillListing`（`skills/index.js:243`）把技能目录注入系统提示——这正是书里
「模型自选」的机制，**线是通的**。但描述被按比例截断：

```text
budget=5600 → 5135字符, 48行, 均行107字符, 带"use when:"提示=1行, 被截断=30行
budget=1400 → 2069字符, 48行, 均行43字符,  带"use when:"提示=1行, 被截断=48行
budget= 700 → 2069字符, 48行, 均行43字符,  带"use when:"提示=1行, 被截断=48行
budget= 210 → 2069字符, 48行, 均行43字符,  带"use when:"提示=1行, 被截断=48行
```

三个结论：

1. **目录实际 48 个技能**（`.khy/skills/` 43 + builtin/bridge 约 5），盘点基数不是 69。
2. **2069 字符硬底，预算约束在低位静默失效**——`skills/index.js:277` 的
   `Math.max(20, maxDescLen)` 保证每描述 ≥20 字符，故预算压到 210 时输出仍是 2069。
   `constants/prompts.js:2122-2126` 把预算压到 `onePercent`（可能 2000）或 minimal 模式
   的 300-1000，全部落进这个失效区间。
3. **触发短语全在被砍的那一半**——`formatLine` 前向截断 `slice(0, descLen-1) + '…'`，
   而 `code-review-and-quality` 的 "Use when reviewing code written by yourself…"
   在句尾，107 字符预算下已砍成 "Conducts multi-axis…"。

**④ `whenToUse` 是现成空槽位**：`formatLine` 已实现渲染
（`cmd.whenToUse ? ' (use when: ' + ... : ''`），但 **0/48 技能填了该字段**
（仅 `frontend-beautify` 填了，对应上表那 1 行）。

> **第 3 章的性价比最高动作：一行代码不用改，48 个技能各补一个 `when_to_use` 字段，
> 语义触发立刻获得它该有的输入。**

**已执行修复（2026-09-16，本章落地）**：

| 修复 | 位置 | 效果 |
| --- | --- | --- |
| MCP 排除时不再预留 30% 预算 | `skillSearch.js:209` | `includeMcp:false` 时技能从 3584 → **5120** 字符（+43%） |
| hint 长度计入 overhead | `skills/index.js:289` | 批量填 `when_to_use` 不再静默溢出预算 |
| 15 个技能补 `when_to_use` | `.khy/skills/*/manifest.json` | 带触发提示的技能从 1 → **16**；描述均长 75→105 字符 |

修复后实测（预算 5120）：输出 5071 字符，48 行，均行 105，最长 175，
被截断 40 行，带 `use when:` 提示 16 行。代价是 `maxDescLen` 从 78 降到 53
（15 个 hint 共占 1395 字符 overhead），少数短描述技能开始被截断，
但首句意图仍在——**触发提示的价值高于描述尾部的 25 个字符**。

`when_to_use` 只补了 15 个（非全部 43）：overhead 是全量求和，
43 个长 hint 会把 `maxDescLen` 压回 20 字符地板，净效果为负。
精选标准是「description 长（200+ 字符，截断实际在切掉有用内容）
且触发条件非显而易见」。剩余 28 个技能的触发短语本身在 description 前 78 字符内，
补 hint 属重复。

**`onePercent` 未动**：`prompts.js:2117` 的 `Math.floor(tokens * 0.01 * 4)` 是
刻意的 1% 策略（变量名即声明），抬高需用户裁决——它影响每次推理的提示开销。

#### 3.2.3 allowed-tools 对 prompt 型技能是空操作（本章新发现）

A1 白名单闸门（`toolCalling.js:212` `_checkActiveSkillPolicy`）的激活点
**只有 `skills/index.js:568`**，且该行位于
`if (skill.handlerPath && fs.existsSync(skill.handlerPath))` 块内：

```text
executeSkill()
├─ if (handlerPath 存在) → setActiveSkill(skill)  ← A1 只在这里激活
│  └─ handler 进程内执行，工具调用受白名单约束
└─ else → 返回 prompt.md 文本                       ← 从不 setActiveSkill
   └─ AI 拿到 prompt 后自行调工具（白名单完全不生效）
```

`.khy/skills` 全部 43 个都是纯 prompt 技能（`handlerPath: null`，
`_convertLegacySkill` 硬编码），所以给它们加 `allowed-tools` 是**空操作**——
字段会被读取进 skill 对象，但闸门从不检查它。

生命周期根本不同：handler 技能是「进程内执行，工具调用受限」；
prompt 技能是「prompt 注入后 AI 自行推理调工具」，`executeSkill` 立即返回，
「激活窗口」是 AI 后续整个推理过程，不是一个函数调用。这是设计问题，
不是几行代码能修的。

**结论**：给 prompt 技能补 `allowed-tools` 会是骗人的（改了但没效果）。
正确动作是扩门禁激活范围到 prompt 返回路径——但那需要一个明确的
「prompt 技能激活窗口」定义（何时开始、何时结束），属第 3 章设计范畴。
逃生地板（`ask_user`/`abort`，`constraintLattice.js:275`）保证任何白名单
都不会清空行动集，所以扩展门禁本身是安全的。

#### 3.2.4 双文件共存时的发现优先级

`discoverAllSkills`（`skills/index.js:140-161`）的加载顺序：

```text
1. loadSkillsFromDir(manifest.json)  → manifest 技能先注册
2. discoverSkillsDeep(SKILL.md)      → if(!skills.has(id)) 才添加
```

manifest 优先，SKILL.md 同 ID 时被跳过。所以「目录同时有 manifest.json 和
SKILL.md」时，SKILL.md 对运行时是死文件。

`frontend-beautify` 正是这种情况：manifest.json（当前真源）+ prompt.md
（当前正文，引用 `references/`）+ SKILL.md（旧单体版，8311B，元数据已漂移：
有 `version`/`lifecycle`/`layer`/`dependencies`，无 `aliases`/`trigger`/`when_to_use`）。

唯一消费者是 `exportSkill`（`skillPackageService.js:277`），候选顺序
`SKILL.md` → `prompt.md` → `_legacyBody`——**SKILL.md 优先导致导出过期内容**。

**已删除** `.khy/skills/frontend-beautify/SKILL.md`（2026-09-16）：
加载器跳过它（manifest 优先），`getSkillPrompt` 只读 `promptPath`(=prompt.md)，
`replSession`/`userSkillCommands` 都是「prompt.md 优先，SKILL.md 回退」。
删除后 `exportSkill` 改导出 prompt.md（当前版），bug 消除。

注意：`SKILL.md` 本身是 khy 支持的发现格式（`skillLoaderNativeSkillMd.test.js`
明确断言 `discoverSkillsDeep` 能原生发现 `.khy/skills` 下的 SKILL.md），
只是不与同目录 manifest.json 共存时才是死文件。

#### 3.2.2 内置子智能体已在用

书说子智能体解决上下文窗口有限性——为主对话开辟独立上下文空间，完成后只回注结论。
书里的最小权限原则体现为「代码审查员仅拥有读取权限」。

`.khy/agents/` 为空不等于无子智能体机制：

```text
services/backend/src/agents/
├── types.js                          ← omitClaudeMd 属性（子智能体可选择性不带项目指令）
└── built-in/
    ├── khyGuideAgent.js
    ├── fixAgent.js
    ├── mapAgent.js
    ├── verificationAgent.js
    └── auditAgent.js
```

`verificationAgent.js:46` 的提示词已含「Read the project's CLAUDE.md and/or README …
to discover build/test commands」——即书里「子智能体独立上下文」的实际使用形态。
hooks 的 `SubAgentStart` / `SubAgentEnd` 事件已预留，委派链路的事件面也铺好了。

**第 4 章落点修正**：不是「从零建立子智能体机制」，而是
「内置 agent 已 5 个，缺用户级 `.khy/agents/` 定义格式与委派链路的权限收敛」。
执行手册要求的「先用 1 个小任务验证委派链路」应改为**验证现有内置 agent 的链路**，
再决定是否开放用户级定义。

### 3.3 集成层 —— 连接外部世界

书的模型：集成层是水电管网，两支柱——**Headless**（`-p` 非交互 +
`--output-format json` 可脚本解析 + `--max-turns` 控成本 + `--allowed-tools` 白名单，
嵌进 CI/CD 做 PR 自动审查）与 **MCP**（`.mcp.json`，"AI 时代的 USB-C"，
Tools/Resources/Prompts 三大能力）。扩展层在「体内」强化机能，集成层在「体外」建连接。

| 机制 | khyos 现状 | 证据 |
| --- | --- | --- |
| Headless | ✅ 基本齐 | `services/backend/src/cli/printOutputFormat.js`：`-p`、`--output-format text\|json\|stream-json`、`--max-turns`（cap 100）、`--allowed-tools`、`--disallowed-tools`；文件头注释「Mirrors `claude -p "<query>" --output-format`」 |
| MCP | ⚠️ 部分 | `.khy/mcp.json` 1 个服务器 `deepseek-eyes`（stdio，`python -m deepseek_eyes`）；注意路径是 `.khy/mcp.json` 而非 `.mcp.json` |
| 外部生态接入 | ⚠️ 意外能力 | `services/skills/ccSkillBridge.js`（`KHY_CC_SKILL_BRIDGE` 默认 ON）+ OpenClaw bridge，可发现 `~/.claude/skills`、`~/.claude/plugins/cache`、`~/.claude/local-plugins` |

**缺口**：`.github/workflows/` 存在但未接 khy headless 调用（第 7 章）；MCP 无作用域
分层（用户级/项目级/本地级）与信任评估流程（第 6 章）；MCP 生态深度浅（仅 1 服务器）。

### 3.4 编程层 —— Agent SDK

书的模型：顶楼建筑师工作室，一道**分水岭**——之下靠配置与命令行延展行为（使用者），
之上用 Python/TypeScript 直接调用底层核心（构建者）。书给出
`claude_code.query(prompt, allowed_tools, max_turns)` 示例，并指出一个耐人寻味的事实：
**Claude Code 本身就是基于 Agent SDK 构建的一个 AI Agent**——终端里的一切读写执行，
本质都是 SDK 层的工具调用。

**khyos 现状**：

- ❌ **无对外 SDK**：无可 `require('khy')` 的库入口，外部程序只能起子进程。
- ⚠️ **但 harness 内核存在且相当重**：`services/backend/src/services/toolUseLoopCore.js`
  8000+ 行，含 `IterationBudget`、token-budget governor（`ceiling` 参数，0 时禁用并
  保持 byte-identical legacy 行为）、`_maxTokensRecovery`、`doomLoopGuard.js`。
  这就是 khyos 自己的 SDK 层，缺的是稳定 API 边界。

**留给第 8 章的架构抉择**：

| 路线 | 内容 | 风险 |
| --- | --- | --- |
| A. 把 `toolUseLoopCore.js` 库化 | 它已是内核，缺稳定 API 边界 | 该文件 8000+ 行，是红线 R4 阈值（2500）的 3 倍。属既有债务非新增，`KHY_ARCH_GOD_FILE_LOC` 只卡新增，但库化会扩大其公开面 |
| B. 另起 SDK，现有 loop 当参考实现 | 干净的封装边界 | 双内核，行为可能分叉 |

---

## 四、Harness 五要素盘点

| 要素 | 刻度 | khyos 实现 |
| --- | --- | --- |
| 工具系统 | ✅ 有 | `services/toolCalling.js:3475` `registerTool` + `services/toolCatalog/` + `toolRegistryDedup.collapseRedundant` 去重折叠；`toolCalling.js:212` active-skill `allowed-tools` 白名单闸门（0/48 配置，**且仅对 handler 技能生效**，§3.2.3） |
| 权限控制 | ⚠️ 机制强、默认宽 | `.khy/permissions.json`（`profile: "yolo"`、`version: 2`）+ `.khy/tool_permissions.json` + `toolCallingPermissions.js` + `execApproval.js` / `approvalLedger.js` / `guardApproval.js`；`ToolPermission` hook 只能**收紧**裁决（`hookContribSeams.tighten` 强制单调性） |
| 上下文管理 | ✅ 有 | `contextCompressor.js` + `contextWindowGuard.js` + 技能目录 `charBudget` 预算 + `memoryCompressor.js` |
| 会话持久化 | ✅ 有 | `.khy/sessions.db`（SQLite，含 `-shm`/`-wal`）+ `.khy/session.json` + `.khy/sessions/`（24 条）+ `sessionChecklistResetService.js` + `sessionFileRepair.js` |
| 事件钩子 | ⚠️ 通电未挂线 | `hookRegistry.js` 11 事件 + `hr.blocked` 阻断 + `preventContinuation` 优雅停机 + `_stopHookActive` 防无限续跑；`.khy/hooks.json` 不存在 → 零挂载 |

**刻度：3 有 / 2 部分 / 0 无。**

khyos 的 Harness **不是缺零件，是缺接线和配置**。这与计划 JSON 原记的「三处主要缺口」
描述不同——那个说法低估了底座完成度，也高估了补建成本。

**权限控制的一处需注意项**：`.khy/permissions.json` 的 `profile` 为 `"yolo"`，
即默认全放行。机制完备但默认姿态宽——第 5 章落地 hooks.json 时应同时评估这个默认值。

---

## 五、Agentic Loop 对照

书的模型：提交一个 bug 时，Claude Code 不是「看一眼猜答案」，而是**反复观察、假设、
验证**——先查日志、再搜代码、再理解上下文、最后动手。两个终止条件：① 模型主动停止
（不再发起工具调用）；② 达到 `--max-turns` 最大轮次（防无限循环）。

| 书的机制 | khyos 实现 |
| --- | --- |
| Agentic Loop 主体 | `services/backend/src/services/toolUseLoopCore.js`（8000+ 行） |
| 最大轮次限制 | `IterationBudget(effectiveMaxIterations)` |
| 防无限循环 | `services/doomLoopGuard.js` + `contextWindowGuard.js` |
| 成本护栏 | token-budget governor，`ceiling` 参数（0 时禁用，`assessBudget` 恒 `ok`，循环不因此停止） |
| 截断续写 | `_maxTokensRecovery` + `MAX_NEGLIGIBLE_CONTINUATIONS` |
| Hook 优雅停机 | `toolUseLoopCore.js:3388` PostToolUse `preventContinuation` → `_hookStopRequested` 早退 |
| Stop 防无限续跑 | `toolUseLoopCore.js:3216` `_stopHookActive`（已强制续跑一次后置位） |

---

## 六、baseline 更正记录

计划 JSON `plan.steps[0].khyosBaseline` 与 `dataNeeds` 原记 6 处与实测不符，
已按实测更正。后续章节请以此节为准，不要回引旧记。

| # | 原记 | 实测 |
| --- | --- | --- |
| 1 | 记忆层「有，但无五层分级」 | 多生态 8 种指令文件 + **section 级覆盖** + mtime 鲜度，分级意识强于 CC；真缺口是「规则级/本地级未成体系」与按路径条件化加载 |
| 2 | 子智能体「全仓库无子智能体定义文件，本项目最大缺口」 | **内置子智能体已 5 个**（`src/agents/built-in/`）+ `SubAgentStart/End` hook 预留；空的是**用户级** `.khy/agents/` 定义目录 |
| 3 | 集成层「Headless 参数体系缺」 | 五参数全在 `printOutputFormat.js`，第 7 章范围应从「建参数」改为「接 CI 编排 + 验证成本护栏」 |
| 4 | 编程层「完全空白」 | 无对外 SDK 成立，但 harness 内核 `toolUseLoopCore.js` 存在（8000+ 行），缺的是库化封装 |
| 5 | 扩展层「.khy/skills/ 69 项」 | 69 是**条目数**；43 是目录数；注入模型的目录总数是 **48**（含 builtin + bridge） |
| 6 | 扩展层「无 Hooks 运行时机制」 | 运行时完整（11 事件 + block + 优雅停机 + Stop 防续跑）；`.khy/hooks.json` 不存在 → **零挂载**，不是「无机制」 |

---

## 七、病灶 → 章节归属表

1.1 与 1.2 精读发现的每个缺口，按机制归属指定到具体章节。
**本章不修任何行为**——所有施工动作归各自章节执行。

| # | 病灶 | 归属章 | 该章实际动作 | 风险 | 本章状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 技能语义触发信号被截断（预算饥荒 + 触发短语在句尾） | 第 3 章 | ① 48 个技能补 `when_to_use` ② 预算治理：抬高上限 / 分层注入 / 去 `Math.max(20,…)` 硬底 ③ 收敛匹配真源 | 中 | **已做①② 部分**：MCP 30% 浪费已修、overhead 计算已修、15 个技能已补 hint；上限抬高与匹配收敛待第 3 章 |
| 2 | 0/48 技能声明 `allowed-tools`，闸门代码就绪 | 第 3 章 | 给高危技能补白名单 | 中 | **发现前置条件不成立**：闸门仅对 handler 技能生效（§3.2.3），prompt 技能加白名单是空操作。需先定义「prompt 技能激活窗口」 |
| 3 | Hooks 零挂载 | 第 5 章 | 写 `.khy/hooks.json`，把 `scripts/ci/check-*.js` 挂为 command 型 hook | 高 | 待第 5 章（高风险，需 dry-run + 一键关闭） |
| 4 | 用户级子智能体定义目录为空 | 第 4 章 | 先验证现有内置 agent 委派链路，再定是否开放 `.khy/agents/` 定义格式 | 高 | 待第 4 章 |
| 5 | 无对外 Agent SDK | 第 8 章 | 决定路线 A（库化 `toolUseLoopCore`）还是 B（另起 SDK） | 中 | 待第 8 章 |
| 6 | 无 plugin.json 清单 | 第 9 章 | 设计清单格式，复用现成 `ccSkillBridge` 发现通道 | 中 | 待第 9 章 |
| 7 | MCP 无作用域分层与信任评估 | 第 6 章 | 三层作用域 + 信任评估流程文档化 | 低 | 待第 6 章 |
| 8 | CI 未接 khy headless | 第 7 章 | `.github/workflows/` 接 `khy -p --output-format json` + 成本护栏 | 低 | 待第 7 章 |
| 9 | 记忆层「规则级 / 本地级」未成体系 | 第 2 章 | 五层分级 + 按路径条件化加载 | 高 | 待第 2 章 |
| 10 | `frontend-beautify` 双轨漂移 | 第 3 章 | 以 manifest 为准处置 SKILL.md | 中 | **已处置**：删除 SKILL.md（§3.2.4），`exportSkill` 改导出 prompt.md |
| 11 | `initVerifiers.js:14` 注释过时 | 第 3 章 | 更正括注「(khy 不发现该路径)」 | 低 | **已处置**：改为「(该路径仅经 ccSkillBridge 桥接发现,非 khy 原生路径)」 |
| 12 | `.khy/permissions.json` 默认 `profile: "yolo"` | 第 5 章 / 第 10 章 | 评估默认姿态，与 hooks.json 落地一并决定 | 中 | 待第 5/10 章 |

---

## 八、本章已执行的改动（2026-09-16）

### 8.1 代码改动（受版本控制）

| 改动 | 文件 | 风险依据 |
| --- | --- | --- |
| 删除 `matchSkills` 函数（14 行）及其导出项 | `services/backend/src/skills/skillLoader.js` | 全仓（含 tests）零调用点；`skillLoader.js` 本体保留（`discoverSkillsDeep` 由 `skills/index.js:153` 在用）；空查询 `includes('')` 恒真会命中全部技能，属潜在 bug |
| 项目级 hooks 路径 `.khyquant` → `.khy` + 更正文件头注释 | `services/backend/src/services/domain/extensions/hooks/hookRegistry.js:66`、`:13` | 盘上 `.khy/hooks.json` 与 `.khyquant/hooks.json` **均不存在**，改动等于纠正一个尚未被使用的路径；与全局侧 `_globalHooksPath()`（已走 `getAppHome()`）及 `dataHome.js` 明文禁令对齐 |
| MCP 排除时不预留 30% 预算 | `services/backend/src/services/skillSearch.js:209` | `getSkillCatalogSection` 传 `includeMcp:false`（MCP 工具有独立动态段），预留浪费三分之一预算；技能从 3584 → 5120 字符 |
| hint 长度计入 overhead | `services/backend/src/skills/index.js:289` | `formatLine` 的 `use when:` 提示在 `descLen` 之外追加，原 overhead 不含它，批量填 hint 会静默溢出预算（第二遍不再复查总量） |
| 更正过时注释「(khy 不发现该路径)」 | `services/backend/src/cli/handlers/initVerifiers.js:14-16` | `ccSkillBridge.js:11-12` 明列 `.claude/skills` 两级路径，`instructionEcosystemRegistry.js:204` 亦确认；脚手架指令本体（目标 = `.khy/skills`）保持不变 |

### 8.2 数据改动（`.khy/` 被 gitignore，不入版本控制）

| 改动 | 位置 | 依据 |
| --- | --- | --- |
| 15 个技能补 `when_to_use` | `.khy/skills/{code-review-and-quality, code-simplification, debug, debugging-and-error-recovery, context-engineering, api-and-interface-design, frontend-ui-engineering, git-workflow-and-versioning, security-and-hardening, performance-optimization, test-driven-development, incremental-implementation, planning-and-task-breakdown, documentation-and-adrs, ci-cd-and-automation}/manifest.json` | 触发短语原在 description 尾部，被 `formatLine` 前向截断切掉；`when_to_use` 在截断之后渲染，不会被砍。只补 15 个（非 43）：overhead 全量求和，全补会把 `maxDescLen` 压回 20 字符地板 |
| 删除 `frontend-beautify/SKILL.md` | `.khy/skills/frontend-beautify/` | 与 manifest.json 同目录 → `discoverAllSkills` 跳过它（manifest 优先）；唯一消费者 `exportSkill` 因 SKILL.md 优先而导出过期内容；`prompt.md`（当前版，引用 `references/`）+ manifest.json 已覆盖其全部语义 |

### 8.3 刻意未做

| 项 | 理由 | 归属 |
| --- | --- | --- |
| 抬高 `onePercent` 预算上限 | `prompts.js:2117` 的 1% 是刻意策略（变量名即声明），抬高影响每次推理开销，需用户裁决 | 第 3 章 |
| 给 prompt 技能补 `allowed-tools` | 闸门仅对 handler 技能生效（§3.2.3），补了是空操作 | 第 3 章 |
| 扩展 A1 门禁到 prompt 返回路径 | 需先定义「prompt 技能激活窗口」（何时开始/结束），是设计问题非代码问题 | 第 3 章 |
| 创建 `.khy/hooks.json` | 高风险章协议：先 dry-run，保留一键关闭开关，再真实执行 | 第 5 章 |
| `hookRegistry.js:42` catch 兜底路径 | 仅 `dataHome` require 失败时触发的防御分支，改错会吞掉异常；需先确认该兜底是否应改为抛错而非静默降级 | 第 5 章 |

---

## 九、不适用于 khyos 的机制（初步）

khyos 是 Python launcher + Node.js backend + Vue.js frontend 混合栈，
以下机制不能照抄。全书收口时（第 10 章）需逐项复核并补充理由。

| 书的机制 | 不适配原因 | khyos 的替代 |
| --- | --- | --- |
| 技能元数据载体 `SKILL.md` + YAML frontmatter | YAML 在 khyos 协议中**仅允许用于 CI/CD 与 ML 配置**（`docs/10_规范/其它规范/FILE-FORMAT-PROTOCOL.md` §2.5）；khyos 元数据用 JSON | `manifest.json` + `prompt.md`；SKILL.md 仅作兼容导入 |
| `.claude/commands/` 独立命令目录 | khyos 的每个技能已同时是斜杠命令（`manifest.json` 的 `trigger` + `aliases`），等于书里「Commands 并入 Skills」的终态 | 技能即命令；`.khy/commands/` 是历史遗留空目录 |
| `.mcp.json` / `.claude/settings.json` 路径约定 | khyos 运行时统一收敛在 `.khy/`，由 `dataHome.js` 解析 | `.khy/mcp.json`、`.khy/settings.json`、`.khy/hooks.json` |
| `.khyquant/` 遗留路径 | `dataHome.js` 明文禁止新增裸 `os.homedir()+'.khyquant'` 硬编码 | 统一经 `getAppHome()` / `getDataHome()` |
| 单一 Python SDK（`claude_code.query`） | khyos 是混合栈，SDK 需双语言适配 | 第 8 章双语言接口设计 |

---

## 十、本文档维护

- **编号**：112（2026-09-16 实测 `docs/03_DESIGN_设计/` 最大编号 111，112 空闲）
- **索引登记**：`docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md` §二清单
- **HTML 产物**：由 `npm run docs:build` 生成，禁止手写
- **格式协议**：`docs/10_规范/其它规范/FILE-FORMAT-PROTOCOL.md` —— LF 换行、标题不跳级、
  代码块标语言、相对路径链接、行宽 ≤120
- **关联计划**：`.khy/plans/learn-claude-code-book.json` `plan.steps[0]`

---

## 关联规则索引

- `CLAUDE.md` —— 红线 R1–R4、行为准则 B1–B3 的语义真源
- `AGENTS.md` —— 工程规则 1–4（RUNTIME-001~004）的语义真源
- [`../10_规范/registry/RULES-REGISTRY.json`](../../10_规范/registry/RULES-REGISTRY.json) —— 规则单一真源登记表
- [`../10_规范/其它规范/FILE-FORMAT-PROTOCOL.md`](../../10_规范/其它规范/FILE-FORMAT-PROTOCOL.md) —— 文件格式协议
- `[DESIGN-ARCH-111] 规则遵守保障机制.md` —— 规则登记表的门绑定层
- 后续章节：`[DESIGN-ARCH-113]` 记忆系统、`[DESIGN-PROCESS-001]` Skills、
  `[DESIGN-ARCH-115]` 子智能体、`[DESIGN-ARCH-116]` Hooks、
  `[DESIGN-ARCH-117]` MCP、`[DESIGN-ARCH-118]` Headless、
  `[DESIGN-ARCH-119]` Agent SDK、`[DESIGN-ARCH-120]` Plugins、
  `[DESIGN-ARCH-121]` 工程化最佳实践
