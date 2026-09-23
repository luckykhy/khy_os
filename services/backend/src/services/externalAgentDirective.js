'use strict';

// RULES-REGISTRY: PROCESS-004

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 toolTierCatalog.js / procedureCatalog.js /
//   roundAdvanceAssessor.js 的形状——_isEnabled 委托 flagRegistry(注册表异常/关时逐字节
//   回退 OFF_VALUES 手写判定);判定全在叶子、零 I/O、确定性(无时钟/随机)、绝不抛、门关返
//   ''/null;接线(prompts.js _codingProfile 注入能力指令 / toolUseLoop 首轮注入点名 nudge)
//   只做 IO、包一层 try/catch fail-soft。别把匹配逻辑写进接线处、别漏 try/catch、别让叶子抛。

/**
 * externalAgentDirective.js — 纯叶子:让 khyos「学会用自然语言驱动别的 agent(Claude Code /
 * Codex / OpenCode 等)」的**意识 + 确定性路由**单一真源。
 *
 * 诉求(goal 2026-07-07「让 khyos 自己学会使用自然语言驱动别的 agent 如 claude code 等」):
 * 执行链早已成熟——AgentTool 支持 subagent_type:'claude'|'codex'|'opencode' 经各 CLI 适配器
 * (cliToolAdapter/claudeAdapter/codexAdapter/opencodeAdapter)真 spawn 外部 agent;
 * agentLauncherRegistry 支持 `khy <agent>` 顶层启动 claude/codex/cursor/kiro/trae/opencode/
 * warp/vscode/windsurf。真缺口是弱模型主题的两处**认知**层面:
 *
 *   缺口 A(意识)——coding profile 从不告诉模型「你能把整个任务委派给外部 CLI agent」。
 *     procedureCatalog 教流程、toolTierCatalog 教工具分级,但没有一处教「可以把活交给 Claude
 *     Code / Codex / OpenCode」。弱模型不会自己发现 subagent_type:'claude'。
 *   缺口 B(确定性 NL 解析)——用户自然语言明确点名外部 agent(「用 claude code 帮我重构」
 *     「让 codex 跑测试」「叫 opencode 改这个」)时,没有确定性识别把弱模型引到正确路由,
 *     全靠模型开盲盒。
 *
 * 本叶子补这两处(不重复造执行链):
 *   buildExternalAgentDirective(env)  —— 始终注入的能力指令(镜像 toolTierCatalog.buildTierDirective)。
 *   detectExternalAgentRequest(msg,env) —— 确定性识别「点名某外部 agent + 驱动动词」两命中才接管
 *                                          (镜像 nlExternalAppResolver 的「app 名 + 动作词」零假阳性闸门)。
 *   buildExternalAgentNudge(msg,env)  —— 命中时产一次性 [SYSTEM] 路由 nudge,逼模型真的用 Agent 工具
 *                                          委派(delegatable)或提示顶层 `khy <name>` 启动(launch-only)。
 *
 * 与既有件的关系(不重复造):
 *  - AgentTool(subagent_type/adapter)—— 真正的执行工具;本叶子只教模型它存在 + 点名时指对路。
 *  - agentLauncherRegistry —— `khy <agent>` 顶层启动的 SSOT;本叶子的 launch-only 项与之对齐但服务于
 *    对话中的 NL 识别(不接管顶层命令解析)。
 *  - nlExternalAppResolver / nlExternalAppImportResolver —— 处理「给外部 app 配模型 / 反向导入外部 app
 *    的模型」;本叶子处理「把任务本身交给外部 agent 跑」,三者互不接管(不同意图面)。
 *
 * 委派边界补充(2026-09-16「khyos 经常莫名其妙把活甩给 claude code / opencode」):
 *     既有缺口是「可以委派」被教了、「什么时候不许委派」没人教。本叶子在保持上述能力的同时补上准入侧:
 *     `DELEGATION_GATES` 是三闸门(G1 用户点名 / G2 能力缺失 / G3 隔离要求)的单一真源,
 *     `evaluateDelegationAdmission()` 是准入判定的执行点(**默认自做**,缺证据即 deny,异常 fail-closed)。
 *     语义真源 docs/10_规范/其它规范/[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md;规则 PROCESS-004。
 *
 * 契约:纯叶子——零 I/O、确定性、绝不抛(fail-soft)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_EXTERNAL_AGENT_DIRECTIVE  默认 on(parent KHY_WEAK_MODEL_GUIDANCE)——能力指令总开关。
 *     父/子任一关 ⇒ buildExternalAgentDirective 返 ''、_codingProfile 逐字节回退(不注入该段)。
 *   KHY_EXTERNAL_AGENT_NUDGE      默认 on(parent KHY_EXTERNAL_AGENT_DIRECTIVE)——首轮点名 nudge 开关。
 *     父/子任一关 ⇒ detectExternalAgentRequest 返 null、buildExternalAgentNudge 返 ''、注入点逐字节回退。
 *
 * @module services/externalAgentDirective
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 能力指令总开关(parent KHY_WEAK_MODEL_GUIDANCE)。默认 on。 */
function isExternalAgentDirectiveEnabled(env) {
  return _isEnabled('KHY_EXTERNAL_AGENT_DIRECTIVE', env);
}

/** 首轮点名 nudge 开关(parent KHY_EXTERNAL_AGENT_DIRECTIVE)。默认 on。 */
function isExternalAgentNudgeEnabled(env) {
  return _isEnabled('KHY_EXTERNAL_AGENT_NUDGE', env);
}

/**
 * 可驱动的外部 agent 注册表(单一真源·冻结)。
 *   id          — 规范标识(delegatable 项即 AgentTool 的 subagent_type;launch-only 项即 `khy <id>`)。
 *   name        — 人类可读名(nudge 文案用)。
 *   aliases     — 双语 NL 关键词(小写匹配);越具体越靠前,避免与普通词碰撞。
 *   delegatable — true = 可经 Agent 工具 subagent_type 委派;false = 仅顶层 `khy <id>` 会话启动。
 *   adapter     — 网关适配器 key(与 agentLauncherRegistry.adapterKey 对齐)。
 *   blurb       — 一句话说明。
 */
const EXTERNAL_AGENTS = Object.freeze([
  Object.freeze({
    id: 'claude',
    name: 'Claude Code',
    aliases: Object.freeze(['claude code', 'claude-code', 'claudecode', 'claude']),
    delegatable: true,
    adapter: 'claude',
    blurb: 'Anthropic Claude Code CLI',
  }),
  Object.freeze({
    id: 'codex',
    name: 'Codex',
    aliases: Object.freeze(['openai codex', 'codex']),
    delegatable: true,
    adapter: 'codex',
    blurb: 'OpenAI Codex CLI',
  }),
  Object.freeze({
    id: 'opencode',
    name: 'OpenCode',
    aliases: Object.freeze(['opencode', 'open code']),
    delegatable: true,
    adapter: 'opencode',
    blurb: 'OpenCode CLI',
  }),
  Object.freeze({
    id: 'cursor',
    name: 'Cursor',
    aliases: Object.freeze(['cursor agent', 'cursor-agent', 'cursor']),
    delegatable: false,
    adapter: 'cursor',
    blurb: 'Cursor CLI/agent',
  }),
  Object.freeze({
    id: 'kiro',
    name: 'Kiro',
    aliases: Object.freeze(['kiro']),
    delegatable: false,
    adapter: 'kiro',
    blurb: 'Kiro agent',
  }),
  Object.freeze({
    id: 'trae',
    name: 'Trae',
    aliases: Object.freeze(['trae']),
    delegatable: false,
    adapter: 'trae',
    blurb: 'Trae IDE agent',
  }),
  Object.freeze({
    id: 'warp',
    name: 'Warp',
    aliases: Object.freeze(['warp']),
    delegatable: false,
    adapter: 'warp',
    blurb: 'Warp agent',
  }),
  Object.freeze({
    id: 'windsurf',
    name: 'Windsurf',
    aliases: Object.freeze(['windsurf']),
    delegatable: false,
    adapter: 'windsurf',
    blurb: 'Windsurf agent',
  }),
]);

// 驱动/委派动词(双语)。命中任一即视为「要把任务交出去」的意图,与 agent 点名两命中才接管
// (零假阳性:单出现 "cursor"/"claude" 而无驱动动词 → 不接管,避免误伤「光标位置」「clause」类噪音)。
const DRIVE_VERB_RE =
  /(用|使用|让|叫|请|派|交给|委派|驱动|切到|切换到|调用|喊|找|拉起|启动|跑一下|帮我用|帮我叫|use\b|drive\b|delegate\b|hand[\s-]?off|hand it to|ask\b|have\b|let\b|run (?:it |this |the task )?(?:with|on|through|via)|spawn\b|switch to|kick off|fire up|launch\b)/i;

// 收敛到 utils/toLowerCaseSafe 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/toLowerCaseSafe');

// ─── 委派边界（PROCESS-004 / [DESIGN-PROCESS-001]）──────────────────────────────
// 语义真源：docs/10_规范/其它规范/[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md
// 默认档是「自做」：委派是例外，必须命中三闸门之一并携带可核验证据，缺则一律不委派。
// 本节是那条规则的**代码真源**（闸门集合 + 准入判定），守卫 scripts/ci/check-delegation-boundary.js
// 断言它不漂离规范 §3 的表格。

/** 默认档标记：注入文案必须携带它，守卫按字面断言（§2「默认档是自做，不是委派」）。 */
const SELF_FIRST_MARKER = '默认自做';

/**
 * 委派准入闸门（冻结·单一真源）。id 与 key 必须与 [DESIGN-PROCESS-001] §3 表格逐项一致。
 *   id       — 规则文本里的闸门编号（规范与代码共用同一套编号）。
 *   key      — 机器可读标识（准入判定的输入字段名与台账字段）。
 *   label    — 人类可读名（文案与拒绝理由用）。
 *   evidence — 该闸门成立所必需的证据字段；空数组 = 无需额外证据（用户原话即证据）。
 */
const DELEGATION_GATES = Object.freeze([
  Object.freeze({ id: 'G1', key: 'user-named', label: '用户点名', evidence: Object.freeze(['userNamedAgentId']) }),
  Object.freeze({ id: 'G2', key: 'capability-gap', label: '能力缺失', evidence: Object.freeze(['capabilityGap', 'reason']) }),
  Object.freeze({ id: 'G3', key: 'isolation-required', label: '隔离要求', evidence: Object.freeze(['isolationRequired', 'isolationNote']) }),
]);

/** 各闸门在注入文案里的「何时成立」一句话（与 [DESIGN-PROCESS-001] §3 判据列同义）。 */
const _GATE_WHEN = Object.freeze({
  G1: '本轮用户明确点名某外部 agent 要它做这件事(「用 claude code 帮我…」「让 codex 跑测试」)。',
  G2: 'khy 本地确实没有完成该任务的工具 / 服务 / 技能,且你能指出缺的是哪一项。',
  G3: '任务必须在隔离的外部环境里执行,或本地执行会污染、破坏工作区。',
});

/**
 * 不可核验的委派理由措辞（§5.3 禁止「模型自认为更适合」）。命中即判 deny。
 * 注意：本列表只用于**判定理由**，不是文案黑名单——注入文案里出现这些词（作为反例警示教育）
 * 是允许且必要的，守卫断言的是「不得出现开放式授权句式」，两者不同。
 */
const VAGUE_REASON_RE =
  /(更适合交给|更合适交给|更适合由外部|更强|更快|更省事|更顺手|顺手丢|讨好|帮你省事|suits? an external|better suited|just easier|more capable than)/i;

/**
 * 委派闸门标记：模型发起外部委派时必须在 prompt 里写出的自声明标记。
 * 两重作用：① 让「用户点名」这一确定性事实从注入点一路传到工具调用点（工具看不到用户原文）；
 * ② 让准入判定在工具侧可机判——没有标记即视为没有闸门，fail-closed 回自做。
 * 中英双语，大小写不敏感。
 */
const DELEGATION_GATE_MARKER_RE = /\[\s*(?:委派闸门|delegation[-\s]?gate)\s*[:：]?\s*(G[123])\s*\]/i;

/** 取一个闸门的定义（未知 id → null）。纯函数，绝不抛。 */
function getDelegationGate(id) {
  try {
    const want = String(id || '').trim().toUpperCase();
    return DELEGATION_GATES.find((g) => g.id === want) || null;
  } catch {
    return null;
  }
}

/** 从一段文本里读出模型自声明的委派闸门 id（无标记 → null）。纯函数，绝不抛。 */
function detectDelegationGateInText(text) {
  try {
    const match = DELEGATION_GATE_MARKER_RE.exec(String(text || ''));
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/** 证据字段是否非空（字符串非空白 / 数组含非空白项）。 */
function _hasEvidence(value) {
  if (Array.isArray(value)) return value.some((item) => String(item == null ? '' : item).trim() !== '');
  return typeof value === 'string' ? value.trim() !== '' : value === true;
}

/**
 * 委派准入判定（PROCESS-004 的执行点）。
 *
 * 默认自做：只有命中三闸门之一且证据齐备才返回 allowed:true；其余一律 deny。
 * 契约：纯函数、确定性、零 I/O、绝不抛；无法判定时返回 deny（fail-closed —— 失败方向
 * 必须落在「自做」这一侧，绝不能因为判定异常而放行委派）。
 *
 * @param {object} [input]
 * @param {string} [input.userNamedAgentId]   G1：用户本轮点名的外部 agent id（通常来自 detectExternalAgentRequest）
 * @param {boolean} [input.userNamed]         G1 的等价布尔写法（true 即视为用户已点名）
 * @param {string|string[]} [input.capabilityGap] G2：khy 本地缺失的能力清单
 * @param {boolean} [input.isolationRequired] G3：任务是否必须在隔离的外部环境执行
 * @param {string} [input.isolationNote]      G3：为什么本地做不到 / 为什么必须在外面
 * @param {string} [input.reason]             一句话可核验理由（G2 必需；G3 可由 isolationNote 代替）
 * @param {boolean} [input.selfCapable]       调用方声明本地能覆盖 ⇒ 无条件 deny（§5.2）
 * @param {object} [env]
 * @returns {{allowed:boolean, gate:(string|null), gateKey:(string|null), code:string, reason:string}}
 */
function evaluateDelegationAdmission(input, env) {
  const deny = (code, reason) => ({ allowed: false, gate: null, gateKey: null, code, reason });
  try {
    // 认知层总闸关 ⇒ 外部 agent 面整体关闭，不存在合法委派。
    if (!isExternalAgentDirectiveEnabled(env)) {
      return deny('awareness-off', '外部智能体能力指令已关闭（KHY_EXTERNAL_AGENT_DIRECTIVE），不作委派');
    }
    const req = input && typeof input === 'object' ? input : {};

    // §5.2 本地已覆盖时禁止委派——这一条优先于所有闸门。
    if (req.selfCapable === true) {
      return deny('self-capable', 'khy 本地能力已覆盖该任务，按默认档自做（§5.2）');
    }

    const reason = typeof req.reason === 'string' ? req.reason.trim() : '';
    const vague = reason !== '' && VAGUE_REASON_RE.test(reason);

    // ── G1 用户点名：用户原话即证据，无需额外举证；理由（若有）不参与判定 ──
    const named =
      (typeof req.userNamedAgentId === 'string' && req.userNamedAgentId.trim() !== '') ||
      req.userNamed === true;
    if (named) {
      return {
        allowed: true,
        gate: 'G1',
        gateKey: 'user-named',
        code: 'allowed',
        reason: '用户在本轮明确点名了该外部智能体（闸门 G1）',
      };
    }

    // ── G2 能力缺失：必须能指名缺哪一项，且理由不得是不可核验措辞 ──
    if (_hasEvidence(req.capabilityGap)) {
      if (!reason) return deny('missing-evidence', 'G2 未附带理由，无法核验能力缺失');
      if (vague) return deny('vague-reason', 'G2 的理由不可核验（禁止「更适合/更强/更省事」类措辞，§5.3）');
      const gap = Array.isArray(req.capabilityGap)
        ? req.capabilityGap.map((x) => String(x).trim()).filter(Boolean).join('、')
        : String(req.capabilityGap).trim();
      return {
        allowed: true,
        gate: 'G2',
        gateKey: 'capability-gap',
        code: 'allowed',
        reason: `本地缺失能力：${gap}`,
      };
    }

    // ── G3 隔离要求：必须说明为什么本地做不到 / 为什么必须在外面 ──
    if (req.isolationRequired === true) {
      const note = (typeof req.isolationNote === 'string' ? req.isolationNote.trim() : '') || reason;
      if (!note) return deny('missing-evidence', 'G3 未说明隔离原因');
      if (vague) return deny('vague-reason', 'G3 的理由不可核验（§5.3）');
      return {
        allowed: true,
        gate: 'G3',
        gateKey: 'isolation-required',
        code: 'allowed',
        reason: `隔离要求：${note}`,
      };
    }

    // ── 三闸门都不成立：默认自做（这是常态分支，不是异常） ──
    return deny('no-gate', '未命中任何委派闸门（G1/G2/G3），按默认档由 khy 自做');
  } catch {
    // fail-closed：判定异常一律不委派。
    return { allowed: false, gate: null, gateKey: null, code: 'fail-soft', reason: '委派准入判定异常，已回退自做' };
  }
}


/**
 * 确定性识别用户是否在自然语言里点名要驱动某外部 agent。
 * 两命中闸门(零假阳性):必须同时出现 ①某已知 agent 的别名 ②驱动/委派动词。
 * 多 agent 同现时按注册表顺序取第一个命中者(delegatable 项优先靠前)。
 * 纯函数,绝不抛;门关或未命中 → null。
 *
 * @param {string} message 用户消息原文
 * @param {object} [env]
 * @returns {{id:string,name:string,delegatable:boolean,adapter:string,blurb:string}|null}
 */
function detectExternalAgentRequest(message, env) {
  try {
    if (!isExternalAgentNudgeEnabled(env)) {
      return null;
    }
    const text = _norm(message);
    if (!text) {
      return null;
    }
    if (!DRIVE_VERB_RE.test(text)) {
      return null;
    } // 无驱动动词 → 不接管
    for (const agent of EXTERNAL_AGENTS) {
      for (const alias of agent.aliases) {
        // 词界匹配:别名两侧非字母数字(中文/标点/空白/首尾均可),避免 "clause"/"discourse" 类子串误命中。
        const idx = text.indexOf(alias);
        if (idx < 0) {
          continue;
        }
        const before = idx === 0 ? '' : text[idx - 1];
        const after = idx + alias.length >= text.length ? '' : text[idx + alias.length];
        const isWordChar = (c) => c !== '' && /[a-z0-9]/.test(c);
        if (isWordChar(before) || isWordChar(after)) {
          continue;
        } // 子串命中(前后仍是字母数字)→ 跳过
        return {
          id: agent.id,
          name: agent.name,
          delegatable: agent.delegatable,
          adapter: agent.adapter,
          blurb: agent.blurb,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 命中时产一次性 [SYSTEM] 路由 nudge——逼弱模型真的把任务交出去,而非内联硬啃。
 * 纯函数,绝不抛;门关或未命中 → ''。
 *
 * @param {string} message
 * @param {object} [env]
 * @returns {string}
 */
function buildExternalAgentNudge(message, env) {
  try {
    const hit = detectExternalAgentRequest(message, env);
    if (!hit) {
      return '';
    }
    if (hit.delegatable) {
      // 点名即 G1 成立——把这一确定性事实**随委派调用一起传下去**:模型必须把
      // `[委派闸门 G1]` 写进 prompt 首行,工具侧的准入判定据此放行(工具看不到用户原文,
      // 没有这条标记就无法区分「用户点名」与「模型自己想去外包」)。
      return [
        '[SYSTEM:外部 agent 路由]',
        `用户明确要求用 ${hit.name}(${hit.blurb})完成本任务——委派闸门 **G1 用户点名** 已成立。请立即调用 Agent 工具委派:`,
        `  subagent_type: '${hit.id}'`,
        '  prompt: 写成**自包含**的完整任务描述——外部 agent 看不到本次对话历史,必须把目标、涉及文件的绝对路径、约束、期望产出全部写进 prompt。',
        '  prompt **首行必须是闸门标记**: `[委派闸门 G1]` ——没有这个标记,委派会被准入判定拒绝并回退 khy 自做。',
        '不要自己内联去做这件事,也不要只是口头说「交给它」;真的发起这一次 Agent 工具调用,并在回复用户时声明「已交给 X(闸门 G1)」。',
      ].join('\n');
    }
    return [
      '[SYSTEM:外部 agent 路由]',
      `用户点名 ${hit.name}(${hit.blurb})。它作为**顶层会话**运行,不能经 Agent 工具的 subagent_type 委派。`,
      `请告知用户可用 \`khy ${hit.id}\` 启动该 agent 的独立会话;若当前任务可由 khy 自身或可委派的 agent(claude/codex/opencode)完成,则说明并按用户意愿继续。`,
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * 始终注入 coding profile 的能力指令(镜像 toolTierCatalog.buildTierDirective)——让模型知道
 * 「可以用自然语言把整个任务交给外部 CLI agent」这一能力存在,以及点名时该怎么路由。
 * 纯函数,绝不抛;门关 → ''(逐字节回退,不注入)。
 *
 * @param {object} [env]
 * @returns {string}
 */
function buildExternalAgentDirective(env) {
  try {
    if (!isExternalAgentDirectiveEnabled(env)) {
      return '';
    }
    const delegatable = EXTERNAL_AGENTS.filter((a) => a.delegatable);
    const launchOnly = EXTERNAL_AGENTS.filter((a) => !a.delegatable);
    const delLines = delegatable
      .map((a) => `- \`subagent_type: '${a.id}'\` → ${a.name}(${a.blurb})`)
      .join('\n');
    const launchLine = launchOnly.map((a) => `\`khy ${a.id}\``).join(' / ');
    const gateLines = DELEGATION_GATES
      .map((g) => `- **${g.id} ${g.label}** —— ${_GATE_WHEN[g.id]}`)
      .join('\n');
    return [
      '## 驱动其它 agent / Driving other agents',
      '',
      `**${SELF_FIRST_MARKER}。** 先由 khy 自己做完；只有命中下面三闸门之一,才可以把任务交给外部编码 CLI agent。`,
      gateLines,
      '',
      '禁止:以「它更强 / 更快 / 更省事 / 更顺手」为理由委派(闸门 G2 的证据只能是**可复查的缺失能力清单**);把重构、跨文件改动、大规模实现、迁移、端到端实现、调研、设计、验收这类 khy 自有能力外包;先扔出去试、不行再自己做;把理解与裁决外包。',
      '用户没有点名、也没有可核验的能力缺失或隔离要求时,**自己做完**,不要委派。',
      '',
      '经 Agent 工具的 `subagent_type` 委派(外部 agent **看不到本次对话历史**,`prompt` 必须自包含:目标 + 涉及文件的绝对路径 + 约束 + 期望产出):',
      delLines,
      '',
      '委派时必须在 prompt 首行写出闸门标记( `[委派闸门 G1]` / `[委派闸门 G2]` / `[委派闸门 G3]` 之一;没有标记的委派会被准入判定拒绝并回退自做),并在回复用户时显式声明「已交给 X(闸门 Gn)」。',
      '',
      `其它可用 agent 作为**顶层会话**运行(不能经 subagent_type 委派):${launchLine}——需要时提示用户用对应命令启动。`,
    ].join('\n');
  } catch {
    return '';
  }
}

// ─── A2A Integration ────────────────────────────────────────────────────────

/**
 * Send task to external agent via A2A protocol.
 * @param {string} agentId - External agent ID
 * @param {object} task - Task payload
 * @returns {Promise<object|null>} A2A routing result or null if A2A unavailable
 */
async function sendToExternalAgentA2A(agentId, task) {
  try {
    const { getA2A } = require('./a2aFacade');
    const a2a = getA2A();
    
    // Register external agent if not already registered
    const existingAgent = a2a.getAgent(agentId);
    if (!existingAgent) {
      a2a.registerAgent({
        id: agentId,
        name: agentId,
        type: 'external',
        capabilities: ['external_execution'],
      });
    }
    
    // Send task via A2A
    return await a2a.submitTask(agentId, task);
  } catch (error) {
    // A2A not available or routing failed
    return null;
  }
}

/**
 * Find external agents by capability via A2A.
 * @param {string} capability
 * @returns {object[]}
 */
function findExternalAgentsByCapabilityA2A(capability) {
  try {
    const { getA2A } = require('./a2aFacade');
    const a2a = getA2A();
    return a2a.findAgentsByCapability(capability);
  } catch {
    return [];
  }
}

module.exports = {
  isExternalAgentDirectiveEnabled,
  isExternalAgentNudgeEnabled,
  detectExternalAgentRequest,
  buildExternalAgentNudge,
  buildExternalAgentDirective,
  EXTERNAL_AGENTS,
  // 委派边界（PROCESS-004 / [DESIGN-PROCESS-001]）
  DELEGATION_GATES,
  SELF_FIRST_MARKER,
  DELEGATION_GATE_MARKER_RE,
  getDelegationGate,
  detectDelegationGateInText,
  evaluateDelegationAdmission,
  // A2A integration
  sendToExternalAgentA2A,
  findExternalAgentsByCapabilityA2A,
};
