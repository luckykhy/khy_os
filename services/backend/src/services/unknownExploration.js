'use strict';

/**
 * unknownExploration.js — 面对「未知」时的主动探索决策(纯函数,零依赖)。
 *
 * 为什么存在(提升 Khy-os 对未知的鲁棒性):
 *   KHY 现有的「未知处理」防呆扎实——永不静默、永不白屏、永不裸抛——但所有终态都是
 *   「提问用户 / 降级人工 / 诚实放弃」。当 agent 遇到不认识的工具、陌生的概念/库,或
 *   无法归类的错误时,它不会主动去「查一下」,只会凭已有知识硬猜或把未知推回给用户。
 *
 *   本模块补上那条缺失的反射弧:在 agent 即将「放弃」之前,根据**结构化失败信号**
 *   (而非散文)判断这是哪一类知识缺口,并选出一次**有界**的主动探索动作:
 *     - list_tools  : 调了不存在/用错的工具 → 给出真实可用工具清单,让它重选(不依赖网络)
 *     - web_search  : 像是陌生概念/报错 且能联网 → 先检索事实再作答
 *     - inspect_env : 陌生情况但断网 → 先探查本地环境(读文件/--help/查依赖)获取事实
 *
 *   它只产出「该探索什么 + 注入给模型的指令」,不自己执行;执行仍由 loop 的下一轮在
 *   真实工具体系里完成。探索次数由调用方用计数器硬限制(MAX_PROBES),探索仍失败则回到
 *   原有的降级/放弃链——主动尝试一次,而不是无限纠缠,也不是一遇未知就躺平。
 */

const DEFAULT_MAX_PROBES = 2;

const _NETWORK_RE = /network|timeout|etimedout|econnrefused|econnreset|enotfound|offline|无法连接|超时|404|503/i;

/**
 * 从结构化失败信号识别知识缺口的类型。不解析模型散文判断对错,只看工具层信号。
 *
 * @param {object} signals
 * @param {string[]} [signals.errors] - 本轮各工具的小写错误文本(loop 已聚合)。
 * @param {boolean} [signals.hasUnknownTool] - 是否出现 "unknown tool"。
 * @param {boolean} [signals.hasNetwork] - 是否出现网络类错误。
 * @param {number}  [signals.consecutiveFailures] - 连续失败轮数。
 * @returns {{ hasGap: boolean, gapType: string|null, hasNetwork: boolean }}
 *   gapType ∈ 'unknown_tool' | 'tool_misuse' | 'persistent_failure'
 */
function detectKnowledgeGap(signals = {}) {
  const errors = Array.isArray(signals.errors)
    ? signals.errors.map((e) => String(e || '').toLowerCase())
    : [];
  const hasUnknownTool = signals.hasUnknownTool === true
    || errors.some((e) => e.includes('unknown tool'));
  const hasNetwork = signals.hasNetwork === true
    || errors.some((e) => _NETWORK_RE.test(e));
  const hasMisuse = errors.some((e) => e.includes('validation failed')
    || e.includes('invalid') || e.includes('missing required'));
  const consecutiveFailures = Number.isFinite(signals.consecutiveFailures)
    ? signals.consecutiveFailures : 0;

  if (hasUnknownTool) return { hasGap: true, gapType: 'unknown_tool', hasNetwork };
  if (hasMisuse) return { hasGap: true, gapType: 'tool_misuse', hasNetwork };
  if (consecutiveFailures > 0) return { hasGap: true, gapType: 'persistent_failure', hasNetwork };
  return { hasGap: false, gapType: null, hasNetwork };
}

/**
 * 选一次主动探索动作。预算耗尽或无缺口时返回 null,调用方据此回到原降级链。
 *
 * @param {{hasGap:boolean,gapType:string,hasNetwork:boolean}} gap
 * @param {object} ctx
 * @param {Array<{name:string,description?:string}>} [ctx.availableTools] - 真实可用工具。
 * @param {boolean} [ctx.searchAvailable] - web 检索是否可用(默认从 availableTools 推断)。
 * @param {number} [ctx.probesUsed] - 已用探索次数。
 * @param {number} [ctx.maxProbes] - 探索上限(默认 2)。
 * @returns {{ action: string, directive: string }|null}
 */
function planProbe(gap, ctx = {}) {
  if (!gap || !gap.hasGap) return null;
  const maxProbes = Number.isFinite(ctx.maxProbes) ? ctx.maxProbes : DEFAULT_MAX_PROBES;
  const probesUsed = Number.isFinite(ctx.probesUsed) ? ctx.probesUsed : 0;
  if (probesUsed >= maxProbes) return null;

  const tools = Array.isArray(ctx.availableTools) ? ctx.availableTools : [];
  const searchAvailable = typeof ctx.searchAvailable === 'boolean'
    ? ctx.searchAvailable
    : tools.some((t) => /search|web_?fetch|retriev|联网|检索/i.test(String(t && t.name)));

  // 未知工具 / 用错工具:先把真实清单摆出来让模型重选 —— 与网络无关,最该先做。
  if (gap.gapType === 'unknown_tool' || gap.gapType === 'tool_misuse') {
    return { action: 'list_tools', directive: _listToolsDirective(tools, gap.gapType) };
  }

  // 持续失败 = 多半撞上了知识盲区:能联网就先检索事实,断网则探查本地环境。
  if (searchAvailable && !gap.hasNetwork) {
    return { action: 'web_search', directive: _webSearchDirective() };
  }
  return { action: 'inspect_env', directive: _inspectEnvDirective(gap.hasNetwork) };
}

const _MAX_TOOLS_LISTED = 40;

function _listToolsDirective(tools, gapType) {
  const lines = [];
  for (const t of tools.slice(0, _MAX_TOOLS_LISTED)) {
    const name = String((t && t.name) || '').trim();
    if (!name) continue;
    const desc = String((t && t.description) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    lines.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
  }
  const head = gapType === 'unknown_tool'
    ? '你调用了**不存在**的工具,导致连续失败。'
    : '你的工具调用参数有误(校验失败),导致连续失败。';
  const list = lines.length ? lines.join('\n') : '(当前无可用工具)';
  return `[SYSTEM: ${head}下面是当前**真实可用**的工具清单,请只从中选择、用正确的名称与参数重试,`
    + `不要再凭印象编造工具名或参数:\n${list}\n先选对工具,再继续完成任务。]`;
}

function _webSearchDirective() {
  return '[SYSTEM: 你似乎遇到了**不熟悉的概念、库或报错信息**,仅凭已有知识难以判断。'
    + '请**先主动用 web_search 工具检索**相关事实(把陌生的术语或报错原文作为查询),'
    + '拿到可靠信息后再继续——不要凭猜测作答,也不要直接放弃。]';
}

function _inspectEnvDirective(offline) {
  const why = offline ? '当前无法联网检索,' : '';
  return `[SYSTEM: 你似乎遇到了**不熟悉的情况**,${why}请**先主动探查本地环境**来获取事实:`
    + '阅读相关文件、运行带 --help/--version 的命令、查看目录结构或依赖状态,'
    + '据此推断这个未知概念/错误的真相,再决定下一步。先查清事实,不要直接放弃。]';
}

module.exports = {
  detectKnowledgeGap,
  planProbe,
  DEFAULT_MAX_PROBES,
  _listToolsDirective,
  _webSearchDirective,
  _inspectEnvDirective,
};
