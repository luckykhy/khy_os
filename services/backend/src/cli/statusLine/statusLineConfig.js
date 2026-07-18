'use strict';

/**
 * statusLineConfig.js — 纯叶子:状态行(status line)「配置解析 + stdin 契约构造 + 渲染行归一」
 * 的单一真源。
 *
 * 背景(先核实再动手):khy 此前只有一个 setup agent(agents/built-in/statuslineSetup.js)
 * 负责把 `statusLine.command` 写进 ~/.khy/settings.json,**没有任何运行时**去执行这条 command、
 * 把约定的 stdin JSON 喂给它、渲染它的 stdout、刷新它、或让用户关掉它。stdin 契约只存在于
 * setup agent 的 prompt 文字里。本叶子把「契约」固化成可测的纯函数,执行/IO 由 thin runner
 * (statusLineRunner.js)承担。
 *
 * 与 cli/hudRenderer.js 的 renderStatusBar 正交:那是 khy 自带的内部 HUD(从内部状态拼装),
 * 本叶子治的是「用户配置的外部 command」这条 Claude-Code 对齐的可见闭环。
 *
 * 契约:零 IO、确定性(不依赖时钟/随机)、绝不抛(fail-soft)、env 门控 KHY_STATUS_LINE 默认开;
 * 关则 isEnabled=false,runner 据此跳过执行(可见闭环的「关闭」开关)。
 *
 * settings 形状(对齐 Claude Code statusLine 设置):
 *   { "statusLine": { "type": "command", "command": "<shell>", "padding": 0 } }
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_STATUS_LINE 默认开;{0,false,off,no} 关。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_PCT_ROUND 默认开;{0,false,off,no} 关 → 逐字节回退原始浮点。
 * 独立于父门控 KHY_STATUS_LINE(父关则 runner 整体跳过执行;本子门控只治百分比取整这一面)。
 */
function _pctRoundEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_PCT_ROUND;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_COST 默认开;{0,false,off,no} 关 → payload 不含 `cost` 段
 * (逐字节回退刀92前的 stdin 契约)。独立于父门控 KHY_STATUS_LINE 与 KHY_STATUS_LINE_PCT_ROUND。
 */
function _costEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_COST;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_MODEL_NAME 默认开;{0,false,off,no} 关 → `model.display_name`
 * 逐字节回退原始 model id(刀96 前行为)。独立于父门控 KHY_STATUS_LINE 与其它子门控。
 */
function _modelNameEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_MODEL_NAME;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_OUTPUT_STYLE 默认开;{0,false,off,no} 关 → payload 不含 `output_style`
 * 段(逐字节回退刀97前的 stdin 契约)。独立于父门控 KHY_STATUS_LINE 与其它子门控。
 */
function _outputStyleEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_OUTPUT_STYLE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_PERMISSION_MODE 默认开;{0,false,off,no} 关 → payload 不含
 * `permission_mode` 字段(逐字节回退刀98前的 stdin 契约)。独立于父门控与其它子门控。
 */
function _permissionModeEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_PERMISSION_MODE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_SESSION_ID 默认开;{0,false,off,no} 关 → `session_id` 逐字节回退空串
 * (刀99 前行为——壳从不注入 sessionId,叶子恒发 '')。独立于父门控与其它子门控。
 */
function _sessionIdEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_SESSION_ID;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_STATUS_LINE_TRANSCRIPT_PATH 默认开;{0,false,off,no} 关 → payload 不含
 * `transcript_path` 键(逐字节回退刀100前的 stdin 契约——该键从不存在)。独立于父门控与其它子门控。
 */
function _transcriptPathEnabled(env = process.env) {
  const raw = env && env.KHY_STATUS_LINE_TRANSCRIPT_PATH;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 从已解析的 khy settings 对象中抽出 status line 配置(单一真源)。
 * 绝不抛:任何非法形状回退到「未配置」。
 *
 * @param {object} settings 已解析的 khy settings(resolveKhySettings 的输出)
 * @returns {{configured:boolean, type:(string|null), command:(string|null), padding:number}}
 */
function resolveStatusLineSetting(settings) {
  const out = { configured: false, type: null, command: null, padding: 0 };
  try {
    const sl = settings && typeof settings === 'object' ? settings.statusLine : null;
    if (!sl || typeof sl !== 'object') return out;
    const type = typeof sl.type === 'string' && sl.type.trim() ? sl.type.trim() : 'command';
    const command = typeof sl.command === 'string' ? sl.command.trim() : '';
    const padding = Number.isFinite(sl.padding) ? Math.max(0, Math.floor(sl.padding)) : 0;
    out.type = type;
    out.padding = padding;
    if (command) {
      out.command = command;
      out.configured = true;
    }
  } catch { /* fail-soft → 未配置 */ }
  return out;
}

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../../utils/finiteNumber').toFiniteOr0;

/**
 * 计算上下文使用率。窗口大小未知/<=0 → null(诚实:不臆造百分比)。
 *
 * 刀42:百分比对齐 CC `src/utils/context.ts::calculateContextPercentages` —— **先 Math.round
 * 取整、再 clamp**,`remaining` 由取整后的 `used` 派生(`100 - clampedUsed`),保证两字段均为
 * **整数**且 `used + remaining === 100`。此前 `_usagePercent` 直接把原始浮点 `47.371928...`
 * 当 `used_percentage` 经 runner `JSON.stringify` 透传给用户的 status-line command,下游不再取整
 * → 用户照 CC 官方 recipe `echo "Context: $used% used"` 会看到 `47.371928166% used`(丑、非整数、
 * 且 used+remaining 不整除 100)。khy 自身 HUD(`hudRenderer.js:436`)对同一计算早已 `Math.round`,
 * 本叶子是同口径漏掉取整的孤儿。子门控 KHY_STATUS_LINE_PCT_ROUND 默认开;关 → 逐字节回退原始浮点。
 *
 * 诚实边界(刻意不纳入):① CC `totalInputTokens===0 → null`(避免「ctx:0%」闪烁)是**行为/UX
 * 策略**且会隐藏新会话真实 0% → 不强塞(khy 显 0% 各自合理);② CC 分子 = input + cache_creation
 * + cache_read(排除 output)是 **token 计量语义**非显示格式,且 khy context 不单独携带 cache 分项
 * → 不纳入(属值语义非本显示刀)。本刀只治「取整」这一显示面。
 *
 * @returns {{used:(number|null), remaining:(number|null)}}
 */
function _usagePercent(usedTokens, windowSize, env = process.env) {
  const size = _num(windowSize);
  if (size <= 0) return { used: null, remaining: null };
  const ratio = (_num(usedTokens) / size) * 100;
  if (_pctRoundEnabled(env)) {
    // CC 口径:round → clamp → remaining 由 clampedUsed 派生(均为整数,和恒为 100)。
    const used = Math.min(100, Math.max(0, Math.round(ratio)));
    return { used, remaining: 100 - used };
  }
  // 门控关:逐字节回退原始浮点(clamp raw float)。
  const used = Math.max(0, Math.min(100, ratio));
  return { used, remaining: Math.max(0, 100 - used) };
}

/**
 * 构造喂给 status line command 的 stdin JSON(逐字段对齐 statuslineSetup.js 的 prompt 契约)。
 * 纯变换:调用方注入快照,本函数不读任何运行时/时钟。
 *
 * @param {object} snapshot
 * @param {string} [snapshot.sessionId]
 * @param {string} [snapshot.cwd]
 * @param {{id?:string, displayName?:string}} [snapshot.model]
 * @param {string} [snapshot.projectDir]
 * @param {string[]} [snapshot.addedDirs]
 * @param {string} [snapshot.version]
 * @param {object} [snapshot.context] {totalInputTokens,totalOutputTokens,contextWindowSize,inputTokens,outputTokens}
 * @param {object} [snapshot.cost] {totalCostUSD,totalDurationMs} 会话成本/墙钟(时钟读在壳内注入)
 * @param {string} [snapshot.outputStyle] 当前输出样式名(壳注入 getActiveOutputStyleName 结果)
 * @param {string} [snapshot.permissionMode] 当前权限模式(壳注入 getPermissionMode 结果·CC 词汇映射)
 * @param {string} [snapshot.transcriptPath] 当前会话 JSONL transcript 路径(壳注入 jsonlPathFor 结果)
 * @param {object} [env] 门控环境(KHY_STATUS_LINE_PCT_ROUND / KHY_STATUS_LINE_COST / KHY_STATUS_LINE_OUTPUT_STYLE / KHY_STATUS_LINE_PERMISSION_MODE / KHY_STATUS_LINE_SESSION_ID / KHY_STATUS_LINE_TRANSCRIPT_PATH)
 * @returns {object} 约定的 stdin 负载对象(交给 runner JSON.stringify)
 */
function buildStdinPayload(snapshot = {}, env = process.env) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const model = s.model && typeof s.model === 'object' ? s.model : {};
  const ctx = s.context && typeof s.context === 'object' ? s.context : {};
  const curIn = _num(ctx.inputTokens);
  const curOut = _num(ctx.outputTokens);
  const pct = _usagePercent(curIn + curOut, ctx.contextWindowSize, env);
  const cwd = typeof s.cwd === 'string' ? s.cwd : '';
  // 刀99:session_id —— 对齐 CC `types/statusLine.ts:6` + `StatusLine.tsx:302`(`session_id: getSessionId()`)。
  // half-wired 底座:khy `sessionForestService.getCurrentSessionId()` 早已 live 且被 /rename、/color、
  // /recap、/topology、TUI(App.js:883)等多路消费;但本快照壳历来从不注入它 → 叶子恒发 `session_id:''`
  // (用户照 `jq -r .session_id` 取到空)。壳注入 sessionId,叶子据此透传;门控关 → 逐字节回退空串(刀99 前)。
  const sessionId = _sessionIdEnabled(env) && typeof s.sessionId === 'string' ? s.sessionId : '';
  const payload = {
    session_id: sessionId,
    cwd,
    model: {
      id: typeof model.id === 'string' ? model.id : '',
      display_name: typeof model.displayName === 'string' ? model.displayName : '',
    },
    workspace: {
      current_dir: cwd,
      project_dir: typeof s.projectDir === 'string' ? s.projectDir : cwd,
      added_dirs: Array.isArray(s.addedDirs) ? s.addedDirs.filter((d) => typeof d === 'string') : [],
    },
    version: typeof s.version === 'string' ? s.version : '',
    context_window: {
      total_input_tokens: _num(ctx.totalInputTokens),
      total_output_tokens: _num(ctx.totalOutputTokens),
      context_window_size: _num(ctx.contextWindowSize),
      current_usage: { input_tokens: curIn, output_tokens: curOut },
      used_percentage: pct.used,
      remaining_percentage: pct.remaining,
    },
  };
  // 刀92:cost 段 —— 对齐 CC `components/StatusLine.tsx::buildStatusLineCommandInput` 的 cost 契约,
  // 让用户配置的 status-line command 能照官方 recipe `jq -r '.cost.total_cost_usd'` 取到会话成本。
  // 半接线底座:khy 自带 HUD 早已消费 hudState.sessionCostUSD(hudRenderer.js:52/89/428),但这条
  // 对齐 CC 的外部 command 契约从未看到它 → 本刀把已累计的成本接到已构造的信封里(零新基础设施)。
  // 只纳入 khy 有活底座的两字段:total_cost_usd(sessionCostUSD 累计值)与 total_duration_ms
  // (壳内由 hudState.sessionStart 派生;时钟读在壳,叶子保持零时钟/确定性)。
  // 诚实边界(刻意省略,镜像本文件对 rate_limits 的省略先例):CC 的 total_api_duration_ms /
  // total_lines_added / total_lines_removed 在 khy 无任何会话级累加器(grep 实证),发 0 会把
  // 「未跟踪」伪装成「本会话改了 0 行/0ms API」→ 宁省勿假。子门控 KHY_STATUS_LINE_COST 关 →
  // 不含 cost 段(逐字节回退刀92前的 payload)。
  if (_costEnabled(env)) {
    const cost = s.cost && typeof s.cost === 'object' ? s.cost : {};
    payload.cost = {
      total_cost_usd: _num(cost.totalCostUSD),
      total_duration_ms: _num(cost.totalDurationMs),
    };
  }
  // 刀97:output_style 段 —— 对齐 CC `types/statusLine.ts:23-25` + `StatusLine.tsx:268-269`
  // (`output_style:{ name: settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME }`),让用户配置的
  // status-line command 能照官方 recipe `jq -r '.output_style.name'` 取到当前输出样式名。
  // 半接线底座:khy 的 `getActiveOutputStyleName()`(constants/outputStyles.js:85)早已 live——
  // 它读 KHY_OUTPUT_STYLE 决定每回合系统提示的输出样式(prompts.js 构建时消费),`/output-style`
  // 命令(router.js:4840)也读它;但这条对齐 CC 的外部 command 契约从未看到它 → 本刀把已 live 的
  // 样式名接到已构造的信封里(壳注入 name,叶子零 IO/零 env 样式解析)。
  // 诚实边界:name 由壳注入(getActiveOutputStyleName 已应用默认 'senior-engineer',恒非空);
  // 若注入缺失/空(壳 require 失败)→ 省略整段而非发 name:''(不臆造空样式名)。子门控
  // KHY_STATUS_LINE_OUTPUT_STYLE 关 → 不含 output_style 段(逐字节回退刀97前的 payload)。
  if (_outputStyleEnabled(env)) {
    const name = typeof s.outputStyle === 'string' ? s.outputStyle.trim() : '';
    if (name) payload.output_style = { name };
  }
  // 刀98:permission_mode 字段 —— 对齐 CC `types/statusLine.ts:9` + `StatusLine.tsx:228/331`
  // (顶层 `permission_mode: toolPermissionContext.mode`),让用户配置的 status-line command 能照官方
  // recipe `jq -r '.permission_mode'` 取到当前工具权限模式。半接线底座:khy 的 getPermissionMode()
  // (toolCalling.js:2232)早已 live 且被工具审批/TUI/autonomy 消费,只是 status-line 契约从未看到它。
  // 壳注入 khy 内部模式,叶子做 CC 词汇映射(bypass→bypassPermissions);未知/注入缺失 → 省略字段
  // (不臆造 'default')。子门控 KHY_STATUS_LINE_PERMISSION_MODE 关 → 不含该字段(逐字节回退刀98前)。
  if (_permissionModeEnabled(env)) {
    const pm = resolvePermissionModeLabel(s.permissionMode);
    if (pm) payload.permission_mode = pm;
  }
  // 刀100:transcript_path 字段 —— 对齐 CC `types/statusLine.ts:7`(顶层 `transcript_path: string`)。
  // half-wired 底座:khy `sessionPersistence.jsonlPathFor(sessionId)`(:175)是「会话 JSONL transcript
  // 路径」的公开只读 SSOT,已被 trajectoryReplay(replayBundle.js:89 / replayLedger.js:56)live 消费;
  // 但对齐 CC 的 status-line command 契约从未看到它 → 用户照 `jq -r .transcript_path` 取不到。壳据当前
  // sessionId 解析路径注入,叶子透传。诚实边界:CC 契约必填但该键刀100前从不存在 → 门控关时**省略键**
  // (逐字节回退刀100前·条件字段门控形态,同 cost/output_style);门控开时恒发(路径解析不出→''·honest)。
  // 子门控 KHY_STATUS_LINE_TRANSCRIPT_PATH 关 → 不含 transcript_path 键。
  if (_transcriptPathEnabled(env)) {
    payload.transcript_path = typeof s.transcriptPath === 'string' ? s.transcriptPath : '';
  }
  return payload;
}

/**
 * 解析 status-line stdin 契约里的 `model.display_name`(友好本地化名)。
 *
 * 半接线底座(刀96):CC `components/StatusLine.tsx:260` 把 display_name 设为
 * `renderModelName(runtimeModel)`——**友好本地化名**(`types/statusLine.ts:15` 自述「已本地化的
 * 展示名」),而 khy 的快照壳(`handlers/statusline.js::_buildSnapshot`)历来把 displayName 塌成
 * **原始 model id**(`st.lastModel`)。于是用户照 khy 自己帮助文档(`handlers/statusline.js:147`)
 * 里的官方 recipe `jq -r .model.display_name` 取到的是 `claude-opus-4-8` 而非 `Opus 4.8`。
 * 而友好名 SSOT `cli/ccModelName.formatModelLabel` **早已 live**(刀94 `/status` 已消费它,
 * `router.js:1716`),`hudState.lastModel` 也每轮由 `updateModelInfo` 填充并已被本快照读到——
 * 缺的只是把已存在的 SSOT 接到这条已构造的信封上(零新基础设施)。
 *
 * 纯函数、绝不抛。**inject-don't-require**:`formatModelLabel` 由壳注入(承刀93/94),叶子保持
 * 零依赖。门控 KHY_STATUS_LINE_MODEL_NAME 关 → 逐字节回退原始 id;`formatModelLabel` 缺失/
 * 抛出/返回空 → 回退原始 id(诚实:拿不到友好名不臆造、不丢原值)。
 *
 * @param {string} rawModel 原始 model id(hudState.lastModel)
 * @param {(model:string, env?:object)=>string} [formatModelLabel] 注入的友好名 SSOT
 * @param {object} [env] 门控环境(KHY_STATUS_LINE_MODEL_NAME)
 * @returns {string} 友好名或原始 id(绝不返回 undefined)
 */
function resolveModelDisplayName(rawModel, formatModelLabel, env = process.env) {
  const raw = typeof rawModel === 'string' ? rawModel : (rawModel == null ? '' : String(rawModel));
  try {
    if (!raw) return '';
    if (!_modelNameEnabled(env)) return raw; // 门控关 → 逐字节回退原始 id(刀96 前)。
    if (typeof formatModelLabel !== 'function') return raw;
    const label = formatModelLabel(raw, env);
    return typeof label === 'string' && label.trim() ? label : raw;
  } catch {
    return raw; // fail-soft:友好名解析失败绝不丢原值。
  }
}

// khy 内部权限模式词汇 → CC PermissionMode 词汇(`services/acp/agent/permissionMode.ts:6-10`
// = default/acceptEdits/bypassPermissions/plan;CC v2.1.83+ 另增 auto、dontAsk)。同名直通,
// 仅 khy 内部 `bypass` 映射到 CC 的 `bypassPermissions`(khy toolCalling._normalizePermissionMode
// 反向:把 CC 拼写归一成内部 bypass)。`auto`/`dontAsk` 与 CC 同名直通。也容忍已是 CC 拼写的
// 输入直通,未知 → ''(叶子据此省略字段,不臆造)。
const _CC_PERMISSION_MODE = Object.freeze({
  default: 'default',
  plan: 'plan',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  dontAsk: 'dontAsk',
  bypass: 'bypassPermissions',
  bypassPermissions: 'bypassPermissions',
});

/**
 * 解析 status-line stdin 契约里的 `permission_mode`(对齐 CC `toolPermissionContext.mode`)。
 *
 * 半接线底座(刀98):CC `components/StatusLine.tsx:331` 读 `useAppState(s=>s.toolPermissionContext.mode)`
 * 并作为 `permission_mode` 发出(`types/statusLine.ts:9`);khy 的 status-line 契约从不携带它。
 * 而 khy `services/toolCalling.getPermissionMode()`(:2232)**早已 live**——返回 CC 对齐词汇
 * default/plan/acceptEdits/bypass,每回合驱动工具审批(toolCalling.js:3173/3308)、被 TUI
 * (App.js:215-220 Shift+Tab 循环)与 autonomy 面板(autonomy.js:58)消费。缺的只是把已 live 的
 * 模式接到已构造的信封上(壳注入原始模式,叶子做 CC 词汇映射;零 IO)。
 *
 * 纯函数、绝不抛。未知/空 → ''(叶子据此省略字段,不臆造 'default')。
 *
 * @param {string} mode khy 内部权限模式(getPermissionMode 结果)
 * @returns {string} CC 词汇 permission_mode,或 ''(未知)
 */
function resolvePermissionModeLabel(mode) {
  try {
    const raw = typeof mode === 'string' ? mode.trim() : '';
    if (!raw) return '';
    return _CC_PERMISSION_MODE[raw] || '';
  } catch {
    return '';
  }
}

/**
 * 归一 command 的 stdout 为一行可显示的状态行(对齐 CC:多行只取首个非空行,去 ANSI 之外原样,
 * 按 maxLen 截断,padding 加左空格)。绝不抛。
 *
 * @param {string} raw command 的原始 stdout
 * @param {object} [opts]
 * @param {number} [opts.maxLen=512] 行长上限(防失控输出占满终端)
 * @param {number} [opts.padding=0] 左侧空格数
 * @returns {string}
 */
function normalizeRenderedLine(raw, opts = {}) {
  try {
    const maxLen = Number.isFinite(opts.maxLen) ? Math.max(0, Math.floor(opts.maxLen)) : 512;
    const padding = Number.isFinite(opts.padding) ? Math.max(0, Math.floor(opts.padding)) : 0;
    const text = String(raw == null ? '' : raw);
    // 取首个非空行(CC 状态行是单行展示)。
    let line = '';
    for (const ln of text.split('\n')) {
      if (ln.trim() !== '') { line = ln; break; }
    }
    // 去掉行尾回车/空白(保留行内对齐),按上限截断。
    line = line.replace(/[\r\s]+$/, '');
    if (maxLen > 0 && line.length > maxLen) line = line.slice(0, maxLen);
    return padding > 0 ? ' '.repeat(padding) + line : line;
  } catch {
    return '';
  }
}

/**
 * 人类可读一行摘要(给 `statusline show` / 帮助 / 自检)。
 * @param {object} resolved resolveStatusLineSetting 的输出
 * @param {boolean} enabled isEnabled 的结果
 * @returns {string}
 */
function summarizeStatusLine(resolved, enabled) {
  const r = resolved && typeof resolved === 'object' ? resolved : {};
  if (!enabled) return '状态行:已关闭(KHY_STATUS_LINE=0)';
  if (!r.configured) return '状态行:未配置(运行 `khy statusline setup` 或 `statusline set <command>`)';
  const cmd = String(r.command || '');
  const shown = cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd;
  return `状态行:已配置 [${r.type || 'command'}] ${shown}`;
}

module.exports = {
  isEnabled,
  resolveStatusLineSetting,
  buildStdinPayload,
  resolveModelDisplayName,
  resolvePermissionModeLabel,
  normalizeRenderedLine,
  summarizeStatusLine,
};
