'use strict';

/**
 * unattendedAutoAnswer.js — 「无人值守时自动用推荐选项作答 AskUserQuestion」纯叶子
 * (零 IO、零随机、绝不抛)。
 *
 * 诉求(goal 2026-07-11「…不一定是目标,可能是一个超长的人机互动任务不中断的底气落盘,
 * 这就包括 goal 中间如果 ai 提出问题,模型是否可以帮忙回答使用最推荐方案…」):
 *   连续几天不中断的关键缺口——即便有交互通道(前台跑 /goal),AskUserQuestion 也会**阻塞等人**
 *   (toolUseLoopCore has-channel 分支 await onControlRequest)。一个阻塞问题会停住整个 run。
 *   本叶子提供确定性的「自动采用推荐选项作答」:把每张问题卡的**推荐选项**(复用 questionQuality
 *   的推荐前置逻辑取 index 0)选定,拼成 toolUseLoopCore 下游期望的 answers 形状
 *   `{ [questionText]: answerLabel }`,让循环跳过阻塞、无感续跑。
 *
 * 契约:
 *   - `isEnabled(env)`:门控 `KHY_UNATTENDED_AUTOANSWER`,**默认关**(不同于 endurance 其它键,
 *     自动作答是行为变更,须显式 opt-in;endurance 落盘会把它打开)。仅 {1,true,on,yes} 视作开。
 *   - `selectAutoAnswers(questions, env)`:对每张卡取推荐项(questionQuality.promoteRecommendedFirst
 *     后的 index 0),产出 `{ answers, picks }`;门控关或无有效问题 → `{ answers:{}, picks:[] }`。
 *     绝不抛(任何异常 fail-soft 到空)。
 *
 * 与既有降级的关系:
 *   - `KHY_ASK_NOCHANNEL_STRICT`(默认开)只在**无通道**时让模型自决;本键在**有无通道皆**生效,
 *     且是**代码确定性选推荐项**,不是让模型猜。
 *   - `KHY_QUESTION_RECOMMENDED_FIRST` 只把推荐项排到显示首位;本键真正把它**选中作答**。
 */

const questionQuality = require('./questionQuality');

// 显式的「开」值——刻意不复用 questionQuality 的 OFF_VALUES 反选(那是默认开语义),
// 本键默认关:只有明确置真才自动作答,缺省/空/其它一律关(逐字节回退今日阻塞行为)。
const ON_VALUES = ['1', 'true', 'on', 'yes'];

/** 门控:无人值守自动作答(默认关;仅显式真值开)。 */
function isEnabled(env = process.env) {
  const v = String((env && env.KHY_UNATTENDED_AUTOANSWER) == null ? '' : env.KHY_UNATTENDED_AUTOANSWER)
    .trim()
    .toLowerCase();
  return ON_VALUES.includes(v);
}

/** 取一个选项的可读标签(string 直接用,对象取 label/value)。 */
function _optLabel(o) {
  if (typeof o === 'string') return o;
  if (o && (o.label || o.value)) return String(o.label || o.value);
  return '';
}

/**
 * 选定单张问题卡的推荐答案:复用 questionQuality 的推荐前置,取 index 0 作为基线,
 * 再交由 autoAnswerIntentGuard 按用户**原始本意**做确定性校准(不偏离本意)。
 * @param {object} q - { question, options, multiSelect }
 * @param {object} [intentContext] - { goalText, intentAnchors, originalMessage };缺省则不校准
 * @param {object} [env]
 * @returns {{ qText:string, answer:string, recommended:boolean, realigned:boolean, reason:string }|null}
 */
function _pickForQuestion(q, intentContext, env = process.env) {
  if (!q || typeof q !== 'object') return null;
  const qText = String(q.question || '').trim();
  if (!qText) return null;
  const opts = Array.isArray(q.options) ? q.options : [];
  if (opts.length === 0) return null;
  // 推荐前置(门控关时 questionQuality 返回原序;此处我们仍取 index 0 作为「最推荐」默认)。
  let ordered = opts;
  try { ordered = questionQuality.promoteRecommendedFirst(opts); } catch { ordered = opts; }
  let chosen = ordered[0];
  let realigned = false;
  let reason = 'baseline';
  // 不偏离本意:仅当调用方给了 intentContext(原始诉求/目标锚点)时才校准;缺省 → 逐字节回退
  // 到基线 index 0。校准本身门控 KHY_UNATTENDED_AUTOANSWER_INTENT_GUARD(默认开·关则原样返回)。
  if (intentContext) {
    try {
      const refined = require('./autoAnswerIntentGuard').refineChoice({
        options: opts,
        baselineChoice: chosen,
        intentContext,
        env,
      });
      if (refined && refined.choice != null) {
        chosen = refined.choice;
        realigned = !!refined.realigned;
        reason = refined.reason || reason;
      }
    } catch { /* fail-soft:校准失败绝不影响作答,保留基线 */ }
  }
  const answer = _optLabel(chosen).trim();
  if (!answer) return null;
  let recommended = false;
  try { recommended = questionQuality.isRecommendedOption(chosen); } catch { recommended = false; }
  return { qText, answer, recommended, realigned, reason };
}

/**
 * 对整组 questions 产出自动答案。绝不抛。
 * @param {Array} questions
 * @param {object} [env]
 * @param {object} [intentContext] - { goalText, intentAnchors, originalMessage };
 *   给定时由 autoAnswerIntentGuard 把选择校准回用户原始本意;缺省 → 逐字节回退到基线 index 0。
 * @returns {{ answers: Record<string,string>, picks: Array<{question:string,answer:string,recommended:boolean,realigned:boolean,reason:string}> }}
 */
function selectAutoAnswers(questions, env = process.env, intentContext = null) {
  const empty = { answers: {}, picks: [] };
  if (!isEnabled(env)) return empty;
  if (!Array.isArray(questions) || questions.length === 0) return empty;
  try {
    const answers = {};
    const picks = [];
    for (const q of questions) {
      const p = _pickForQuestion(q, intentContext, env);
      if (!p) continue;
      answers[p.qText] = p.answer;
      picks.push({
        question: p.qText,
        answer: p.answer,
        recommended: p.recommended,
        realigned: !!p.realigned,
        reason: p.reason,
      });
    }
    return { answers, picks };
  } catch {
    return empty;
  }
}

/**
 * 渲染一行「已自动作答」摘要(供接线层作为可见轨迹前缀;纯字符串)。绝不抛。
 * @param {Array<{question:string,answer:string,recommended:boolean}>} picks
 * @returns {string}
 */
function buildAutoAnswerNote(picks) {
  try {
    if (!Array.isArray(picks) || picks.length === 0) return '';
    const parts = picks.map((p) => {
      // 透明轨迹:被按用户本意校准过的卡显式标注,让「不偏离本意」的动作可见、可审计。
      const tag = p.realigned ? '(已按你的目标校准)' : (p.recommended ? '(推荐)' : '');
      return `「${p.question}」→ ${p.answer}${tag}`;
    });
    return `[无人值守·已自动采用推荐选项作答] ${parts.join('; ')}`;
  } catch {
    return '';
  }
}

module.exports = {
  ON_VALUES,
  isEnabled,
  selectAutoAnswers,
  buildAutoAnswerNote,
  _pickForQuestion,
};
