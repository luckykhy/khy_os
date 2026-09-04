'use strict';

/**
 * ocMcpBridge.js — pure leaf: the single source of truth for *where* OpenClaw
 * stores configured MCP servers on disk, and *how* to extract the mcpServers
 * map out of OpenClaw's config shape, so khy can reuse OpenClaw's MCP assets —
 * any MCP server OpenClaw has set up becomes usable in khy. Zero-IO /
 * deterministic / never throws. Mirrors ccMcpBridge.js.
 *
 * Verified OpenClaw convention (phase 0): MCP servers are configured inside the
 * single JSON5 config file at
 *   - <stateHome>/openclaw.json  →  `mcp.servers`   (standard mcpServers schema:
 *       {command,args,env} | {url,transport})
 * where <stateHome> defaults to ~/.openclaw and is resolved (with the
 * KHY_OPENCLAW_DATA_HOME / OPENCLAW_STATE_DIR / --profile overrides) by the
 * shared utils/openclawHome leaf. The server-config schema is byte-identical to
 * khy's MCP loader, so "reuse OpenClaw's MCP" reduces to: point at the config
 * file, tolerantly parse the JSON5 text, and pull `mcp.servers` out. The shell
 * (services/mcp/index.js loadConfig) does the fs read and merges the result at
 * LOWEST priority (it never overrides an already-present server).
 *
 * Contract: zero IO (no fs/network/clock; homedir + env and the already-read
 * file TEXT injected by the shell), deterministic, never throws (fail-soft →
 * []/{} /null), env gate KHY_OPENCLAW_MCP_BRIDGE default ON; OFF → isEnabled=
 * false and the shell reverts byte-for-byte to its prior MCP discovery.
 *
 * Honest boundary: this only *discovers/reuses* MCP servers OpenClaw already
 * has configured on disk; it does not install, network-fetch, or launch
 * anything (khy's existing MCP client connects them). A missing file is
 * silently skipped by the shell.
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** KHY_OPENCLAW_MCP_BRIDGE gate: default ON, {0,false,off,no} (case/space-insensitive) → OFF. */
function isOcMcpBridgeEnabled(env = process.env) {
  const raw = env && env.KHY_OPENCLAW_MCP_BRIDGE;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

/** Join fail-soft: any bad segment → ''. Keeps the leaf non-throwing. */
const { openclawStateDir } = require('../../../../utils/openclawHome');
const _join = require('../../../../utils/pathJoinSafe');

/**
 * Enumerate OpenClaw's MCP config sources (does NOT touch the fs — the shell
 * decides which exist, reads the TEXT, and calls parseConfig + extractMcpServers).
 *
 * @param {object} args
 * @param {string} [args.homedir]  user home (shell injects os.homedir())
 * @param {object} [args.env]      environment map (shell injects process.env)
 * @returns {Array<{path:string, kind:string}>} sources (currently the single
 *   openclaw.json). Empty when no state home resolves. kind ∈ {'openclawJson'}.
 */
function ocMcpConfigSources({ homedir, env = process.env } = {}) {
  try {
    const stateDir = openclawStateDir({ homedir, env });
    if (!stateDir) {
      return [];
    }
    const p = _join(stateDir, 'openclaw.json');
    return p ? [{ path: p, kind: 'openclawJson' }] : [];
  } catch {
    return [];
  }
}

/**
 * Tolerantly parse OpenClaw's JSON5 config TEXT into an object. Prefers the
 * repo's `json5` dependency when resolvable; otherwise falls back to a
 * best-effort strip of // and block comments plus trailing commas before a
 * strict JSON.parse. Pure (string in → object|null out), never throws.
 *
 * @param {string} text raw file contents (shell injects fs.readFileSync)
 * @returns {object|null} parsed object, or null on any failure
 */
function parseConfig(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  // Preferred: real JSON5 parser (handles comments, trailing commas, unquoted
  // keys, single quotes) — resolved lazily so a missing dep is fail-soft.
  try {
    const JSON5 = require('json5');
    if (JSON5 && typeof JSON5.parse === 'function') {
      const obj = JSON5.parse(text);
      return obj && typeof obj === 'object' ? obj : null;
    }
  } catch {
    /* json5 unavailable or parse failed → try the tolerant fallback */
  }

  // Fallback: strip comments + trailing commas, then strict JSON.parse. Covers
  // the common JSON5-lite cases OpenClaw configs use without a real parser.
  try {
    const stripped = _stripJsonc(text);
    const obj = JSON.parse(stripped);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Strip line comments, block comments, and trailing commas from a
 * JSONC/JSON5-lite string while preserving string literals. Best-effort — used
 * only when the json5 dep is unavailable. Never throws.
 * @param {string} text
 * @returns {string}
 */
function _stripJsonc(text) {
  let out = '';
  let inStr = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n !== undefined ? n : '';
        i++;
        continue;
      }
      if (c === quote) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Extract the mcpServers map out of one parsed OpenClaw config object. OpenClaw
 * nests servers under `mcp.servers`. Pure — the shell passes the already-parsed
 * object.
 *
 * @param {object} raw parsed OpenClaw config
 * @returns {object} { name: serverConfig } map (empty on any miss / bad input)
 */
function extractMcpServers(raw) {
  try {
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const map = raw.mcp && raw.mcp.servers;
    if (!map || typeof map !== 'object') {
      return {};
    }
    // Shallow-copy each server config so callers can annotate (add _scope etc.)
    // without mutating the injected input.
    const out = {};
    for (const [name, cfg] of Object.entries(map)) {
      if (name && cfg && typeof cfg === 'object') {
        out[name] = { ...cfg };
      }
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  isOcMcpBridgeEnabled,
  ocMcpConfigSources,
  parseConfig,
  extractMcpServers,
};
