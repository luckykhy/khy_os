'use strict';

/**
 * resultGuard.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 结果守卫:杜绝「执行了工具但只给了承诺式前言、未交付结论、也无收尾」就静默返回。
 *
 * 复现痛点(用户截图):问「我的电脑怎样做会更好用」,模型反复
 *   「让我先收集你电脑的硬件和软件现状,再给具体建议」
 * 地跑 wmic/dir,却始终不交付那句承诺的「针对性建议」,每轮结束又被「继续」重启再绕圈,
 * 最终什么收尾总结都没有就停了——正是「没完成也没收尾,中途截断什么都不干」。
 *
 * 根因(services/toolUseLoop.js 成功返回路径):用 `去空白后 >= 40 字` 当作「模型已写结论」。
 * 一段**很长的前言式承诺**(「让我先…再给具体建议」+ 一段铺垫)字数 >= 40 → 被误判为已有
 * 结论 → 不追加任何收尾 → 把「只承诺、未交付」的前言当结果返回。叠加 deliveryConclusion
 * nudge 只在 `replyClean.length < 80` 触发(长前言躲过),这一类「长承诺无交付」整类穿透。
 *
 * 本叶子提供四件纯逻辑(结论判据**不在此重写**,由调用方 toolUseLoop 用既有
 * `_looksLikeDeliveryConclusion`(委派 query/activeAssist.hasSynthesizedConclusion)算好后
 * 注入,保单一真源、保 leaf-contract 纯净):
 *   1) looksLikeForwardPromise(text)        —— 检测「让我先…再/然后…给建议/结论」式延迟承诺
 *   2) assessClosure({...}, env)            —— 综合判定本轮是否「执行了工具但只承诺未交付」
 *   3) shouldAppendDeliverySummary({...},env)—— 替换 `>= 40` 粗代理;门控关逐字节回退
 *   4) buildClosureNotice({...}, env)       —— 诚实收尾文案;门控关返回 ''
 *
 * 门控:KHY_RESULT_GUARD(默认开)。=0/false/off/no → 关 → 全部逻辑逐字节回退历史行为
 * (assessClosure 恒 unfinished:false;shouldAppendDeliverySummary 退回 `< 40`;
 *  buildClosureNotice 退回 '')。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

// 「工具跑完后空/极短文本」判定空白后的字符上限——超过即不视为「空回复」。
// 保守取小:仅抓真正什么都没说的回合(裸 JSON 被压成空、半截话被截断),
// 绝不误伤一句话的正常短结论。
const EMPTY_CLOSURE_MAX_CHARS = 12;

function resultGuardEnabled(env = process.env) {
  const flag = String((env && env.KHY_RESULT_GUARD) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

/**
 * 子门控:工具跑完后「空/极短文本」是否触发诚实收尾(KHY_RESULT_GUARD_EMPTY,默认开)。
 * 关 → assessClosure 的空文本分支整体跳过 → 逐字节回退历史(仅承诺式前言会判 unfinished)。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function emptyAfterToolsGuardEnabled(env = process.env) {
  const flag = String((env && env.KHY_RESULT_GUARD_EMPTY) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

/**
 * 子门控:工具跑完后「只报告处理进度/宣告下一步、未交付结论」是否触发诚实收尾
 * (KHY_RESULT_GUARD_PROGRESS_ONLY,默认开)。
 *
 * 复现(弱模型 grep→read 空转,用户截图):每轮结束只留一句
 *   「找到 3 处匹配,我逐个核对,先从第一处入手。」/「定位相关位置,再往下走。」
 * 这类文本**既非空**(躲过 empty 分支)、**也没有「再给建议/结论」式延迟交付名词**
 * (躲过 looksLikeForwardPromise),于是 assessClosure 恒判 unfinished:false → 静默截断,
 * 「回复守卫检测不到没完成」。本子门控补上这第三类:纯进度旁白 + 连续/推进标记、无结论、
 * 无代码块、篇幅短 → 判 unfinished,附诚实收尾。
 * 关 → assessClosure 的进度旁白分支整体跳过 → 逐字节回退历史。
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function progressOnlyGuardEnabled(env = process.env) {
  const flag = String((env && env.KHY_RESULT_GUARD_PROGRESS_ONLY) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

/**
 * 子门控:为最弱档(T0)强制启用「交付结论」nudge(KHY_T0_DELIVERY_NUDGE,默认开)。
 *
 * 调用方把本判据 OR 进 `_harnessProfile.nudges`:非 T0 档 `nudges` 本就为 true,OR 短路无影响;
 * 唯独 T0 档 `nudges:false`(modelTier.harnessProfile,relaxed=T0)时,本判据决定是否补这一推。
 * 「ForWeakTier」语义由 call-site 的 OR 结构承载——本叶子只读门控,绝不在此判 tier。
 * 关 → 返回 false → T0 维持 `false || false` 不推 → 逐字节回退历史。
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function deliveryNudgeForcedForWeakTier(env = process.env) {
  const flag = String((env && env.KHY_T0_DELIVERY_NUDGE) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

// 句首/通篇的「把当前动作框定为前置准备」的承诺引导词。
// 借鉴 toolUseLoop._looksLikeProgressOnlyReply 的前缀直觉,但这里**不限长度**——正是要抓住
// 那段已经混进一段铺垫、字数早超 80 的「长前言」。
const _FORWARD_LEAD = /(让我先|我先|让我|我来|我会先|我打算先|我准备先|我这就先|那我先|先看看|先收集|先了解|先分析|先检查|先查|先梳理|让我看看|let me (?:first|start by|begin by)|i'?ll (?:first|start by)|first[, ]+(?:let me|i)\b|i need to first)/i;

// 「延迟连接词 + (可选的 给/给出/提供…) + 可交付产物名」紧邻出现:把交付推到「之后」。
// 命中例:「再给针对性建议」「再给具体建议」「然后给出结论」「之后再做总结」「then I'll give you recommendations」。
// `[^。．.!?！？\n]{0,16}` 桥接连接词与产物名,但**不跨句**(遇句终止符即断),避免「然后」与远处
// 名词的伪关联。
const _DEFERRED_DELIVERABLE = /(再|然后|接下来|之后|稍后|马上|then\b|after that)[^。．.!?！？\n]{0,16}(建议|意见|方案|结论|总结|分析|报告|答复|回答|说明|清单|计划|recommendation|advice|suggestion|summary|conclusion|plan|report)/i;

/**
 * 文本是否为「让我先 … <动作> … 再/然后 … 给(建议/结论/…)」式**未兑现的延迟承诺**。
 * 纯函数:仅依赖字符串/正则,绝不抛。是否已交付结论由调用方另行注入,不在此判。
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeForwardPromise(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return _FORWARD_LEAD.test(t) && _DEFERRED_DELIVERABLE.test(t);
}

// 进度旁白通常很短;超长文本更可能是真实正文(即便缺结论关键词也别误伤)。
const _PROGRESS_MAX_CHARS = 400;

// 动作/检视动词:模型正在「找/看/查/读/定位/核对/扫描…」——过程动作,不是交付。
const _PROGRESS_ACTION = /(找到|发现|定位|查看|看下|看看|读取|检查|排查|梳理|扫描|搜索|匹配|核对|浏览|确认|found|locat|inspect|scan|search|read|check|review|analy[sz]|match|look)/i;

// 连续/推进标记:句子在宣告「先…再…/逐个/往下/继续/下一步/入手…」——摆明还没完、要接着走。
// 与 _DEFERRED_DELIVERABLE 互补:后者要求出现「建议/结论」等交付名词;本组只认「推进」意图,
// 抓的正是连交付承诺都没有、纯报进度的更隐蔽一类。
const _PROGRESS_CONTINUATION = /(先从|先看|先查|先定位|先读|再往下|再看|再查|再定位|再决定|往下走|往下|逐个|逐一|接下来|下一步|继续|入手|着手|然后再|这就|马上就|一个一个|挨个|one by one|step by step|next step|move on|start(?:ing)? with|continuing|proceed)/i;

/**
 * 文本是否为「只报告处理进度 / 宣告下一步」式的**纯进度旁白**(无结论、无代码、篇幅短)。
 * 与 looksLikeForwardPromise 互补:命中 = 动作动词 ∧ 连续/推进标记,且不含代码块 / tool_call、
 * 篇幅不超上限。是否已交付结论由调用方在 assessClosure 外层用单一真源排除,此处不判。
 * 纯函数,绝不抛。
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeProgressNarration(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (t.length > _PROGRESS_MAX_CHARS) return false; // 长正文更可能真交付,保守不误伤
  if (/```/.test(t)) return false;                  // 含代码块 → 有实质产物
  if (/<tool_call>/i.test(t)) return false;
  return _PROGRESS_ACTION.test(t) && _PROGRESS_CONTINUATION.test(t);
}

/**
 * 综合判定:本轮是否「执行了工具,但最终文本只是承诺式前言、未交付结论」。
 * 门控关 → 恒 { unfinished:false }(出口不附收尾 → 逐字节回退历史)。
 *
 * @param {object} opts
 * @param {number} opts.totalToolCalls         本轮累计工具调用次数
 * @param {boolean} opts.hasDeliveredConclusion 调用方用单一真源算好的「是否已交付结论」
 * @param {string} opts.finalText               将要返回给用户的最终文本
 * @param {object} [env=process.env]
 * @returns {{unfinished: boolean, reason: (string|null)}}
 */
function assessClosure({ totalToolCalls, hasDeliveredConclusion, finalText } = {}, env = process.env) {
  if (!resultGuardEnabled(env)) return { unfinished: false, reason: null };
  const tc = Number(totalToolCalls);
  if (!Number.isFinite(tc) || tc <= 0) return { unfinished: false, reason: null };
  if (hasDeliveredConclusion) return { unfinished: false, reason: null };
  if (looksLikeForwardPromise(finalText)) {
    return { unfinished: true, reason: 'promise-without-delivery' };
  }
  // 进度旁白分支(子门控 KHY_RESULT_GUARD_PROGRESS_ONLY,默认开):工具跑完(tc>0)、未交付
  // 结论、最终文本只是「找到…逐个核对…先从…入手」「定位…再往下走」式纯进度/推进旁白
  // (既非空、也无延迟交付名词,两条旧分支都躲过)→ 诚实收尾,绝不静默。
  // 子门控关 → 整支跳过 → 逐字节回退历史(仅承诺式前言 / 空文本判 unfinished)。
  if (progressOnlyGuardEnabled(env) && looksLikeProgressNarration(finalText)) {
    return { unfinished: true, reason: 'progress-only-after-tools' };
  }
  // 空文本分支(子门控 KHY_RESULT_GUARD_EMPTY,默认开):工具跑完(tc>0)、未交付结论、
  // 最终文本去空白后为空或极短(裸 JSON 被压成空 / 被截断的半截话)→ 诚实收尾,绝不静默。
  // 子门控关 → 整支跳过 → 逐字节回退历史(仅承诺式前言判 unfinished)。
  if (emptyAfterToolsGuardEnabled(env)) {
    const compact = String(finalText == null ? '' : finalText).replace(/\s/g, '');
    if (compact.length <= EMPTY_CLOSURE_MAX_CHARS) {
      return { unfinished: true, reason: 'empty-after-tools' };
    }
  }
  return { unfinished: false, reason: null };
}

/**
 * 是否应追加模板化交付摘要。替换 toolUseLoop 历史的 `去空白 >= 40 字 → 视为已写结论` 粗代理。
 *   门控关 → `去空白长度 < 40`(与历史 `!(_conclusionLen >= 40)` **逐字节等价**)。
 *   门控开 → `!hasDeliveredConclusion`(用真结论判据,不再被长承诺骗过)。
 *
 * @param {object} opts
 * @param {string} opts.finalText
 * @param {boolean} opts.hasDeliveredConclusion
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function shouldAppendDeliverySummary({ finalText, hasDeliveredConclusion } = {}, env = process.env) {
  if (!resultGuardEnabled(env)) {
    return String(finalText == null ? '' : finalText).replace(/\s/g, '').length < 40;
  }
  return !hasDeliveredConclusion;
}

/**
 * 诚实收尾文案:本轮执行了工具但只承诺未交付时,绝不静默——附一句让用户一眼看出「未完成」。
 * 门控关 → ''(call-site 据此不追加 → 逐字节回退)。
 *
 * @param {object} opts
 * @param {number} opts.totalToolCalls
 * @param {string} [opts.reason]
 * @param {object} [env=process.env]
 * @returns {string}
 */
function buildClosureNotice({ totalToolCalls, reason } = {}, env = process.env) {
  if (!resultGuardEnabled(env)) return '';
  const tc = Number(totalToolCalls);
  const n = Number.isFinite(tc) && tc > 0 ? Math.floor(tc) : 0;
  const exec = n > 0 ? `已执行 ${n} 次工具收集信息,` : '';
  if (reason === 'empty-after-tools') {
    // 工具跑完却几乎没吐正文(只剩裸 JSON / 半截话)——明确告诉用户「未给结论」,给一步可执行的出口。
    return `\n\n---\n⚠ 本轮${exec}但几乎没有给出文字结论(可能只回了工具数据或被截断)。`
      + `请发送「继续 基于已得到的结果直接作答」,或用 /model 换更强模型。`;
  }
  if (reason === 'progress-only-after-tools') {
    // 只报告了处理进度 / 宣告下一步,却没交付结论——点破「在原地绕圈」,给一步可执行的出口。
    return `\n\n---\n⚠ 本轮${exec}但只报告了处理进度、宣告了下一步,尚未给出结论(疑似在收集阶段空转)。`
      + `请发送「继续 基于已得到的结果直接给出结论」,或用 /model 换更强模型。`;
  }
  // 默认(promise-without-delivery 等):统一收尾。
  return `\n\n---\n⚠ 本轮${exec}但尚未给出最终结论/建议(疑似在收集阶段反复绕圈)。`
    + `请输入「继续 并直接给出结论」,或用 /model 换更强模型。`;
}

module.exports = {
  resultGuardEnabled,
  emptyAfterToolsGuardEnabled,
  progressOnlyGuardEnabled,
  deliveryNudgeForcedForWeakTier,
  looksLikeForwardPromise,
  looksLikeProgressNarration,
  assessClosure,
  shouldAppendDeliverySummary,
  buildClosureNotice,
};
