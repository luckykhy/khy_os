'use strict';

/**
 * searchNecessity.js — 「该不该联网搜索」的单一真源(goal 2026-06-26
 * 「有的任务模型知识库就可以回答的,不一定要搜索,可以不搜」)。
 *
 * 现状:是否联网搜索完全交给模型自行决定,系统侧只有反方向的「搜够了该收口」
 * (searchConvergence)。两个真实痛点:
 *   - 弱模型对「什么是 X / 写段代码 / 算个数 / 翻译」这类知识库本就能答的任务也贸然联网,
 *     既慢,又容易被劣质抓取结果带偏;
 *   - 反过来对「最新 / 今天 / 股价 / 天气」这类时效问题又偷懒凭记忆回答,给出陈旧答案。
 *
 * 本叶子给出确定性的三档判定 need ∈ required | optional | skip,并据此生成一段系统指令
 * (注入系统提示词而非用户消息,不发起任何工具调用,最终是否搜索仍由模型执行):
 *   - required:时效 / 实时 / 显式联网请求 → 命令模型「先搜再答,不得凭记忆」。
 *     **零漏判是底线**:任何时效信号(复用 searchFreshness 的时间意图判定)都不会被判成 skip。
 *   - skip:稳定知识(定义 / 概念 / 原理)、写代码 / 调试、数学计算、翻译、创作、纯推理,
 *     且无任何时效 / 联网信号 → 提示模型「先用知识库直接作答,确实不确定再联网核实」。
 *   - optional:其余 / 拿不准 → 不注入(系统提示词字节不变),完全交给模型。
 *
 * 这是「是否搜索」第一次有程序化、确定性的判据,与 searchConvergence(搜索循环收口)、
 * searchFreshness(搜什么时间窗)、searchSourceDiscovery(从哪些站点搜)正交互补。
 *
 * 纯叶子:零 IO、确定性、绝不抛、可单测。env 门控 KHY_SEARCH_NECESSITY(默认开,
 * 仅显式 0/false/off 关闭;关闭后 routeSearchNecessity 返回空指令,系统提示词字节不变)。
 */

// searchFreshness 是时间意图的单一真源,这里只读取它的 detectFreshness 判定。
let _freshness = null;
try { _freshness = require('./searchFreshness'); } catch { /* optional — 退化为本模块自身信号 */ }

// ── env 门控 ─────────────────────────────────────────────────────────
// 收敛到 utils/envOnByName 单一真源(逐字节委托,调用点不变)
const _envOn = require('../../utils/envOnByName');
function isEnabled(env) { return _envOn(env, 'KHY_SEARCH_NECESSITY'); }

// ── 信号词(保守:宁可判 optional 也不误杀;required 的判据从严但对时效零漏判)──

// 显式联网请求:用户直接点名要搜 / 查。命中即 required(尊重用户明确意图)。
const EXPLICIT_SEARCH_RE = /(搜索|搜一下|搜下|搜搜|查一下|查查|查询|检索|联网|上网|百度一下|谷歌一下|search\s+(for|the\s+web|online|it)|look\s+(it|this)\s+up|web\s+search|google\s+(it|for))/i;

// 实时状态:即便没有「最新」字样,这类问题几乎一定需要实时数据。
const REALTIME_RE = /(股价|股票|汇率|利率|油价|金价|币价|行情|报价|市值|涨跌|实时|天气|气温|路况|航班|班次|赛果|比分|彩票|开奖|stock\s+price|exchange\s+rate|weather|live\s+score)/i;

// 稳定知识:定义 / 概念 / 原理 / 比较等,知识库通常能答。
const STABLE_KNOWLEDGE_RE = /(什么是|是什么|啥是|解释(一下)?|说明一下|含义|定义|原理|为什么|怎么理解|介绍一下|概念|区别|对比一下|优缺点|利弊|what\s+(is|are|does)\b|why\s+(is|are|does|do)\b|how\s+(does|do|to)\b|explain\b|definition\s+of|difference\s+between)/i;

// 编程 / 技术生成:写 / 改 / 调代码、报错排查 —— 模型直接能做。
const CODE_TASK_RE = /(写(一?段|一?个)?代码|实现(一个|个)?|帮我写|改一下代码|重构|调试|报错|报个错|堆栈|stack\s*trace|正则表达式|正则|算法|写个函数|代码|脚本|编译|debug|refactor|implement\s+(a|an|the)?|write\s+(a\s+)?(function|code|script|program|class)|fix\s+(this|the|my)\s+(code|bug|error))/i;

// 数学 / 翻译 / 创作 / 头脑风暴:自足任务,不需要联网。
// 创作类:写(诗/文章/故事/...);允许「写」与文体名之间夹少量限定词(如「写一首关于秋天的诗」)。
const SELF_CONTAINED_RE = /(翻译|译成|译为|帮我算|计算一下|算一下|等于多少|求解|解方程|写(一?首|一?篇|一?个)?[^,，。!?！？\n]{0,12}?(诗|文章|故事|作文|文案|邮件|信|周报|日报|总结|提纲|大纲|脚本)|起个?名字?|取个?名字?|润色|改写(?!代码)|续写|出个?主意|头脑风暴|想几个|translate|calculate|compute|solve\s+(for|the)|write\s+(a\s+)?(poem|essay|story|email|letter|article)|brainstorm|come\s+up\s+with)/i;

/**
 * 判定一次查询是否需要联网搜索。
 * @param {string} query
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @returns {{ need:'required'|'optional'|'skip', reason:string, freshness?:string, directiveKind:('required'|'skip'|null) }}
 */
function assessSearchNeed(query, opts = {}) {
  const env = opts.env;
  if (!isEnabled(env)) return { need: 'optional', reason: 'disabled', directiveKind: null };

  const q = String(query || '');
  if (!q.trim()) return { need: 'optional', reason: 'empty', directiveKind: null };

  // 1) 时效窗口(复用 searchFreshness 的意图判定)。任何窗口命中 → 时效问题。
  let freshWindow = null;
  try { if (_freshness && typeof _freshness.detectFreshness === 'function') freshWindow = _freshness.detectFreshness(q); }
  catch { /* ignore */ }

  const explicit = EXPLICIT_SEARCH_RE.test(q);
  const realtime = REALTIME_RE.test(q);

  // ── required:必须联网 ─────────────────────────────────────────────
  // 任何时效 / 实时 / 显式联网信号优先命中 → required。这一分支排在 skip 之前,
  // 是「零漏判时效」的保证:哪怕同时含「解释一下」,只要带时效信号也判 required。
  if (freshWindow || realtime || explicit) {
    return {
      need: 'required',
      reason: explicit ? 'explicit-search' : (freshWindow ? 'time-sensitive' : 'realtime-state'),
      freshness: freshWindow || (realtime ? 'auto' : undefined),
      directiveKind: 'required',
    };
  }

  // ── skip:知识库可答 ───────────────────────────────────────────────
  // 仅在确认是稳定知识 / 自足任务、且上面已确认无任何时效信号时。
  if (STABLE_KNOWLEDGE_RE.test(q) || CODE_TASK_RE.test(q) || SELF_CONTAINED_RE.test(q)) {
    return { need: 'skip', reason: 'stable-knowledge', directiveKind: 'skip' };
  }

  // ── optional:拿不准 → 交给模型 ────────────────────────────────────
  return { need: 'optional', reason: 'undecided', directiveKind: null };
}

/**
 * 据判定生成注入系统提示词的指令。optional / 关闭 → 空串(系统提示词字节不变)。
 * @param {object} assessment  assessSearchNeed 的返回
 * @param {object} [env]
 * @returns {string}
 */
function buildNecessityDirective(assessment, env) {
  if (!assessment || !isEnabled(env)) return '';
  if (assessment.directiveKind === 'skip') {
    return [
      '[搜索必要性] 这个问题大概率你的知识库就能直接回答。',
      '请优先基于你已有的知识直接作答 —— 不要贸然联网搜索(搜索更慢,且劣质抓取结果可能把你带偏)。',
      '只有当你确实不确定、或答案可能在你的知识截止之后发生过变化时,才使用 WebSearch 核实。',
    ].join('\n');
  }
  if (assessment.directiveKind === 'required') {
    const fresh = assessment.freshness && assessment.freshness !== 'auto'
      ? `(时间窗口约为「${assessment.freshness}」,务必传 freshness)`
      : '(时效问题务必传 freshness)';
    return [
      '[搜索必要性] 这是时效性 / 需要实时信息的问题,你的记忆很可能已经过期。',
      `请先用 WebSearch 取回最新数据${fresh}再作答,不要仅凭记忆回答。`,
      '若搜索失败或无果,如实说明并标注「未能确证」,不要编造。',
    ].join('\n');
  }
  return '';
}

/**
 * 便捷封装(与 multimodalIntentRouter / clarificationCards 等路由签名对齐):一次性给出
 * directive + assessment。媒体输入(图 / 音 / 视 / 文档)不属于「该不该联网」的决策范畴,
 * 直接返回空指令交给其它路由。
 * @param {object} args
 * @param {string} args.text
 * @param {boolean} [args.hasMedia]
 * @param {string[]} [args.modes]   预留:意图模式(暂不参与判定,保持签名一致)
 * @param {object} [args.options]
 * @param {object} [args.env]
 * @returns {{ directive:string, assessment:(object|null) }}
 */
function routeSearchNecessity({ text, hasMedia = false, env } = {}) {
  if (!isEnabled(env)) return { directive: '', assessment: null };
  if (hasMedia) return { directive: '', assessment: null };
  const assessment = assessSearchNeed(text, { env });
  const directive = buildNecessityDirective(assessment, env);
  return { directive, assessment };
}

module.exports = {
  isEnabled,
  assessSearchNeed,
  buildNecessityDirective,
  routeSearchNecessity,
};
