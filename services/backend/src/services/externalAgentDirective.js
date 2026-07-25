'use strict';

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
  Object.freeze({ id: 'claude', name: 'Claude Code', aliases: Object.freeze(['claude code', 'claude-code', 'claudecode', 'claude']), delegatable: true, adapter: 'claude', blurb: 'Anthropic Claude Code CLI' }),
  Object.freeze({ id: 'codex', name: 'Codex', aliases: Object.freeze(['openai codex', 'codex']), delegatable: true, adapter: 'codex', blurb: 'OpenAI Codex CLI' }),
  Object.freeze({ id: 'opencode', name: 'OpenCode', aliases: Object.freeze(['opencode', 'open code']), delegatable: true, adapter: 'opencode', blurb: 'OpenCode CLI' }),
  Object.freeze({ id: 'cursor', name: 'Cursor', aliases: Object.freeze(['cursor agent', 'cursor-agent', 'cursor']), delegatable: false, adapter: 'cursor', blurb: 'Cursor CLI/agent' }),
  Object.freeze({ id: 'kiro', name: 'Kiro', aliases: Object.freeze(['kiro']), delegatable: false, adapter: 'kiro', blurb: 'Kiro agent' }),
  Object.freeze({ id: 'trae', name: 'Trae', aliases: Object.freeze(['trae']), delegatable: false, adapter: 'trae', blurb: 'Trae IDE agent' }),
  Object.freeze({ id: 'warp', name: 'Warp', aliases: Object.freeze(['warp']), delegatable: false, adapter: 'warp', blurb: 'Warp agent' }),
  Object.freeze({ id: 'windsurf', name: 'Windsurf', aliases: Object.freeze(['windsurf']), delegatable: false, adapter: 'windsurf', blurb: 'Windsurf agent' }),
]);

// 驱动/委派动词(双语)。命中任一即视为「要把任务交出去」的意图,与 agent 点名两命中才接管
// (零假阳性:单出现 "cursor"/"claude" 而无驱动动词 → 不接管,避免误伤「光标位置」「clause」类噪音)。
const DRIVE_VERB_RE = /(用|使用|让|叫|请|派|交给|委派|驱动|切到|切换到|调用|喊|找|拉起|启动|跑一下|帮我用|帮我叫|use\b|drive\b|delegate\b|hand[\s-]?off|hand it to|ask\b|have\b|let\b|run (?:it |this |the task )?(?:with|on|through|via)|spawn\b|switch to|kick off|fire up|launch\b)/i;

// 收敛到 utils/toLowerCaseSafe 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/toLowerCaseSafe');

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
    if (!isExternalAgentNudgeEnabled(env)) return null;
    const text = _norm(message);
    if (!text) return null;
    if (!DRIVE_VERB_RE.test(text)) return null; // 无驱动动词 → 不接管
    for (const agent of EXTERNAL_AGENTS) {
      for (const alias of agent.aliases) {
        // 词界匹配:别名两侧非字母数字(中文/标点/空白/首尾均可),避免 "clause"/"discourse" 类子串误命中。
        const idx = text.indexOf(alias);
        if (idx < 0) continue;
        const before = idx === 0 ? '' : text[idx - 1];
        const after = idx + alias.length >= text.length ? '' : text[idx + alias.length];
        const isWordChar = (c) => c !== '' && /[a-z0-9]/.test(c);
        if (isWordChar(before) || isWordChar(after)) continue; // 子串命中(前后仍是字母数字)→ 跳过
        return { id: agent.id, name: agent.name, delegatable: agent.delegatable, adapter: agent.adapter, blurb: agent.blurb };
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
    if (!hit) return '';
    if (hit.delegatable) {
      return [
        '[SYSTEM:外部 agent 路由]',
        `用户明确要求用 ${hit.name}(${hit.blurb})完成本任务。请立即调用 Agent 工具委派:`,
        `  subagent_type: '${hit.id}'`,
        '  prompt: 写成**自包含**的完整任务描述——外部 agent 看不到本次对话历史,必须把目标、涉及文件的绝对路径、约束、期望产出全部写进 prompt。',
        '不要自己内联去做这件事,也不要只是口头说「交给它」;真的发起这一次 Agent 工具调用。',
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
    if (!isExternalAgentDirectiveEnabled(env)) return '';
    const delegatable = EXTERNAL_AGENTS.filter((a) => a.delegatable);
    const launchOnly = EXTERNAL_AGENTS.filter((a) => !a.delegatable);
    const delLines = delegatable
      .map((a) => `- \`subagent_type: '${a.id}'\` → ${a.name}(${a.blurb})`)
      .join('\n');
    const launchLine = launchOnly.map((a) => `\`khy ${a.id}\``).join(' / ');
    return [
      '## 驱动其它 agent / Driving other agents',
      '',
      '你可以用自然语言把**整个任务**交给外部编码 CLI agent,而不必自己内联硬啃。经 Agent 工具的 `subagent_type` 委派:',
      delLines,
      '',
      '何时委派:用户在自然语言里明确点名某外部 agent(「用 claude code 帮我…」「让 codex 跑测试」「叫 opencode 改这个」),或某任务更适合交给一个完整的外部 agent 独立完成时。',
      '委派要点:被委派的 agent **看不到本次对话历史**——`prompt` 必须自包含(目标 + 涉及文件的绝对路径 + 约束 + 期望产出)。委派后如常读取它的结果并向用户汇报。',
      '',
      `其它可用 agent 作为**顶层会话**运行(不能经 subagent_type 委派):${launchLine}——需要时提示用户用对应命令启动。`,
    ].join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  isExternalAgentDirectiveEnabled,
  isExternalAgentNudgeEnabled,
  detectExternalAgentRequest,
  buildExternalAgentNudge,
  buildExternalAgentDirective,
  EXTERNAL_AGENTS,
};
