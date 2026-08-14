'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 roundAdvanceAssessor.js / streamRepetitionGuard.js 的形状——
//   _isEnabled 委托 flagRegistry(注册表异常/关时逐字节回退 OFF_VALUES 手写判定);判定全在叶子、
//   零 I/O、确定性(无时钟/随机)、绝不抛、门关返安全默认(isEcho→false / shouldSuppress→false);
//   接线(toolUseLoop)只做 IO、包一层 try/catch fail-soft。别把判定逻辑写进接线处、别漏 try/catch、
//   别让叶子抛。

/**
 * answerEchoGuard.js — 纯叶子:跨轮「答案回声」断路器 + 软交付门抑制决策。
 *
 * 缺口(dogfood 实测,provider api:agnes:agnes-2.0-flash):toolUseLoop 在模型产出答案后跑约 18 个
 * 「质量/交付门」,每个门 `currentMessage='[SYSTEM]…'; continue;` 会在同一用户轮内**再驱动一次完整
 * 生成**;relay/api SSE 适配器逐轮 live 流式、append-only REPL 无法回收 → 屏幕出现两遍同一答案。
 *   - Flavor A(无工具 Q&A):软交付门再驱动一次 → 恰好 2 遍。
 *   - Flavor B(失败工具,如 repoAudit 确定性失败):错误文本回灌 → 模型复现同一答案 + 同一失败工具,
 *     机械断路器阈值太高(5/8 次)故反复多次。
 * 统一缺口:**不存在跨轮的答案文本比对**(streamRepetitionGuard 只管单轮流内退化;toolLoopDetector
 * 只管工具调用/内容 chanting)。本叶子补这条。
 *
 * 两条协同(各自门控):
 *   1. 回声断路器(KHY_ANSWER_ECHO_GUARD):normalize 出答案指纹,isEcho 判本轮答案是否复现了本轮
 *      已流式过的某个答案 → 接线处据此在结论前早返、不再进下一轮(封顶到已流式的那一份,不无限循环)。
 *   2. 软门抑制(KHY_SUPPRESS_SOFT_REDRIVE):一个 substantive 答案已「交付」(流式 flush,或非流式适配器
 *      一次性打印最终答案) + 本轮零工具调用时,shouldSuppressSoftRedrive→true,接线处据此给 7 个软交付
 *      门 **以及** goalStopGate 的 redrive 分支加 `&& !suppressed`,消除同一答案被再驱动重复生成。硬纠错
 *      门(errorCoverage 等)不受此抑制(由回声断路器兜底)。交付信号不再仅看是否流式:弱模型/非流式适配
 *      器 streamed 恒 false,故 ctx.delivered 由接线处按「流式或零工具调用」给出。
 *
 * 契约:纯叶子——零 I/O、确定性、绝不抛(fail-soft)。门关 → 安全默认(不触发任何抑制/断路)。
 *
 * @module services/answerEchoGuard
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const _isEnabledDefaultOn = require('../utils/isEnabledDefaultOn');

/** 回声断路器总开关。默认 on。 */
function isEnabled(env) {
  return _isEnabledDefaultOn('KHY_ANSWER_ECHO_GUARD', env);
}

/** 软交付门抑制开关。默认 on。 */
function isSuppressEnabled(env) {
  return _isEnabledDefaultOn('KHY_SUPPRESS_SOFT_REDRIVE', env);
}

// 归一化上限:退化/回声总在答案主体成立,无需比对超长文本;截断上限保证确定性 O(n)。
const NORMALIZE_CAP = 4096;
// substantive 下限:短于此的回复不进回声历史(避免「好的」「稍等」等短句误判)。
const DEFAULT_MIN_CHARS = 24;
// isEcho 近似匹配的长度比阈值:较短/较长 ≥ 此值且长者包含短者 → 判回声。
const DEFAULT_ECHO_RATIO = 0.92;
// Word-level Jaccard similarity threshold for paraphrase echoes (same meaning,
// different wording). Additive widening only: the exact/containment checks are
// unchanged; Jaccard is consulted only when they miss.
const DEFAULT_JACCARD_THRESHOLD = 0.7;
// Jaccard guardrail 1: the length ratio (fp/prev) must fall inside this range
// — a genuine "continue/expand" reply is clearly longer/shorter and must never
// be flagged as an echo.
const JACCARD_LEN_RATIO_MIN = 0.6;
const JACCARD_LEN_RATIO_MAX = 1.7;
// Jaccard guardrail 2: both sides need >= this many tokens, avoiding false
// hits from incidental character-set overlap in short samples.
const JACCARD_MIN_TOKENS = 12;

// 进度占位串:仅这些(或空)不算 substantive。刻意保守(只挑明显的过程语),宁可漏判不误判。
const PLACEHOLDER_RE =
  /^(?:好的|收到|明白|稍等|请稍候|正在|让我|我来|生成中|thinking|working|ok|sure)\b/i;

/**
 * 把一条回复归一化成用于跨轮比对的指纹。
 * 剥 [SYSTEM] 指令行/常见工具调用标记 → 折叠空白 → lowercase → 截断上限。纯函数。
 * @param {string} reply
 * @returns {string}
 */
function normalize(reply) {
  let s = typeof reply === 'string' ? reply : reply == null ? '' : String(reply);
  // 剥整行 [SYSTEM: …] 前言注入(接线处可能已带,防污染指纹)。
  s = s.replace(/\[SYSTEM[:：][^\]]*\]/gi, ' ');
  // 剥占位式工具调用回显 `[模型请求执行工具: NAME]` / ```tool_call``` 围栏残留。
  s = s.replace(/\[模型请求执行工具[:：][^\]]*\]/g, ' ');
  s = s.replace(/```[a-z_]*\s*/gi, ' ');
  // 折叠所有空白(含中文全角空格)为单空格。
  s = s
    .replace(/[\s　]+/g, ' ')
    .trim()
    .toLowerCase();
  if (s.length > NORMALIZE_CAP) {
    s = s.slice(0, NORMALIZE_CAP);
  }
  return s;
}

/**
 * 该回复是否够「实质」以进入回声历史/触发抑制。归一化长度达标且非纯占位。纯函数。
 * @param {string} reply
 * @param {{minChars?: number}} [opts]
 * @returns {boolean}
 */
function isSubstantive(reply, opts) {
  const minChars = opts && Number.isFinite(opts.minChars) ? opts.minChars : DEFAULT_MIN_CHARS;
  const fp = normalize(reply);
  if (fp.length < minChars) {
    return false;
  }
  if (PLACEHOLDER_RE.test(fp)) {
    return false;
  }
  return true;
}

/**
 * Split a fingerprint into tokens for Jaccard comparison: CJK/kana per
 * character, Latin/digits per word. The CJK class mirrors
 * toolLoopDetector._isCjkChar() (Hiragana+Katakana \u3040-\u30ff included) so
 * kana characters participate in similarity, consistent with "CJK per
 * character". Pure function.
 * @param {string} fp  output of normalize() (lowercased, whitespace folded)
 * @returns {string[]}
 */
function _tokenize(fp) {
  if (typeof fp !== 'string' || fp.length === 0) {
    return [];
  }
  return (
    fp.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[a-z0-9][a-z0-9'-]*/g) || []
  );
}

/**
 * Jaccard similarity of two token arrays (deduplicated set intersection over
 * union). Pure function.
 * @param {string[]} aTokens
 * @param {string[]} bTokens
 * @returns {number} 0..1
 */
function _jaccardSimilarity(aTokens, bTokens) {
  if (!Array.isArray(aTokens) || !Array.isArray(bTokens)) {
    return 0;
  }
  if (aTokens.length === 0 || bTokens.length === 0) {
    return 0;
  }
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let inter = 0;
  for (const t of aSet) {
    if (bSet.has(t)) {
      inter += 1;
    }
  }
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 本轮答案指纹 fp 是否复现了历史(本轮已流式过的答案指纹数组)中的某一个。
 * 命中条件(任一):
 *   1. 精确相等,或长者包含短者且长度比 ≥ ratio(吸收尾部追加的小提示差异);
 *   2. 改写型回声:长度相近(护栏区间内)且词级 Jaccard 相似度 ≥ jaccard 阈值。
 * 条件 2 仅在条件 1 未命中时追加检测(只放宽不收紧)。纯函数。
 * @param {string} fp                normalize() 的产出
 * @param {string[]} history         之前 push 进来的指纹
 * @param {{ratio?: number, jaccard?: number, redriveCount?: number, lenRatioMax?: number}} [opts]
 * @returns {boolean}
 */
function isEcho(fp, history, opts) {
  if (typeof fp !== 'string' || fp.length === 0) {
    return false;
  }
  if (!Array.isArray(history) || history.length === 0) {
    return false;
  }
  const ratio = opts && Number.isFinite(opts.ratio) ? opts.ratio : DEFAULT_ECHO_RATIO;
  let jaccard = opts && Number.isFinite(opts.jaccard) ? opts.jaccard : DEFAULT_JACCARD_THRESHOLD;
  // Duplicate-output fix (auto-web-search rephrase): a search-result-driven
  // restatement re-prints the same answer plus appended citations, so it runs
  // clearly longer than the streamed original and would otherwise skip Jaccard
  // via the base length-ratio ceiling. Callers detecting this scenario may pass
  // a wider lenRatioMax so the padded restatement still enters Jaccard scoring.
  // Backward compatible: absent/invalid opts.lenRatioMax keeps the base ceiling.
  const lenRatioMax =
    opts && Number.isFinite(opts.lenRatioMax) ? opts.lenRatioMax : JACCARD_LEN_RATIO_MAX;
  // Progressive relaxation for repeated re-drives (duplicate-output fix): once a
  // substantive answer has ALREADY been delivered this turn and the loop keeps
  // re-driving, each retry smuggles a slightly different lead-in that drags
  // word-level Jaccard just under the base threshold and slips past. redriveCount
  // = how many answers were already delivered this turn: >=1 lowers the bar to
  // 0.5, >=2 to 0.3. The length-ratio window + min-token floor below still veto
  // genuine "expand/continue" replies. The very first turn is unaffected: history
  // is empty then, so this function already returned false above.
  if (opts && Number.isFinite(opts.redriveCount) && opts.redriveCount >= 1) {
    const relaxed = opts.redriveCount >= 2 ? 0.3 : 0.5;
    if (relaxed < jaccard) {
      jaccard = relaxed;
    }
  }
  let fpTokens = null; // lazy: only tokenize when a comparable-length pair shows up
  for (const prev of history) {
    if (typeof prev !== 'string' || prev.length === 0) {
      continue;
    }
    if (prev === fp) {
      return true;
    }
    const shorter = fp.length <= prev.length ? fp : prev;
    const longer = fp.length <= prev.length ? prev : fp;
    if (longer.length > 0 && shorter.length / longer.length >= ratio && longer.includes(shorter)) {
      return true;
    }
    // Paraphrase echo (same meaning, different wording): the containment match
    // above cannot catch rewrites. Two guardrails (length-ratio window + minimum
    // token count) protect genuine "continue/expand" replies and short samples.
    const lenRatio = fp.length / prev.length;
    if (lenRatio < JACCARD_LEN_RATIO_MIN || lenRatio > lenRatioMax) {
      continue;
    }
    if (fpTokens === null) {
      fpTokens = _tokenize(fp);
    }
    if (fpTokens.length < JACCARD_MIN_TOKENS) {
      continue;
    }
    const prevTokens = _tokenize(prev);
    if (prevTokens.length < JACCARD_MIN_TOKENS) {
      continue;
    }
    if (_jaccardSimilarity(fpTokens, prevTokens) >= jaccard) {
      return true;
    }
  }
  return false;
}

/**
 * 软交付门抑制判决:一个 substantive 答案已流式 + 本轮零工具调用 → 抑制软门再驱动。
 * 门(KHY_SUPPRESS_SOFT_REDRIVE)关 → 恒 false(逐字节回退,软门原样触发)。纯函数,绝不抛。
 * @param {{streamed:boolean, delivered?:boolean, iterationToolCalls:number, reply:string, placeholder?:boolean}} ctx
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldSuppressSoftRedrive(ctx, env) {
  try {
    if (!isSuppressEnabled(env)) {
      return false;
    }
    if (!ctx || typeof ctx !== 'object') {
      return false;
    }
    // "Delivered" is streaming-independent: a substantive answer reaches the user
    // either by a live stream flush (ctx.streamed) OR by a non-streaming adapter
    // printing its final answer once (ctx.delivered, set by the caller when the
    // turn issued zero tool calls). Weak/non-streaming adapters keep streamed=false
    // forever, so keying suppression on streaming alone let the soft "did you
    // really finish?" gates re-drive a duplicate. Require either signal.
    if (ctx.streamed !== true && ctx.delivered !== true) {
      return false;
    }
    if (Number(ctx.iterationToolCalls) !== 0) {
      return false;
    }
    if (ctx.placeholder === true) {
      return false;
    }
    return isSubstantive(ctx.reply);
  } catch {
    return false; // fail-soft:抑制判决绝不反噬主循环
  }
}

module.exports = {
  isEnabled,
  isSuppressEnabled,
  normalize,
  isSubstantive,
  isEcho,
  shouldSuppressSoftRedrive,
  DEFAULT_MIN_CHARS,
  DEFAULT_ECHO_RATIO,
  DEFAULT_JACCARD_THRESHOLD,
  // Jaccard guardrail constants exported for test contracts only — the
  // detection logic above stays the single source of truth.
  JACCARD_LEN_RATIO_MIN,
  JACCARD_LEN_RATIO_MAX,
  JACCARD_MIN_TOKENS,
};
