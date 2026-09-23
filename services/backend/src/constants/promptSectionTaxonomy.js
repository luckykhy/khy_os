'use strict';

/**
 * promptSectionTaxonomy.js — 系统提示词「静态 / 动态」分层的**唯一声明真源**（纯数据叶子）。
 *
 * 背景：分区信息目前**隐式**分散在五处，彼此必须手工同步，且没有任何守卫：
 *   1. `prompts.js::getSystemPrompt()` 返回数组里的位置（boundary 之前 / 之后 / 绝对尾部）；
 *   2. `systemPromptSection(id, compute, cacheKey)` 与 `DANGEROUS_uncachedSystemPromptSection(...)`
 *      的 cached 标志；
 *   3. `promptCacheOrder.js::VOLATILE_SECTION_IDS`（易变段清单，硬编码在另一个文件）；
 *   4. `prompts.js::ON_DEMAND_PROMPT_SECTION_IDS`（按需胶囊清单，第三份清单）；
 *   5. `prompts.js::_memoStaticSection`（进程级记忆，第四种「静态」机制）。
 * 后果：跨文件漂移无人拦截——例如 git_status 被声明为「一变即变」的易变段，cacheKey 却只有 cwd，
 * 段缓存在会话内永不失效（详见 CONCERNS.staleKey）。
 *
 * 本模块把分层从「散落的隐式约定」变成「一处声明 + 守卫核验」：
 *   - 本文件 = 规范（normative）；`prompts.js` = 实现（runtime）。
 *   - `scripts/ci/check-prompt-taxonomy.js` 做静态 + 运行时交叉核验，漂移即 CI 变红并点名 section。
 *
 * 契约：零 I/O、零 require、确定性、冻结常量（绝不抛、无副作用）。只被守卫与文档消费，
 * **不参与运行时装配**，因此引入本文件对 prompt 产物零字节影响。
 *
 * @module constants/promptSectionTaxonomy
 */

/**
 * 层级定义（rank 越小越稳定，守卫据此做单调性断言）。
 *
 *  static           编译期常量。位于 boundary 之前，是前缀缓存的地基；不得读取任何输入。
 *  dynamic_stable   会话级动态。位于 boundary 之后；cacheKey 必须折入它读到的每一个真实输入。
 *  dynamic_volatile 每轮/每分钟可变。位于 boundary 之后，且必须重排到动态区尾部（dead-last）。
 *  on_demand        按用户意图每轮重选的能力胶囊。默认置于最终数组的绝对尾部。
 */
const TIERS = Object.freeze({
  STATIC: Object.freeze({ id: 'static', rank: 0, label: '静态（编译期常量）' }),
  DYNAMIC_STABLE: Object.freeze({ id: 'dynamic_stable', rank: 1, label: '动态-稳定（会话级）' }),
  DYNAMIC_VOLATILE: Object.freeze({ id: 'dynamic_volatile', rank: 2, label: '动态-易变（每轮/每分钟）' }),
  ON_DEMAND: Object.freeze({ id: 'on_demand', rank: 3, label: '按需胶囊（意图选片）' }),
});

/** 位置槽：段在最终数组里的落点（与 tier 正交，因为尾部同时容纳易变段与按需胶囊）。 */
const SLOTS = Object.freeze({
  PREFIX: 'prefix', // boundary 之前
  DYNAMIC: 'dynamic', // boundary 之后、尾部之前
  TRAILING: 'trailing', // 动态组之后、易变组之前（model/security 尾巴）
  TAIL: 'tail', // 绝对尾部：volatile 组 → on-demand 胶囊
});

/** 装载机制：段以何种方式进入数组。守卫据此决定用哪种核对方式。 */
const MECHANISMS = Object.freeze({
  SECTION: 'section', // systemPromptSection / DANGEROUS_uncachedSystemPromptSection 声明
  INLINE: 'inline', // 在返回数组里直接求值/直传
});

/** cacheKey 来源词表（封闭集合，避免自由文本导致守卫无法判定）。 */
const CACHE_KEY_SOURCES = Object.freeze({
  CONST: 'const',
  UNCACHED: 'uncached',
  OUTPUT_STYLE: 'outputStyle',
  ENABLED_TOOLS: 'enabledTools',
  REQUEST: 'request',
  MEMORY_STAMP: 'memoryStamp',
  CLOCK_BUCKET: 'clockBucket',
  LANGUAGE: 'languagePreference',
  CWD: 'cwd',
  REFERENCES_STAMP: 'referencesStamp',
  PERSONA_STAMP: 'personaStamp',
  ROLE_STAMP: 'roleStamp',
  COMPANION_STAMP: 'companionStamp',
  PROJECT_TREE_STAMP: 'projectTreeStamp',
  // ── P1 新増的三类新鲜度戳(修 CONCERNS.staleKey,见 constants/promptFreshness.js)──
  GIT_STAMP: 'gitStamp', // .git/index + HEAD 的 mtime + 时间桶
  INSTRUCTION_STAMP: 'instructionStamp', // 指令文件的 mtime:size
  SKILL_FINGERPRINT: 'skillFingerprint', // 技能集指纹(装/卸/改描述即变)
  CONTEXT_WINDOW: 'contextWindowTokens',
  MODEL: 'model',
  MODEL_AND_LANGUAGE: 'modelAndLanguage',
  FLAG: 'flag',
  BOOTSTRAP_PATHS: 'bootstrapFiles',
});

/**
 * 含「随时间变化」输入的 cacheKey 来源 —— 守卫 W1 的接受集。
 * 分两类：实时输入（每轮/每分钟必然变）与新鲜度戳（只有内容变才变，用于正确 bust 缓存）。
 */
const REALTIME_CACHE_KEY_SOURCES = Object.freeze([
  CACHE_KEY_SOURCES.UNCACHED,
  CACHE_KEY_SOURCES.CLOCK_BUCKET,
]);

const FRESHNESS_STAMP_CACHE_KEY_SOURCES = Object.freeze([
  CACHE_KEY_SOURCES.MEMORY_STAMP,
  CACHE_KEY_SOURCES.PROJECT_TREE_STAMP,
  CACHE_KEY_SOURCES.REFERENCES_STAMP,
  CACHE_KEY_SOURCES.GIT_STAMP,
  CACHE_KEY_SOURCES.INSTRUCTION_STAMP,
  CACHE_KEY_SOURCES.SKILL_FINGERPRINT,
]);

const TIME_VARYING_CACHE_KEY_SOURCES = Object.freeze([
  ...REALTIME_CACHE_KEY_SOURCES,
  ...FRESHNESS_STAMP_CACHE_KEY_SOURCES,
  CACHE_KEY_SOURCES.REQUEST,
]);

/**
 * 全部 section 的规范声明，**数组顺序即装配顺序**（同槽位内）。
 *
 *  @param {string}   id             段 id，与 prompts.js 中逐字一致
 *  @param {string}   tier           TIERS.*.id
 *  @param {string}   slot           SLOTS.*
 *  @param {string}   mechanism      MECHANISMS.*
 *  @param {string?}  builder        prompts.js 里的构造函数名；null = 由调用方注入或直接求值
 *  @param {string}   cacheKeySource CACHE_KEY_SOURCES.*
 *  @param {string[]} dependsOn      产物实际依赖的**运行时输入**（W2 用：静态区必须为空）。
 *                                   注意与 gate 的区别：gate 是部署期门控（只读 env，不在会话内切换），
 *                                   不视为前缀破坏源；dependsOn 是会随请求/会话变化的值。
 *  @param {string?}  gate           门控环境变量（部署期常量，非运行时输入）
 *  @param {string?}  note           为何如此分层的理由（尤其「看起来静态其实动态」的陷阱）
 */
const SECTIONS = Object.freeze([
  // ═══ 静态区（prefix）═══
  {
    id: 'simple_intro', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getSimpleIntroSection', cacheKeySource: CACHE_KEY_SOURCES.OUTPUT_STYLE,
    dependsOn: ['outputStyleConfig'],
    note: '陷阱：注释标为「Static content」且在 boundary 之前，产物却随 outputStyleConfig 变化——切换样式即击穿静态前缀。',
  },
  {
    id: 'simple_system', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getSimpleSystemSection', cacheKeySource: CACHE_KEY_SOURCES.CONST, dependsOn: [],
    gate: 'KHY_PROMPT_SECTION_STATIC_MEMO',
  },
  {
    id: 'doing_tasks', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getDoingTasksSection', cacheKeySource: CACHE_KEY_SOURCES.OUTPUT_STYLE,
    dependsOn: ['outputStyleConfig.keepCodingInstructions'], gate: 'KHY_PROMPT_SECTION_STATIC_MEMO',
    note: '内容为常量；是否出现由 output style 的 keepCodingInstructions 决定（布尔位，不引入内容漂移）。',
  },
  {
    id: 'execution_discipline', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getExecutionDisciplineSection', cacheKeySource: CACHE_KEY_SOURCES.CONST, dependsOn: [],
    gate: 'KHY_PROMPT_SECTION_STATIC_MEMO',
  },
  {
    id: 'planning_and_recovery', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getPlanningAndRecoverySection', cacheKeySource: CACHE_KEY_SOURCES.CONST, dependsOn: [],
    gate: 'KHY_PROMPT_SECTION_STATIC_MEMO',
  },
  {
    id: 'compact_task_discipline', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getCompactTaskDisciplineSection', cacheKeySource: CACHE_KEY_SOURCES.CONST, dependsOn: [],
    gate: 'KHY_PLANNING_DISCIPLINE',
    note: 'compactPrompt 分支的替代品：与 doing_tasks / execution_discipline / planning_and_recovery 互斥出现。',
  },
  {
    id: 'session_memory_and_context', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getSessionMemoryAndContextSection', cacheKeySource: CACHE_KEY_SOURCES.CONST, dependsOn: [],
    gate: 'KHY_PROMPT_SECTION_STATIC_MEMO',
  },
  {
    id: 'using_your_tools', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getUsingYourToolsSection', cacheKeySource: CACHE_KEY_SOURCES.ENABLED_TOOLS,
    dependsOn: ['enabledTools'], gate: 'KHY_PROMPT_TOOLS_SECTION_MEMO',
    note: '陷阱：产物是 Set(enabledTools) 的纯函数，却位于静态前缀——任何 deferred 揭示/档位切换都击穿前缀。',
  },
  {
    id: 'deferred_tools_hint', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: null, cacheKeySource: CACHE_KEY_SOURCES.REQUEST, dependsOn: ['router deferred-tools state'],
    note: '陷阱：由 router 按「当前已揭示的 deferred tools」逐轮计算后注入，却排在 boundary 之前。',
  },
  {
    id: 'unified_output_and_tone', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getUnifiedOutputAndToneSection', cacheKeySource: CACHE_KEY_SOURCES.CONST,
    dependsOn: [], gate: 'KHY_FABLE_VOICE',
    note: '尾附条目来自 fableVoiceProfile.toneAndStyleItems()（受 KHY_FABLE_VOICE 门控，部署期常量）。',
  },
  {
    id: 'tone_and_style', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getToneAndStyleSection', cacheKeySource: CACHE_KEY_SOURCES.CONST,
    dependsOn: [], gate: 'KHY_FABLE_VOICE',
    note: 'KHY_PROMPT_UNIFIED_OUTPUT 关闭时的原始段（逐字节回退路径）；因调非纯的 fableVoiceProfile 而不走静态记忆。',
  },
  {
    id: 'output_efficiency', tier: TIERS.STATIC.id, slot: SLOTS.PREFIX, mechanism: MECHANISMS.INLINE,
    builder: 'getOutputEfficiencySection', cacheKeySource: CACHE_KEY_SOURCES.CONST, dependsOn: [],
    gate: 'KHY_PROMPT_SECTION_STATIC_MEMO',
  },

  // ═══ 动态区·稳定组（dynamic）═══
  {
    id: 'memory', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getMemorySection', cacheKeySource: CACHE_KEY_SOURCES.MEMORY_STAMP,
    dependsOn: ['global MEMORY.md', 'project MEMORY.md', 'PROGRESS.md'],
    gate: 'KHY_PROJECT_MEMORY_RECALL',
    note: '正面样例：cacheKey 折入 mtime:size，内容一变即失效。',
  },
  {
    id: 'task_memory', tier: TIERS.DYNAMIC_VOLATILE.id, slot: SLOTS.TAIL, mechanism: MECHANISMS.SECTION,
    builder: 'getTaskMemorySection', cacheKeySource: CACHE_KEY_SOURCES.UNCACHED, dependsOn: ['task board'],
    gate: 'KHY_TASK_MEMORY_RECALL', note: '任务板每轮可变（创建/推进/完成）→ DANGEROUS_uncached，归入易变组。',
  },
  {
    id: 'env_info', tier: TIERS.DYNAMIC_VOLATILE.id, slot: SLOTS.TAIL, mechanism: MECHANISMS.SECTION,
    builder: 'getEnvironmentSection', cacheKeySource: CACHE_KEY_SOURCES.CLOCK_BUCKET,
    dependsOn: ['platform', 'shell', 'cwd', 'clock'], gate: 'KHY_SYSTEM_CLOCK',
    note: '含实时时钟 → 键折入时钟桶，随时间自然失效。',
  },
  {
    id: 'language', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getLanguageSection', cacheKeySource: CACHE_KEY_SOURCES.LANGUAGE, dependsOn: ['languagePreference'],
  },
  {
    id: 'output_style', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getOutputStyleSection', cacheKeySource: CACHE_KEY_SOURCES.OUTPUT_STYLE, dependsOn: ['outputStyleName'],
    note: '注意：output style 同时影响静态区的 simple_intro / doing_tasks，变更仍会击穿前缀。',
  },
  {
    id: 'mcp_instructions', tier: TIERS.DYNAMIC_VOLATILE.id, slot: SLOTS.TAIL, mechanism: MECHANISMS.SECTION,
    builder: 'getMcpInstructionsSection', cacheKeySource: CACHE_KEY_SOURCES.UNCACHED,
    dependsOn: ['MCP connection state'], note: 'MCP 连接态每轮可变 → DANGEROUS_uncached。',
  },
  {
    id: 'project_instructions', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getProjectInstructionsSection', cacheKeySource: CACHE_KEY_SOURCES.INSTRUCTION_STAMP,
    dependsOn: ['khy.md 四层', 'CLAUDE.md', 'AGENTS.md'], note: '已修复（P1）：键折入全部已发现指令文件的 mtime:size，改文件当轮即生效。',
  },
  {
    id: 'references', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: null, cacheKeySource: CACHE_KEY_SOURCES.REFERENCES_STAMP, dependsOn: ['references.json'],
    gate: 'KHY_REFERENCES',
  },
  {
    id: 'persona', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getPersonaSection', cacheKeySource: CACHE_KEY_SOURCES.PERSONA_STAMP, dependsOn: ['persona.md'],
  },
  {
    id: 'role', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getRoleSection', cacheKeySource: CACHE_KEY_SOURCES.ROLE_STAMP, dependsOn: ['active role'],
    note: 'DESIGN-ARCH-059 的临时角色覆盖层，层叠在 persona 之下。',
  },
  {
    id: 'companion', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getCompanionSection', cacheKeySource: CACHE_KEY_SOURCES.COMPANION_STAMP,
    dependsOn: ['active companion (L1)'],
  },
  {
    id: 'git_status', tier: TIERS.DYNAMIC_VOLATILE.id, slot: SLOTS.TAIL, mechanism: MECHANISMS.SECTION,
    builder: 'getGitStatusSection', cacheKeySource: CACHE_KEY_SOURCES.GIT_STAMP,
    dependsOn: ['git branch', 'working tree'], gate: 'KHY_PROMPT_GIT_STATUS_MIN',
    note: '已修复（P1）：键折入 .git/index 与 HEAD 的 mtime + 时间桶，不再冻结在首轮。',
  },
  {
    id: 'project_structure', tier: TIERS.DYNAMIC_VOLATILE.id, slot: SLOTS.TAIL, mechanism: MECHANISMS.SECTION,
    builder: 'getProjectStructureSection', cacheKeySource: CACHE_KEY_SOURCES.PROJECT_TREE_STAMP,
    dependsOn: ['cwd 目录 mtime'], gate: 'KHY_PROJECT_TREE', note: '顶层增删即变；键折入 cwd + 目录 mtime。',
  },
  {
    id: 'skill_catalog', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getSkillCatalogSection', cacheKeySource: CACHE_KEY_SOURCES.SKILL_FINGERPRINT,
    dependsOn: ['contextWindowTokens', 'installed skills', 'skill descriptions'], gate: 'KHY_PROMPT_SKILLS_MIN',
    note: '已修复（P1）：键折入技能集指纹（id + description 哈希），并保留 contextWindowTokens。',
  },
  {
    id: 'khy_specific', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getKhySpecificSection', cacheKeySource: CACHE_KEY_SOURCES.MODEL,
    dependsOn: ['model', 'cwd', 'enabledTools', 'hasNativeToolUse', 'isLowTierModel', 'taskScale'],
    note: '陷阱：taskScale 逐轮由用户消息评分得出却被折进这一大段的键——措辞一变就整段重算。',
  },
  {
    id: 'model_guidance', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: null, cacheKeySource: CACHE_KEY_SOURCES.MODEL_AND_LANGUAGE,
    dependsOn: ['model', 'languagePreference'],
  },
  {
    id: 'unknown_problem_handler', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: null, cacheKeySource: CACHE_KEY_SOURCES.FLAG, dependsOn: ['KHY_UNKNOWN_PROBLEM_HANDLER'],
    gate: 'KHY_UNKNOWN_PROBLEM_HANDLER',
  },
  {
    id: 'bootstrap_context', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.DYNAMIC, mechanism: MECHANISMS.SECTION,
    builder: 'getBootstrapContextSection', cacheKeySource: CACHE_KEY_SOURCES.BOOTSTRAP_PATHS,
    dependsOn: ['bootstrapFiles paths'],
  },

  // ═══ 动态组之后、易变组之前（trailing）═══
  {
    id: 'content_output_guide', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.TRAILING, mechanism: MECHANISMS.INLINE,
    builder: 'getContentOutputGuideSection', cacheKeySource: CACHE_KEY_SOURCES.CONST,
    dependsOn: ['hasNativeToolUse', 'isLowTierModel'],
    note: '仅在无原生 function calling 或低档模型时出现；位置对齐 makeSystemPrompt。',
  },
  {
    id: 'base_security', tier: TIERS.DYNAMIC_STABLE.id, slot: SLOTS.TRAILING, mechanism: MECHANISMS.INLINE,
    builder: null, cacheKeySource: CACHE_KEY_SOURCES.REQUEST, dependsOn: ['caller-supplied security directive'],
    note: '由调用方注入；空串被 filter 丢弃，不占上下文。',
  },
]);

/**
 * 按需胶囊清单（规范声明，顺序即装配顺序）。
 * 运行时真源为 prompts.js 的 ON_DEMAND_PROMPT_SECTION_IDS；守卫逐项有序核验两者相等。
 */
const ON_DEMAND_SECTION_IDS = Object.freeze([
  'scope_minimization',
  'planning_verification',
  'task_progress_management',
  'error_handling_fallback',
  'multi_agent_collaboration',
  'file_operations',
  'command_execution',
  'search_exploration',
  'codebase_analysis',
  'tool_discovery',
  'response_formatting',
  'feature_access_proxy_boundary',
  'git_operations',
  'action_safety',
  'security_permission_boundaries',
  'sensitive_data',
  'small_model_structured_flow',
]);

/**
 * getSystemPrompt 体内允许出现的 section 构造函数 → tier 归类白名单。
 * 守卫据此拦截「新增段忘了声明分层」——本规范要消灭的主要漂移形态。
 * '@on_demand' 表示聚合调用点（本身不是单个 section）。
 */
const BUILDER_TIERS = Object.freeze({
  getSimpleIntroSection: TIERS.STATIC.id,
  getSimpleSystemSection: TIERS.STATIC.id,
  getDoingTasksSection: TIERS.STATIC.id,
  getExecutionDisciplineSection: TIERS.STATIC.id,
  getPlanningAndRecoverySection: TIERS.STATIC.id,
  getCompactTaskDisciplineSection: TIERS.STATIC.id,
  getOnDemandPromptSectionEntries: TIERS.ON_DEMAND.id,
  getSessionMemoryAndContextSection: TIERS.STATIC.id,
  getUsingYourToolsSection: TIERS.STATIC.id,
  getUnifiedOutputAndToneSection: TIERS.STATIC.id,
  getToneAndStyleSection: TIERS.STATIC.id,
  getOutputEfficiencySection: TIERS.STATIC.id,
  // 内容本身是常量，但「是否出现」由调用方按 hasNativeToolUse / isLowTierModel 逐轮决定，
  // 故其拥有段 content_output_guide 归 dynamic_stable（与 owning section 的 tier 保持一致）。
  getContentOutputGuideSection: TIERS.DYNAMIC_STABLE.id,
  getMemorySection: TIERS.DYNAMIC_STABLE.id,
  getTaskMemorySection: TIERS.DYNAMIC_VOLATILE.id,
  getEnvironmentSection: TIERS.DYNAMIC_VOLATILE.id,
  getLanguageSection: TIERS.DYNAMIC_STABLE.id,
  getOutputStyleSection: TIERS.DYNAMIC_STABLE.id,
  getMcpInstructionsSection: TIERS.DYNAMIC_VOLATILE.id,
  getProjectInstructionsSection: TIERS.DYNAMIC_STABLE.id,
  getPersonaSection: TIERS.DYNAMIC_STABLE.id,
  getRoleSection: TIERS.DYNAMIC_STABLE.id,
  getCompanionSection: TIERS.DYNAMIC_STABLE.id,
  getGitStatusSection: TIERS.DYNAMIC_VOLATILE.id,
  getProjectStructureSection: TIERS.DYNAMIC_VOLATILE.id,
  getSkillCatalogSection: TIERS.DYNAMIC_STABLE.id,
  getKhySpecificSection: TIERS.DYNAMIC_STABLE.id,
  getBootstrapContextSection: TIERS.DYNAMIC_STABLE.id,
});

/**
 * 已知分层缺陷清单：规范**承认**、但实现侧尚未修复的问题。
 * 守卫对每条做「缺陷仍然存在」的断言——修好后必须同步删条目，避免清单腐化成过期文档。
 *
 * 已修复而移出的条目（保留记录，便于追溯）：
 *   - `staleKey`（2026-09-15 修复）：`git_status` / `project_instructions` / `skill_catalog`
 *     三段原先只以会话常量做 cacheKey，被段缓存冻结在会话首轮。现由
 *     `constants/promptFreshness.js` + `prompts.js` 的三个新鲜度键函数折入真实输入
 *     （.git/index 与 HEAD 的 mtime + 时间桶 / 指令文件 mtime:size / 技能集指纹），
 *     门控 `KHY_PROMPT_FRESH_KEYS`（默认开，关即回退旧键）。
 */
const CONCERNS = Object.freeze({
  volatileInPrefix: Object.freeze({
    id: 'volatileInPrefix',
    title: '每轮可变的内容处在静态前缀内',
    sections: Object.freeze(['deferred_tools_hint', 'using_your_tools', 'simple_intro', 'doing_tasks']),
    detail:
      'boundary 之前的段被当作「静态可缓存前缀」，但 deferred_tools_hint 由 router 按当前已揭示的 ' +
      'deferred tools 逐轮计算，using_your_tools 是 enabledTools 的函数，simple_intro/doing_tasks 是 ' +
      'output style 的函数。任何一次 deferred 揭示、档位切换或样式切换都会击穿静态前缀，' +
      '使整份提示的 provider 前缀缓存从该点起失效。修法：把 per-turn 输入移出前缀，或纳入 volatile 组。',
    exit: '移出前缀后，从本清单删除对应 id。',
  }),
  parametrizedStatic: Object.freeze({
    id: 'parametrizedStatic',
    title: '静态段被参数化',
    sections: Object.freeze(['simple_intro', 'doing_tasks']),
    detail:
      'getSimpleIntroSection(outputStyleConfig) 与 getDoingTasksSection 的产物随 output style 变化，' +
      '却被归入「Static content (cacheable)」。静态段必须只由字面量决定。' +
      '修法：把 output-style 相关句子拆成独立段放进动态区。',
    exit: '拆出后，从本清单删除对应 id。',
  }),
  misfiledTaskScale: Object.freeze({
    id: 'misfiledTaskScale',
    title: '易变输入折进稳定段',
    sections: Object.freeze(['khy_specific']),
    detail:
      'khy_specific 的 cacheKey 折入 taskScale，而 taskScale 逐轮由用户消息重新评分——措辞稍有变化' +
      '就整段重算。按判据此类输入属易变层。修法：把 task-decomposition 子块拆成独立段，' +
      '或把 taskScale 从键里移出（仅在 mode/tools 变化时重算）。',
    exit: '拆分或去键后，从本清单删除对应 id。',
  }),
});

/** 按 tier 取 id 列表（保序）。 */
function idsByTier(tierId) {
  return SECTIONS.filter((s) => s.tier === tierId).map((s) => s.id);
}

/** 按 slot 取 id 列表（保序）。 */
function idsBySlot(slotId) {
  return SECTIONS.filter((s) => s.slot === slotId).map((s) => s.id);
}

/** 按 mechanism 取 id 列表（保序）。 */
function idsByMechanism(mechanismId) {
  return SECTIONS.filter((s) => s.mechanism === mechanismId).map((s) => s.id);
}

/** 取单个 section 声明；不存在则 null。 */
function getSection(id) {
  return SECTIONS.find((s) => s.id === id) || null;
}

module.exports = {
  TIERS,
  SLOTS,
  MECHANISMS,
  CACHE_KEY_SOURCES,
  REALTIME_CACHE_KEY_SOURCES,
  FRESHNESS_STAMP_CACHE_KEY_SOURCES,
  TIME_VARYING_CACHE_KEY_SOURCES,
  SECTIONS,
  ON_DEMAND_SECTION_IDS,
  BUILDER_TIERS,
  CONCERNS,
  idsByTier,
  idsBySlot,
  idsByMechanism,
  getSection,
};
