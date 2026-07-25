'use strict';

/**
 * dreamPromote.js — 把 memoryDreaming 引擎(独立 dream-store.json)里高价值的
 * 「深度合成洞见」桥接进 markdown 记忆库的**纯选择器叶子**(零 IO、确定性、绝不抛)。
 *
 * 背景:`services/memoryDreaming.js` 用自己的 JSON store 与不兼容的类型词汇
 * (milestone|decision|commitment|lesson|preference|fact),其 AI 跨记忆合成的
 * `deep`/`pattern` 洞见从不转成可召回的 markdown 记忆 → 孤儿。本叶子负责:
 *   ① 类型映射:dream 词汇 → memdir 四类(user|feedback|project|reference);
 *   ② 选择:仅挑高价值(deep/pattern、score 达阈、未回流过)洞见,按上限截断。
 *
 * 真正的写入交给 memoryEngine.addStructuredMemory(已内建 content-dedup / tier /
 * 原地更新),幂等由「已回流 id 账本 + 内容查重」双保险。本叶子不碰 IO。
 *
 * 门控 KHY_MEMORY_DREAM_PROMOTE 默认开;仅助手模式调用侧才会触发。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

const DEFAULT_MIN_SCORE = 0.9;
const DEFAULT_MAX_PER_RUN = 3;

/** dream 类型词汇 → memdir 四类。缺失/deep/pattern 无 type → feedback(→cross_session)。 */
const TYPE_MAP = Object.freeze({
  preference: 'user',
  lesson: 'feedback',
  milestone: 'project',
  decision: 'project',
  commitment: 'project',
  fact: 'reference',
});
const FALLBACK_TYPE = 'feedback';

/** 仅这些 source 的条目是「AI 跨记忆合成洞见」,才值得回流。 */
const PROMOTABLE_SOURCES = new Set(['deep', 'pattern']);

function isEnabled(env = process.env) {
  return !OFF.has(String((env && env.KHY_MEMORY_DREAM_PROMOTE) || '').trim().toLowerCase());
}

function minScore(env = process.env) {
  const v = parseFloat((env && env.KHY_MEMORY_DREAM_PROMOTE_MIN_SCORE) || '');
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_SCORE;
}

function maxPerRun(env = process.env) {
  const v = parseInt((env && env.KHY_MEMORY_DREAM_PROMOTE_MAX) || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_PER_RUN;
}

/**
 * dream 类型 → memdir 类型。未知/缺失 → feedback。
 * @param {string} dreamType
 * @returns {'user'|'feedback'|'project'|'reference'}
 */
function mapType(dreamType) {
  const t = String(dreamType || '').trim().toLowerCase();
  return TYPE_MAP[t] || FALLBACK_TYPE;
}

/** 由 content 派生一个简短标题(首行/首句,截 ~60 字,加前缀)。 */
function _deriveName(content) {
  const firstLine = String(content || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0) || '';
  // 优先在首句边界切
  const sentence = firstLine.split(/(?<=[。.!?！？])/)[0] || firstLine;
  const core = sentence.slice(0, 60).trim();
  return core ? `记忆洞察: ${core}` : '记忆洞察';
}

/** 由 content 派生一行 description(首行,截 120 字)。 */
function _deriveDescription(content) {
  const firstLine = String(content || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0) || '';
  return firstLine.slice(0, 120).trim();
}

/**
 * 从 dream-store 条目里选出可回流的高价值洞见(纯选择,不写)。
 *
 * 过滤:source∈{deep,pattern} ∧ score>=minScore ∧ 未回流过 ∧ 非空 content。
 * 排序:score desc, createdAt desc。截断:maxPerRun。
 *
 * @param {Array} entries       memoryDreaming.snapshotMemories() 的返回
 * @param {Set<string>} promoted 已回流过的 dream id 集(账本)
 * @param {object} [env]
 * @returns {Array<{id,memdirType,name,description,content}>}
 */
function selectPromotable(entries, promoted, env = process.env) {
  if (!isEnabled(env)) return [];
  const list = Array.isArray(entries) ? entries : [];
  const seen = promoted instanceof Set ? promoted : new Set(Array.isArray(promoted) ? promoted : []);
  const floor = minScore(env);

  const eligible = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (!PROMOTABLE_SOURCES.has(String(e.source || '').toLowerCase())) continue;
    if (!(Number(e.score) >= floor)) continue;
    if (!e.id || seen.has(e.id)) continue;
    const content = String(e.content || '').trim();
    if (!content) continue;
    eligible.push({ e, content });
  }

  eligible.sort((a, b) =>
    (Number(b.e.score) || 0) - (Number(a.e.score) || 0)
    || (Number(b.e.createdAt) || 0) - (Number(a.e.createdAt) || 0)
    || String(a.e.id).localeCompare(String(b.e.id)));

  return eligible.slice(0, maxPerRun(env)).map(({ e, content }) => ({
    id: String(e.id),
    memdirType: mapType(e.type),
    name: _deriveName(content),
    description: _deriveDescription(content),
    content,
  }));
}

module.exports = {
  isEnabled,
  minScore,
  maxPerRun,
  mapType,
  selectPromotable,
  TYPE_MAP,
  FALLBACK_TYPE,
  PROMOTABLE_SOURCES,
  _deriveName,
  _deriveDescription,
};
