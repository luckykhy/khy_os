/**
 * Natural-language → workflow graph generator (multi-tenant).
 *
 * Turns a free-form description into a canonical `{ nodes, connections }` graph
 * constrained to the node catalog, validated by the SAME `validateGraph` used on
 * every save, then auto-laid-out for the canvas. The LLM call goes through the
 * calling user's own resolved upstream (their gateway relay or custom provider),
 * so generation uses the model the user already configured — no shared key.
 *
 * Design choices:
 *  - Default does NOT persist: returns the graph for the editor to preview/edit,
 *    then the existing `POST /api/workflow` saves it. `persist:true` shortcuts to
 *    `workflowService.create`.
 *  - One repair round: if the first graph fails validation, the validator error
 *    is fed back to the model once. A second failure returns a structured error —
 *    never a half-built graph.
 *  - The chat call is injectable (`opts._chatFn`) so tests run without network.
 *
 * @module services/workflowGenerateService
 * @pattern Service
 */
'use strict';

const { buildCatalogPrompt } = require('@khy/shared/workflow/catalogPrompt');
const workflowService = require('./workflowService');
const userGateway = require('./userGatewayConfigService');
// Built-in provider presets (single source of truth, key-less): map a provider
// id → its public baseUrl / keyField / default model. Lets a custom provider the
// user added with ONLY a key (relying on the preset for the endpoint) still
// resolve to a working upstream. Loaded lazily inside the resolver so a preset
// module fault can never break the rest of generation.

const { validateGraph, httpError } = workflowService;

const SYSTEM_PROMPT = [
  'You are a workflow architect. Given a natural-language task description, design',
  'the smallest correct automation as a directed graph of nodes.',
  '',
  buildCatalogPrompt(),
].join('\n');

// ── Upstream resolution ───────────────────────────────────────────────────────

/**
 * Map a provider id to its built-in preset (baseUrl / keyField / default model),
 * so a provider configured with only a key still has an endpoint to call.
 * Fail-soft: any fault in the preset module yields null (no preset), never throws.
 * @param {string} provider
 * @returns {{baseUrl:string, keyField:string, defaultModel:string}|null}
 */
function _presetForProvider(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (!id) return null;
  try {
    // eslint-disable-next-line global-require
    const { getProviderPresets } = require('../../../backend/src/services/gateway/providerPresets');
    const preset = getProviderPresets().find((p) => p.id === id);
    if (!preset || !preset.baseUrl) return null;
    return {
      baseUrl: preset.baseUrl,
      keyField: preset.keyField || 'authorization_bearer',
      defaultModel: preset.defaultModel || '',
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the user's OpenAI-compatible upstream (URL + key + default model).
 * Prefers the relay config; falls back to the highest-priority custom provider.
 *
 * A custom provider row may carry only a key — the endpoint is implied by the
 * built-in preset for that provider id (the common "pick provider, paste key"
 * flow). We therefore accept any provider with a key whose baseUrl is either
 * stored on the row OR derivable from its preset; otherwise it is skipped.
 * Providers are already ordered by priority, so the first that resolves wins.
 */
async function _resolveUpstream(userId) {
  const relay = await userGateway.getResolvedRelay(userId);
  if (relay && relay.baseUrl) {
    return {
      baseUrl: relay.baseUrl,
      apiKey: relay.apiKey,
      apiKeyField: relay.apiKeyField || 'authorization_bearer',
      model: relay.model || '',
    };
  }
  const providers = await userGateway.getResolvedProviders(userId);
  for (const p of providers || []) {
    if (!p || !p.key) continue;
    if (p.baseUrl) {
      return {
        baseUrl: p.baseUrl,
        apiKey: p.key,
        apiKeyField: 'authorization_bearer',
        model: '',
      };
    }
    // No explicit baseUrl: derive endpoint + default model from the preset.
    const preset = _presetForProvider(p.provider);
    if (preset) {
      return {
        baseUrl: preset.baseUrl,
        apiKey: p.key,
        apiKeyField: preset.keyField,
        model: preset.defaultModel,
      };
    }
  }
  // Per-user store yielded nothing usable. Fall back to the global gateway the
  // operator already configured (single-tenant install — same upstream as normal
  // AI chat). Only fires when the user has no relay/provider, so per-user config
  // always wins and multi-tenant isolation is unaffected. See _resolveSystemRelay.
  const system = _resolveSystemRelay();
  if (system) return system;
  return null;
}

/**
 * Extract the first usable key from a RELAY_API_KEY env value. Accepts a JSON
 * array (of strings or `{key}` objects), or a string with several keys delimited
 * by newline / comma / semicolon — the documented multi-key relay formats. Returns
 * '' when none can be read; an upstream with a baseUrl but no key is still usable
 * for keyless / self-hosted relays. Fail-soft: never throws.
 * @param {string} raw
 * @returns {string}
 */
function _firstRelayApiKey(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (typeof item === 'string' && item.trim()) return item.trim();
        if (item && typeof item === 'object' && item.key && String(item.key).trim()) {
          return String(item.key).trim();
        }
      }
    } catch { /* not JSON — fall through to delimiter split */ }
  }
  const first = text.split(/[\n,;]+/g).map((s) => s.trim()).filter(Boolean)[0];
  return first || '';
}

/**
 * Resolve the system-wide (global) gateway upstream from the operator-configured
 * env, mirroring the admin gateway snapshot contract (RELAY_API_ENDPOINT / _KEY /
 * _MODEL / _KEY_FIELD — see aiGatewayAdmin.js getModelConfigSnapshot).
 *
 * Why this exists: on a single-tenant install the operator configures ONE global
 * gateway (the same upstream that powers normal AI chat) and never fills in the
 * per-user 「我的网关」 tables. The per-user store (userGatewayConfigService)
 * deliberately never reads env, so without this fallback workflow generation
 * wrongly reports "尚未配置 AI 上游 / No AI upstream configured" even though the
 * box has a working gateway. Per-user config still takes precedence in
 * `_resolveUpstream`; this only fires when the user has none, so it is
 * zero-regression for the multi-tenant data plane.
 *
 * Fail-soft: any fault yields null (treated as "no system upstream"), never throws.
 * @returns {{baseUrl:string, apiKey:string, apiKeyField:string, model:string}|null}
 */
function _resolveSystemRelay() {
  try {
    const baseUrl = String(process.env.RELAY_API_ENDPOINT || '').trim();
    if (!baseUrl) return null;
    const field = String(process.env.RELAY_API_KEY_FIELD || '').trim().toLowerCase();
    const apiKeyField = (field === 'x-api-key' || field === 'api-key')
      ? field
      : 'authorization_bearer';
    return {
      baseUrl,
      apiKey: _firstRelayApiKey(process.env.RELAY_API_KEY || ''),
      apiKeyField,
      model: String(process.env.RELAY_API_MODEL || '').trim(),
    };
  } catch {
    return null;
  }
}

function _chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function _authHeaders(upstream) {
  const headers = { 'Content-Type': 'application/json' };
  const key = upstream.apiKey || '';
  if (!key) return headers;
  const field = upstream.apiKeyField || 'authorization_bearer';
  if (field === 'x-api-key') headers['x-api-key'] = key;
  else if (field === 'api-key') headers['api-key'] = key;
  else headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Default chat call against an OpenAI-compatible chat/completions endpoint.
 * Returns the assistant message content string.
 */
async function _defaultChat(upstream, messages, model) {
  const axios = require('axios');
  const res = await axios({
    method: 'POST',
    url: _chatCompletionsUrl(upstream.baseUrl),
    headers: _authHeaders(upstream),
    data: {
      model: model || upstream.model || 'gpt-4o-mini',
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    timeout: 90000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 300) : String(res.data || '').slice(0, 300);
    throw httpError(502, `Upstream model error (${res.status}): ${detail}`);
  }
  const data = res.data || {};
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : '';
  return typeof content === 'string' ? content : JSON.stringify(content || '');
}

// ── JSON extraction ───────────────────────────────────────────────────────────

/**
 * Extract the first balanced JSON object from a model reply, tolerating code
 * fences and surrounding prose. Returns the parsed object or null.
 */
function extractFirstJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.trim();
  // Strip a leading ```json / ``` fence if the whole reply is fenced.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();

  // Fast path: whole string is JSON.
  try { return JSON.parse(s); } catch { /* scan for a balanced object */ }

  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

// ── Graph normalization + auto-layout ─────────────────────────────────────────

function _coerceGraph(parsed) {
  const obj = parsed && typeof parsed === 'object' ? parsed : {};
  const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const connections = Array.isArray(obj.connections)
    ? obj.connections
    : (Array.isArray(obj.edges) ? obj.edges : []);
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    description: typeof obj.description === 'string' ? obj.description : '',
    graph: {
      nodes: nodes.map((n, i) => ({
        id: String(n && n.id != null ? n.id : `n${i + 1}`),
        type: n && n.type,
        name: n && (n.name || n.label) ? String(n.name || n.label) : (n && n.type) || 'node',
        position: n && n.position && typeof n.position === 'object'
          ? { x: Number(n.position.x) || 0, y: Number(n.position.y) || 0 }
          : { x: 0, y: 0 },
        data: n && n.data && typeof n.data === 'object' ? n.data : {},
      })),
      connections: connections.map((c, i) => ({
        id: String(c && c.id != null ? c.id : `c${i + 1}`),
        from: c && (c.from != null ? c.from : c.source),
        fromPort: c && (c.fromPort || c.sourcePort || 'default'),
        to: c && (c.to != null ? c.to : c.target),
        toPort: c && (c.toPort || c.targetPort || 'input'),
        ...(c && c.condition ? { condition: c.condition } : {}),
      })),
    },
  };
}

/**
 * Assign canvas positions by BFS layering from the start node so the generated
 * graph renders left-to-right and readable. Pure function; mutates positions in
 * place on a copy.
 */
function autoLayout(graph) {
  const COL_W = 260;
  const ROW_H = 120;
  const nodes = graph.nodes || [];
  const conns = graph.connections || [];
  if (!nodes.length) return graph;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outAdj = new Map();
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const c of conns) {
    if (!byId.has(c.from) || !byId.has(c.to)) continue;
    if (!outAdj.has(c.from)) outAdj.set(c.from, []);
    outAdj.get(c.from).push(c.to);
    indeg.set(c.to, (indeg.get(c.to) || 0) + 1);
  }

  // Seeds: start node(s), else any zero-indegree node, else first node.
  let seeds = nodes.filter((n) => n.type === 'start').map((n) => n.id);
  if (!seeds.length) seeds = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  if (!seeds.length) seeds = [nodes[0].id];

  const level = new Map();
  const queue = [];
  for (const id of seeds) { level.set(id, 0); queue.push(id); }
  while (queue.length) {
    const id = queue.shift();
    const lv = level.get(id) || 0;
    for (const next of outAdj.get(id) || []) {
      const cand = lv + 1;
      if (!level.has(next) || cand > level.get(next)) {
        level.set(next, cand);
        queue.push(next);
      }
    }
  }
  // Any unreached node (cycle/orphan) → place after the deepest level.
  let maxLv = 0;
  for (const v of level.values()) maxLv = Math.max(maxLv, v);
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, maxLv + 1);

  // Stack nodes within each column.
  const rowByCol = new Map();
  for (const n of nodes) {
    const col = level.get(n.id) || 0;
    const row = rowByCol.get(col) || 0;
    rowByCol.set(col, row + 1);
    n.position = { x: col * COL_W, y: row * ROW_H };
  }
  return graph;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a workflow graph from a natural-language prompt.
 *
 * @param {number|string} userId
 * @param {object} opts
 * @param {string} opts.prompt        natural-language description (required)
 * @param {string} [opts.model]       override model name for the LLM call
 * @param {boolean} [opts.persist]    when true, create the workflow and return it
 * @param {function} [opts._chatFn]   injected `(messages) => Promise<string>` for tests
 * @returns {Promise<{graph,name,description,report,workflow?}>}
 */
async function generate(userId, opts = {}) {
  const prompt = String(opts.prompt == null ? '' : opts.prompt).trim();
  if (!prompt) throw httpError(400, 'prompt is required');
  if (prompt.length > 4000) throw httpError(400, 'prompt too long (max 4000 chars)');

  let chatFn = opts._chatFn;
  let model = opts.model;
  if (typeof chatFn !== 'function') {
    const upstream = await _resolveUpstream(userId);
    if (!upstream) {
      throw httpError(
        409,
        '尚未配置 AI 上游：请到「我的网关」填写中转(Relay)或添加一个带 Key 的供应商，'
          + '或由管理员在全局网关(RELAY_API_ENDPOINT)配置后再生成工作流。'
          + ' (No AI upstream configured — set up your relay / add a provider key in 我的网关,'
          + ' or configure the global gateway, first.)',
      );
    }
    model = model || upstream.model;
    chatFn = (messages) => _defaultChat(upstream, messages, model);
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Design a workflow for this task:\n\n${prompt}` },
  ];

  const attempts = [];
  let reply = await chatFn(messages);
  let parsed = extractFirstJson(reply);
  let coerced = _coerceGraph(parsed);

  let validationError = null;
  try {
    validateGraph(coerced.graph, { strict: true });
  } catch (err) {
    validationError = err.message || String(err);
  }
  attempts.push({ ok: !validationError, error: validationError });

  // One repair round: feed the validator's complaint back to the model.
  if (validationError) {
    const repairMessages = messages.concat([
      { role: 'assistant', content: reply },
      {
        role: 'user',
        content:
          `That graph failed validation: ${validationError}\n` +
          'Fix it and return ONLY the corrected JSON object, same shape, obeying every hard rule.',
      },
    ]);
    reply = await chatFn(repairMessages);
    parsed = extractFirstJson(reply);
    coerced = _coerceGraph(parsed);
    validationError = null;
    try {
      validateGraph(coerced.graph, { strict: true });
    } catch (err) {
      validationError = err.message || String(err);
    }
    attempts.push({ ok: !validationError, error: validationError, repaired: true });
  }

  if (validationError) {
    const err = httpError(422, `Could not generate a valid workflow: ${validationError}`);
    err.attempts = attempts;
    throw err;
  }

  autoLayout(coerced.graph);

  const name = (coerced.name || prompt.slice(0, 40)).trim() || 'Generated workflow';
  const description = coerced.description || `由自然语言生成：${prompt.slice(0, 120)}`;
  const report = {
    nodeCount: coerced.graph.nodes.length,
    connectionCount: coerced.graph.connections.length,
    attempts: attempts.length,
    repaired: attempts.length > 1,
  };

  if (opts.persist) {
    const workflow = await workflowService.create(userId, { name, description, graph: coerced.graph });
    return { graph: coerced.graph, name, description, report, workflow };
  }

  return { graph: coerced.graph, name, description, report };
}

module.exports = {
  generate,
  // exported for tests / reuse
  extractFirstJson,
  autoLayout,
  _resolveUpstream,
  _resolveSystemRelay,
  _presetForProvider,
};
