'use strict';

/**
 * intentSpectrumAnalyzer.js — 意图光谱解析引擎（§3.1 / §3.2）。
 *
 * 摒弃非黑即白的硬分类，把输入映射为连续的「指令置信度」∈[0,1]，再落到三段光谱：
 *   [0.0,0.3) 安全对话带 / [0.3,0.7) 歧义模糊带 / [0.7,1.0] 指令执行带。
 *
 * 置信度由多特征**综合**叠加（防呆①绝不单关键词决定）：
 *   特权动词(强提权) + 目标宾语 + 强调副词 + 弱动词(仅入歧义) + 祈使引导；疑问句整体衰减。
 *
 * 防呆①硬不变式（写死、不可绕过）：缺「特权动词」这一动词类特征时，置信度无论命中多少
 * 关键词都封顶 `NO_VERB_CAP=0.69`——**绝无可能**仅凭「本地模式」「系统」之类单一目标关键词
 * 跨入执行带。执行带的入场券必须含动词类强意图特征。
 *
 * 否定降级（P0#1）：命中的特权动词若处于否定语境（`不要执行`/`别进入`/`执行不了`），
 * 经 intentNegation 叶子剔除，**不计入**提权——只有「主动」特权动词（activeVerbs）才提权。
 * 子门控 KHY_INTENT_NEGATION 默认开；关闭时 activeVerbs===privilegedVerbs，评分逐字节回退。
 *
 * 解析前归一（Phase C-2 第 1 层）：analyze() 入口先经 intentPreprocess.canonicalize 把全角
 * 数字/空格折半角、空白折叠裁剪，提升子串规则的稳健性。子门控 KHY_INTENT_PREPROCESS 默认开；
 * 关闭时 canonicalize 原样返回已 trim 的入参 → 后续特征抽取/评分逐字节回退。
 *
 * 确定性：不调模型、不做 I/O；仅读 process.env 取子门控（非自声明纯叶子）。
 */

const L = require('./intentLexicon');
const negation = require('./intentNegation');
const preprocess = require('./intentPreprocess');

class IntentSpectrumAnalyzer {
  /**
   * @param {string} text
   * @returns {{
   *   text:string, confidence:number, band:string,
   *   features:{privilegedVerbs:string[], targets:string[], emphasis:string[],
   *             weakVerbs:string[], isQuestion:boolean, isImperative:boolean},
   *   reasons:string[]
   * }}
   */
  analyze(text) {
    const trimmed = String(text == null ? '' : text).trim();
    // 解析前确定性归一（Phase C-2 第 1 层）。门控关 → canonicalize 原样返回 trimmed（字节回退）。
    const raw = preprocess.canonicalize(trimmed, process.env);
    const features = this._extract(raw);
    const { confidence, reasons } = this._score(features);
    return { text: raw, confidence, band: this.bandOf(confidence), features, reasons };
  }

  /** 置信度 → 光谱段（§3.1）。 */
  bandOf(confidence) {
    if (confidence >= L.BAND_EDGES.EXECUTION_MIN) return L.BANDS.EXECUTION;
    if (confidence >= L.BAND_EDGES.CONFIRM_MIN) return L.BANDS.CONFIRM;
    return L.BANDS.CHAT;
  }

  /** 抽取全部判别特征（综合判别的原料，防呆①）。 */
  _extract(text) {
    const privilegedVerbs = L._hits(text, L.PRIVILEGED_VERBS);
    const weakVerbs = L._hits(text, L.WEAK_VERBS);
    const emphasis = L._hits(text, L.EMPHASIS_ADVERBS);

    // 否定降级（P0#1）：剔除处于否定语境的特权动词；只有 activeVerbs 才提权。
    // 门控关时 selectNegatedVerbs 返回 []，activeVerbs 内容等同 privilegedVerbs（字节回退）。
    const negatedVerbs = negation.selectNegatedVerbs(text, privilegedVerbs, process.env, {
      markers: L.NEGATION_MARKERS,
      modals: L.FAILURE_MODALS,
    });
    const activeVerbs = negatedVerbs.length
      ? privilegedVerbs.filter((v) => !negatedVerbs.includes(v))
      : privilegedVerbs;

    const targets = L._hits(text, L.TARGET_KEYWORDS);
    for (const re of L.TARGET_PATTERNS) {
      const m = re.exec(text);
      if (m && !targets.includes(m[0])) targets.push(m[0]);
    }

    const isQuestion = L.QUESTION_MARKERS.some((q) => text.includes(q));
    const lead = L.IMPERATIVE_LEADS.find((w) => text.startsWith(w) || text.includes(w));
    // 祈使：句首即（主动）特权动词，或命中祈使引导词。被否定的句首动词不构成祈使。
    const isImperative = (!!activeVerbs.length && L.PRIVILEGED_VERBS.some((v) => text.startsWith(v) && !negatedVerbs.includes(v))) || !!lead;

    return { privilegedVerbs, activeVerbs, negatedVerbs, targets, emphasis, weakVerbs, isQuestion, isImperative, _lead: lead };
  }

  /** 综合提权计分（§3.2）。返回 [0,1] 置信度 + 可读归因。 */
  _score(f) {
    const W = L.WEIGHTS;
    const reasons = [];
    let escalation = 0;

    // 只有「主动」特权动词才提权；被否定的动词（negatedVerbs）剔除（P0#1）。
    // 门控关时 activeVerbs===privilegedVerbs、negatedVerbs 为空 → 评分逐字节回退。
    const activeVerbs = f.activeVerbs || f.privilegedVerbs;
    if (activeVerbs.length) { escalation += W.PRIVILEGED_VERB; reasons.push(`特权动词:${activeVerbs.join('/')}`); }
    else if (f.weakVerbs.length) { escalation += W.WEAK_VERB; reasons.push(`弱动词:${f.weakVerbs.join('/')}（仅入歧义带）`); }

    if (f.negatedVerbs && f.negatedVerbs.length) {
      reasons.push(`否定语境:${f.negatedVerbs.join('/')}（不计入提权）`);
    }

    if (f.targets.length) { escalation += W.TARGET_OBJECT; reasons.push(`目标宾语:${f.targets.join('/')}`); }
    if (f.emphasis.length) { escalation += W.EMPHASIS; reasons.push(`强调副词:${f.emphasis.join('/')}`); }
    if (f.isImperative) { escalation += W.IMPERATIVE_LEAD; reasons.push('祈使句结构'); }

    // 疑问句整体衰减（祈使 >> 疑问，§3.2）。
    if (f.isQuestion) { escalation *= W.QUESTION_DAMPEN; reasons.push('疑问句 → 提权衰减'); }

    let confidence = W.BASE + escalation;

    // 防呆①硬上限：无（主动）特权动词类特征 → 封顶 NO_VERB_CAP，绝无可能凭单关键词入执行带。
    if (!activeVerbs.length && confidence > W.NO_VERB_CAP) {
      confidence = W.NO_VERB_CAP;
      reasons.push(`防呆①：缺特权动词，置信度封顶 ${W.NO_VERB_CAP}（绝不单关键词放行执行）`);
    }

    confidence = Math.max(0, Math.min(1, confidence));
    confidence = Math.round(confidence * 100) / 100;
    return { confidence, reasons };
  }
}

module.exports = { IntentSpectrumAnalyzer };
