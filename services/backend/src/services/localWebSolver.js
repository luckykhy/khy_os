'use strict';

/**
 * localWebSolver.js — best-effort web problem solving for the no-model + network
 * mode.
 * =================================================================
 * Goal「无模型时...如果有网络，在面对没有在本地模式预设的情况时也可以根据互联网
 * 搜索的方法，和思考结果等尽力把问题解决，而不只是道歉」: when no AI model is
 * available but the network IS up, an un-preset question must NOT collapse to a
 * single search followed by an apology. Instead this orchestrator:
 *   1. tries the query, then deterministically REFORMULATES it (core term,
 *      keyword distillation) and searches again — bounded retries;
 *   2. AGGREGATES + dedups results across all strategies;
 *   3. SYNTHESIZES one answer from the combined evidence (injected synthesizer
 *      reuses the existing IR / organize engine);
 *   4. when nothing is found, returns an HONEST best-effort message — what was
 *      tried, how to refine, what unlocks more — never a bare "抱歉，未找到".
 *
 * Design laws (consistent with the local-mode subsystem):
 *   - 零硬编码: query budget / min-results via env.
 *   - 状态透明: the result carries which strategies ran and the aggregate count;
 *     the no-result message lists the reformulations tried.
 *   - 有界: query count capped; early-exit once enough evidence is gathered.
 *   - 纯函数 + 依赖注入: search / synthesize / coreTerm / keywords are injected,
 *     so the solver is hermetically testable with no real network or model.
 *
 * Entry: solve(query, deps) -> { answer, strategies, queriesTried, resultCount } | null
 *   null  = solver declined (offline, or no search injected) → caller degrades.
 *   answer is always a non-empty rendered string when non-null (best-effort even
 *   on zero results — the honest message).
 */

let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

function _intFromEnv(name, def, min = 1, max = 20) {
  const v = parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}

function _enabled() {
  const v = String(process.env.KHY_LOCAL_WEB_SOLVER || 'on').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

function _norm(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Build the ordered, deduped list of query reformulations to try. Deterministic
 * — no model. The original is always first; reformulations only added when they
 * differ meaningfully from queries already queued.
 */
function buildReformulations(query, deps = {}) {
  const out = [];
  const seen = new Set();
  const push = (q, label) => {
    const t = String(q || '').trim();
    if (!t || t.length < 2) return;
    const key = _norm(t);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ query: t, label });
  };

  push(query, 'original');

  // Core term: strip question words / fillers (e.g. 「法国的首都是什么」→「法国 首都」).
  if (typeof deps.coreTerm === 'function') {
    try {
      const core = deps.coreTerm(query);
      if (core && _norm(core) !== _norm(query)) push(core, 'core_term');
    } catch { /* ignore */ }
  }

  // Keyword distillation: the highest-signal terms joined — drops conversational
  // scaffolding a search engine ranks poorly on.
  if (typeof deps.keywords === 'function') {
    try {
      const kw = deps.keywords(query);
      if (Array.isArray(kw) && kw.length) {
        const joined = kw.slice(0, 6).join(' ');
        if (joined && _norm(joined) !== _norm(query)) push(joined, 'keywords');
      }
    } catch { /* ignore */ }
  }

  return out;
}

function _dedupeResults(results) {
  const out = [];
  const seen = new Set();
  for (const r of results || []) {
    if (!r) continue;
    const url = String(r.url || '').trim();
    const key = url ? url.toLowerCase() : _norm(r.title || r.snippet || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Honest, actionable "could not find it" message — the explicit anti-apology.
 * Reports the network attempt and the reformulations tried (transparency), then
 * gives the user concrete levers instead of a dead end.
 */
function _formatBestEffortMiss(query, triedLabels) {
  const tried = (triedLabels || []).length;
  const suggestions = [
    '换个更具体的说法，或补充关键信息（时间、地点、产品名、版本号等）',
    '把问题拆成更小的几个子问题分别提问',
    '配置 AI 模型（khy gateway config）后可对该问题做深入分析与推理',
  ];
  if (_fmt && _fmt.isEnabled()) {
    return _fmt.compose({
      title: `「${query}」— 暂未检索到可用答案`,
      sections: [
        {
          heading: '已尝试',
          lines: _fmt.bullets([
            `联网搜索（已尝试 ${tried} 种检索方式：${(triedLabels || []).join('、') || '原始查询'}）`,
            '本地推理与离线逻辑（无确定结论）',
          ]),
        },
        {
          heading: '建议',
          lines: _fmt.bullets(suggestions),
        },
      ],
      meta: ['网络搜索', '尽力而为'],
      footer: '已尽力联网检索但未获得可靠结果；这不是无能为力，而是当前信息不足——按上面任一方式可继续推进。',
    });
  }
  const lines = [];
  lines.push(`关于「${query}」，已联网尝试 ${tried} 种检索方式但暂未获得可靠答案。`);
  lines.push('');
  lines.push('你可以这样继续推进：');
  suggestions.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  return lines.join('\n');
}

/**
 * @param {string} query
 * @param {object} deps
 * @param {(q:string)=>Promise<Array|null>} deps.search   inject the real search.
 * @param {(query:string, results:Array)=>(string|null)} deps.synthesize  render
 *        an answer from aggregated results (reuses IR/organize engine).
 * @param {(q:string)=>string} [deps.coreTerm]
 * @param {(q:string)=>string[]} [deps.keywords]
 * @param {boolean} [deps.networkUp=true]
 * @returns {Promise<{answer:string, strategies:string[], queriesTried:number, resultCount:number}|null>}
 */
async function solve(query, deps = {}) {
  if (!_enabled()) return null;
  const q = String(query || '').trim();
  if (q.length < 2) return null;
  if (deps.networkUp === false) return null;            // offline → caller degrades
  const search = typeof deps.search === 'function' ? deps.search : null;
  if (!search) return null;
  const synthesize = typeof deps.synthesize === 'function' ? deps.synthesize : null;

  const maxQueries = _intFromEnv('KHY_LOCAL_WEB_SOLVER_MAX_QUERIES', 3, 1, 6);
  const minResults = _intFromEnv('KHY_LOCAL_WEB_SOLVER_MIN_RESULTS', 4, 1, 30);

  const plan = buildReformulations(q, deps).slice(0, maxQueries);
  const tried = [];
  let aggregated = [];

  for (const step of plan) {
    tried.push(step.label);
    let res = null;
    try { res = await search(step.query); } catch { /* one strategy fails, continue */ }
    if (Array.isArray(res) && res.length) {
      aggregated = _dedupeResults([...aggregated, ...res]);
    }
    // Early-exit: enough evidence gathered, no need to burn more search latency.
    if (aggregated.length >= minResults) break;
  }

  // Evidence in hand → synthesize a single answer from the COMBINED results.
  if (aggregated.length && synthesize) {
    let answer = null;
    try { answer = synthesize(q, aggregated); } catch { answer = null; }
    if (answer && String(answer).trim()) {
      return {
        answer: String(answer).trim(),
        strategies: tried,
        queriesTried: tried.length,
        resultCount: aggregated.length,
      };
    }
  }

  // No usable evidence anywhere → honest best-effort message, never a bare apology.
  return {
    answer: _formatBestEffortMiss(q, tried),
    strategies: tried,
    queriesTried: tried.length,
    resultCount: aggregated.length,
  };
}

module.exports = {
  solve,
  buildReformulations,
  // exposed for tests
  _dedupeResults,
  _formatBestEffortMiss,
};
