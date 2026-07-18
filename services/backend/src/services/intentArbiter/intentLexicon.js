'use strict';

/**
 * intentLexicon.js — 意图光谱解析特征词库单一真源（§3.2 动态提权特征引擎）。
 *
 * 把「自然语言 → 指令置信度」所需的全部判别特征收口于此：特权动词、目标宾语、强调副词、
 * 弱动词、疑问标记、以及误判淬火所需的纠正信号。业务侧严禁另起炉灶散落关键词——这是
 * 防呆①「绝不单一关键词路由」得以综合判别的物质基础。
 *
 * 纯数据 + 阈值/权重常量。确定性，不调模型、不做 I/O。
 */

// —— 置信度光谱三段（§3.1）：左闭右开，覆盖 [0,1] ——
const BANDS = Object.freeze({
  CHAT: 'chat',             // [0.0, 0.3) 安全对话带
  CONFIRM: 'confirm',       // [0.3, 0.7) 歧义模糊带
  EXECUTION: 'execution',   // [0.7, 1.0] 指令执行带
});
const BAND_EDGES = Object.freeze({ CONFIRM_MIN: 0.3, EXECUTION_MIN: 0.7 });

// —— 提权/降权权重（§3.2）。综合叠加，绝不单因子决定（防呆①）——
const WEIGHTS = Object.freeze({
  BASE: 0.1,            // 基线（默认偏闲聊）
  PRIVILEGED_VERB: 0.45, // 特权动词：最强提权因子
  TARGET_OBJECT: 0.2,   // 目标宾语（模式/工具/系统模块）
  EMPHASIS: 0.2,        // 强调副词
  WEAK_VERB: 0.2,       // 弱动词（看看/瞧瞧）：仅拉入歧义带，不足以执行
  IMPERATIVE_LEAD: 0.1, // 祈使引导（给我/请/帮我）
  QUESTION_DAMPEN: 0.5, // 疑问句对提权项的整体衰减系数（祈使 >> 疑问，§3.2）
  // 防呆①硬上限：缺特权动词类特征时，置信度无论如何不得跨入执行带。
  NO_VERB_CAP: 0.69,
});

// 特权动词：强动作词，将自然语言从闲聊拉升为指令（§3.2）。
// 同义词扩充（P0#3）：'跑一下'/'跑一遍' 明确「运行/执行」之意；裸 '跑' 刻意不加
// （会误匹配 '跑步'/'跑题' 等非指令语境）。
const PRIVILEGED_VERBS = Object.freeze([
  '进入', '执行', '切换', '调用', '开启', '关闭', '启动', '运行',
  '打开', '扫描', '部署', '挂载', '卸载', '激活', '停用', '重启',
  '跑一下', '跑一遍',
]);

// 弱动词：表达「看/了解/试探」意向，不构成执行指令，落歧义带待确认。
// 同义词扩充（P0#3）：'搞一下'/'弄一下'/'试试' 等口语模糊动词，意图不明确，仅入歧义带。
const WEAK_VERBS = Object.freeze([
  '看看', '看下', '看一下', '瞧瞧', '瞅瞅', '了解', '查查', '瞄一眼',
  '搞一下', '弄一下', '搞搞', '弄弄', '试一下', '试试',
]);

// 目标宾语关键词 + 构词正则（「X模式 / X工具」）。
const TARGET_KEYWORDS = Object.freeze([
  '本地模式', '调试工具', '系统', '调试', '内核', '沙箱', '网关', '终端', '后台',
]);
const TARGET_PATTERNS = Object.freeze([
  /[^\s，。,.!！?？]{0,6}模式/,
  /[^\s，。,.!！?？]{0,6}工具/,
]);

// 强调副词：强度词，显著提权（§3.2）。
const EMPHASIS_ADVERBS = Object.freeze([
  '明确要求', '明确', '立刻', '马上', '必须', '一定', '务必', '赶紧', '立即', '坚决',
]);

// 祈使引导词：句首出现强烈暗示祈使句（§3.2 语法结构）。
const IMPERATIVE_LEADS = Object.freeze([
  '给我', '请', '帮我', '麻烦', '替我', '给你', '我要求', '我要', '要求', '我命令',
]);

// 疑问标记：命中则判为疑问句，整体衰减提权（§3.2：疑问 << 祈使）。
const QUESTION_MARKERS = Object.freeze([
  '吗', '呢', '什么', '啥', '谁', '怎么', '如何', '是不是', '要不要', '能不能', '可不可以', '?', '？',
]);

// —— 否定语境检测词表（P0#1，供 intentNegation 叶子做首遍评分的否定降级）——
// 前向否定词：紧贴动词左侧时表示该动词被否定（`不要执行`/`别执行`/`不执行`）。
// 多字优先于裸 '不'，但 intentNegation 用严格邻接判据，顺序不影响结果。
const NEGATION_MARKERS = Object.freeze([
  '不要', '别', '不用', '不必', '无需', '别再', '先别', '不想', '不需要',
  '没', '没有', '勿', '甭', '不',
]);
// 后向无能/失败情态：紧贴动词右侧时表示陈述句而非命令（`执行不了`/`执行失败`）。
const FAILURE_MODALS = Object.freeze([
  '不了', '不动', '不起来', '不下去', '失败', '出错', '报错', '不成',
]);

// —— 误判淬火纠正信号（§3.4 / 防呆③）——
// 误触：用户表示「我没让你执行 / 只是在聊天」——分类器过激进。
const FALSE_TRIGGER_SIGNALS = Object.freeze([
  '我没有让', '没让你', '我没让', '我没说', '别执行', '不要执行', '不用执行',
  '只是在聊天', '我只是', '谁让你', '没让你执行', '别动', '停下',
]);
// 漏判：用户表示「我刚才说了 / 为什么没反应 / 快执行」——分类器过保守。
const MISS_SIGNALS = Object.freeze([
  '我刚才说', '刚才说了', '为什么没', '怎么没反应', '没反应', '帮我执行', '快执行',
  '赶紧执行', '我说了', '让你执行', '怎么不动',
]);

/** 命中列表里任一词的子串匹配。 */
function _hits(text, list) {
  const out = [];
  for (const w of list) if (text.includes(w)) out.push(w);
  return out;
}

module.exports = {
  BANDS,
  BAND_EDGES,
  WEIGHTS,
  PRIVILEGED_VERBS,
  WEAK_VERBS,
  TARGET_KEYWORDS,
  TARGET_PATTERNS,
  EMPHASIS_ADVERBS,
  IMPERATIVE_LEADS,
  QUESTION_MARKERS,
  NEGATION_MARKERS,
  FAILURE_MODALS,
  FALSE_TRIGGER_SIGNALS,
  MISS_SIGNALS,
  _hits,
};
