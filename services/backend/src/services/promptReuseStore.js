'use strict';

/**
 * promptReuseStore.js — Agent 提示词复用机制·存储+检索+评估底层。
 *
 * 规范见 docs/03_DESIGN_设计/[DESIGN-ARCH-018] Agent提示词复用机制.md。
 *
 * 定位（轻量集成，只加不改）：本模块**只新增**一套「提示词配方（recipe）」的本地
 * 持久化与相似度检索，**绝不**改动 constants/prompts.js 等现有提示词装配链路，
 * 也不覆盖任何现有提示词内容。它沉淀的是「Agent 运行中被验证有效的任务打法/提示
 * 片段」，供后续相似任务检索复用。
 *
 * 存储（房屋风格对齐 arenaResultStore.js + utils/dataHome）：
 *   每个配方一份 JSON：~/.khy/prompts/recipes/{id}.json，经 getDataDir() 解析，
 *   id 取自任务签名的 sha1，文件名做路径穿越净化。
 *
 * 防呆（与规范 §5 对应）：
 *   - 版本保留：同一配方的 promptText 变化时**追加** versions[]，绝不覆盖历史（R-保留）。
 *   - 相似度阈值：retrieve() 必须过滤 similarity < threshold，避免误推荐（R-阈值）。
 *   - 只读不爆：任何读/解析失败静默跳过，绝不抛出影响 Agent（R-健壮）。
 *
 * 零外部依赖（仅 Node 内置 crypto/fs/path + 本仓 utils/dataHome）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('../utils/dataHome');

// ── 常量 ─────────────────────────────────────────────────────────────────────
const MAX_SAMPLES = 5;          // 每个配方最多留存的原始任务样本数（用于展示/二次匹配）
const MAX_VERSIONS = 20;        // 版本历史上限（防无界增长；只截尾不丢最新）
const PROMPT_TEXT_CAP = 4000;   // 单条 promptText 存储上限（字符），防超大文本占满磁盘
const DEFAULT_THRESHOLD = 0.35; // 相似度默认阈值（§检索逻辑）
const SMOOTH_PRIOR = 2;         // 贝叶斯平滑：先验「伪样本」数，抑制小样本过拟合

// 极简停用词（中英）：仅用于相似度分词，降低高频虚词权重。不影响存储原文。
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'in', 'on', 'at', 'is', 'are',
  'be', 'with', 'this', 'that', 'it', 'as', 'by', 'from', 'please', 'help', 'me',
  '的', '了', '和', '与', '在', '是', '请', '帮', '我', '一个', '这个', '那个', '把', '给',
]);

// ── 目录 / 文件 ──────────────────────────────────────────────────────────────
function _recipesDir() {
  return getDataDir('prompts', 'recipes');
}

function _safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function _filePath(id) {
  return path.join(_recipesDir(), `${_safeId(id)}.json`);
}

function _sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

// ── 分词 / 签名 / 相似度 ─────────────────────────────────────────────────────
/**
 * 归一化分词：英文按词、中文按字符二元组（bigram）切分，去停用词与超短 token。
 * 二元组能在无分词器的前提下显著提升中文相似度判定的鲁棒性。
 * @param {string} text
 * @returns {string[]} 去重后的 token 列表
 */
function normalizeTokens(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];

  // 英文/数字词
  const ascii = s.match(/[a-z0-9_]+/g) || [];
  for (const w of ascii) {
    if (w.length >= 2 && !STOPWORDS.has(w)) tokens.push(w);
  }

  // 中文（含其它 CJK）逐字符序列 → 相邻二元组
  const cjk = (s.match(/[一-鿿]/g) || []);
  for (let i = 0; i < cjk.length - 1; i++) {
    const bigram = cjk[i] + cjk[i + 1];
    if (!STOPWORDS.has(bigram)) tokens.push(bigram);
  }
  // 单字兜底（极短中文任务，如「重构」已是二元组；此处覆盖单字场景）
  if (cjk.length === 1 && !STOPWORDS.has(cjk[0])) tokens.push(cjk[0]);

  return [...new Set(tokens)];
}

/**
 * 任务签名：对归一化 token 集合排序后取 sha1。token 集合相同（语序无关）的任务
 * 会落到同一配方，实现「同类任务」的自然合并（用于 upsert 去重）。
 * @param {string} text
 * @returns {string}
 */
function signatureFor(text) {
  const toks = normalizeTokens(text).sort();
  return _sha1(toks.join(' '));
}

function idFor(text) {
  return signatureFor(text).slice(0, 16);
}

/**
 * 两个 token 集合的相似度。采用 Sørensen–Dice 系数：2·|交集| / (|A|+|B|)，取值 0..1。
 * 相比 Jaccard，Dice 对长度不对称的文本（如「短查询 vs 长历史任务」）更宽容，
 * 召回更稳；而对几乎无交集的不相似任务仍趋近 0，不会引入误推荐（防呆·阈值）。
 * 集合实现使用 Set，O(n)。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function similarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const sa = a instanceof Set ? a : new Set(a);
  const sb = b instanceof Set ? b : new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const denom = sa.size + sb.size;
  return denom === 0 ? 0 : (2 * inter) / denom;
}

// ── 效果评分（§评估方法）────────────────────────────────────────────────────
/**
 * 由 stats 计算 0..1 的效果分。综合：
 *   - 成功率（贝叶斯平滑，抑制 1/1=100% 这类小样本假象）；
 *   - 显式用户反馈（归一化到 0..1，缺省中性 0.5，权重随反馈样本量增长）；
 * 二者按反馈可信度加权融合，无反馈时完全由成功率决定。
 * @param {object} stats
 * @returns {number}
 */
function computeEffectiveness(stats = {}) {
  const uses = Number(stats.uses || 0);
  const successes = Number(stats.successes || 0);
  // 贝叶斯平滑成功率：先验为中性 0.5，权重 SMOOTH_PRIOR。
  const smoothed = (successes + SMOOTH_PRIOR * 0.5) / (uses + SMOOTH_PRIOR);

  const fbCount = Number(stats.feedbackCount || 0);
  if (fbCount <= 0) return _clamp01(smoothed);

  // 反馈均值假定已归一化到 -1..1（负面..正面），映射到 0..1。
  const fbMean = Number(stats.feedbackSum || 0) / fbCount;
  const fbScore = _clamp01((fbMean + 1) / 2);
  // 反馈可信度随样本量平滑上升（fbCount/(fbCount+SMOOTH_PRIOR)）。
  const w = fbCount / (fbCount + SMOOTH_PRIOR);
  return _clamp01(smoothed * (1 - w) + fbScore * w);
}

function _clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ── 持久化原语 ───────────────────────────────────────────────────────────────
function loadRecipe(id) {
  try {
    const raw = fs.readFileSync(_filePath(id), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveRecipe(recipe) {
  if (!recipe || !recipe.id) throw new Error('promptReuseStore: recipe.id is required');
  // 写入前重算缓存的效果分，保证检索排序一致。
  recipe.effectiveness = computeEffectiveness(recipe.stats);
  fs.writeFileSync(_filePath(recipe.id), JSON.stringify(recipe, null, 2), 'utf-8');
  return recipe.id;
}

function deleteRecipe(id) {
  try {
    fs.unlinkSync(_filePath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出全部配方（已解析）。损坏文件静默跳过。
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {object[]}
 */
function listRecipes(opts = {}) {
  let files;
  try {
    files = fs.readdirSync(_recipesDir()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(_recipesDir(), f), 'utf-8'));
      if (r && r.id) out.push(r);
    } catch { /* skip corrupt */ }
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

// ── 写入：用法登记（含版本保留）─────────────────────────────────────────────
/**
 * 登记一次「任务 → 有效提示词」用法。若已有同签名配方：
 *   - promptText 与当前版本不同 → **追加** 新版本（绝不覆盖历史，防呆·保留）；
 *   - 累加 uses，刷新 lastUsedAt，补充任务样本。
 * 否则新建配方。返回配方 id（供随后 recordOutcome 关联）。
 *
 * @param {object} entry
 * @param {string} entry.taskText   触发任务的自然语言描述
 * @param {string} [entry.promptText] 本次被验证有效的提示词/打法片段（核心复用物）
 * @param {string} [entry.category]  功能/场景分类
 * @param {string} [entry.traceId]   关联 trace（仅记录，不参与匹配）
 * @returns {{id:string, recipe:object}}
 */
function recordUsage(entry = {}) {
  const taskText = String(entry.taskText || '').trim();
  if (!taskText) throw new Error('promptReuseStore.recordUsage: taskText is required');

  const id = idFor(taskText);
  const now = Date.now();
  const promptText = entry.promptText != null
    ? String(entry.promptText).slice(0, PROMPT_TEXT_CAP)
    : '';
  const promptHash = promptText ? _sha1(promptText) : '';

  let recipe = loadRecipe(id);
  if (!recipe) {
    recipe = {
      id,
      signature: signatureFor(taskText),
      category: entry.category || 'general',
      tokens: normalizeTokens(taskText),
      taskSamples: [taskText.slice(0, 280)],
      current: promptText ? { promptText, hash: promptHash, createdAt: now } : null,
      versions: promptText ? [{ promptText, hash: promptHash, createdAt: now }] : [],
      stats: {
        uses: 1,
        successes: 0,
        failures: 0,
        avgDurationMs: 0,
        feedbackSum: 0,
        feedbackCount: 0,
        createdAt: now,
        lastUsedAt: now,
        lastTraceId: entry.traceId || null,
      },
    };
  } else {
    recipe.stats.uses = Number(recipe.stats.uses || 0) + 1;
    recipe.stats.lastUsedAt = now;
    if (entry.traceId) recipe.stats.lastTraceId = entry.traceId;
    if (entry.category && recipe.category === 'general') recipe.category = entry.category;

    // 版本保留：仅当 promptText 非空且哈希不同于当前版本时追加新版本。
    if (promptText && (!recipe.current || recipe.current.hash !== promptHash)) {
      recipe.versions = Array.isArray(recipe.versions) ? recipe.versions : [];
      recipe.versions.push({ promptText, hash: promptHash, createdAt: now });
      // 只截最旧、保留最新 MAX_VERSIONS 条，绝不删掉刚追加的版本。
      if (recipe.versions.length > MAX_VERSIONS) {
        recipe.versions = recipe.versions.slice(-MAX_VERSIONS);
      }
      recipe.current = { promptText, hash: promptHash, createdAt: now };
    }

    // 任务样本去重补充
    if (!recipe.taskSamples.includes(taskText.slice(0, 280))) {
      recipe.taskSamples.unshift(taskText.slice(0, 280));
      if (recipe.taskSamples.length > MAX_SAMPLES) {
        recipe.taskSamples = recipe.taskSamples.slice(0, MAX_SAMPLES);
      }
    }
    // token 集合并入新任务词项（提升后续相似度召回）
    recipe.tokens = [...new Set([...(recipe.tokens || []), ...normalizeTokens(taskText)])];
  }

  saveRecipe(recipe);
  return { id, recipe };
}

// ── 写入：效果回收 ───────────────────────────────────────────────────────────
/**
 * 回收一次任务结果，更新配方效果统计并重算效果分。
 * @param {object} outcome
 * @param {string} [outcome.id]        配方 id（优先）
 * @param {string} [outcome.taskText]  无 id 时由任务文本反解 id
 * @param {boolean} outcome.success    任务是否成功
 * @param {number} [outcome.durationMs] 耗时（用于均值）
 * @param {number} [outcome.feedbackScore] 显式用户反馈，归一化到 -1..1
 * @returns {object|null} 更新后的配方；找不到返回 null
 */
function recordOutcome(outcome = {}) {
  const id = outcome.id || (outcome.taskText ? idFor(String(outcome.taskText)) : null);
  if (!id) return null;
  const recipe = loadRecipe(id);
  if (!recipe) return null;

  const s = recipe.stats;
  if (outcome.success === true) s.successes = Number(s.successes || 0) + 1;
  else if (outcome.success === false) s.failures = Number(s.failures || 0) + 1;

  if (Number.isFinite(outcome.durationMs)) {
    const n = Number(s.successes || 0) + Number(s.failures || 0);
    const prev = Number(s.avgDurationMs || 0);
    // 增量均值（以成功+失败计数为分母）
    s.avgDurationMs = n > 0 ? Math.round(prev + (outcome.durationMs - prev) / n) : Math.round(outcome.durationMs);
  }

  if (Number.isFinite(outcome.feedbackScore)) {
    const fb = Math.max(-1, Math.min(1, Number(outcome.feedbackScore)));
    s.feedbackSum = Number(s.feedbackSum || 0) + fb;
    s.feedbackCount = Number(s.feedbackCount || 0) + 1;
  }

  saveRecipe(recipe);
  return recipe;
}

// ── 检索（§检索逻辑 + 防呆·阈值）────────────────────────────────────────────
/**
 * 检索与给定任务相似且历史有效的配方，按「相似度 × 效果」排序返回 Top-N。
 * 低于 threshold 的一律剔除（防误推荐）。
 *
 * @param {string} taskText
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.35] 相似度下限
 * @param {number} [opts.limit=3]        返回上限
 * @param {number} [opts.minUses=1]      最少使用次数（过滤未经验证的配方）
 * @param {number} [opts.minEffectiveness=0] 效果分下限
 * @returns {Array<{id, category, similarity, effectiveness, score, promptText, sample, stats}>}
 */
function retrieve(taskText, opts = {}) {
  const text = String(taskText || '').trim();
  if (!text) return [];
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 3;
  const minUses = Number.isFinite(opts.minUses) ? opts.minUses : 1;
  const minEff = Number.isFinite(opts.minEffectiveness) ? opts.minEffectiveness : 0;

  const queryTokens = new Set(normalizeTokens(text));
  if (queryTokens.size === 0) return [];

  const selfId = idFor(text);
  const candidates = [];
  for (const recipe of listRecipes()) {
    if (!recipe || !recipe.stats) continue;
    if (Number(recipe.stats.uses || 0) < minUses) continue;
    // 不把「与查询完全同源、且尚无任何效果信号」的配方推给自己当噪音。
    // 但允许同 id 但已有成功记录的配方回流（这正是复用价值所在）。
    const sim = similarity(queryTokens, new Set(recipe.tokens || []));
    if (sim < threshold) continue;

    const eff = Number.isFinite(recipe.effectiveness)
      ? recipe.effectiveness
      : computeEffectiveness(recipe.stats);
    if (eff < minEff) continue;

    // 综合排序分：相似度为主，效果为权（0.5 基线 + 0.5 效果）。
    const score = sim * (0.5 + 0.5 * eff);
    candidates.push({
      id: recipe.id,
      isSelf: recipe.id === selfId,
      category: recipe.category || 'general',
      similarity: Number(sim.toFixed(4)),
      effectiveness: Number(eff.toFixed(4)),
      score: Number(score.toFixed(4)),
      promptText: recipe.current ? recipe.current.promptText : '',
      sample: (recipe.taskSamples && recipe.taskSamples[0]) || '',
      stats: {
        uses: recipe.stats.uses || 0,
        successes: recipe.stats.successes || 0,
        failures: recipe.stats.failures || 0,
        avgDurationMs: recipe.stats.avgDurationMs || 0,
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

module.exports = {
  // 原语
  loadRecipe,
  saveRecipe,
  deleteRecipe,
  listRecipes,
  // 写入
  recordUsage,
  recordOutcome,
  // 检索 / 评估
  retrieve,
  computeEffectiveness,
  // 工具（导出供 service 层与测试复用）
  normalizeTokens,
  signatureFor,
  idFor,
  similarity,
  // 常量
  DEFAULT_THRESHOLD,
  MAX_VERSIONS,
};
