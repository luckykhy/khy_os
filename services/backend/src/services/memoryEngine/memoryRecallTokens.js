'use strict';

/**
 * memoryRecallTokens.js — 召回「token 富化」纯叶子(零 IO、零状态、确定性、绝不抛)。
 *
 * 诉求根因(goal 2026-07-03「永久/仓库/会话/任务记忆…没把握主动写入与主动调用的时机,
 * 感觉 khy 特别健忘」):记忆召回的匹配全靠**字面 token 重叠**——
 * memdir._tokenizeForRecall 只产出「Latin 连续串(≥2)」与「单个 CJK 字」,
 * _overlapCount 做精确集合成员判断,既无词组概念也无跨语言归一。两个可证的召回缺口:
 *   ① 跨语言 = 硬零:中文存的记忆,英文提问(或反之)token 完全不在同一字符集 → 永不重叠 → 召不回。
 *   ② 多字词被拆成单字 = 精度塌陷:「记忆」被拆成 记/忆,查「记忆时机」会与任何含单字 记 的
 *      无关记忆同分,真正共享词组「记忆」的那条被单字噪声淹没、被 limit 截断掉 → 感觉健忘。
 *
 * 本叶子只做一件事:把一个**已算好的 base token 集**富化成一个**超集**(field 侧与 query 侧
 * 对称施加同一变换),于是 `overlap(enrich(q), enrich(f)) ≥ overlap(base(q), base(f))` 恒成立
 * ——**单调**:永不让既有命中消失,只可能新增命中。两层可组合、各自独立门控:
 *
 *   1) CJK 二元组(bigram):对原文里连续的 CJK 字追加相邻二元组(记忆→记忆、时机→时机…)。
 *      共享真实词组的记忆因而多得一分强信号,压过单字噪声、稳定排到 limit 之内。攻缺口②。
 *   2) 规范别名哨兵(canonical alias sentinel):一张小而克制的领域词表(记忆系统 + 协作核心
 *      名词)。原文命中某组的任一触发词(英文整词 或 中文子串),就往 token 集里加该组的
 *      **规范哨兵 token**(`a:<id>`,控制字前缀,绝不与真实 Latin/CJK token 冲突)。
 *      于是一条中文记忆「…偏好…」与一句英文提问「…preferences…」都会带上同一个 `a:pref`
 *      → 二者重叠 → 跨语言/近义召回成立。攻缺口①。哨兵对称加到两侧,故仍是单调超集。
 *
 * 纯函数:零 IO、零状态、不读时钟、绝不抛(任何异常都回退到「返回 base 的副本」)。**不 require
 * 任何模块**——base token 由调用方(scoring.keywordScore / memdir.selectRelevantMemories,那里
 * 本就调 memdir._tokenizeForRecall)算好后传入,故 tokenizer 仍是单一真源、本叶子不与之耦合。
 *
 * 门控(均默认开,∈{0,false,off,no} 关):
 *   KHY_MEMORY_RECALL_ENRICH  —— 富化总开关。关 ⇒ 原样返回 base 的副本(逐字节回退到既有召回)。
 *   KHY_MEMORY_RECALL_BIGRAM  —— 仅 CJK 二元组层(独立子门控)。
 *   KHY_MEMORY_RECALL_ALIAS   —— 仅别名哨兵层(独立子门控)。
 *
 * 精度取舍(诚实标注):别名层为「召回优先」——命中触发词即加哨兵,可能让个别弱相关记忆进入候选;
 * 但下游有 keywordScore×recency 排序、minScore、limit 三重收口,且全程门控可关,故为可控的净增益。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

/** 富化总开关。默认开,仅 KHY_MEMORY_RECALL_ENRICH∈{0,false,off,no} 关闭。 */
function isEnabled(env) {
  return !OFF.has(String((env || process.env || {}).KHY_MEMORY_RECALL_ENRICH || '').trim().toLowerCase());
}

/** CJK 二元组子层开关(独立)。默认开。 */
function _bigramEnabled(env) {
  return !OFF.has(String((env || process.env || {}).KHY_MEMORY_RECALL_BIGRAM || '').trim().toLowerCase());
}

/** 别名哨兵子层开关(独立)。默认开。 */
function _aliasEnabled(env) {
  return !OFF.has(String((env || process.env || {}).KHY_MEMORY_RECALL_ALIAS || '').trim().toLowerCase());
}

// 规范哨兵前缀:控制字符 U+0001,真实 token([a-z0-9]+ 或单个 CJK)绝无此字符 → 零冲突。
const ALIAS_PREFIX = 'a:';

/**
 * 别名分组:每组一个稳定 id + 触发词(en 英文整词、zh 中文子串)。命中即加 `a:<id>`。
 * 刻意小而克制、领域聚焦(本系统反复被问到的记忆/写入/召回/时机/记忆层级 + 通用协作名词),
 * 零假阳性偏向:英文按「整词 token」判(避免子串误触),中文按原文子串判(CJK 无词边界)。
 * 需要扩展时应审慎增组,而非放宽判据。
 */
const ALIAS_GROUPS = Object.freeze([
  { id: 'mem', en: ['memory', 'memories', 'remember', 'remembered', 'recall', 'recalled', 'recollection'],
    zh: ['记忆', '记住', '记得', '召回', '回忆', '想起'] },
  { id: 'forget', en: ['forget', 'forgot', 'forgotten', 'forgetful', 'amnesia'],
    zh: ['健忘', '遗忘', '忘记', '忘了', '忘掉', '记不'] },
  { id: 'pref', en: ['preference', 'preferences', 'prefer', 'prefers', 'preferred', 'habit', 'habits'],
    zh: ['偏好', '喜好', '习惯', '喜欢'] },
  { id: 'project', en: ['project', 'projects', 'repo', 'repos', 'repository', 'codebase'],
    zh: ['项目', '工程', '仓库'] },
  { id: 'session', en: ['session', 'sessions', 'conversation', 'conversations'],
    zh: ['会话', '对话'] },
  { id: 'task', en: ['task', 'tasks', 'todo', 'todos'],
    zh: ['任务', '待办'] },
  { id: 'permanent', en: ['permanent', 'permanently', 'persistent', 'durable'],
    zh: ['永久', '永远', '持久'] },
  { id: 'config', en: ['config', 'configuration', 'configure', 'settings', 'setting'],
    zh: ['配置', '设置', '设定'] },
  { id: 'gateway', en: ['gateway', 'gateways'],
    zh: ['网关'] },
  { id: 'timing', en: ['timing', 'trigger', 'triggers', 'triggered'],
    zh: ['时机', '触发'] },
  { id: 'write', en: ['save', 'saved', 'store', 'stored', 'capture', 'captured', 'persist'],
    zh: ['写入', '保存', '存储', '捕获'] },
  { id: 'rule', en: ['rule', 'rules', 'convention', 'conventions', 'guideline', 'guidelines'],
    zh: ['规则', '约定', '规范'] },
]);

const _CJK_RE = /[一-鿿]/;

/**
 * 追加原文中连续 CJK 字的相邻二元组到目标集合。纯字符串扫描,零分配爆炸(上界=原文长度)。
 * @param {Set<string>} out
 * @param {string} raw
 */
function _addCjkBigrams(out, raw) {
  const s = String(raw || '');
  for (let i = 0; i + 1 < s.length; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (_CJK_RE.test(a) && _CJK_RE.test(b)) out.add(a + b);
  }
}

/**
 * 追加命中的别名哨兵。en 触发词按「是否作为整词 token 出现在 baseTokens」判定(精确,避免
 * 子串误触);zh 触发词按「是否为原文小写子串」判定(CJK 无词边界)。任一命中即加该组哨兵。
 * @param {Set<string>} out
 * @param {Set<string>} baseTokens
 * @param {string} lowerRaw
 */
function _addAliasSentinels(out, baseTokens, lowerRaw) {
  for (const g of ALIAS_GROUPS) {
    let hit = false;
    for (const w of g.en) { if (baseTokens.has(w)) { hit = true; break; } }
    if (!hit) {
      for (const p of g.zh) { if (lowerRaw.indexOf(p) !== -1) { hit = true; break; } }
    }
    if (hit) out.add(ALIAS_PREFIX + g.id);
  }
}

/**
 * 把 base token 集富化成超集(见文件头)。field 侧与 query 侧调用完全相同,保证对称 → 单调。
 *
 * @param {Set<string>|Iterable<string>} baseTokens  调用方用 memdir._tokenizeForRecall 算好的 token
 * @param {string} rawText                           该 token 对应的原文(用于二元组与中文别名子串判定)
 * @param {object} [env]
 * @returns {Set<string>}  base 的超集(总开关关 / 出错 ⇒ base 的副本,逐字节回退)
 */
function enrichTokens(baseTokens, rawText, env) {
  const base = baseTokens instanceof Set ? baseTokens : new Set(baseTokens || []);
  try {
    if (!isEnabled(env)) return new Set(base);
    const out = new Set(base);
    const raw = String(rawText || '');
    if (_bigramEnabled(env)) _addCjkBigrams(out, raw);
    if (_aliasEnabled(env)) _addAliasSentinels(out, base, raw.toLowerCase());
    return out;
  } catch {
    // 绝不抛:任何异常都回退到 base 的副本(等价于富化关闭)。
    return new Set(base);
  }
}

module.exports = {
  isEnabled,
  enrichTokens,
  ALIAS_GROUPS,
  ALIAS_PREFIX,
};
