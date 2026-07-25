'use strict';

/**
 * advisor.js — `/advisor` 命令薄壳:基于实测表现推荐当前最佳可执行模型。对齐 Claude Code 的 /advisor
 * (求一个更优的建议),但**诚实落到 khy 的本地语义**:不伪造云端 reviewer server-tool,而是复用 gateway 的
 * 连通性探测 + ucbRouter 多臂老虎机(成功率×速度的实测回报)给出推荐。
 *
 * **背后逻辑**(语法解析 + 候选/排名合成 + 文本渲染)在纯叶子 services/advisor/advisorPlan.js(单一真源·零 IO);
 * 本薄壳只做:门控、探测候选(委托 gateway.buildGatewayModelChoices)、取 UCB 排名(委托 gateway/ucbRouter.rank)、
 * 把两者交给叶子合成推荐、渲染。绝不另起炉灶,绝不写任何 host/port/model 硬编码 —— 候选与排名全来自既有 SSOT。
 *
 * 诚实边界:本命令是**只读推荐器**,不自动切换模型(切换仍走 /model 人工闸门);无臂统计时如实说明「尚无实测数据」。
 * 探测可能耗时数秒(与 /model 同源探测),期间复用 buildGatewayModelChoices 的 onNotice/onError 流式反馈。
 *
 * 用法:`/advisor [recommend|status|help]`(空参 = recommend)。门控 KHY_ADVISOR_COMMAND 默认开;
 * 关 → 命令不接管(字节回退)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../../services/advisor/advisorPlan');

// try/catch combinator 单一真源 utils/tryOr:执行 fn,任何异常 → dflt。
const _safe = require('../../utils/tryOr');
// async try/catch combinator 单一真源 utils/tryOrAsync:await fn,任何异常 → dflt。
const _safeAsync = require('../../utils/tryOrAsync');

/** 探测可执行候选(委托既有 gateway SSOT,与 /model 同源)。返回 { candidates, empty }。 */
async function _probeCandidates() {
  const gw = _safe(() => require('./gateway'), null);
  if (!gw || typeof gw.buildGatewayModelChoices !== 'function') {
    return { candidates: [], empty: true };
  }
  const built = await _safeAsync(
    () => gw.buildGatewayModelChoices({ onNotice: printInfo, onError: printError }),
    null,
  );
  if (!built || built.empty || !Array.isArray(built.modelChoices)) {
    return { candidates: [], empty: true };
  }
  // modelChoices[].value = { adapter, model };name 是含标记的人面串(可作 label)。
  const candidates = built.modelChoices
    .filter((c) => c && c.value && c.value.adapter)
    .map((c) => ({
      adapter: c.value.adapter,
      model: c.value.model == null ? null : c.value.model,
      label: typeof c.name === 'string' ? c.name : undefined,
    }));
  return { candidates, empty: candidates.length === 0 };
}

/** 取候选 adapter 的 UCB 排名(委托既有 ucbRouter SSOT,纯读不 mutate)。 */
function _rankAdapters(candidates) {
  const router = _safe(() => require('../../services/gateway/ucbRouter'), null);
  if (!router || typeof router.rank !== 'function') return [];
  // 去重 adapter key(候选可能同 adapter 多模型,老虎机按 adapter 学习)。
  const seen = new Set();
  const adapterKeys = [];
  for (const c of candidates) {
    const k = String(c.adapter || '').trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); adapterKeys.push(c.adapter); }
  }
  return _safe(() => router.rank(adapterKeys), []) || [];
}

/**
 * `/advisor` 入口。
 * @param {string} _subCommand
 * @param {string[]} [args]
 * @param {object} [_options]
 * @returns {Promise<boolean>} 是否接管该命令(门控关 → false)。
 */
async function handleAdvisor(_subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('Advisor 命令未启用(KHY_ADVISOR_COMMAND 为关)。');
    return false;
  }

  const parsed = leaf.parseAdvisorArgs(args);

  if (parsed.action === 'help') {
    printInfo(leaf.buildHelpText());
    return true;
  }
  if (!parsed.valid && parsed.parseError === 'unknown_action') {
    printError(leaf.buildUnknownText());
    return true;
  }

  // recommend / status 都需要先探测候选 + 取排名,再交叶子合成。
  const { candidates } = await _probeCandidates();
  const ranking = _rankAdapters(candidates);
  const rec = leaf.buildRecommendation({ candidates, ranking });

  if (parsed.action === 'status') {
    printInfo(leaf.buildStatusText(rec));
    return true;
  }
  printInfo(leaf.buildRecommendText(rec));
  return true;
}

module.exports = { handleAdvisor };
