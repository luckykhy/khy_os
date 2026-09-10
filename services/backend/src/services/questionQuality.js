'use strict';

/**
 * questionQuality.js — 「提高 khy 提问质量 + 把推荐选项放到第一个」纯叶子(零 IO、零随机、绝不抛)。
 *
 * 诉求(goal 2026-07-03「提高 khy 的提问质量,并把推荐选项放到第一个」):
 *   AskUserQuestion 的「推荐选项应排第一」此前**只是系统提示里的一句话**(工具 prompt 第 26 行),
 *   没有任何代码强制;模型若把标了「(Recommended)/(推荐)」的选项放在非首位,TUI/REPL 会**照原序**
 *   渲染 → 推荐项错位。本叶子在工具 execute()(TUI 与 REPL 的**唯一必经点**)确定性地把带推荐
 *   标记的选项**提升到 index 0**,让「推荐第一」由代码保证而非全凭模型自觉。
 *
 * 契约:
 *   - `promoteRecommendedFirst(options)`:稳定提升——把**第一个**带推荐标记的选项移到队首,其余保持
 *     原相对序;无标记 → 返回**逐字节等价**(同引用不复制)。只认「括号包裹的 recommended/推荐」这类
 *     明确标记(半/全角括号),不误伤正文里恰好含 “recommended” 字样的选项。
 *   - `normalizeQuestions(questions, {env})`:对每张卡的 options 逐一提升;门控关或无标记 → 原样返回。
 *   - `buildQuestionContextNote(questions, ctx)`:任务执行中的提问兜底——当模型发出的提问卡
 *     「可检测地脱离任务上下文」(语言与会话不一致 / 问题文本与原始诉求零词元重叠)时,产出一行
 *     确定性的中文上下文注记,由宿主渲染在问题卡上方,让用户即使拿到一张泛泛的卡也能对照任务
 *     目标准确作答。**纯附加信息,绝不拦截/改写模型的问题**(启发式只加注不拦人,零阻断风险)。
 *
 * 门控 KHY_QUESTION_RECOMMENDED_FIRST(默认开,值 ∈{0,false,off,no} 关)——沿用 questionCardModel.js
 * 同款 OFF_VALUES 语义,与近邻代码一致。
 * 门控 KHY_QUESTION_CONTEXT_NOTE(默认开)——控制上下文注记。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _flagOn(raw) {
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 门控:推荐项前置(默认开;仅显式 falsy 关 → 逐字节回退保留模型原序)。 */
function isRecommendedFirstEnabled(env = process.env) {
  return _flagOn(env && env.KHY_QUESTION_RECOMMENDED_FIRST);
}

// 明确的「推荐」标记:括号(半角/全角)包裹的 recommended / 推荐。刻意要求括号包裹,避免误伤
// 正文里恰好出现 “recommended settings” 之类的普通选项标签。
const _RECOMMENDED_MARKER_RE = /[（(]\s*(?:recommended|推荐)\s*[)）]/i;

function _optLabel(o) {
  if (typeof o === 'string') {
    return o;
  }
  return o && (o.label || o.value) ? String(o.label || o.value) : '';
}

/** 该选项是否带明确「推荐」标记。 */
function isRecommendedOption(option) {
  try {
    return _RECOMMENDED_MARKER_RE.test(_optLabel(option));
  } catch {
    return false;
  }
}

/**
 * 稳定提升:把第一个带推荐标记的选项移到队首,其余保持原相对序。
 * 无标记 / 已在首位 / 输入非数组 → 返回**原引用**(逐字节等价,零复制)。绝不抛。
 * @param {Array} options
 * @returns {Array}
 */
function promoteRecommendedFirst(options) {
  if (!Array.isArray(options) || options.length < 2) {
    return options;
  }
  try {
    let idx = -1;
    for (let i = 0; i < options.length; i++) {
      if (isRecommendedOption(options[i])) {
        idx = i;
        break;
      }
    }
    if (idx <= 0) {
      return options;
    } // 无标记或已在首位 → 原样(不复制)
    const reordered = options.slice();
    const [rec] = reordered.splice(idx, 1);
    reordered.unshift(rec);
    return reordered;
  } catch {
    return options; // fail-soft:任何异常都退回原序
  }
}

/**
 * 对整组 questions 逐卡提升 options 的推荐项。门控关 → 原样返回(同引用)。
 * 仅当至少一张卡实际发生重排时才产出新数组;否则返回原引用(逐字节等价)。绝不抛。
 * @param {Array} questions
 * @param {{env?:object}} [opts]
 * @returns {Array}
 */
function normalizeQuestions(questions, opts = {}) {
  const env = (opts && opts.env) || process.env;
  if (!isRecommendedFirstEnabled(env)) {
    return questions;
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return questions;
  }
  try {
    let changed = false;
    const out = questions.map((q) => {
      if (!q || !Array.isArray(q.options)) {
        return q;
      }
      const promoted = promoteRecommendedFirst(q.options);
      if (promoted === q.options) {
        return q;
      } // 未重排 → 同引用
      changed = true;
      return { ...q, options: promoted };
    });
    return changed ? out : questions;
  } catch {
    return questions;
  }
}

// ── 任务执行中的提问上下文兜底(buildQuestionContextNote)────────────────────
//
// 「做任务时问题不准」的代码兜底:模型在任务中途发出的 AskUserQuestion 卡片若**可检测地**
// 脱离了任务上下文(整卡语言与会话语言不一致 / 问题文本与用户原始诉求零词元重叠),在问题卡
// 上方附加一行确定性的中文注记(当前任务目标 + 「不符就选其它」出口),让用户对照目标准确作答。
// 设计红线:**纯附加信息**——绝不拦截、绝不改写、绝不因启发式误判而多跑一轮模型(注记内容本身
// 恒为真:它描述的是任务目标,不是对问题质量的指控),因此假阳性代价仅为多显示一行灰字。

/** 门控:上下文注记(默认开;仅显式 falsy 关)。 */
function isQuestionContextNoteEnabled(env = process.env) {
  return _flagOn(env && env.KHY_QUESTION_CONTEXT_NOTE);
}

// CJK 统一表意文字区间(含扩展A;覆盖常用中文字符)。测试用非全局版(.test() 无 lastIndex 状态),
// 计数用全局版(.match)。两者字符区间必须逐字节一致。
const _CJK_TEST_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
const _CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/g;

/** 文本中 CJK 字符占比(非空白字符为分母);空文本返回 0。绝不抛。 */
function _cjkRatio(text) {
  const t = String(text == null ? '' : text);
  const cjk = (t.match(_CJK_RE) || []).length;
  const total = t.replace(/\s/g, '').length;
  if (!total) {
    return 0;
  }
  return cjk / total;
}

// 保守阈值:原始消息 CJK 占比 ≥30% 才视为「中文会话」(混排代码/路径时仍可命中)。
const _CJK_SESSION_RATIO = 0.3;

/** 从文本抽取可比词元:CJK 连续段(≥2 字)与 Latin 词(≥4 字母),小写去重。 */
function _extractTokens(text) {
  const t = String(text == null ? '' : text);
  const out = new Set();
  const cjkRuns = t.match(/[\u3400-\u4DBF\u4E00-\u9FFF]{2,}/g) || [];
  for (const run of cjkRuns) {
    // CJK 无分词器:整段 + 2-gram 双保险(整段保语义,2-gram 保「性能」⊂「优化性能」这类包含)。
    out.add(run);
    for (let i = 0; i + 2 <= run.length; i++) {
      out.add(run.slice(i, i + 2));
    }
  }
  const latin = String(t).match(/[A-Za-z][A-Za-z0-9_]{3,}/g) || [];
  for (const w of latin) {
    out.add(w.toLowerCase());
  }
  return out;
}

/** 单卡文本(question + header + option labels)是否含任何 CJK。 */
function _cardHasCjk(q) {
  const parts = [q && q.question, q && q.header];
  const opts = q && Array.isArray(q.options) ? q.options : [];
  for (const o of opts) {
    parts.push(typeof o === 'string' ? o : o && (o.label || o.value));
  }
  return parts.some((p) => _CJK_TEST_RE.test(String(p == null ? '' : p)));
}

/** 把任务摘要压成一行安全片段(去换行、截断)。 */
function _summaryFragment(summary, max = 60) {
  return String(summary == null ? '' : summary)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * buildQuestionContextNote —— 提问卡的确定性上下文注记(纯叶子,零 IO,绝不抛)。
 *
 * 信号(保守,逐卡联合判定):
 *   - `lang-mismatch`:会话为中文(原始消息 CJK 占比 ≥30%)且**所有**卡片文本零 CJK。
 *   - `context-free`:所有问题文本都与「原始消息 + 意图摘要」零词元重叠,且原始消息足够长
 *     (≥12 字符,避免对「继续」「好的」这类短消息误判)。
 * 两个信号都未命中 → 注记为空(逐字节不改变今日行为)。
 *
 * @param {Array} questions  AskUserQuestionTool 规范化后的 questions 数组
 * @param {{originalMessage?:string, intentSummary?:string, env?:object}} [ctx]
 * @returns {{note:string, signals:string[]}}
 */
function buildQuestionContextNote(questions, ctx = {}) {
  const empty = { note: '', signals: [] };
  try {
    const env = (ctx && ctx.env) || process.env;
    if (!isQuestionContextNoteEnabled(env)) {
      return empty;
    }
    const list = Array.isArray(questions) ? questions.filter(Boolean) : [];
    if (list.length === 0) {
      return empty;
    }
    const original = String((ctx && ctx.originalMessage) == null ? '' : ctx.originalMessage);
    const summary = _summaryFragment(ctx && ctx.intentSummary);

    const signals = [];
    const sessionCjk = _cjkRatio(original) >= _CJK_SESSION_RATIO;
    const langMismatch = sessionCjk && !list.some((q) => _cardHasCjk(q));
    if (langMismatch) {
      signals.push('lang-mismatch');
    }

    let contextFree = false;
    if (original.replace(/\s/g, '').length >= 12) {
      const ctxTokens = _extractTokens(original + (summary ? ` ${summary}` : ''));
      if (ctxTokens.size > 0) {
        const allFree = list.every((q) => {
          const opts = q && Array.isArray(q.options) ? q.options : [];
          const qTokens = _extractTokens(
            [q && q.question, q && q.header]
              .concat(opts)
              .map((o) => (typeof o === 'string' ? o : o && (o.label || o.value)))
              .filter(Boolean)
              .join(' ')
          );
          for (const tok of qTokens) {
            if (ctxTokens.has(tok)) {
              return false;
            }
          }
          return true;
        });
        if (allFree) {
          contextFree = true;
          signals.push('context-free');
        }
      }
    }

    if (signals.length === 0) {
      return empty;
    }

    const lines = [];
    if (summary || contextFree) {
      const head = summary ? `此问题服务于当前任务「${summary}」` : '以上问题属于当前任务的一部分';
      lines.push(`【任务上下文】${head};若与你实际想做的不符,选「其它」并用一句话说明即可。`);
    }
    if (langMismatch) {
      lines.push('【语言提示】问题语言与会话语言不一致;选项含义不明时,选「其它」用中文补充。');
    }
    return { note: lines.join('\n'), signals };
  } catch {
    return empty; // fail-soft:任何异常都退回「无注记」
  }
}

module.exports = {
  OFF_VALUES,
  isRecommendedFirstEnabled,
  isRecommendedOption,
  promoteRecommendedFirst,
  normalizeQuestions,
  isQuestionContextNoteEnabled,
  buildQuestionContextNote,
  _RECOMMENDED_MARKER_RE,
  // 内部导出供测试。
  _cjkRatio,
  _extractTokens,
};
