/* khy-brain-gateway.js — a real-model brain for the built-in KHY agent.
 *
 * The built-in agent (khy-agent.js) answers the kernel's decision plane through
 * an injectable "brain". The default brain is a dependency-free rule set; this
 * module provides an alternative brain that asks the project's AI gateway for a
 * real model decision, so `ai <prose>` and `agentask <question>` are answered by
 * an actual LLM — while the OS stays loosely coupled to any specific model
 * (requirement 3): the model is chosen in-system via /disk/etc/agent.conf
 * (requirement 4), and if the gateway is unreachable we fall back to the rule
 * brain so the kernel is NEVER left blocked.
 *
 * Transport is plain HTTP to the gateway's OpenAI-compatible endpoint
 * (POST /v1/chat/completions). Only Node stdlib is used (http/https/fs/os), so
 * the bridge keeps its zero-dependency property and an agent process still runs
 * independently of the kernel.
 *
 * Configuration (all optional; opts override env override defaults):
 *   opts.url       gateway completions URL   (env KHY_GATEWAY_URL, else
 *                  http://${PROXY_HOST||127.0.0.1}:${PROXY_PORT||9100}/v1/chat/completions)
 *   opts.token     bearer token              (env PROXY_AUTH_TOKEN, else the
 *                  authToken in ~/.khy/proxy_server_auth.json)
 *   opts.model     fallback model id         (env KHY_BRAIN_MODEL, else
 *                  'claude/claude-sonnet-4-20250514'); the live config's `model`
 *                  key wins over this so the in-system choice routes the brain.
 *   opts.timeoutMs per-call HTTP timeout     (env KHY_BRAIN_TIMEOUT_MS, else
 *                  2500 — under the kernel's 3s ask deadline so a slow gateway
 *                  degrades to the rule brain instead of timing out the kernel).
 *
 * Usage:
 *   const { makeGatewayBrain } = require('./khy-brain-gateway');
 *   const agent = await new KhyAgent({ socketPath, brain: makeGatewayBrain() }).start();
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultBrain, INTENT_GENERIC, INTENT_NL } = require('./khy-agent');

const DEFAULT_MODEL = 'claude/claude-sonnet-4-20250514';
const DEFAULT_TIMEOUT_MS = 2500;

/* Read the gateway's auth token from the persisted file, if present. The gateway
 * normalizes tokens to a `khy-` prefix and writes them here on first start. */
function readAuthTokenFile() {
  const candidates = [
    path.join(os.homedir(), '.khy', 'proxy_server_auth.json'),
  ];
  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j.authToken === 'string' && j.authToken) return j.authToken;
    } catch (_e) { /* missing/unreadable: try next */ }
  }
  return null;
}

function defaultGatewayUrl() {
  const host = (process.env.PROXY_HOST || '127.0.0.1').trim();
  const port = (process.env.PROXY_PORT || '9100').trim();
  return `http://${host}:${port}/v1/chat/completions`;
}

/* POST a JSON body and resolve the parsed JSON response. Rejects on transport
 * error, timeout, non-2xx status, or unparseable body — callers fall back. */
function postJson(url, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`gateway HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`gateway timeout after ${timeoutMs}ms`)); });
    req.end(payload);
  });
}

/* Pull the assistant text out of an OpenAI-style completion envelope. */
function assistantText(resp) {
  const c = resp && resp.choices && resp.choices[0];
  const content = c && c.message && c.message.content;
  return typeof content === 'string' ? content : '';
}

function firstLine(s) {
  return String(s).split(/\r?\n/).map((t) => t.trim()).find(Boolean) || '';
}

/* Build the messages for a decision question, shaping the model's output to the
 * exact grammar each plane expects. */
function buildMessages(question, code, config) {
  const cfgLine = config && Object.keys(config).length
    ? `\nCurrent system config: ${Object.entries(config).map(([k, v]) => `${k}=${v}`).join(', ')}.`
    : '';
  if (code === INTENT_GENERIC) {
    return [
      {
        role: 'system',
        content:
          'You are the security decision authority embedded in KHY-OS, a self-built '
          + 'operating system. The kernel is asking whether to permit an action. Reply '
          + 'with EXACTLY one word and nothing else: ALLOW or DENY. DENY anything '
          + 'destructive, irreversible, or dangerous (deleting/formatting/wiping data, '
          + 'shutting down, killing all processes); ALLOW safe, ordinary operations.'
          + cfgLine,
      },
      { role: 'user', content: String(question) },
    ];
  }
  // INTENT_NL (and anything else): one structured action line.
  return [
    {
      role: 'system',
      content:
        'You are the agent embedded in KHY-OS. The user speaks to you in natural '
        + 'language and you control the OS by replying with EXACTLY ONE action line, '
        + 'nothing else. Grammar:\n'
        + '  SET <key> <value>   persist a config value (common keys: model, endpoint)\n'
        + '  GET <key>           read back a config value\n'
        + '  SAY <text>          say something to the user (use for anything that is '
        + 'not a config change or read)\n'
        + 'Reply with one line beginning with SET, GET, or SAY. No quotes, no code '
        + 'fences, no explanation.'
        + cfgLine,
    },
    { role: 'user', content: String(question) },
  ];
}

/* Coerce the model's reply into the exact token the plane expects; on anything
 * unrecognized, defer to the rule brain (GENERIC) or wrap as SAY (NL). */
function shapeReply(reply, question, code, config) {
  if (code === INTENT_GENERIC) {
    const u = reply.toUpperCase();
    if (/\bDENY\b/.test(u)) return 'DENY';
    if (/\bALLOW\b/.test(u)) return 'ALLOW';
    return defaultBrain(question, code, config);
  }
  const line = firstLine(reply);
  const m = line.match(/^(set|get|say)\b\s*(.*)$/i);
  if (m) {
    const rest = m[2].trim();
    return rest ? `${m[1].toUpperCase()} ${rest}` : m[1].toUpperCase();
  }
  // Model answered in prose without an action verb: treat it as something to say.
  return line ? `SAY ${line}` : defaultBrain(question, code, config);
}

/* Build a brain bound to a gateway. Returns async (question, code, config) =>
 * string. Never throws and never returns null: on any gateway failure it falls
 * back to the dependency-free rule brain, so the kernel always gets an answer. */
function makeGatewayBrain(opts = {}) {
  const url = opts.url || process.env.KHY_GATEWAY_URL || defaultGatewayUrl();
  const token = opts.token || process.env.PROXY_AUTH_TOKEN || readAuthTokenFile();
  const fallbackModel = opts.model || process.env.KHY_BRAIN_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(opts.timeoutMs || process.env.KHY_BRAIN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};

  return async function gatewayBrain(question, code, config) {
    // The in-system configured model (requirement 4) routes the brain; the
    // env/opt model is only the fallback when nothing is configured.
    const model = (config && config.model) || fallbackModel;
    try {
      const resp = await postJson(
        url,
        token,
        { model, messages: buildMessages(question, code, config) },
        timeoutMs,
      );
      const text = assistantText(resp);
      if (!text) return defaultBrain(question, code, config);
      return shapeReply(text, question, code, config);
    } catch (e) {
      onError(e);
      return defaultBrain(question, code, config); // never block the kernel
    }
  };
}

module.exports = { makeGatewayBrain, DEFAULT_MODEL };
