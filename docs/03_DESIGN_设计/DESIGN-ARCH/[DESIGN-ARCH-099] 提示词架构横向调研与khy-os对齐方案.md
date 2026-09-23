<!-- 文档分类: DESIGN-ARCH-099 | 阶段: 设计 | 关联: [DESIGN-ARCH-098] 结构重设计、[DESIGN-PROMPT-002] 分层规范 -->
# [DESIGN-ARCH-099] 提示词架构横向调研与 khy-os 对齐方案

> **性质**：调研报告 + 对齐方案（提案）。调研时间 2026-09-15。
> **上游**：[DESIGN-ARCH-098] 给出 khy-os 自身的目标结构（L0–L4）；本文横向比对四个开源实现，
> 校准 098 的取舍，并给出**可直接落地**的对齐清单（含「已经对齐、不用改」的项）。
> **一句话结论**：khy 的提示词架构是 Claude Code 早期结构的**忠实移植**（文件头自述如此），
> 因此它继承了那套分层思想，却**没继承后续的优化**——而开源同行已经用四种不同方式
> 解决了 khy 现在正面临的问题。

---

## 0. 摘要

### 0.1 五条最高收益动作（按预期收益排序）

| # | 动作 | 对齐谁 | 现状痛点（khy 实测） | 预期收益 |
|---|------|--------|---------------------|---------|
| **R1** | **每轮状态改为 messages 增量注入** | Codex CLI | 每轮重算 52,817 字符 | 系统提示词整段会话**逐字节不变**，命中率拉到理论上限 |
| **R2** | **单条注入内容设硬上限（≤10k tokens/条目）** | Codex CLI | `# claudeMd` 单条 26,378 字符（≈15–20k tokens） | 消灭超限条目；防止项目文件继续膨胀 |
| **R3** | **缓存失效归因细化到「段」** | Claude Code | ⚠️ **修正**：khy 不是「无」——早有 `KHY_CACHE_PREFIX_SHAPE` + `constants/promptPrefixShape.js`（SHA-256 短哈希，system/tools/order 三维度）。缺的是 **per-section 粒度**：只能说「系统提示变了」，说不出哪一段变了 | 每次失效可回答「是谁变了」 |
| **R4** | **工具使用纪律下沉到工具 description** | Gemini CLI / opencode | 纪律在 system 段与工具实现里各写一份 | 削减静态段 + 纪律离开「决策点」更近 |
| **R5** | **前缀稳定性测试套件** | Codex CLI | 无（只有段缓存功能测试） | 把「前缀不被击穿」变成回归可测的硬约束 |

### 0.2 三条不需要改的（已对齐，避免重复造轮子）

- **工具池排序**：khy `tools/index.js::assembleToolPool()` 注释明写 `sorted for prompt cache stability`，
  且带 memo 化——与 Claude Code 的 `assembleToolPool()` 同源同做法。**已对齐。**
- **段缓存的 cacheKey 契约**：`systemPromptSection(id, compute, cacheKey)` 与
  `DANGEROUS_uncachedSystemPromptSection(...)` 的双构造器 + `DANGEROUS_` 前缀警告命名，
  完整照搬了 CC 的设计，机制本身是对的（问题在**用错了键**，见 098 §7）。
- **compact 专用提示词**：khy `services/domain/memory/compact/prompt.js` 与 Gemini CLI 的
  `getCompressionPrompt(config)` 思路一致——主提示词与压缩提示词分离。**已对齐。**

---

## 1. 调研范围与可信度分级

| 项目 | 开源 | 证据等级 | 说明 |
|------|------|---------|------|
| **Claude Code** | ❌ 闭源 | **B（社区逆向）** | 基于多份源码级分析（v2.1.88）与流量抓包，细节高度一致但**非官方**；引用时标注 |
| **opencode**（sst/opencode） | ✅ | **A（源码）** | 可直接引用文件路径与实现描述 |
| **Codex CLI**（openai/codex） | ✅ Apache-2.0 | **A（源码）** | Rust；有官方目录结构与测试文件路径可引 |
| **Gemini CLI**（google-gemini/gemini-cli） | ✅ | **A（源码）** | TypeScript；`prompts.ts` / `promptProvider.ts` / `snippets.ts` |
| **DeepSeek Harness**（deepseek-ai/deepseek-harness） | ✅ MIT | **A−（源码 + 官方文档）** | v0.1 预览版（2026-08-13），接口仍在变 |

> **诚实声明**：Claude Code 的具体行号与内部常量名来自第三方分析，可能随版本漂移；
> 本文凡标注 B 级的结论只用于**印证设计意图**，不作为「照抄某个实现」的依据。
> 另需注意：khy-os 现有 `prompts.js` 的注释明确写着「Architecture ported from Claude Code's
> prompts.ts — same section structure, same cache boundary pattern」，所以下文对照 CC 时，
> 差异**不是巧合而是欠同步**。

---

## 2. 五个项目的提示词架构

### 2.1 Claude Code（对照基准：khy 的移植来源）

**静态面**：`getSystemPrompt()` 返回**字符串数组**（与 khy 同构），前 6–7 段为静态 section：
`getSimpleIntroSection` / `getSimpleSystemSection` / `getSimpleDoingTasksSection` /
`getActionsSection` / `getUsingYourToolsSection` / `getSimpleToneAndStyleSection` /
`getOutputEfficiencySection`。之后插入 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`。

**关键语义（khy 最容易误读的一点）**：CC 的 boundary **不是**「常量 vs 动态」的分界，
而是「**全局共享可缓存 / 会话私有**」的分界——boundary 之上要求**对所有用户字节相同**，
从而吃到服务端**跨用户共享**的前缀缓存。而且这个标记**只在 `shouldUseGlobalCacheScope()`
为真（1P API）时才插入**。khy 把 boundary 当成「常量/动态」的分界，于是把
`outputStyle`、`enabledTools`、`deferred_tools_hint` 这类**逐会话/逐轮变化**的东西放进了
「应当全局共享」的区域——在语义上就已经不自洽了。

**动态面**：13 个 `SystemPromptSection` 注册项，其中**只有 `mcp_instructions` 一个**使用
`DANGEROUS_uncachedSystemPromptSection`（理由是 MCP 会在轮次间连断）。其余 12 个都是
「守清 / compact 前只算一次」。

**缓存工程（CC 最强的部分）**：

1. **专用失效检测模块** `promptCacheBreakDetection.ts`：每轮对比
   `systemHash` / `toolsHash` / `cacheControlHash` / `perToolHashes` / `model` / `fastMode`，
   定位「是谁变了导致缓存失效」。源码注释留下一条极有说服力的记录：
   > 动态 agent 列表曾占全舰队 cache_creation token 的 **10.2%** → 于是把 agent 列表
   > **从 system prompt 移入会话消息附件**，让 system prompt 不再改变。

2. **项目指令不放 system prompt**：`CLAUDE.md` 通过 `<system-reminder>` 注入到
   **messages 数组的第一条用户消息**，并独立设置 `cache_control`。理由正是「system prompt
   在全体用户间共享，把 CLAUDE.md 拼进去就没有共享缓存了」。

3. **日期不进动态位置**：`getSessionStartDate` 被 memoize 到会话起点；
   跨零点的日期变化通过**尾部附件消息**处理，避免击穿缓存。

4. **两个缓存断点**：① system + tools（稳定层）② CLAUDE.md 消息（项目层）。

5. **输出效率用数值而非形容词**：内部版实测「工具调用间文本 ≤25 词、最终回复 ≤100 词」
   相对定性的 “be concise” 带来约 1.2% 输出 token 下降。

6. **工具池** `assembleToolPool()`：内置工具按名称 `localeCompare` 排序构成**连续前缀**，
   MCP 工具排在后面并同样排序。

**工具提示设计**：工具提示与工具实现同址（每个工具自带 description + JSON schema），
且**占了请求的最大头**（工具定义 14–17k tokens，系统提示词仅 2.5k tokens）。
这可作为 khy「system 里塞了 3,104 字符的命令执行纪律」的对照。

**Agent 层**：`Coordinator Mode` 下身份改写为编排者，**只给 3 个工具**
（Agent / SendMessage / TaskStop），无文件读写——即「换模式 = 换工具面 + 换身份段」。

### 2.2 opencode（sst/opencode）

**静态面**：**按模型分文件**的静态 `.txt` 提示词，通过 Bun 编译期静态导入嵌入 bundle：
`anthropic.txt` / `beast.txt`（gpt-4/o1/o3）/ `gpt.txt` / `codex.txt` / `gemini.txt` /
`qwen.txt` / `kimi.txt` / `trinity.txt`。选择逻辑是**模型 id 子串匹配**。

**五层装配**（`SystemPrompt.header → provider → environment → custom → maxSteps`）：

```text
1. header       provider 特定前缀（Anthropic 注入一段身份 spoof）
2. provider     按模型选的静态提示词文件
3. environment  <env> 包裹的运行时块：cwd / 是否 git 仓库 / 平台 / 今天日期 / git 文件树
                （ripgrep 取 git tree，**硬限 200 个文件**防上下文爆炸）
4. custom       指令文件合并：项目级 AGENTS.md → CLAUDE.md → CONTEXT.md（向上找到 git root）
                + 全局 ~/.config/opencode/AGENTS.md + config 指定的路径或 URL
                每份以 `Instructions from: <path>` 分隔；**不做冲突消解**，全部保留
5. maxSteps     接近步数上限时的提醒
```

**每轮状态走 messages，不走 system**：`plan.txt` 追加到**最后一条用户消息**；
`build-switch.txt` 在 plan→build 切换时追加；`max-steps.txt` 作为**伪 assistant 消息**注入。
这是与 khy 最大的结构差异：opencode 把「模式/状态」当**对话内容**处理。

**指令的按需注入（对 khy 的 26k `claudeMd` 是直接解法）**：指令文件在**两个时机**加载——
① 建 system prompt 时从 cwd 向上找；② **工具执行时**：当 Read 工具读到某个子目录的文件，
就从小文件所在目录向上找「尚未加载」的指令文件，作为块注入**工具输出**；并有
**每消息 claim 机制**防止同一文件在一个 turn 内被注入两次。

**缓存处理**：Anthropic 路径下，若 system 数组首元素在插件变换后未被改动，
则**把其余部分 join 成一个字符串**，维持「可缓存的 2 段结构」。

**插件钩子**：`experimental.chat.system.transform` 允许插件增删改 system 数组，
并有「插件清空数组则还原原值」的安全兜底。

### 2.3 Codex CLI（openai/codex，Rust）——**对 khy 最有参考价值的一个**

Codex 的分层不是「静态段 / 动态段」，而是**「指令是字符串，上下文是消息」**：

| 层 | 载体 | 内容 | 注入时机 |
|----|------|------|---------|
| **L0 base instructions** | API 的 `instructions` **字符串** | 按模型族选文件：`codex-rs/core/prompt.md`（默认）/ `gpt_5_1_prompt.md` / `gpt_5_2_prompt.md` / `gpt_5_codex_prompt.md`；可被 `base_instructions_override` 替换；必要时追加 `APPLY_PATCH_TOOL_INSTRUCTIONS` | 每轮请求（**字符串本身稳定**） |
| **L1 developer instructions** | `role: developer` 的**消息** | 权限/插件/技能/协作模式/人格等 | **会话初始化时写入历史一次** |
| **L2 user instructions** | `role: user` 的**消息** | `config.user_instructions` + **AGENTS.md 链** + Skills 元数据，合并为单串，格式为 `# AGENTS.md instructions for <path>` | 会话初始化时一次 |
| **L3 environment context** | `role: user` 的 **XML 消息** | cwd / approval_policy / sandbox_mode / network_access / shell / writable_roots | 首轮建立；**字段变化时只追加「变化字段」的新消息** |

**第三个设计是 Codex 的核心创新**：`build_environment_update_item()`——
环境变化**不在原位置改写**，而是在消息流**尾部追加一条只含变化字段的消息**。
后果是：**`instructions` 字符串在整段会话里逐字节不变**，前缀缓存天然满载。

**v0.123 的片段化重构**（PR #18794 / #18813）——与 098 的锚点方案高度同构，且更彻底：

```rust
pub trait ContextualUserFragment {
    const ROLE: &'static str;          // "developer" | "user"
    const START_MARKER: &'static str;  // XML 式开始标记
    const END_MARKER: &'static str;
    fn body(&self) -> String;
    fn matches_text(text: &str) -> bool;
    fn render(&self) -> String;        // START_MARKER + body + END_MARKER
    fn into(self) -> ResponseItem;
}
```

碎片目录（约 20 个）：`PermissionsInstructions` / `AvailablePluginsInstructions` /
`AvailableSkillsInstructions` / `CollaborationModeInstructions` / `PersonalitySpecInstructions` /
`PluginInstructions` / `AppsInstructions` / `ImageGenerationInstructions` /
`ModelSwitchInstructions` / `NetworkRuleSaved` / `ApprovedCommandPrefixSaved` /
`GuardianFollowupReviewReminder` / `HookAdditionalContext` / `SpawnAgentInstructions`（developer）
+ `EnvironmentContext` / `UserInstructions` / `SkillInstructions`（user）。

**他们为什么重构**（三个原罪，和 khy 现在的问题一一对应）：

1. **压缩无法选择性丢弃**：整块 `DeveloperInstructions` 只能全留或全丢 →
   现在每个碎片**可单独驱逐**（一轮纯重构任务可以扔掉「图像生成指引」）。
2. **插件没有明确注入点**：文本被无结构地追加，两个插件可以**静默冲突**。
3. **调试不可归因**：想查「是哪条指令影响了这轮」只能人肉翻几千 token 的拼接文本。

**上下文管理硬规则**（`codex-rs/core/src/context/mod.rs`）：

| 规则 | 含义 |
|------|------|
| 无历史重写 | 上下文必须**增量构建**，不得回头改已发出的内容 |
| **减少缓存失效** | 明确把「避免高频上下文变更」写成工程目标 |
| 无未绑定条目 | 所有注入内容必须有界，有硬上限 |
| **条目 ≤10k tokens** | 单条注入内容的硬上限 |
| 大条目人工审查 | 新增 >1k tokens 的条目需额外评审 |

**缓存测试**：`codex-rs/core/tests/suite/prompt_caching.rs` —— **有专门的前缀缓存测试套件**，
断言首轮消息次序与后续稳定性。

**其他**：`prompt_cache_key` 字段启用 API 级缓存；工具面随模型族变化
（`gpt-5-codex` → `shell_command` + freeform apply_patch；`exp-*` → `exec_command` + `write_stdin`）；
`~/.codex/prompts/*.md` 支持带 `$1..$9` / `$ARGUMENTS` 占位符的自定义提示词；
`AGENTS.md` 自动读取；仓库自身 `AGENTS.md` 写着 `codex-core crate is bloated, resist adding code to codex-core`。

### 2.4 Gemini CLI（google-gemini/gemini-cli）

**组织方式**：单一模板函数 + **片段模块 + 模型代际变体**。

- 入口 `packages/core/src/core/prompts.ts` 的 `getCoreSystemPrompt(config, userMemory?, interactiveOverride?)`
  与 `getCompressionPrompt(config)`（主提示词 / 压缩提示词分离）。
- 真正的编排在 `packages/core/src/prompts/promptProvider.ts::getCoreSystemPrompt`，三阶段：
  ① **收集上下文**（approval mode、skill 列表、启用工具名、工具列表、已批准 plan 路径、
  是否交互、是否启用交互式 shell、是否开启 narration、**活跃模型 → 选择 modern 还是 legacy 片段模块**、
  subagent 定义、plans 目录、tracker 开关、`getAllGeminiMdFilenames()`、`isGitRepository(cwd)`、
  `process.env['SANDBOX']`）；
  ② **模板覆盖**（`GEMINI_SYSTEM_MD` 指向文件，默认 `.gemini/system.md`，**整份替换**内置提示词）；
  ③ **片段装配**（`snippets.ts` / `snippets.legacy.ts`）。

**条件段落**：sandbox（MacOS Seatbelt / 通用 sandbox / sandbox 外三种）、git 仓库段、
Examples 段、userMemory（以分隔符追加）。

**两个值得抄的工程细节**：

- **首尾呼应（book-ending）**：开头写身份与总则，**结尾再放一段 `Final Reminder:`**
  重申最关键约束（含「绝不要假设文件内容，必须用 read 工具」与「keep going until resolved」）。
  利用结尾的强近因效应，且该段属于**静态**部分，不破坏前缀。
- **`GEMINI_WRITE_SYSTEM_MD`**：把**装配完成**的提示词写盘，供人工检视或调试。
  另有 `prompts.test.ts.snap` **快照测试**锁定装配产物。

**社区反馈的关键概念**：Gemini CLI 用户社区明确观察到 **「context rot」**——
项目指令涨到数百行 markdown 后，模型开始**不遵守指令**、需要反复提醒。
建议把 `SYSTEM.md` 定位为**「固件层」**（与任务无关的、不可协商的工具操作规则），
把项目约定与工作流另置。**这与 098 的 L0 / L1 切分是独立得出的同一结论。**

### 2.5 DeepSeek Harness（deepseek-ai/deepseek-harness，dsh）

**定位差异**：dsh 不把提示词当「一段文本」，而是当**运行时的一个分区服务**：

- 独立包 `core/system-prompt`，职责写着「**提示词分区**与工具 schema 组装」（`ctx.systemPrompt`）。
  另有 `core/session`（追记式 `SessionEvent` 日志）、`core/tools`（作用域工具注册表）、
  `core/agent-loop`（默认驱动）——**分区是被架构成一个独立接缝的**。

**硬性原则**：**「模型可见 = 已记录」**——任何进入模型请求的内容都必须能从
append-only 会话日志重建。模型上下文不是累积状态，而是由 `deriveMessages()` 从日志
**投影**出来的。好处：resume / fork / replay / audit 共享同一份事件流；
调试时可精确回答「第 50 步是什么把它带偏的」。

**模式 = 换插件树而非换提示词**：标准 / PTC / 极简 / 创造四种模式，各自加载不同插件集合，
于是**工具面与权限随之切换**，而提示词结构保持不变。极简模式只留 `bash` + `str_replace_editor`
两个工具（用于模型基准测试，避免工具面干扰）。
这与 CC 的 Coordinator Mode、opencode 的 agent 覆盖 prompt 是同一思路的三种实现。

**PTC（Programmatic Tool Calling）**：把工具封装为代码 API，模型**写一段 TypeScript**
编排多步工具调用，中间结果留在执行环境里**不进入上下文**。
这是对 khy 用散文规则（「尽量并行调用工具」）来表达的同一诉求的**机制化**解法。

**可观测性**：Trajectory 视图按来源列出 System Prompt / 上下文注入 / 推理 / 工具调用 /
工具结果 / 子 Agent 调度，并在 UI 里直接显示**缓存命中率**、上下文占用、首 token 延迟。

---

## 3. 横向归纳

### 3.1 六条共识（四家以上一致）

| # | 共识 | 具体表现 |
|---|------|---------|
| C1 | **指令面要「少而稳」，越靠前越稳定** | CC 的 boundary 语义、opencode 的编译期常量文件、Codex 的 `instructions` 字符串、Gemini 的模板 |
| C2 | **每轮状态走 messages，不走 system** | CC（CLAUDE.md/日期尾部附件）、opencode（plan/build-switch/max-steps）、Codex（环境上下文消息）、dsh（上下文注入记为事件） |
| C3 | **项目指令/环境上下文独立注入、独立缓存** | CC（CLAUDE.md 单独 `cache_control`）、Codex（`UserInstructions` 独立 user 消息）、opencode（`Instructions from:` 分隔） |
| C4 | **注入内容必须有界** | Codex 的 ≤10k tokens/条目与 >1k 人工审查；opencode 的 git tree 限 200 文件；CC 的工具输出截断 |
| C5 | **片段要类型化、可寻址（带标记）** | Codex 的 `ContextualUserFragment` + `START/END_MARKER`；khy 自己的锚点方案同理 |
| C6 | **缓存失效要可观测、可测试** | CC 的 `promptCacheBreakDetection.ts`；Codex 的 `prompt_caching.rs`；dsh 的缓存命中率 UI；Gemini 的 `GEMINI_WRITE_SYSTEM_MD` |

### 3.2 三条分歧（必须为 khy 做取舍，不能和稀泥）

**分歧 D1：项目指令放 system 前缀，还是放 messages？**

- CC / Codex 都选 **messages**。理由分两层：CC 是为了保住**跨用户全局共享缓存**；
  Codex 是为了保住 **`instructions` 字符串逐字节不变**。
- khy 的处境：`project_instructions` 已在动态区（boundary 之后），且 khy 有**自建 relay 路径**
  （Anthropic `cache_control` 边界标记在 `_messageBuilder` 被剥掉，命中率全靠 provider
  最长前缀匹配），**没有全局共享缓存这回事**。
- **结论（对 098 的修正）**：对 khy，把项目指令搬进 system 前缀（098 的 L1 方案）与
  放进 messages，在命中率上**几乎等价**；真正的差别在**改动粒度**——
  放前缀时，项目指令任何一次改动都会毁掉其后全部前缀；放 messages 并采用
  Codex 的 **delta 追加**，则**前缀永远不需要改写**。
  → **R1 因此优先于「把 claudeMd 搬进 L1」**。详见 §6。

**分歧 D2：配置值能否进 system？**

- Codex **允许**：`sandbox_mode` / `approval_policy` 直接枚举在提示词里（因为 OpenAI 侧缓存
  是 per-org 前缀缓存，不必全局共享）。
- CC **不允许**进「全局共享区」：任何逐会话变化的值都必须在 boundary 之后。
- khy 现状是两边都踩：`simple_intro`/`doing_tasks` 依赖 output style（不该在前缀），
  而 `deferred_tools_hint` 逐轮变化也在前缀。
- **结论**：khy 应取 CC 的严格版——**前缀只放「会话内不变 + 无参数化」的内容**，
  配置派生内容一律放 boundary 之后。

**分歧 D3：模型差异怎么表达？**

- **多份文件**：opencode（`anthropic.txt` / `beast.txt` / …）、Codex（`prompt.md` /
  `gpt_5_codex_prompt.md` / `gpt_5_1_prompt.md` …）——按模型族**整份替换**。
- **条件段落 / 代际模块**：Gemini（`snippets.ts` vs `snippets.legacy.ts`，按活跃模型选）。
- khy 现状：`getSystemPrompt` 内**条件分支**（`compactPrompt`、`isLowTierModel`、
  `hasNativeToolUse`）+ 外层 `HARDCORE_SYSTEM_PROMPT` legacy 外壳。
- **结论**：khy 的模型分支已经散在函数体里，**建议改为 Codex 式的「基座文件 + 模型族变体文件」**，
  让「某个模型的差异」成为可 diff、可评审的独立文件，而不是埋在 3,000 行装配器里的 if。

---

## 4. khy-os 差距对照

| 维度 | 同行做法 | khy 现状 | 差距 |
|------|---------|---------|------|
| 每轮状态载体 | messages 增量（Codex/opencode/CC） | system prompt 尾部 5 个易变段 | **高** |
| 前缀稳定性 | `instructions` 字符串全程不变（Codex） | 每轮重排 + 参数化内容在前缀 | **高** |
| 单条目大小上限 | ≤10k tokens/条目（Codex 硬规则） | `# claudeMd` 26,378 字符**无上限** | **高** |
| 缓存失效归因 | 专用哈希监控模块（CC） | **已有** `promptPrefixShape.js`（system/tools/order），缺 per-section 粒度 | **中**（非「高」，见 R3 修正） |
| 前缀稳定性测试 | `prompt_caching.rs` 专项套件（Codex） | 无（仅段缓存功能测试） | **高** |
| 片段类型化 | `ContextualUserFragment` + 标记（Codex） | 无（靠数组位置 + 手工清单） | 中（099 已提锚点） |
| 指令文件按需注入 | 工具执行时向上发现并注入（opencode） | 一次性全量注入 | 中 |
| 工具纪律位置 | 与工具实现同址（Gemini/opencode） | system 段 + 工具实现**各一份** | 中 |
| 装配产物可检视 | `GEMINI_WRITE_SYSTEM_MD` + 快照测试 | 无直接开关 | 中 |
| 输出长度约束 | 数值化（≤25 词 / ≤100 词，实测 -1.2% 输出 token） | 定性（"short and concise"） | 低 |
| 工具池排序 | 按名排序成连续前缀（CC） | **已对齐** | 无 |
| 段缓存构造器 | 双构造器 + `DANGEROUS_` 命名（CC） | **已对齐** | 无 |
| 主提示词 / 压缩提示词分离 | `getCompressionPrompt`（Gemini） | **已对齐** | 无 |

---

## 5. 具体优化方案

### R1　每轮状态改为 messages 增量注入　【高】

**对齐**：Codex CLI `build_environment_update_item()`。

**改什么**：把 L3（`env_info`、`git_status`、`task_memory`、`mcp_instructions`、
`deferred_tools_hint`）从系统提示词中**移出**，改为：

- 会话首轮：在消息流里建立一份基线上下文消息（XML 或标记块）；
- 之后每轮：**只追加变化字段**的新消息，不改写已有内容。

**收益**：系统提示词在整段会话内**逐字节不变**。实测每轮重算量从 52,817 字符降到
**约 300（含 L4 意图块）**——因为易变项不再进入系统提示词。

**风险**：改变模型看到的上下文形态（从「系统提示词里有 git 状态」变成「消息流里有」）。
需评估对指令遵循的影响。**这是本方案唯一需要行为回归验证的大改动。**

**验收**：连续两轮装配的系统提示词求公共前缀，应等于全长；git 状态变化体现在消息流尾部。

### R2　单条注入内容设硬上限　【高·可立刻做】

**对齐**：Codex CLI `core/context/mod.rs` 的「条目 ≤10k tokens；>1k 需人工审查」。

**改什么**：在 `promptSectionTaxonomy.js` 给每个 section 增加 `maxTokens` 字段，
守卫按锚点统计实际大小；超限即红。首当其冲的是 `# claudeMd`（26,378 字符 ≈ 15–20k tokens，
**超上限约 2 倍**）。

**收益**：立刻暴露最大的单条膨胀源，防止项目文件继续无界增长。

**风险**：可能立即变红（现状确实超限）。对策：先以 WARN 上线，给出「切分或按需注入」的
修复指引，再逐步收紧为 ERROR。

### R3　缓存失效归因细化到「段」　【中】

> ⚠️ **调研修正（2026-09-15）**：初稿写「khy 无任何缓存失效归因能力 → 高」。实施 098 时核查发现
> khy **早已有** `KHY_CACHE_PREFIX_SHAPE`（默认开）与 `constants/promptPrefixShape.js`：
> 每轮对 system / tools 拍 SHA-256 短哈希并跨轮比对，输出 `PrefixChangeReasons(['system','tools','order'])`，
> 由 `cli/cacheWarning.js` 展示中文归因。所以差距不是「有没有」，而是**粒度**——
> 只能定位到「系统提示变了」，无法定位到「哪一段变了」。

**改什么**：在 `promptPrefixShape.js` 的 `captureShape()` 中，用 `promptAnchors.parseAnchors(system)`
把系统提示切成段并逐段哈希，塞进快照的 `sectionHashes`；`compareShape()` 增加
`reasons: ['section:<id>']`。**P0 的锚点正好为它提供了切分依据**——这也是为什么
098 §7 的落地顺序把「打锚点」放在最前。

**收益**：把「cache hit 掉了」从现象变成可归因的事实，且归因到具体段。CC 正是靠同类能力发现
了「agent 列表占全舰队 cache_creation 的 10.2%」这种反直觉问题。

**风险**：低（纯观测）。但需注意快照体积：35 段 × 16 字符哈希 ≈ 560 字节/轮，可接受。

**验收**：人为改动 `AGENTS.md` 后，归因输出应点名 `project_instructions`，而非笼统的「系统提示」。

### R4　工具使用纪律下沉到工具 description　【中·可立刻做】

**对齐**：Gemini CLI（`packages/core/src/tools/shell.md` + `shell.ts` 同址）、opencode（`Tool.define` 内联）。

**改什么**：khy 的命令执行纪律目前是**双份**——`getCommandExecutionSection()`（3,104 字符，
含 `buildTransparencyItem()` 与工具超时教学）与 `tools/shellCommand.js` 的实现内描述。
把细则下沉到各工具的 description，system 侧只留**跨工具的通用原则**（「有专用工具就用专用工具」
一类）。工具提示天然随工具面一起被缓存，且**距离决策点更近**。

**收益**：直接削减静态段；也顺带缓解 098 §1.3 测到的「优先专用工具而非 shell」在
2 个段重复（1,421 + 196 字符）的问题。

**风险**：需确认工具 description 的注入路径在所有 provider 上都可靠（khy 的本地文本协议路径
`getToolDefinitions()` 与原生 function-calling 路径要一致）。

### R5　前缀稳定性测试套件　【高·成本低】

**对齐**：Codex CLI `codex-rs/core/tests/suite/prompt_caching.rs`。

**改什么**：新增 `services/backend/tests/promptPrefixStability.test.js`，断言：

1. 同会话连续两次装配（无用户显式切换）的**公共前缀 = 整个静态前缀长度**；
2. 工具池顺序稳定（与 CC `assembleToolPool` 的排序契约对齐）；
3. **无时钟/日期进入静态前缀**（防 CC 记录过的「跨零点破裂」类问题）；
4. 切换 output style / 工具档位后，前缀失效范围**恰为**该层起点。

**收益**：把「前缀不被击穿」从口头约定变成 CI 可拦的红线。

### R6　装配产物可检视开关　【中】

**对齐**：Gemini CLI `GEMINI_WRITE_SYSTEM_MD`；dsh 的 Trajectory 按来源展示。

**改什么**：新增 `khy prompt --dump`（或 `KHY_WRITE_SYSTEM_MD=<path>`）把**装配完成**的
提示词按锚点分层写盘，并打印每层字节数；配合 R3 输出缓存命中归因。

**收益**：把「44 个段、21 个装配槽、66,780 字符」这种问题从「靠读代码推断」变成「一条命令」。

### R7　指令文件按需注入　【中】

**对齐**：opencode 的「工具执行时向上发现指令文件 + 每消息 claim 防重复」。

**改什么**：保留首轮注入项目根章程，但**子目录级**的约定改为：Read/Edit 工具触达该目录时，
向上查找尚未注入的指令文件并随**工具输出**注入。

**收益**：直接压制 `claudeMd` 类膨胀（khy 的 26,378 字符里有相当部分是子目录级约定）；
与 C4「条目有界」形成互补。

**风险**：语义从「一开始就知道」变成「走到才知道」。对强模型可行，**对低档模型建议保持全量**。

### R8　模型差异文件化　【中】

**对齐**：Codex CLI（`prompt.md` + `gpt_5_codex_prompt.md` + `gpt_5_1_prompt.md` …）。

**改什么**：把 `getSystemPrompt` 里的 `isLowTierModel` / `hasNativeToolUse` / `compactPrompt`
分支，外显为「基座提示词文件 + 模型族变体文件」，选择逻辑按模型族集中一处
（对齐 opencode 的 `SystemPrompt.provider(model)`）。

**收益**：模型差异变得可 diff、可评审、可单独回滚；装配器瘦身。

### R9　输出与格式约束数值化　【低·成本极低】

**对齐**：Claude Code 的 `≤25 words` / `≤100 words`（内部实测 -1.2% 输出 token）。

**改什么**：`getUnifiedOutputAndToneSection` 现在只有 "Your responses should be short and concise."，
补上可度量的上限；同时把 098 §6.4 的去重结果做成**首尾呼应**（Gemini 的 book-ending）：
L0 开头放总则、L0 结尾重述红线——**两处都在静态区，不破坏前缀**，取代现在散在 13 处的重复。

---

## 6. 对 [DESIGN-ARCH-098] 的修正

调研后需修正 098 的一处取舍（其余结论得到强化）：

| 098 原方案 | 修正后 | 依据 |
|-----------|-------|------|
| §3 把项目章程（`claudeMd` 稳定部分）搬进 **L1 前缀** | 改为 **R1：走 messages 增量注入**，L1 前缀只保留真正会话级且不参数化的项（语言/风格/模型档位/工具档位） | 分歧 D1：khy 走 relay 路径、无全局共享缓存，前缀方案与 messages 方案命中率等价，但 messages 方案下**前缀永不因项目文件改动而作废** |
| §3 把 `using_your_tools` 等派生内容留在 L1 前缀 | 保持 L1，但**必须无参数化**（`enabledTools` 变化即视为用户显式切换，允许一次性失效） | D2：CC 的严格版判据 |
| §7 改动 9「先只加新鲜度戳，切分单独立项」 | **维持**（这是全案最高风险项），并补 R2 硬上限 + R7 按需注入作为切分的替代路径 | |

**被调研强化的结论**（无需修改）：

- 098 的**锚点方案**（`<!-- khy:lN -->`）与 Codex v0.123 的 `START_MARKER/END_MARKER` 同构，
  且 Codex 多给了一条收益：**压缩期可选择性驱逐单个片段**。
- 098 的 **L4 意图块**与 Codex 的 `ModelSwitchInstructions` / `CollaborationModeInstructions`
  属同类（把「本轮模式」显式化为可寻址片段）。
- 098 的 **L0/L1 切分**与 Gemini CLI 社区独立提出的「固件层 vs 项目层」结论一致。
- 098 的**每轮重算预算 ≤8k** 目标偏保守：若采纳 R1，可收紧到 **≤300 字符**（只剩意图块）。

---

## 7. 落地顺序

```text
第一批（零/低风险，立刻可做，不改产物语义）
  R2 硬上限（先 WARN） + R3 缓存失效监控 + R5 前缀稳定性测试 + R6 dump 开关
  验收：四个观测面就位，后续每一项改动都可被量化

第二批（需要一次行为回归）
  R1 每轮状态改 messages 增量注入  ← 收益最大、风险最高，单独门控
  R1 通过后，098 的 P2（boundary 后移）可大幅简化

第三批（结构调整）
  R4 工具纪律下沉 + R9 数值化与首尾呼应 + R8 模型差异文件化

第四批（长线，独立立项）
  R7 指令文件按需注入（含 claudeMd 切分）  ← 全案最高风险，见 098 §10
```

**顺序理由**：先建立**度量**（R2/R3/R5/R6），再动**结构**。CC 敢把 agent 列表搬出 system，
前提是它有 `promptCacheBreakDetection.ts` 能立刻看到影响；khy 缺的正是这个前提。

---

## 8. 不适用的照搬（明确划界）

| 同行做法 | 为什么 khy 不宜直接照搬 |
|---------|----------------------|
| CC 的「全局共享前缀缓存」语义 | khy 走自建 relay 路径，`cache_control` 边界标记在 `_messageBuilder` 被剥掉，命中率靠 provider 最长前缀匹配——**没有跨用户共享缓存**这回事。照搬 boundary 的「全局共享」语义会得出错误结论 |
| CC 的 `shouldUseGlobalCacheScope()` 条件插标记 | khy 的路径矩阵更复杂（原生 / relay / 本地文本协议 / codex 适配器），标记语义需按路径分别定义，不能单开关 |
| dsh 的「一切皆插件」 | dsh 是 Agent Runtime 定位，插件化是它的产品命题。khy 的提示词装配不需要引入插件运行时——治理复杂度远超收益 |
| dsh 的 PTC（程序化工具调用） | 需要 `Code Mode SDK` 与沙箱执行环境，是**机制**级改造而非提示词改造。但值得单独立项评估：它比散文规则（「尽量并行调用工具」）更能真正省 token |
| opencode 的「不做冲突消解，全部保留」 | khy 的指令注入链已有优先级（`KHY > CLAUDE > AGENTS`），且实测 `claudeMd` 已到 26k 字符。再叠加无上限合并会加速膨胀 |
| Codex 的 `≤10k tokens` 绝对值 | 数值本身依赖其工具面与模型；khy 应先用 **WARN + 分布统计**建立自己的基线，再定阈值 |

---

## 9. 参考来源

| 来源 | 用于 |
|------|------|
| `openai/codex`（Apache-2.0）：`codex-rs/core/context/mod.rs`、`codex-rs/core/src/codex.rs`、`codex-rs/core/src/user_instructions.rs`、`codex-rs/core/src/project_doc.rs`、`codex-rs/core/src/environment_context.rs`、`codex-rs/core/tests/suite/prompt_caching.rs`、`codex-rs/core/prompt.md` 及 `gpt_5_*_prompt.md` | §2.3、§3、R1/R2/R5/R8 |
| `sst/opencode`：`packages/opencode/src/session/system.ts`、`session/prompt/*.txt`、`session/instruction.ts`、`tool/tool.ts`、`agent/agent.ts` | §2.2、R7、D3 |
| `google-gemini/gemini-cli`：`packages/core/src/core/prompts.ts`、`packages/core/src/prompts/promptProvider.ts`、`packages/core/src/prompts/snippets.ts`、`packages/core/src/tools/shell.md` | §2.4、R4/R6/R9、D3 |
| `deepseek-ai/deepseek-harness`（MIT，v0.1 预览）：`core/system-prompt`、`core/session`（`deriveMessages`）、`core/agent-loop`；官方文档站与 Cordis 论文 | §2.5、共识 C6、§8 |
| Claude Code 源码级第三方分析（v2.1.88，**B 级证据**）：`perfecxion.ai` 装配管线分析、`claudecodecamp.com` 请求结构实测、`claude-wiki.com` 装配条目、dev.to 源码拆解、腾讯云缓存实测 | §2.1、R3、R9、D2 |
| khy-os 自身：`[DESIGN-ARCH-098]`、`[DESIGN-PROMPT-002]`、`services/backend/src/constants/promptSectionTaxonomy.js`、`prompts.js`、`promptCacheOrder.js`、`tools/index.js::assembleToolPool()` | §4 差距对照、§6 修正 |

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-15 | 首版：横评 CC / opencode / Codex / Gemini / dsh 五家，归纳六共识三分歧，给出 R1–R9 对齐清单与对 098 的修正 |

---

*本文是调研与方案；实施后应同步更新 [`[DESIGN-ARCH-098]`]([DESIGN-ARCH-098] 系统提示词结构重设计-静态动态分层与缓存优化方案.md) 与分层规范真源。*
