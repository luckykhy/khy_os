/**
 * flowRegistry.js — 流程注册表:Agent 沉淀的确定性工作流的保存 / 加载 / 检索。
 *
 * 「Agent 做大脑 + RPA 做手脚」的存储层:Agent 首次完成任务后把 canonical 图
 * `{ nodes, connections }` 沉淀到 `getAppDataDir('workflows')/<slug>.json`,二次
 * 执行时经 `find(intentText)` 确定性匹配后直接重放,无需再走 LLM 规划。
 *
 * 设计(薄 IO + 纯逻辑分离):
 * - 纯函数(stableStringify / computeGraphHash / tokenize / scoreFlow)零 IO、
 *   确定性,单独导出便于单测;
 * - IO 面(save/load/list/remove/find)全部 fail-soft:损坏 JSON 跳过并计入
 *   warnings,任何异常都收敛为结构化返回 `{ ok:false, errors }`,绝不抛;
 * - 文件格式与 cli/handlers/workflow.js 的 `_loadSaved` 兼容
 *   (`{ name, nodes, connections, _meta }`),WorkflowTool 只读 nodes/connections,
 *   新增 `_meta` 字段不影响既有消费方;
 * - 幂等保存:对 nodes+connections 做稳定序列化后 sha256,同名同哈希直接返回,
 *   哈希不同则 version+1 覆盖并保留 `_meta.previousVersion`;
 * - `find` 联动 flowStats 成功率加权(懒 require,失败静默降级为不加权),
 *   跨平台流程(`_meta.platform !== process.platform`)降权并标注。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getAppDataDir } = require('../../utils/dataHome');

const { validateGraph, slugify } = require('./workflowCliCore');

const CREATED_BY = ['agent', 'recorder', 'import'];
const CONTRACT_TYPES = ['fileExists', 'fileContains', 'varContains', 'windowTitle', 'httpStatus'];

// Whitelist filter for _meta.contract: accepted only when every item is an
// object whose type is a known assertion type; otherwise ignored (fail-soft).
function _validContract(contract) {
  if (!Array.isArray(contract) || contract.length === 0) {
    return null;
  }
  const ok = contract.every(
    (a) => a && typeof a === 'object' && !Array.isArray(a) && CONTRACT_TYPES.includes(a.type)
  );
  return ok ? contract : null;
}

// ── Pure helpers (exported for unit tests) ──────────────────────────────────

// Deterministic JSON: object keys sorted recursively, so semantically identical
// graphs always hash the same regardless of key insertion order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// sha256 over the stable serialization of nodes + connections only (not _meta).
function computeGraphHash(graph) {
  const g = graph && typeof graph === 'object' ? graph : {};
  const payload = stableStringify({
    nodes: Array.isArray(g.nodes) ? g.nodes : [],
    connections: Array.isArray(g.connections) ? g.connections : [],
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// Tokenize free text for keyword-overlap scoring: English/number words are
// lowercased tokens; Chinese runs become character bigrams (unigram fallback
// for single-char runs). Deterministic, no NLP dependency.
function tokenize(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const tokens = new Set();
  const words = s.match(/[a-z0-9_]+/g) || [];
  for (const w of words) {
    tokens.add(w);
  }
  const hanRuns = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of hanRuns) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

// Query-coverage overlap: how many query tokens the target contains, 0..1.
function overlapScore(queryTokens, targetTokens) {
  if (!queryTokens.size || !targetTokens.size) {
    return 0;
  }
  let hit = 0;
  for (const t of queryTokens) {
    if (targetTokens.has(t)) {
      hit += 1;
    }
  }
  return hit / queryTokens.size;
}

/**
 * Structural guard for canonical graphs, run before persisting. Pure and
 * deterministic (exported for unit tests). Catches shapes that pass
 * validateGraph but would fail at runtime in workflowExecutor.runGraph
 * (e.g. empty graph, missing start node).
 * @param {object} graph  canonical { nodes, connections }
 * @returns {{ok:true}|{ok:false,errors:string[]}}
 */
function checkGraphShape(graph) {
  const errors = [];
  const g = graph && typeof graph === 'object' ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : null;
  if (!nodes || nodes.length === 0) {
    errors.push('流程图 nodes 必须为非空数组');
    return { ok: false, errors };
  }
  const startCount = nodes.filter((n) => n && n.type === 'start').length;
  const endCount = nodes.filter((n) => n && n.type === 'end').length;
  if (startCount === 0) {
    errors.push('流程图缺少 start 节点');
  } else if (startCount > 1) {
    errors.push(`流程图只能有 1 个 start 节点,当前有 ${startCount} 个`);
  }
  if (endCount === 0) {
    errors.push('流程图缺少 end 节点');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Score one stored flow against an intent text. Pure and deterministic.
 * @param {string} intentText
 * @param {{name?:string,_meta?:object}} flow
 * @param {{successRate?:number|null, platform?:string}} [opts]
 * @returns {{score:number, platformMismatch:boolean}}
 */
function scoreFlow(intentText, flow, opts = {}) {
  const q = tokenize(intentText);
  const meta = (flow && flow._meta) || {};
  const sIntent = overlapScore(q, tokenize(meta.intent));
  const sTags = overlapScore(q, tokenize(Array.isArray(meta.tags) ? meta.tags.join(' ') : ''));
  const sName = overlapScore(q, tokenize(flow && flow.name));
  let score = sIntent * 0.5 + sTags * 0.3 + sName * 0.2;
  // Success-rate weighting: 0.8x (always fails) .. 1.2x (always succeeds).
  const sr =
    typeof opts.successRate === 'number' && Number.isFinite(opts.successRate)
      ? Math.max(0, Math.min(1, opts.successRate))
      : null;
  if (score > 0 && sr != null) {
    score *= 0.8 + 0.4 * sr;
  }
  const platform = opts.platform || process.platform;
  const platformMismatch = !!(meta.platform && meta.platform !== platform);
  if (platformMismatch) {
    score *= 0.5;
  }
  return { score, platformMismatch };
}

// ── Thin IO layer (all fail-soft) ────────────────────────────────────────────

function _storeDir() {
  return getAppDataDir('workflows');
}

function _fileFor(name) {
  const slug = slugify(name);
  return { slug, file: path.join(_storeDir(), `${slug}.json`) };
}

function _readFlowFile(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!obj || typeof obj !== 'object') {
      return null;
    }
    if (Array.isArray(obj.nodes) && Array.isArray(obj.connections)) {
      return obj;
    }
    // Compatibility with the wrapped format used by cli/handlers/workflow.js
    // _loadSaved: { graph: { nodes, connections }, name, _meta }. Flatten it
    // so both formats are readable through one code path.
    const g = obj.graph;
    if (g && typeof g === 'object' && Array.isArray(g.nodes) && Array.isArray(g.connections)) {
      return {
        ...obj,
        nodes: g.nodes,
        connections: g.connections,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function _metaSummary(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    intent: m.intent || '',
    tags: Array.isArray(m.tags) ? m.tags : [],
    params: Array.isArray(m.params) ? m.params : [],
    platform: m.platform || '',
    createdBy: m.createdBy || '',
    createdAt: m.createdAt || '',
    version: Number(m.version) || 1,
    graphHash: m.graphHash || '',
    ...(Array.isArray(m.contract) && m.contract.length
      ? {
          contract: `${m.contract.length} 条断言(${m.contract
            .map((a) => a && a.type)
            .filter(Boolean)
            .join(',')})`,
        }
      : {}),
    ...(typeof m.healedFrom === 'string' && m.healedFrom ? { healedFrom: m.healedFrom } : {}),
  };
}

/**
 * Validate + persist a flow. Idempotent on identical graph hash; bumps version
 * (keeping `_meta.previousVersion`) when the graph changed.
 * @param {string} name
 * @param {object} graph  canonical { nodes, connections }
 * @param {{intent?:string,tags?:string[],params?:string[],platform?:string,createdBy?:string,
 *          contract?:Array<object>,healedFrom?:string}} [meta]
 * @returns {{ok:true,name:string,slug:string,file:string,version:number,unchanged:boolean}
 *          |{ok:false,errors:string[]}}
 */
function save(name, graph, meta = {}) {
  try {
    const check = validateGraph(graph);
    if (!check.ok) {
      return { ok: false, errors: check.errors };
    }
    const shape = checkGraphShape(graph);
    if (!shape.ok) {
      return { ok: false, errors: shape.errors };
    }
    const { slug, file } = _fileFor(name);
    const hash = computeGraphHash(graph);
    // Single version path for both fresh and existing files: baseVersion is 0
    // when there is no readable previous meta, so version is always base + 1.
    const existing = fs.existsSync(file) ? _readFlowFile(file) : null;
    const prevMeta = (existing && existing._meta) || {};
    if (prevMeta.graphHash === hash) {
      return {
        ok: true,
        name: String(name),
        slug,
        file,
        version: Number(prevMeta.version) || 1,
        unchanged: true,
      };
    }
    const baseVersion = Number(prevMeta.version) || 0;
    const version = baseVersion + 1;
    const _meta = {
      intent: String(meta.intent == null ? '' : meta.intent),
      tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
      params: Array.isArray(meta.params) ? meta.params : [],
      platform: meta.platform || process.platform,
      createdBy: CREATED_BY.includes(meta.createdBy) ? meta.createdBy : 'agent',
      createdAt: new Date().toISOString(),
      version,
      graphHash: hash,
    };
    const contract = _validContract(meta.contract);
    if (contract) {
      _meta.contract = contract;
    }
    if (typeof meta.healedFrom === 'string' && meta.healedFrom) {
      _meta.healedFrom = meta.healedFrom;
    }
    if (baseVersion > 0) {
      _meta.previousVersion = baseVersion;
    }
    const doc = {
      name: String(name),
      nodes: graph.nodes,
      connections: Array.isArray(graph.connections) ? graph.connections : [],
      _meta,
    };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
    return { ok: true, name: String(name), slug, file, version, unchanged: false };
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
}

/**
 * Load one flow by name.
 * @returns {{ok:true,flow:object}|{ok:false,errors:string[]}}
 */
function load(name) {
  try {
    const { slug, file } = _fileFor(name);
    if (!fs.existsSync(file)) {
      return { ok: false, errors: [`流程不存在:${slug}`] };
    }
    const flow = _readFlowFile(file);
    if (!flow) {
      return { ok: false, errors: [`流程文件损坏:${slug}.json`] };
    }
    return { ok: true, flow };
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
}

/**
 * List stored flows (name + _meta summary). Corrupt files are skipped and
 * reported in warnings.
 * @returns {{ok:true,flows:Array<object>,warnings:string[]}|{ok:false,errors:string[]}}
 */
function list() {
  try {
    const dir = _storeDir();
    const warnings = [];
    const flows = [];
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    for (const f of files) {
      const flow = _readFlowFile(path.join(dir, f));
      if (!flow) {
        warnings.push(`已跳过损坏的流程文件:${f}`);
        continue;
      }
      flows.push({
        name: flow.name || f.replace(/\.json$/, ''),
        slug: f.replace(/\.json$/, ''),
        _meta: _metaSummary(flow._meta),
      });
    }
    return { ok: true, flows, warnings };
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
}

/**
 * Remove one stored flow. Missing file is not an error (fail-soft).
 * @returns {{ok:true,removed:boolean}|{ok:false,errors:string[]}}
 */
function remove(name) {
  try {
    const { file } = _fileFor(name);
    if (!fs.existsSync(file)) {
      return { ok: true, removed: false };
    }
    fs.unlinkSync(file);
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
}

/**
 * Deterministic intent → stored-flow matching. Scores keyword overlap against
 * `_meta.intent` / `_meta.tags` / flow name, weighted by flowStats success rate
 * (lazily required; scoring degrades gracefully when stats are unavailable).
 * @param {string} intentText
 * @returns {Array<{name,slug,score,intent,tags,params,successRate,platformMismatch}>}
 *   sorted by score desc; empty array when nothing matches.
 */
function find(intentText) {
  try {
    const listed = list();
    if (!listed.ok) {
      return [];
    }
    let stats = null;
    try {
      stats = require('./flowStats');
    } catch {
      stats = null;
    }
    const out = [];
    for (const item of listed.flows) {
      let successRate = null;
      if (stats) {
        try {
          successRate = stats.getSuccessRate(item.name);
        } catch {
          successRate = null;
        }
      }
      const { score, platformMismatch } = scoreFlow(intentText, item, { successRate });
      if (score <= 0) {
        continue;
      }
      out.push({
        name: item.name,
        slug: item.slug,
        score: Math.round(score * 1000) / 1000,
        intent: item._meta.intent,
        tags: item._meta.tags,
        params: item._meta.params,
        successRate,
        platformMismatch,
      });
    }
    out.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
    return out;
  } catch {
    return [];
  }
}

module.exports = {
  save,
  load,
  list,
  remove,
  find,
  // pure helpers (unit-tested)
  checkGraphShape,
  stableStringify,
  computeGraphHash,
  tokenize,
  overlapScore,
  scoreFlow,
};
