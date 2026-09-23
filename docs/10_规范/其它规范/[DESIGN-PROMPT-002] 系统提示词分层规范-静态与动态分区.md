<!-- 文档分类: DESIGN-PROMPT-002 | 阶段: 规范 | 真源: services/backend/src/constants/promptSectionTaxonomy.js | 守卫: scripts/ci/check-prompt-taxonomy.js -->
# [DESIGN-PROMPT-002] 系统提示词分层规范：静态与动态分区

> **用途**：给 khy-os 主系统提示词的**每一段**规定唯一的层级归属、唯一的落点、以及唯一的 cacheKey 纪律。
> **性质**：规范性（normative）。本文件解释规范；规范的**可执行真源**是
> `services/backend/src/constants/promptSectionTaxonomy.js`，由
> `scripts/ci/check-prompt-taxonomy.js`（`npm run check:prompt-taxonomy`）强制。
> **关系**：本文补的是 [DESIGN-PROMPT-001] Prompt Engineering 规范缺的那条轴——**分区轴**。
> [DESIGN-OTHER-003] 是结构导览图，不承担规范职责（其静态/动态清单已与实现脱节，见 §11）。

---

## 1. 要解决的问题

系统提示词同时被三套机制消费，三套机制对「这段会不会变」的假设必须一致：

| 机制 | 位置 | 对分区的诉求 |
|------|------|------------|
| provider 前缀缓存 | 网关/中转路径 | 稳定字节必须**连续地**排在最前；任何一个易变字节出现，其后全部失效 |
| 段缓存 | `constants/systemPromptSections.js` | 声明为「稳定」的段必须给出**正确的** cacheKey，否则会冻结首轮内容 |
| 静态记忆 | `prompts.js::_memoStaticSection` | 只有**可证纯**的构造结果才能被进程级复用 |

现状的问题是：分区信息**隐式**散落在五处，彼此必须靠人工同步，没有任何守卫。

```
① 返回数组里的位置          prompts.js::getSystemPrompt()
② cached / DANGEROUS_uncached  systemPromptSection() 的签名
③ 易变段清单                promptCacheOrder.js::VOLATILE_SECTION_IDS
④ 按需胶囊清单              prompts.js::ON_DEMAND_PROMPT_SECTION_IDS
⑤ 静态记忆白名单            prompts.js::_memoStaticSection 的调用点
```

代价不是「不好看」，而是**可观测的功能缺陷**。已确认的四条见 §8；其中 `git_status` 因为
分类说它「一变即变」而实现只给了 `cwd` 做键，导致它在**整段会话里停在第一轮**。

### 1.1 目标函数

> 让「最稳定的字节」连续地占据前缀，让「会变的字节」只出现在尾部，
> 并且让**每一条**「这段会不会变」的判断都能被机器复核。

---

## 2. 四层定义

| 层 | rank | 判据 | 落点 | cacheKey 要求 |
|----|------|------|------|--------------|
| `static` 静态（编译期常量） | 0 | 产物**只由源码字面量**决定：无 env 读、无 `Date`、无入参 | `boundary` **之前** | 不适用（不进段缓存） |
| `dynamic_stable` 动态·稳定 | 1 | 依赖会话内**少变**的状态（cwd / 模型 / 语言 / 记忆戳 / 配置戳） | `boundary` 之后 | 必须折入它读到的**每一个**运行时输入 |
| `dynamic_volatile` 动态·易变 | 2 | 每轮或每分钟可能自然变化（时钟 / 任务板 / MCP 连接态 / git 工作树 / 目录树） | `boundary` 之后的**尾部** | 必须是实时输入或新鲜度戳 |
| `on_demand` 按需胶囊 | 3 | 按**用户每一轮的意图**在不同内容集合间选择 | 最终数组的**绝对尾部** | 不适用（选集本身即变量） |

`static` 与后三者的分界就是 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`。原生
`cache_control` 路径在该标记处断开缓存；中转（relay）/ DeepSeek 路径上标记会被剥离，
命中率完全依赖 provider「匹配到第一个变了的字节为止」的最长前缀匹配——**这就是尾部纪律
存在的原因**（见 [DESIGN-ARCH-047]）。

### 2.1 分层总览图

<img src="../assets/prompt-taxonomy-layers.svg" alt="系统提示词四层分区与落点顺序：静态段位于缓存边界之前，边界之后依次是稳定动态组、动态组之后的尾巴、以及死尾处的易变组与按需胶囊" width="680">

*图源：`docs/10_规范/assets/prompt-taxonomy-layers.svg`。左侧箭头表示稳定性自上而下递减——
越靠上越「长命」，越靠下越「善变」。*

读图要点：

- **边界是一条实打实的分界线**，不是注释：`static` 全部在它之前，其余三层全部在它之后。
- 边界之后并非「随便放」，而是**再分三档**：稳定动态组 → 尾巴 → 死尾（易变 + 按需）。
  这个内部顺序由 `promptCacheOrder.partitionDynamicSections()` 保证，由守卫的
  `PTX-070/071` 断言。
- 越靠下的内容越「不值得为它牺牲前缀」：把它们集中压在末尾，上游静态字节才能长期命中。

---

## 3. 判据：新段该放哪一层

五问，自上而下，**首个命中即停**：

1. 产物是否只由源码字面量决定（无 env 读、无 `Date`、无入参）？
   → **`static`**，放 `boundary` 之前。
   注意：只读 env 的**门控**不算运行时输入（见 §7）。
2. 它是否会**不依赖用户新输入**而在会话内自行变化（时钟、任务板、连接态、工作树）？
   → **`dynamic_volatile`**，放尾部。
3. 它是否按用户每轮的意图在**不同内容集合**间选择？
   → **`on_demand`**，放绝对尾部。
4. 以上都不是？
   → **`dynamic_stable`**，放动态组。
5. 拿不准「它到底依赖什么」？
   → 先按 `dynamic_stable` 落位，**并把真实输入折进 cacheKey**——宁可多失效，不可冻结。

---

## 4. 落点图（`getSystemPrompt` 返回数组）

```text
┌─ slot: prefix ── boundary 之前（静态地基，必须连续）────────────────────────┐
│  simple_intro → simple_system → [behavioral] → session_memory_and_context  │
│  → using_your_tools → deferred_tools_hint → output_and_tone → efficiency   │
│  其中 [behavioral] = doing_tasks / execution_discipline /                    │
│                    planning_and_recovery /（compact 时改为 compact_task_…）  │
│                    /（relocation 关闭时按需胶囊留在此处）                      │
├─ __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ ───────────────────────────────────────┤
│  ① 稳定动态组（promptCacheOrder.partitionDynamicSections 的 stable 部分）     │
│      memory → language → output_style → project_instructions → references  │
│      → persona → role → companion → skill_catalog → khy_specific           │
│      → model_guidance → unknown_problem_handler → bootstrap_context        │
│  ② slot: trailing                                                          │
│      content_output_guide → base_security                                  │
├─ slot: tail（dead-last，易变 + 按需）───────────────────────────────────────┤
│  ③ 易变组（partitionDynamicSections 的 volatile 部分）                      │
│      task_memory → env_info → mcp_instructions → git_status                │
│      → project_structure                                                   │
│  ④ 按需胶囊（KHY_ONDEMAND_OUT_OF_PREFIX 开启时移到这里；关闭则留在 ① 之前）    │
└────────────────────────────────────────────────────────────────────────────┘
```

**顺序不变量**（由守卫核验，`PTX-070/071`）：

```
boundary 标记  <  ...resolvedStable  <  ...resolvedVolatile
```

---

## 5. 全量分层表

32 段 + 17 个按需胶囊。**顺序即装配顺序**（同槽位内）。

<!-- 下表由 services/backend/src/constants/promptSectionTaxonomy.js::SECTIONS 渲染；修改请改真源 -->

| #  | id                           | 层     | 落点             | 装载      | 构造函数                                | cacheKey 来源           | 门控                               |
|----|------------------------------|-------|----------------|---------|-------------------------------------|-----------------------|----------------------------------|
| 1  | `simple_intro`               | 静态    | 前缀(boundary 前) | inline  | `getSimpleIntroSection`             | `outputStyle`         | —                                |
| 2  | `simple_system`              | 静态    | 前缀(boundary 前) | inline  | `getSimpleSystemSection`            | `const`               | `KHY_PROMPT_SECTION_STATIC_MEMO` |
| 3  | `doing_tasks`                | 静态    | 前缀(boundary 前) | inline  | `getDoingTasksSection`              | `outputStyle`         | `KHY_PROMPT_SECTION_STATIC_MEMO` |
| 4  | `execution_discipline`       | 静态    | 前缀(boundary 前) | inline  | `getExecutionDisciplineSection`     | `const`               | `KHY_PROMPT_SECTION_STATIC_MEMO` |
| 5  | `planning_and_recovery`      | 静态    | 前缀(boundary 前) | inline  | `getPlanningAndRecoverySection`     | `const`               | `KHY_PROMPT_SECTION_STATIC_MEMO` |
| 6  | `compact_task_discipline`    | 静态    | 前缀(boundary 前) | inline  | `getCompactTaskDisciplineSection`   | `const`               | `KHY_PLANNING_DISCIPLINE`        |
| 7  | `session_memory_and_context` | 静态    | 前缀(boundary 前) | inline  | `getSessionMemoryAndContextSection` | `const`               | `KHY_PROMPT_SECTION_STATIC_MEMO` |
| 8  | `using_your_tools`           | 静态    | 前缀(boundary 前) | inline  | `getUsingYourToolsSection`          | `enabledTools`        | `KHY_PROMPT_TOOLS_SECTION_MEMO`  |
| 9  | `deferred_tools_hint`        | 静态    | 前缀(boundary 前) | inline  | —                                   | `request`             | —                                |
| 10 | `unified_output_and_tone`    | 静态    | 前缀(boundary 前) | inline  | `getUnifiedOutputAndToneSection`    | `const`               | `KHY_FABLE_VOICE`                |
| 11 | `tone_and_style`             | 静态    | 前缀(boundary 前) | inline  | `getToneAndStyleSection`            | `const`               | `KHY_FABLE_VOICE`                |
| 12 | `output_efficiency`          | 静态    | 前缀(boundary 前) | inline  | `getOutputEfficiencySection`        | `const`               | `KHY_PROMPT_SECTION_STATIC_MEMO` |
| 13 | `memory`                     | 动态·稳定 | 动态组            | section | `getMemorySection`                  | `memoryStamp`         | `KHY_PROJECT_MEMORY_RECALL`      |
| 14 | `task_memory`                | 动态·易变 | 尾部             | section | `getTaskMemorySection`              | `uncached`            | `KHY_TASK_MEMORY_RECALL`         |
| 15 | `env_info`                   | 动态·易变 | 尾部             | section | `getEnvironmentSection`             | `clockBucket`         | `KHY_SYSTEM_CLOCK`               |
| 16 | `language`                   | 动态·稳定 | 动态组            | section | `getLanguageSection`                | `languagePreference`  | —                                |
| 17 | `output_style`               | 动态·稳定 | 动态组            | section | `getOutputStyleSection`             | `outputStyle`         | —                                |
| 18 | `mcp_instructions`           | 动态·易变 | 尾部             | section | `getMcpInstructionsSection`         | `uncached`            | —                                |
| 19 | `project_instructions`       | 动态·稳定 | 动态组            | section | `getProjectInstructionsSection`     | `cwd`                 | —                                |
| 20 | `references`                 | 动态·稳定 | 动态组            | section | —                                   | `referencesStamp`     | `KHY_REFERENCES`                 |
| 21 | `persona`                    | 动态·稳定 | 动态组            | section | `getPersonaSection`                 | `personaStamp`        | —                                |
| 22 | `role`                       | 动态·稳定 | 动态组            | section | `getRoleSection`                    | `roleStamp`           | —                                |
| 23 | `companion`                  | 动态·稳定 | 动态组            | section | `getCompanionSection`               | `companionStamp`      | —                                |
| 24 | `git_status`                 | 动态·易变 | 尾部             | section | `getGitStatusSection`               | `cwd`                 | `KHY_PROMPT_GIT_STATUS_MIN`      |
| 25 | `project_structure`          | 动态·易变 | 尾部             | section | `getProjectStructureSection`        | `projectTreeStamp`    | `KHY_PROJECT_TREE`               |
| 26 | `skill_catalog`              | 动态·稳定 | 动态组            | section | `getSkillCatalogSection`            | `contextWindowTokens` | `KHY_PROMPT_SKILLS_MIN`          |
| 27 | `khy_specific`               | 动态·稳定 | 动态组            | section | `getKhySpecificSection`             | `model`               | —                                |
| 28 | `model_guidance`             | 动态·稳定 | 动态组            | section | —                                   | `modelAndLanguage`    | —                                |
| 29 | `unknown_problem_handler`    | 动态·稳定 | 动态组            | section | —                                   | `flag`                | `KHY_UNKNOWN_PROBLEM_HANDLER`    |
| 30 | `bootstrap_context`          | 动态·稳定 | 动态组            | section | `getBootstrapContextSection`        | `bootstrapFiles`      | —                                |
| 31 | `content_output_guide`       | 动态·稳定 | 动态组之后          | inline  | `getContentOutputGuideSection`      | `const`               | —                                |
| 32 | `base_security`              | 动态·稳定 | 动态组之后          | inline  | —                                   | `request`             | —                                |

**分层快照**：`static=12`、`dynamic_stable=15`、`dynamic_volatile=5`、`on_demand=17`。

### 5.1 按需胶囊（`on_demand`，17 个）

顺序即装配顺序；选集由 `_classifyPromptIntentSignals()` 按用户意图逐轮决定
（延续轮/短请求/无用户消息会回退为「全部激活」）。

```
scope_minimization            planning_verification         task_progress_management
error_handling_fallback       multi_agent_collaboration     file_operations
command_execution             search_exploration            codebase_analysis
tool_discovery                response_formatting           feature_access_proxy_boundary
git_operations                action_safety                 security_permission_boundaries
sensitive_data                small_model_structured_flow
```

---

## 6. cacheKey 纪律

段缓存（`systemPromptSections.js`）**按 id 存一条记录**，键不变即永不重算。因此：

| # | 规则 |
|---|------|
| C1 | 声明为 `dynamic_*` 的段必须给出 cacheKey；只给 id（省略 cacheKey）仅对「产物永不依赖请求」的段安全。 |
| C2 | cacheKey 必须折入该段**读到的每一个运行时输入**——包括间接读到的（配置文件、目录 mtime、连接态）。 |
| C3 | 键的来源分三类，用途不同，不可混用（见下表）。 |
| C4 | 会话内恒定、但内容依赖磁盘文件的段，**必须**折入新鲜度戳；否则内容变更不会生效。 |

| cacheKey 来源类别 | 取值 | 语义 | 例子 |
|------------------|------|------|------|
| 实时输入 | `uncached` / `clockBucket` | 每轮或每分钟**必然**变 | `task_memory`、`mcp_instructions`、`env_info` |
| 新鲜度戳 | `memoryStamp` / `projectTreeStamp` / `referencesStamp` | **内容变了才**变，用于正确失效 | `memory`、`project_structure`、`references` |
| 会话常量 | `cwd` / `model` / `languagePreference` / `contextWindowTokens` / `flag` | 会话内不变 | `language`、`model_guidance` |

> **反面样例（现况）**：`git_status` 归 `dynamic_volatile`（「工作树一变即变」），键却只有
> `cwd`——落在「会话常量」列，于是内容永不过期。修法是给它一个新鲜度戳（status 摘要哈希）。

---

## 7. 门控 ≠ 运行时依赖

守卫把两者严格分开，新增段时不要混淆：

- **`gate`（门控）**：只读 env 的**部署期**开关（如 `KHY_FABLE_VOICE`、`KHY_PROJECT_TREE`）。
  部署后不在会话内翻转，因此**不**视为前缀破坏源。落盘在规范 `SECTIONS[].gate`。
- **`dependsOn`（运行时依赖）**：会随请求/会话变化的值（`enabledTools`、`outputStyleConfig`、
  router 的 deferred 状态）。落盘在 `SECTIONS[].dependsOn`；`static` 层的此项**必须为空**。

---

## 8. 已知分层缺陷（规范承认，尚未修复）

登记在 `promptSectionTaxonomy.js::CONCERNS`。守卫对每条做「**缺陷仍然存在**」的断言——
修好之后**必须**同步删条目，否则守卫变红。这是防止清单腐化成过期文档的机制。

| id | 严重度 | 涉及段 | 问题 |
|----|-------|-------|------|
| `staleKey` | **高** | `git_status`、`project_instructions`、`skill_catalog` | 易变段被纯会话键缓存 → 会话内冻结。`git_status` 最严重：分类说它一变即变，实现却停在首轮。 |
| `volatileInPrefix` | **高** | `deferred_tools_hint`、`using_your_tools`、`simple_intro`、`doing_tasks` | 每轮可变的内容处在静态前缀内 → 一次 deferred 揭示 / 档位切换 / 样式切换就把静态前缀从该点起全部作废。 |
| `parametrizedStatic` | 中 | `simple_intro`、`doing_tasks` | 静态段被参数化（产物随 output style 变化）。 |
| `misfiledTaskScale` | 中 | `khy_specific` | `taskScale` 逐轮由用户消息评分得出，却被折进这一大段的键 → 措辞一变就整段重算。 |

**修法要点**：

- `staleKey`：折入真实输入——git 用 `git status --short` 的摘要哈希，`project_instructions`
  用指令文件集合的 `mtime:size`，`skill_catalog` 用技能集指纹。
- `volatileInPrefix`：把 per-turn 输入移出 `boundary` 之前，或纳入 volatile 组交给
  `promptCacheOrder` 重排。
- `parametrizedStatic`：把 output-style 相关句子拆成独立段放进动态区。
- `misfiledTaskScale`：拆分 `khy_specific` 的 task-decomposition 子块，或把 `taskScale` 从键里移出。

---

## 9. 扩展流程：新增一段的 SOP

1. 在 `promptSectionTaxonomy.js::SECTIONS` 登记：`id` / `tier` / `slot` / `mechanism` /
   `builder` / `cacheKeySource` / `dependsOn` / `gate` / `note`。
2. 若引入新构造函数，同步登记 `BUILDER_TIERS`（否则守卫 `PTX-060` 变红）。
3. 按 §3 的判据确认层级，按 §4 的落点放代码。
4. 若它命中 §8 的任何一类问题，在 `CONCERNS` 里补进对应条目（否则守卫 WARN 变吵）。
5. 运行 `npm run check:prompt-taxonomy`，必须 exit 0。
6. 同步本文 §5 的表（表头注释已标明真源）。

**最容易犯的两个错**：

- 把「需要每轮重选的内容」直接塞进 `boundary` 之前——它看起来是「提示词的主体部分」，
  但它是**每轮变量**。落在前缀里等于给自己挖缓存坑。
- 声明了段、给了 cacheKey，但 cacheKey 只含调用者顺手拿到的那个参数，而不是该段**真正读到**的输入。

---

## 10. 守卫与文件

| 文件 | 角色 |
|------|------|
| `services/backend/src/constants/promptSectionTaxonomy.js` | 规范真源（纯数据叶子，零 require，不参与运行时装配） |
| `services/backend/src/constants/prompts.js` | 实现（`getSystemPrompt` 装配器） |
| `services/backend/src/constants/promptCacheOrder.js` | 易变段清单 + 重排实现（①②③④ 的收敛点） |
| `services/backend/src/constants/systemPromptSections.js` | 段缓存与 cacheKey 机制 |
| `scripts/ci/check-prompt-taxonomy.js` | 守卫：`npm run check:prompt-taxonomy`，已接入 `npm run check:structure` |

### 10.1 守卫校验的九类断言

| 级别 | 规则 | 内容 |
|------|------|------|
| ERROR | `PTX-001`…`PTX-011` | 规范内部自洽：id 唯一、tier/slot/mechanism 合法、builder 归类一致、slot 与 tier 相容、CONCERNS 引用的 id 存在 |
| ERROR | `PTX-030/031` | 动态段集合与顺序 = 规范（比对 `systemPromptSection` 声明） |
| ERROR | `PTX-040/041` | `VOLATILE_SECTION_IDS` = 规范 `dynamic_volatile`（集合 + 顺序） |
| ERROR | `PTX-050`…`PTX-052` | 按需胶囊清单 = 规范（以运行时导出为准，失败降级为正则 + WARN） |
| ERROR | `PTX-060/061` | `getSystemPrompt` 里不得出现未声明分层的构造函数；规范不得登记幽灵 builder |
| ERROR | `PTX-070/071` | `boundary` → `...resolvedStable` → `...resolvedVolatile` 的落点单调性 |
| ERROR | `PTX-090`…`PTX-094` | CONCERNS 各条目**仍然存在**（修好即须删条目） |
| WARN | `PTX-080` | 静态段带非空 `dependsOn`（**仅报未登记的新增项**） |
| WARN | `PTX-081/082` | 易变段的键不含易变输入 / 实时键落在稳定槽（同上，仅报新增） |

> WARN 只针对「**尚未登记**在 CONCERNS 里的新漂移」。因此一次干净的 CI 运行应当
> **既无 ERROR 也无 WARN**——一旦出现 WARN，就意味着有人引入了新的分层欠账。

---

## 11. 与 [DESIGN-OTHER-003] 的分工

| 文件 | 职责 | 分区信息 |
|------|------|---------|
| `[DESIGN-OTHER-003] khy-系统提示词结构图.md` | prompt **栈**导览（runtime 选路 / 指令注入链 / compact / agent / tool 各层） | 不承担规范职责 |
| **本文** | 主 system prompt 的**分区规范** | 规范性，由守卫强制 |

`[DESIGN-OTHER-003]` 的「静态区顺序」清单把按需胶囊与 `git_status` 之后的段写得与实现不符
（它反映的是一个更早的版本），读它时请以本文 §4/§5 为准。

---

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-15 | 首版：确立四层分区、五问判据、cacheKey 纪律、四类已知缺陷与守卫接线 |

---

*本规范由 khy-os 平台团队维护；可执行真源在 `promptSectionTaxonomy.js`，本文件是其说明。*
