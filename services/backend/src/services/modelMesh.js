'use strict';

const crypto = require('crypto');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_DISCOVERY_TTL_MS = 30000;
const MAX_PEERS = 64;

function enabled(env = process.env) {
  const raw = String(env.KHY_MODEL_MESH || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function normalizeUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function parsePeers(env = process.env) {
  const raw = String(env.KHY_MESH_PEERS || '').trim();
  if (!raw) return [];
  let values;
  try { values = JSON.parse(raw); } catch { values = raw.split(',').map((item) => item.trim()); }
  if (!Array.isArray(values)) return [];
  return values.slice(0, MAX_PEERS).map((item, index) => {
    const source = typeof item === 'string' ? { url: item } : item || {};
    const url = normalizeUrl(source.url || source.endpoint);
    if (!url) return null;
    return {
      id: String(source.id || `peer-${index + 1}`).trim().slice(0, 64),
      url,
      models: Array.isArray(source.models) ? source.models.map(String) : [],
      capabilities: Array.isArray(source.capabilities) ? source.capabilities.map(String) : [],
      priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 100,
    };
  }).filter(Boolean);
}

/**
 * Parse KHY_MESH_RESTRICTED_MODELS: a comma-separated list of
 *   modelName=ip1|ip2|...
 * where the ip list may contain exact IPs, "a.b.c.d/n" CIDR blocks, or the
 * literal "*" meaning "reachable nowhere (only via a peer)". A model absent
 * from the map is unrestricted and is served locally.
 * Returns { modelName: string[] } (allowed-IP sets; [] never happens; "*" is
 * stored as the single marker "*").
 */
function parseRestrictedModels(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  const map = {};
  for (const entry of raw.split(',')) {
    const trim = entry.trim();
    if (!trim) continue;
    const eq = trim.indexOf('=');
    const model = (eq >= 0 ? trim.slice(0, eq) : trim).trim().toLowerCase();
    if (!model) continue;
    const rules = (eq >= 0 ? trim.slice(eq + 1) : '*').split('|').map((x) => x.trim()).filter(Boolean);
    map[model] = rules.length ? rules : ['*'];
  }
  return map;
}

/** Enumerate this host's own IPs (IPv4 + IPv6), an Env override first. */
function localIps(env = process.env) {
  const override = String(env.KHY_MESH_LOCAL_IP || '').trim();
  if (override) return override.split(',').map((x) => x.trim()).filter(Boolean);
  const out = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const entry of interfaces[name] || []) {
        if (entry && entry.address) out.push(entry.address);
      }
    }
  } catch { /* best effort */ }
  return out;
}

/** Zero-dep IP match: exact IP equality, "a.b.c.d/n" IPv4 CIDR, or "*". */
function ipAllowed(rules, needle) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  for (const rule of rules) {
    if (!rule) continue;
    if (rule === '*') return true;
    if (rule === needle) return true;
    const slash = rule.indexOf('/');
    if (slash > 0) {
      const base = rule.slice(0, slash);
      const bits = Number(rule.slice(slash + 1));
      if (Number.isFinite(bits) && bits >= 0 && bits <= 32 && base.indexOf('.') >= 0) {
        const toInt = (ip) => ip.split('.').reduce((acc, part) => (acc * 256 + Number(part)) >>> 0, 0);
        const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
        if ((toInt(base) & mask) === (toInt(needle) & mask)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether this node can serve `model` given its IP-restriction rules.
 * Unrestricted model  → true (serve locally).
 * Restricted to "*"   → false (reachable only via a peer).
 * Restricted to IPs   → true iff one of this host's IPs matches the rules.
 */
function locallyServes(env = process.env, model) {
  const name = String(model || '').trim().toLowerCase();
  if (!name) return false;
  const rules = parseRestrictedModels(env.KHY_MESH_RESTRICTED_MODELS)[name];
  if (rules === undefined) return true;
  return rules.includes('*') ? false : localIps(env).some((ip) => ipAllowed(rules, ip));
}

function localCapabilities(env = process.env) {
  const restricted = parseRestrictedModels(env.KHY_MESH_RESTRICTED_MODELS);
  // A model that this node cannot serve under its current IP is handed out to
  // peers as "advertised but restricted": callers must not forward it to us.
  const restrictedModels = Object.keys(restricted).filter((name) => !locallyServes(env, name));
  return {
    id: String(env.KHY_MESH_NODE_ID || os.hostname()).trim().slice(0, 64),
    models: String(env.KHY_MESH_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean),
    capabilities: String(env.KHY_MESH_CAPABILITIES || '').split(',').map((x) => x.trim()).filter(Boolean),
    restrictedModels,
    updatedAt: new Date().toISOString(),
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorize(token, env = process.env) {
  return safeEqual(token, env.KHY_MESH_TOKEN);
}

function matches(peer, request = {}) {
  const model = String(request.model || request.preferredModel || '').trim().toLowerCase();
  const capability = String(request.meshCapability || '').trim().toLowerCase();
  const models = (peer.models || []).map((item) => String(item).trim().toLowerCase());
  const capabilities = (peer.capabilities || []).map((item) => String(item).trim().toLowerCase());
  return !!((model && models.includes(model)) || (capability && capabilities.includes(capability)));
}

function serializableOptions(options = {}) {
  const allowed = ['model', 'preferredModel', 'preferredAdapter', 'system', 'messages', 'images', 'maxTokens', 'temperature', 'topP', 'tools', 'toolChoice', 'userId', 'sessionId', 'requestId', 'requestSource', 'taskScale', 'meshCapability'];
  const out = {};
  for (const key of allowed) if (options[key] !== undefined && typeof options[key] !== 'function') out[key] = options[key];
  out._meshHop = Math.max(1, Number(options._meshHop || 0) + 1);
  return out;
}

class ModelMesh {
  constructor(options = {}) {
    this._env = options.env || process.env;
    this._fetch = options.fetch || globalThis.fetch;
    this._now = options.now || Date.now;
    this._cache = new Map();
  }
  isEnabled() { return enabled(this._env) && !!String(this._env.KHY_MESH_TOKEN || '').trim(); }
  _timeoutMs() { return Math.max(1000, Number(this._env.KHY_MESH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS); }
  async discover(peer) {
    const ttl = Math.max(1000, Number(this._env.KHY_MESH_DISCOVERY_TTL_MS) || DEFAULT_DISCOVERY_TTL_MS);
    const cached = this._cache.get(peer.url);
    if (cached && this._now() - cached.at < ttl) return { ...peer, ...cached.value };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(10000, this._timeoutMs()));
    try {
      const response = await this._fetch(`${peer.url}/api/mesh/capabilities`, { headers: { 'x-khy-mesh-token': String(this._env.KHY_MESH_TOKEN) }, signal: controller.signal });
      if (!response.ok) throw new Error(`capability discovery HTTP ${response.status}`);
      const body = await response.json();
      const value = {
        id: String(body.id || peer.id).slice(0, 64),
        models: Array.isArray(body.models) ? body.models.map(String) : peer.models,
        capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : peer.capabilities,
        restrictedModels: Array.isArray(body.restrictedModels) ? body.restrictedModels.map(String) : (peer.restrictedModels || []),
      };
      this._cache.set(peer.url, { at: this._now(), value });
      return { ...peer, ...value };
    } finally { clearTimeout(timer); }
  }
  async select(options = {}) {
    if (!this.isEnabled() || Number(options._meshHop || 0) > 0) return null;
    const peers = parsePeers(this._env);
    const discovered = await Promise.all(peers.map(async (peer) => { try { return await this.discover(peer); } catch { return peer; } }));
    const ev = this._env;
    const restricted = parseRestrictedModels(ev.KHY_MESH_RESTRICTED_MODELS);
    const onlyRestricted = Object.keys(restricted).length > 0;
    const model = String(options.model || options.preferredModel || '').trim().toLowerCase();
    const candidates = discovered.filter((peer) => matches(peer, options));
    return (
      candidates
        // A peer marks a model restricted when it cannot serve it under ITS
        // own IP: such a peer would fail the request, so never select it.
        .filter((peer) => !(model && (peer.restrictedModels || []).map((m) => String(m).toLowerCase()).includes(model)))
        .filter((peer) => {
          if (!model) return true; // capability-based routing: local lacks it, forward.
          if (!onlyRestricted) return true; // no restriction declared: legacy eager forward.
          // Restricted list is declared: forward unless the model is both
          // listed as restricted AND this node can serve it under its current
          // IP. A model not in the list is unrestricted -> hand it to the peer.
          const serveable = locallyServes(ev, model);
          return !(Object.prototype.hasOwnProperty.call(restricted, model) && serveable);
        })
        .sort((a, b) => a.priority - b.priority)[0] || null
    );
  }
  async forward(prompt, options = {}) {
    const peer = await this.select(options);
    if (!peer) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs());
    try {
      if (typeof options.onChunk === 'function') options.onChunk({ type: 'status', text: `模型请求已路由到节点 ${peer.id}` });
      const response = await this._fetch(`${peer.url}/api/mesh/generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-khy-mesh-token': String(this._env.KHY_MESH_TOKEN) }, body: JSON.stringify({ prompt: String(prompt || ''), options: serializableOptions(options) }), signal: controller.signal });
      const body = await response.json();
      if (!response.ok || !body || body.success === false) throw new Error(`mesh peer ${peer.id} failed (HTTP ${response.status})`);
      return { ...body, mesh: { peerId: peer.id, remote: true } };
    } finally { clearTimeout(timer); }
  }
}

let singleton = null;
function getModelMesh() { return singleton || (singleton = new ModelMesh()); }

module.exports = { ModelMesh, getModelMesh, enabled, parsePeers, parseRestrictedModels, localIps, ipAllowed, locallyServes, localCapabilities, authorize, matches, serializableOptions };
