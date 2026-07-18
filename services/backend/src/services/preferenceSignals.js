/**
 * preferenceSignals — pure-leaf detector for explicit response-style corrections.
 *
 * The "太懂我了" learning trigger: when the user tells khyos *how* they want it to
 * answer ("太长了" / "说重点" / "详细点" / "直接做，别给计划"), this maps that one
 * remark to the signal vocabulary consumed by usageHabitService.recordResponseFeedback,
 * so the preference is learned once and applied on every future turn — the user
 * never has to repeat it.
 *
 * Design constraints:
 *  - PURE: no IO, no env, no module state. Deterministic. The env gate and the
 *    recordResponseFeedback/getHabitContext wiring live at the call site (cli/ai.js).
 *  - CONSERVATIVE / zero false positives: a request like "帮我写个简短的报告" describes
 *    the *deliverable*, not feedback about khyos's own verbosity. We only fire when the
 *    message reads as meta-commentary on the response — either a short standalone
 *    correction, or a longer message that explicitly references the reply
 *    (回复/回答/你/上面/刚才/这次/每次/说话/讲). When in doubt → null.
 *  - PRIORITY ORDER resolves overlaps deterministically: too_long is checked before
 *    too_short so "太详细了" (wants less) wins over the "详细" substring; plan/tip come last.
 */

'use strict';

// A message at or below this code-point length is treated as a standalone remark,
// so a bare "太长了" / "简短点" counts as feedback without needing a meta-marker.
const STANDALONE_MAX_CHARS = 18;

// Explicit references to the assistant's prior reply. Their presence lets a longer
// message ("你这次回答太啰嗦了") still qualify as response feedback.
const META_MARKERS = [
  '回复', '回答', '答复', '你说', '你讲', '说得', '讲得', '说话',
  '上面', '上文', '刚才', '刚刚', '这次', '每次', '总是', '老是',
  'your answer', 'your reply', 'your response', 'you always', 'last reply',
];

// Ordered signal table. First list whose any-substring matches wins. Lists are
// curated to NOT overlap across categories; within a message, earlier categories
// take precedence (see PRIORITY ORDER note above).
const SIGNAL_TABLE = [
  {
    signal: 'too_long',
    patterns: [
      '太长', '太啰嗦', '太罗嗦', '啰嗦', '罗嗦', '废话', '太多了', '太冗长', '冗长',
      '精简', '简短', '简洁', '说重点', '讲重点', '长话短说', '别废话', '少说点',
      '太详细', '太细了', '太繁琐', '繁琐', '太长了',
      'too long', 'too verbose', 'be concise', 'be brief', 'more concise',
      'tl;dr', 'tldr', 'shorter', 'less detail', 'too wordy',
    ],
  },
  {
    signal: 'too_short',
    patterns: [
      '太短', '太简单了', '太简略', '简略', '详细点', '详细一点', '详细些', '说详细',
      '再详细', '更详细', '展开说', '展开讲', '展开一下', '多说点', '多讲点',
      '具体点', '具体一点', '深入点', '深入一点', '不够详细', '说清楚点',
      'too short', 'more detail', 'more details', 'elaborate', 'expand on',
      'go deeper', 'in more depth', 'be more detailed',
    ],
  },
  {
    signal: 'too_much_code',
    patterns: [
      '别贴代码', '别贴大段代码', '别写一堆代码', '别给代码', '不要代码', '不用贴代码',
      '只说思路', '说思路就行', '讲思路就行', '只讲思路', '别全是代码', '少贴代码', '少点代码',
      'no code', 'skip the code', 'just explain', 'explanation only', 'no code dump',
    ],
  },
  {
    signal: 'wants_code',
    patterns: [
      '直接上代码', '上代码', '直接给代码', '给我代码', '把代码给我', '直接写代码', '贴代码',
      '别光说思路', '别只说思路', '少废话上代码',
      'show me the code', 'just the code', 'code only', 'give me the code',
    ],
  },
  {
    signal: 'skipped_plan',
    patterns: [
      '别给计划', '别做计划', '不用计划', '不要计划', '别规划', '少做计划',
      '直接做', '直接改', '直接执行', '直接开始', '直接上手', '直接干', '别问了直接',
      'just do it', 'skip the plan', 'no plan', 'no planning', 'just go ahead',
    ],
  },
  {
    signal: 'liked_plan',
    patterns: [
      '先给计划', '先出方案', '先说方案', '先列计划', '先看计划', '先规划',
      '先别动手', '先别改', '先别执行', '先讨论', '先确认方案',
      'plan first', 'show me a plan', 'plan before', 'outline first',
    ],
  },
  {
    signal: 'skipped_tip',
    patterns: [
      '别给提示', '不用提示', '别给tip', '不要小贴士', '别给小贴士', '不用小贴士',
      'no tips', 'skip the tips', 'no hints',
    ],
  },
];

/** Code-point length (counts a CJK char as 1, matching user-perceived length). */
function _charLen(s) {
  return [...s].length;
}

function _hasMetaMarker(lower) {
  return META_MARKERS.some((m) => lower.includes(m));
}

/**
 * Detect an explicit response-style correction.
 *
 * @param {string} userText - the raw user message for this turn.
 * @returns {'too_long'|'too_short'|'skipped_plan'|'liked_plan'|'skipped_tip'|null}
 *          the recordResponseFeedback signal, or null when there is no clear,
 *          unambiguous correction (the common case).
 */
function detectPreferenceSignal(userText) {
  if (typeof userText !== 'string') return null;
  const text = userText.trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  // Gate on "is this feedback about the reply?" before classifying which kind.
  // Standalone short remark, or any message that explicitly references the reply.
  const isFeedbackContext = _charLen(text) <= STANDALONE_MAX_CHARS || _hasMetaMarker(lower);
  if (!isFeedbackContext) return null;

  for (const { signal, patterns } of SIGNAL_TABLE) {
    if (patterns.some((p) => lower.includes(p))) return signal;
  }
  return null;
}

module.exports = {
  detectPreferenceSignal,
  // Exported for tests / introspection — not for mutation.
  STANDALONE_MAX_CHARS,
  META_MARKERS,
  SIGNAL_TABLE,
};
