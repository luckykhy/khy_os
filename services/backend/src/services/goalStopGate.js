'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子的黄金范例**。新增业务判定逻辑时照抄这里的形状:
//   零 IO、确定性、绝不抛(坏输入返安全默认)、可单测、经默认开的 KHY_* 门控(见下 isEnabled)、
//   关闭即逐字节回退。判定/文案全在叶子里,IO(读活动目标、清除)由调用方在接线处做。
//   接线范例见 toolUseLoop.js 的 evaluateGoalStop 消费块(try/catch fail-soft)。

/**
 * goalStopGate.js — 持久目标的「Stop-gate」:Claude Code 会话级 Stop hook 的确定性后端等价物。
 *
 * 诉求(goal 2026-07-03「让 khy 学会使用 CC 的 goal 模式」):CC 的 /goal 用一条会话级 Stop hook
 * 在助手**想停**这一刻评估目标条件是否达成——未达成则阻止停止、朝目标再驱动;达成则自动清除并
 * 向用户宣布完成。khy 此前只做到:每轮**开头**注入提醒(goalCore/goalStore)+ 轮次预算(跨轮
 * 结构性兜底)。真正缺的是「想停时按目标条件拦截」这道门——本叶子补上它的确定性判定逻辑。
 *
 * 本叶子是**纯叶子**:零 IO、确定性、绝不抛、可单测。所有判定/文案在此;活动目标的读取与清除
 * (goalStore.getActiveGoal / clearGoal)等 IO 由调用方(toolUseLoop 的 stop 路径)按
 * evaluateGoalStop 的裁决落地。
 *
 * ── 门控(全部默认开,仅显式 0/false/off/no 关闭)──────────────────────────
 *   KHY_GOAL_STOP_GATE      本门总开关。**嵌套父门控 KHY_GOAL**:父关则整个持久目标关,本门也关。
 *                           关闭后 evaluateGoalStop 恒返回 {action:'pass'} → toolUseLoop 行为
 *                           逐字节回退到今日(无 goal 感知的停止拦截)。
 *   KHY_GOAL_AUTO_CLEAR     达成判定后是否自动清除目标。关闭后即便判达成也只 pass 放行,清除交由
 *                           模型自行调用 GoalTool(action=clear)。
 *   KHY_GOAL_EVIDENCE_GATE  证据门(参考 Hermes v0.18.0 evidence-based verification)。嵌套父门控
 *                           KHY_GOAL_STOP_GATE。开时:达成判定若建立在一个「验证声称」之上(如
 *                           「已验证通过 / all tests passed」)却看不到任何具体证据(命令输出 / 测试
 *                           通过数 / 退出码 / 文件摘录)→ 降级为 redrive,要求出具证据后再收尾。关闭
 *                           后逐字节回退:声称即接受(今日行为)。见 claimsVerificationWithoutEvidence。
 *   KHY_GOAL_STOP_GATE_MAX  单个用户轮内最多再驱动(阻止停止)次数,默认 1,clamp [0,10]。跨轮的
 *                           无限循环由 goalCore 的轮次预算(maxTurns)结构性兜底,故本门内预算很小。
 *
 * ── 判定偏置:保守宣布「达成」───────────────────────────────────────────────
 * 误判「已达成」→ 提前放行 + 可能提前清除(违背 CC「达成前不停」的语义,危害大);误判「未达成」
 * → 多推一次(有界:within-turn 上限 + 同句签名 break + 跨轮预算,危害小且可控)。故 looksLike
 * GoalSatisfied 只在出现**完成态(perfective)完成信号**且未被否定/未来时计划主导时才判达成——
 * 宁可多推一次,不可在目标未真正达成时提前收尾。这与 CC 的 Stop-hook 行为一致。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
// 父→子优先级(KHY_GOAL 关 → KHY_GOAL_STOP_GATE 也关)现由 flagRegistry 单一声明式真源
// 集中施加;本文件委托给它(leaf→leaf 相对 require,契约允许)。私有 _FALSY/_off 保留为
// **OFF-fallback 路径**:自门控 KHY_FLAG_REGISTRY 关时逐字节回退到本文件原有的手写判定。
const flagRegistry = require('./flagRegistry');
// completion contract 判定/文案(leaf→leaf 相对 require,契约允许)。门控在本文件施加,关闭即字节回退。
const {
  parseCompletionContract,
  matchEvidenceAgainstContract,
  buildContractRedriveMessage,
} = require('./completionContract');
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * Stop-gate 是否启用。嵌套父门控 KHY_GOAL:父显式关 → 本门也关(整个持久目标关闭)。
 * 委托 flagRegistry('KHY_GOAL_STOP_GATE' parent:'KHY_GOAL',均 CANON 4 词 + 归一);
 * 注册表关时逐字节回退到原手写 `if(_off(KHY_GOAL)) return false; return !_off(KHY_GOAL_STOP_GATE)`。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  if (flagRegistry.isRegistryEnabled(e)) {
    return flagRegistry.isFlagEnabled('KHY_GOAL_STOP_GATE', e);
  }
  if (_off(e.KHY_GOAL)) return false;              // 父门控关 → 整个持久目标关
  return !_off(e.KHY_GOAL_STOP_GATE);
}

/**
 * 达成后是否自动清除(默认开)。关 → 判达成也只 pass,交由模型 GoalTool(action=clear)。
 * 委托 flagRegistry('KHY_GOAL_AUTO_CLEAR',CANON 4 词 + 归一);注册表关时回退原 `!_off(...)`。
 * @param {object} [env]
 * @returns {boolean}
 */
function isAutoClearEnabled(env) {
  const e = env || process.env || {};
  if (flagRegistry.isRegistryEnabled(e)) {
    return flagRegistry.isFlagEnabled('KHY_GOAL_AUTO_CLEAR', e);
  }
  return !_off(e.KHY_GOAL_AUTO_CLEAR);
}

/**
 * 证据门是否启用(默认开)。嵌套父门控 KHY_GOAL_STOP_GATE:父关 → 本门也关。
 *
 * 诉求(参考 Hermes Agent v0.18.0「验证」支柱 / completion contract + evidence-based
 * verification):Hermes 的 judge 只在回复**给出具体证据**(命令结果 / 测试输出 / 文件摘录)
 * 时才判 DONE,绝不接受「已验证通过 / all tests passed」这类**无证据的声称**。khy 此前
 * looksLikeGoalSatisfied 只看措辞——一句「全部测试通过」无论是否真跑过测试都被判达成。本门补上
 * 这道证据校验:当达成判定**建立在一个验证声称之上**却看不到任何具体证据时,把 clear/satisfied
 * 降级为 redrive,要求模型出具证据(而非放行 / 自动清除一个未经证实的目标)。
 *
 * 委托 flagRegistry('KHY_GOAL_EVIDENCE_GATE' parent:'KHY_GOAL_STOP_GATE');注册表关时逐字节
 * 回退到原手写 `if(_off(KHY_GOAL_STOP_GATE)) return false; return !_off(KHY_GOAL_EVIDENCE_GATE)`。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEvidenceGateEnabled(env) {
  const e = env || process.env || {};
  if (flagRegistry.isRegistryEnabled(e)) {
    return flagRegistry.isFlagEnabled('KHY_GOAL_EVIDENCE_GATE', e);
  }
  if (_off(e.KHY_GOAL_STOP_GATE)) return false;   // 父门控关 → 本门也关
  if (_off(e.KHY_GOAL)) return false;             // 祖父门控关
  return !_off(e.KHY_GOAL_EVIDENCE_GATE);
}

/**
 * 完成标准契约门是否启用(默认开)。嵌套父门控 KHY_GOAL_STOP_GATE:父关 → 本门也关。
 *
 * 诉求(参考 Hermes Agent v0.18.0 completion contracts):用户可在目标里**预先声明**"什么叫完成"
 * (完成标准段 / 反引号命令);达成判定时据回复证据**逐条核对**这些标准,未被证据全覆盖 → 降级为
 * redrive 指名缺哪条(而非放行 / 自动清除一个证据不全的目标)。目标未声明任何标准时不生效
 * (parseCompletionContract 返回空 criteria → 跳过),行为逐字节不变。
 *
 * 委托 flagRegistry('KHY_GOAL_COMPLETION_CONTRACT' parent:'KHY_GOAL_STOP_GATE');注册表关时
 * 回退到手写父子判定。
 * @param {object} [env]
 * @returns {boolean}
 */
function isCompletionContractEnabled(env) {
  const e = env || process.env || {};
  if (flagRegistry.isRegistryEnabled(e)) {
    return flagRegistry.isFlagEnabled('KHY_GOAL_COMPLETION_CONTRACT', e);
  }
  if (_off(e.KHY_GOAL_STOP_GATE)) return false;   // 父门控关 → 本门也关
  if (_off(e.KHY_GOAL)) return false;             // 祖父门控关
  return !_off(e.KHY_GOAL_COMPLETION_CONTRACT);
}

/**
 * Verify-ran 门是否启用(默认开)。嵌套父门控 KHY_GOAL_STOP_GATE:父关 → 本门也关。
 *
 * 诉求(goal 2026-07-11「khy 做完任务不会及时验证测试」):证据门(claimsVerificationWithout
 * Evidence)只看回复里**有没有证据形状的文字**——模型贴一段 ``` 代码块或字面写个 `npm test`
 * 就能过关,哪怕本轮从未真正调用过 shell。本门补上「行为证据」:当回复**声称验证通过**却在整轮
 * 的工具执行记录(toolCallLog)里**找不到任何真实运行过的验证命令**时,把 clear 降级为 redrive,
 * 要求模型真正跑一遍验证再收尾。仅当调用方把 toolCallLog 接线传入时生效;旧调用方不传 → 跳过 →
 * 逐字节回退。
 *
 * 委托 flagRegistry('KHY_GOAL_VERIFY_RAN_GATE' parent:'KHY_GOAL_STOP_GATE');注册表关时回退手写父子判定。
 * @param {object} [env]
 * @returns {boolean}
 */
function isVerifyRanGateEnabled(env) {
  const e = env || process.env || {};
  if (flagRegistry.isRegistryEnabled(e)) {
    return flagRegistry.isFlagEnabled('KHY_GOAL_VERIFY_RAN_GATE', e);
  }
  if (_off(e.KHY_GOAL_STOP_GATE)) return false;   // 父门控关 → 本门也关
  if (_off(e.KHY_GOAL)) return false;             // 祖父门控关
  return !_off(e.KHY_GOAL_VERIFY_RAN_GATE);
}

// ── 常量 SSOT ────────────────────────────────────────────────────────
// 单个用户轮内最多再驱动次数。默认 1:在「想停」时最多多推一次(要么确认达成收尾、要么继续),
// 既落地 CC 的「阻止停止」语义,又不在单轮内反复烧 token。跨轮无限循环由轮次预算兜底。
const GOAL_STOP_GATE_DEFAULT_MAX = 1;

/**
 * 解析单轮内再驱动上限:KHY_GOAL_STOP_GATE_MAX 优先,归一为 [0,10] 的整数;非法 → 默认值。
 * 委托 flagRegistry.resolveNumeric(numeric,default 1,clamp[0,10],parseInt 语义);
 * 注册表关时逐字节回退到本文件原有 parseInt+clamp 判定。
 * @param {object} [env]
 * @returns {number}
 */
function resolveMaxRedrives(env) {
  const e = env || process.env || {};
  if (flagRegistry.isRegistryEnabled(e)) {
    return flagRegistry.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', e);
  }
  const raw = e.KHY_GOAL_STOP_GATE_MAX;
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 10);
  return GOAL_STOP_GATE_DEFAULT_MAX;
}

// ── 完成态判定的信号词表(确定性、保守)──────────────────────────────────
// 显式「目标达成」措辞(最强信号,直接判达成)。
const _GOAL_DONE_PHRASE_RE =
  /(目标(?:已|均已|都已)?\s*(?:全部)?\s*(?:完成|达成|实现)|(?:已|均已)\s*(?:完成|达成|实现)(?:了)?\s*(?:该|此|本)?\s*目标|goal\s+(?:is\s+)?(?:complete(?:d)?|accomplished|met|achieved|done))/i;
// 完成态(perfective)通用完成信号:强调「已经发生/已达成」,不含未来时。
const _PERFECTIVE_DONE_RE =
  /(已完成|已达成|已实现|已全部完成|已经完成|均已完成|都已完成|已交付|已验证(?:通过)?|全部(?:测试)?通过|大功告成|completed|finished|accomplished|\bdone\b|\bpassed\b|is\s+now\s+(?:complete|done))/i;
// 否定完成(尚未/还没) —— 出现即判未达成,优先级最高(压过任何完成态信号)。
const _NEGATED_DONE_RE =
  /(尚未|还没|还未|仍未|未能完成|未完成|没(?:有)?完成|not\s+(?:yet\s+)?(?:done|complete(?:d)?|finished)|incomplete|still\s+(?:working|need|to\s+do))/i;
// 未来时/计划腔(表示还没做、只是打算) —— 与完成态并存时抑制「达成」判定(偏向再驱动)。
const _FUTURE_PLAN_RE =
  /(我(?:将|会|准备|打算|先|接下来|下一步)|接下来(?:我)?|下一步(?:我)?|即将|going\s+to|i\s*(?:'|’)?ll\b|i\s+will\b|let\s+me\b|首先(?:我)?)/i;

/**
 * 保守判定回复是否表明「持久目标已达成」。纯函数、不抛。
 *
 * 规则(优先级从高到低):
 *   1. 空回复 → 未达成。
 *   2. 出现否定完成(尚未/还没/not done…) → 未达成(优先级最高)。
 *   3. 出现显式「目标达成」措辞 → 达成(最强信号)。
 *   4. 出现完成态通用信号 且 未被未来时计划主导 → 达成。
 *   5. 其余 → 未达成(保守:宁可再推一次)。
 * @param {string} reply
 * @returns {boolean}
 */
function looksLikeGoalSatisfied(reply) {
  const s = String(reply == null ? '' : reply).trim();
  if (!s) return false;
  if (_NEGATED_DONE_RE.test(s)) return false;          // 明说没完成 → 未达成
  if (_GOAL_DONE_PHRASE_RE.test(s)) return true;       // 显式目标达成 → 达成
  if (_PERFECTIVE_DONE_RE.test(s)) {
    // 完成态信号存在,但若同时被未来时计划主导(如「已看完文件,接下来我将重构…」),
    // 说明本轮只是阶段性小结、目标整体仍在推进 → 保守判未达成,交给再驱动。
    if (_FUTURE_PLAN_RE.test(s)) return false;
    return true;
  }
  return false;
}

// ── 证据校验(参考 Hermes v0.18.0 evidence-based verification)────────────────
// 「验证声称」信号:回复自称已完成某种验证/测试/检查(但可能只是嘴上说)。
const _VERIFICATION_CLAIM_RE =
  /(已验证(?:通过)?|验证(?:已)?通过|(?:全部|所有)?\s*测试(?:全部|均)?\s*(?:通过|全绿)|测试全绿|全部通过|检查(?:已)?通过|校验(?:已)?通过|构建(?:成功|通过)|编译(?:成功|通过)|(?:all\s+(?:the\s+)?)?tests?\s+(?:now\s+)?pass(?:ed|ing)?|checks?\s+pass(?:ed|ing)?|build\s+(?:succeeded|passed|success(?:ful)?)|lint\s+(?:pass(?:ed|ing)?|clean)|verified|\bpassed\b)/i;
// 「具体证据」信号:回复里出现真实的命令/测试/文件产物,而非空口声称。
//   代码块 ``` / 测试通过数(12 passed·3 通过)/ 比值(9/9)/ 退出码 / TAP·node:test 行 /
//   对勾叉号 / jest PASS·FAIL / shell 提示符 / 测试框架调用命令 / 断言。
const _EVIDENCE_RE = new RegExp(
  [
    '```', '~~~',
    '\\d+\\s*(?:passed|passing|failed|failing|通过|失败|个(?:测试|用例)|tests?\\b)',
    '\\d+\\s*\\/\\s*\\d+',
    '(?:exit\\s*code|退出码|return\\s*code|\\brc)\\s*[:=]?\\s*\\d+',
    '(?:tests?|suites?|assertions?)\\s*[:：]\\s*\\d+',
    '\\bok\\s+\\d+\\b',
    '#\\s*(?:pass|fail|tests?)\\b',
    '[✓✔√✅❌✗×]',
    '\\bPASS\\b', '\\bFAIL\\b',
    '(?:^|\\n)\\s*\\$\\s+\\S',
    'npm\\s+(?:run\\s+)?test', 'node\\s+--test', '\\bpytest\\b', '\\bjest\\b', 'go\\s+test', 'cargo\\s+test',
  ].join('|'),
  'i',
);

/**
 * 回复是否包含**具体证据**(真实命令/测试/文件产物,而非空口声称)。纯函数、不抛。
 * 见 _EVIDENCE_RE 的信号清单。
 * @param {string} reply
 * @returns {boolean}
 */
function hasConcreteEvidence(reply) {
  const s = String(reply == null ? '' : reply);
  if (!s.trim()) return false;
  try { return _EVIDENCE_RE.test(s); } catch { return true; } // 失败偏向「有证据」(不误拦)
}

/**
 * 回复是否「声称验证成功却拿不出证据」。纯函数、不抛。
 *
 * 仅当回复**明确声称**做过验证/测试/检查(_VERIFICATION_CLAIM_RE),但**看不到任何具体证据**
 * (hasConcreteEvidence=false)时返回 true。这精确对准 Hermes 识别的失败模式:「说 all tests
 * pass 但不贴输出」。对纯粹的「目标已完成」(不声称验证)不适用——保持原有接受路径不被扰动。
 * @param {string} reply
 * @returns {boolean}
 */
function claimsVerificationWithoutEvidence(reply) {
  const s = String(reply == null ? '' : reply).trim();
  if (!s) return false;
  if (!_VERIFICATION_CLAIM_RE.test(s)) return false;  // 未声称验证 → 证据门不适用
  return !hasConcreteEvidence(s);                      // 声称了但无证据 → 命中
}

// ── 行为证据:本轮是否**真的执行过**验证命令(不只是回复里贴了证据形状的文字)────────────
// shell 类工具名(与 toolLoopDetector.SHELL_TOOLS 同款,内联保叶子零跨叶依赖·归一同 _normalizeName)。
const _SHELL_TOOLS = new Set(['shellcommand', 'bash', 'executecommand', 'runcommand', 'terminal', 'exec']);
function _normalizeToolName(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}
// 「验证/测试/检查/构建」命令签名:真正跑一遍验证时会出现的命令形态。保守宁缺勿滥——只认明确的
// 测试/检查/构建/lint 命令,不认 `cat x-test.log` 之类偶然含关键字的旁路(要求命令与关键字间有空白)。
const _VERIFY_CMD_RE = new RegExp(
  [
    'npm\\s+(?:run\\s+)?(?:test|check|lint|build|verify|arch|maintainer)',
    'yarn\\s+(?:run\\s+)?(?:test|check|lint|build)', 'pnpm\\s+(?:run\\s+)?(?:test|check|lint|build)',
    'node\\s+--test', 'node\\s+--check',
    '\\bpytest\\b', '\\bjest\\b', '\\bvitest\\b', '\\bmocha\\b', 'go\\s+test', 'cargo\\s+test',
    '\\beslint\\b', '\\btsc\\b', '\\bruff\\b', '\\bflake8\\b',
    'make\\s+(?:test|check|lint)',
    'khy\\s+(?:doctor|metadata\\s+(?:check|refresh))',
    'python\\s+-m\\s+(?:pytest|unittest)',
  ].join('|'),
  'i',
);

// 从一条 toolCallLog 记录里取出命令串(shell 工具的 params.command || params.cmd,兼容顶层 command)。
function _commandOfEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const p = entry.params;
  if (p && typeof p === 'object') {
    if (typeof p.command === 'string') return p.command;
    if (typeof p.cmd === 'string') return p.cmd;
    if (typeof p.script === 'string') return p.script;
    if (Array.isArray(p.command)) return p.command.join(' ');
  }
  if (typeof entry.command === 'string') return entry.command;
  return '';
}

/**
 * 本轮工具执行记录里,是否**真的运行过**一条验证/测试/检查命令。纯函数、绝不抛。
 *
 * 只认 shell 类工具(_SHELL_TOOLS)携带的命令,且命令形态命中 _VERIFY_CMD_RE。这样一段单纯贴在
 * 回复里的「假证据文字」(从未对应真实工具调用)不会被误判为「跑过验证」。
 *   - toolCallLog 非数组 / 空 → false(无从证明跑过 → 保守判「没跑」,让声称验证的回复被再驱动)。
 *   - 单条记录解析失败 → 跳过该条(绝不抛)。
 * @param {Array<object>} toolCallLog - runToolUseLoop 整轮工具调用记录
 * @returns {boolean}
 */
function verificationCommandRan(toolCallLog) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return false;
  for (const entry of toolCallLog) {
    try {
      if (!_SHELL_TOOLS.has(_normalizeToolName(entry && entry.tool))) continue;
      const cmd = _commandOfEntry(entry);
      if (cmd && _VERIFY_CMD_RE.test(cmd)) return true;
    } catch { /* 单条解析失败:跳过,绝不抛 */ }
  }
  return false;
}

// ── 再驱动指令(阻止停止,朝目标继续)────────────────────────────────────
/**
 * 构建目标专属的再驱动指令(注入下一轮 currentMessage)。给模型一个干净二选一:
 * 已达成→出完成报告+调 GoalTool(clear) 收尾;未达成→立即继续推进。镜像 CC 想停时的 re-prompt。
 * @param {object} goal - 活动目标(需 goal.text)
 * @param {object} [opts]
 * @param {string} [opts.userMessage] - 用户原始请求(截断附于末尾,帮模型回锚)
 * @returns {string}
 */
function buildRedriveMessage(goal, { userMessage } = {}) {
  const text = (goal && goal.text) || '';
  return [
    '[SYSTEM: 持久目标尚未确认达成 —— 现在还不能停(对齐 Claude Code /goal 的 Stop hook:目标达成前阻止停止)。',
    `当前目标:「${text}」`,
    '请二选一,不要就此收尾、也不要反问"接下来做什么":',
    '① 若目标其实**已经达成** —— 给出一份明确的完成报告(做了什么 / 如何验证 / 结果),并调用 GoalTool(action=clear) 收尾;',
    '② 若目标**尚未达成** —— 立即继续朝它推进(调用工具、执行下一步),不要停在计划或前言上。',
    userMessage ? `用户原始请求: ${String(userMessage).slice(0, 300)}` : '',
    ']',
  ].filter(Boolean).join('\n');
}

/**
 * 构建「证据缺失」的再驱动指令(注入下一轮 currentMessage)。回复声称验证成功却没贴证据时用:
 * 要求模型**实际运行**验证并把具体输出贴出来,再宣布达成。镜像 Hermes 的 evidence-required 判定。
 * @param {object} goal - 活动目标(需 goal.text)
 * @param {object} [opts]
 * @param {string} [opts.userMessage]
 * @returns {string}
 */
function buildEvidenceRedriveMessage(goal, { userMessage } = {}) {
  const text = (goal && goal.text) || '';
  return [
    '[SYSTEM: 你声称已验证/测试通过,但本轮回复里没有任何**具体证据** —— 现在还不能判定达成',
    '(对齐 Hermes Agent 的 evidence-based verification:只认命令结果 / 测试输出 / 文件摘录,不认空口"已通过")。',
    `当前目标:「${text}」`,
    '请**实际运行**验证,并把具体证据贴出来后再收尾:',
    '① 运行相关测试/检查命令(如 `npm test`、`node --test`、构建、lint),并**原样粘贴**其输出',
    '   (含通过/失败计数、退出码,或关键文件内容摘录);',
    '② 证据确凿地表明目标达成后,再给出完成报告并调用 GoalTool(action=clear) 收尾。',
    userMessage ? `用户原始请求: ${String(userMessage).slice(0, 300)}` : '',
    ']',
  ].filter(Boolean).join('\n');
}

/**
 * 构建「验证从未真正运行」的再驱动指令(注入下一轮 currentMessage)。回复声称验证/测试通过,但整轮
 * 工具执行记录里找不到任何真实跑过的验证命令时用:要求模型**真正调用 shell 执行**验证,而不是把
 * 看起来像输出的文字贴上来。对准 goal「khy 做完任务不会及时验证测试」。
 * @param {object} goal - 活动目标(需 goal.text)
 * @param {object} [opts]
 * @param {string} [opts.userMessage]
 * @returns {string}
 */
function buildVerifyRanRedriveMessage(goal, { userMessage } = {}) {
  const text = (goal && goal.text) || '';
  return [
    '[SYSTEM: 你声称已验证/测试通过,但**本轮从未实际执行过任何验证命令** —— 回复里看起来像结果的文字',
    '没有对应的真实运行记录,现在还不能判定达成(对齐 Claude Code /goal:声称"测试通过"必须真的跑过',
    '测试/检查命令,而不是把像输出的文字贴上来)。',
    `当前目标:「${text}」`,
    '请**真正运行**验证后再收尾:',
    '① 实际调用 shell 执行测试/检查(如 `npm test`、`node --test`、`node --check`、`npm run arch:god`、',
    '   `npm run maintainer:check`),让它真实跑出结果(通过/失败计数、退出码);',
    '② 确认全绿后再给完成报告并调用 GoalTool(action=clear) 收尾。',
    userMessage ? `用户原始请求: ${String(userMessage).slice(0, 300)}` : '',
    ']',
  ].filter(Boolean).join('\n');
}

// ── 编排:想停时的裁决 ───────────────────────────────────────────────────
/**
 * 给定活动目标与本轮最终回复,裁决「是否放行停止」。纯函数、绝不抛。
 *
 * 返回 action:
 *   'pass'    放行停止(门关 / 无目标 / 达成但自动清除关 / within-turn 预算耗尽)。
 *   'clear'   目标已达成且自动清除开 → 调用方执行 goalStore.clearGoal 后放行停止。
 *   'redrive' 目标未达成且预算未耗尽 → 调用方以 message 注入下一轮并 continue(阻止停止)。
 *
 * @param {object} args
 * @param {object|null} [args.goal]        - goalStore.getActiveGoal 的输出
 * @param {string} [args.reply]            - 本轮模型最终回复(strippedReply)
 * @param {number} [args.redriveCount]     - 本轮已再驱动次数(调用方维护的计数器)
 * @param {object} [args.env]
 * @param {string} [args.userMessage]      - 用户原始请求
 * @param {Array<object>} [args.toolCallLog] - 本轮工具执行记录(verify-ran 门用;旧调用方不传 → 该门跳过)
 * @returns {{action:'pass'|'clear'|'redrive', reason:string, message?:string}}
 */
function evaluateGoalStop({ goal, reply, redriveCount, env, userMessage, toolCallLog } = {}) {
  if (!isEnabled(env)) return { action: 'pass', reason: 'gate-off' };
  if (!goal || !goal.text) return { action: 'pass', reason: 'no-goal' };

  let satisfied = false;
  try { satisfied = looksLikeGoalSatisfied(reply); } catch { satisfied = false; }
  if (satisfied) {
    // 证据门(参考 Hermes evidence-based verification):达成判定若建立在一个「验证声称」之上
    // 却拿不出具体证据 → 不放行/不自动清除,而是要求出具证据(有界:走同一 redrive 预算)。
    let evidenceMissing = false;
    if (isEvidenceGateEnabled(env)) {
      try { evidenceMissing = claimsVerificationWithoutEvidence(reply); } catch { evidenceMissing = false; }
    }
    if (evidenceMissing) {
      const maxE = resolveMaxRedrives(env);
      const countE = Number(redriveCount) || 0;
      // 预算耗尽:降级为 pass(放行本轮停止)而非 clear——不自动清除一个未经证实的目标,
      // 让每轮开头的 goalCore 指令注入 + 跨轮轮次预算继续兜底。
      if (countE >= maxE) return { action: 'pass', reason: 'evidence-missing-exhausted' };
      return { action: 'redrive', reason: 'evidence-missing', message: buildEvidenceRedriveMessage(goal, { userMessage }) };
    }

    // Verify-ran 门(goal「khy 做完任务不会及时验证测试」):回复**声称验证通过**,但整轮工具执行
    // 记录里**没有任何真实跑过的验证命令**(贴假证据文字骗过 evidence 门的洞)→ 降级为 redrive,
    // 要求真正跑一遍验证。仅当调用方接线传入 toolCallLog(数组)时生效;不传 → 跳过 → 逐字节回退。
    if (isVerifyRanGateEnabled(env) && Array.isArray(toolCallLog)) {
      let claimsVerify = false;
      try { claimsVerify = _VERIFICATION_CLAIM_RE.test(String(reply == null ? '' : reply).trim()); } catch { claimsVerify = false; }
      let ran = true; // 解析失败偏向「跑过」,绝不误拦真实达成
      try { ran = verificationCommandRan(toolCallLog); } catch { ran = true; }
      if (claimsVerify && !ran) {
        const maxV = resolveMaxRedrives(env);
        const countV = Number(redriveCount) || 0;
        // 预算耗尽:pass(不自动清除一个未经真实验证的目标),交由跨轮轮次预算 + 每轮指令注入兜底。
        if (countV >= maxV) return { action: 'pass', reason: 'verify-not-run-exhausted' };
        return { action: 'redrive', reason: 'verify-not-run', message: buildVerifyRanRedriveMessage(goal, { userMessage }) };
      }
    }

    // Completion contract(参考 Hermes v0.18.0):目标预先声明了"什么叫完成"(完成标准段 / 反引号命令)
    // → 逐条核对证据;声明的标准未被证据全覆盖 → redrive 指名缺哪条(有界:走同一 redrive 预算)。
    // 目标未声明任何标准时 parseCompletionContract 返回空 criteria → 跳过,行为逐字节不变。
    if (isCompletionContractEnabled(env)) {
      let contract = null;
      try { contract = parseCompletionContract(goal.text); } catch { contract = null; }
      if (contract && Array.isArray(contract.criteria) && contract.criteria.length > 0) {
        let matched = null;
        try { matched = matchEvidenceAgainstContract(reply, contract); } catch { matched = null; }
        if (matched && !matched.allMet) {
          const maxC = resolveMaxRedrives(env);
          const countC = Number(redriveCount) || 0;
          // 预算耗尽:pass(不自动清除一个证据不全的目标),交由跨轮轮次预算兜底。
          if (countC >= maxC) return { action: 'pass', reason: 'contract-unmet-exhausted' };
          return { action: 'redrive', reason: 'contract-unmet', message: buildContractRedriveMessage(goal, matched.missing, { userMessage }) };
        }
      }
    }
    return { action: isAutoClearEnabled(env) ? 'clear' : 'pass', reason: 'satisfied' };
  }

  const max = resolveMaxRedrives(env);
  const count = Number(redriveCount) || 0;
  if (count >= max) return { action: 'pass', reason: 'redrive-exhausted' };
  return { action: 'redrive', reason: 'not-satisfied', message: buildRedriveMessage(goal, { userMessage }) };
}

module.exports = {
  isEnabled,
  isAutoClearEnabled,
  isEvidenceGateEnabled,
  isCompletionContractEnabled,
  isVerifyRanGateEnabled,
  GOAL_STOP_GATE_DEFAULT_MAX,
  resolveMaxRedrives,
  looksLikeGoalSatisfied,
  hasConcreteEvidence,
  claimsVerificationWithoutEvidence,
  verificationCommandRan,
  buildRedriveMessage,
  buildEvidenceRedriveMessage,
  buildVerifyRanRedriveMessage,
  evaluateGoalStop,
};
