'use strict';

/**
 * crossAgentTasteLearner.js — Mine Claude Code / Command Code / OpenCode /
 * Gemini / YCode / Codex sessions for reusable taste preferences, then promote
 * the high-confidence ones into tasteService.
 *
 * Mirrors the spirit of cmdc's `/learn-taste` (which scrapes session history
 * and surfaces learned preferences) but stays local-only and heuristic: no
 * cloud model, no LLM call. Each candidate is a (category, text, confidence)
 * triple that gets re-bucketed through tasteService.addPreference.
 *
 * Heuristics (no LLM, deterministic, no IO at import):
 *   1. Short standalone meta-comments on assistant replies (re-uses the
 *      preferenceSignals vocabulary) → response-style / workflow preferences.
 *   2. Recurring CLI flags in user turns (--no-emoji, --language=zh,
 *      permissionMode=bypassPermissions, effort=high, …) → style preferences.
 *   3. Repeated tool/command prefixes ("/taste", "khy", "khyos", "gpt-",
 *      "claude-") → tooling-tendency preferences.
 *   4. Recurring response patterns in assistant turns (refusal, summary
 *      style) → lower-confidence hints (not promoted by default).
 *
 * Confidence policy:
 *   * initial 0.6 on first sighting within a session
 *   * +0.05 per distinct session (capped at 0.85 — leave headroom for
 *     explicit `khy taste add` to overtake)
 *   * dedup is hash-of-normalized-text within a category
 *   * the dedup map is per-call (caller decides whether to persist across
 *     calls; today `khy taste learn` runs one scan, returns candidates, and
 *     the user can rerun later)
 *
 * IO contract: this module NEVER mutates taste files. commitCandidates()
 * delegates to tasteService.addPreference so all atomic-write, injection-
 * scan, and overflow-fallback rules stay in one place.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectPreferenceSignal, signalToTaste } = require('./preferenceSignals');

// Minimum confidence we'll even *show* in learn output. Anything weaker is
// noise — `khy taste add` for an explicit item is still the better path.
const MIN_USEFUL_CONFIDENCE = 0.55;
// Auto-commit threshold for `khy taste learn` (no flag) — kept lower than the
// manual-add 0.7 default because candidates are inferred, not declared.
const DEFAULT_AUTO_COMMIT_FLOOR = 0.7;

// CLI-flag → category + canonical text. The text is exactly what lands in
// taste.md, so it's a human-readable statement, not raw flag gibberish.
const CLI_FLAG_PATTERNS = Object.freeze([
  {
    flag: '--language=zh',
    flagsAny: ['--language=zh', '--lang=zh', 'language:zh', '"language":"zh"'],
    category: 'language',
    text: '用户偏好中文输出',
  },
  {
    flag: '--language=en',
    flagsAny: ['--language=en', '--lang=en', 'language:en', '"language":"en"'],
    category: 'language',
    text: '用户偏好英文输出',
  },
  {
    flag: '--no-emoji',
    flagsAny: ['--no-emoji', 'no_emoji', 'noEmoji'],
    category: 'style',
    text: '用户不希望回复带 emoji',
  },
  {
    flag: 'bypassPermissions',
    flagsAny: ['bypasspermissions', 'bypass-permissions', 'permissionmode":"bypass'],
    category: 'workflow',
    text: '用户习惯绕过权限确认',
  },
  {
    flag: 'effort=high',
    flagsAny: ['effort":"high', '"effort":"high"'],
    category: 'workflow',
    text: '用户偏好高 effort(深度思考)模式',
  },
]);

// Command/tool prefixes that are often repeated. We watch for these in user
// turns only — assistant mentions are too noisy.
const TOOL_PREFIX_HINTS = Object.freeze([
  { prefix: 'khy ', category: 'tooling', text: '用户经常直接调用 khy 命令' },
  { prefix: 'khyos ', category: 'tooling', text: '用户经常直接调用 khyos 命令' },
  { prefix: '/taste', category: 'tooling', text: '用户经常用 /taste 命令' },
  { prefix: '/goal', category: 'tooling', text: '用户经常用 /goal 命令' },
  { prefix: 'claude ', category: 'tooling', text: '用户经常让 Claude 直接执行' },
  { prefix: 'zcode ', category: 'tooling', text: '用户经常直接调用 zcode 命令' },
]);

// ── Text extraction per record (one record → array of plain-text strings) ──

/**
 * Normalize a record (any of the six agents) to a flat list of plain-text
 * strings: user messages, assistant text blocks, and CLI flags. We do NOT
 * include thinking blocks or tool payloads — those would just blow up
 * confidence with implementation chatter.
 *
 * @param {object} rec - one JSONL line / one session record
 * @param {string} app - 'claude-code' | 'command-code' | 'opencode' | 'gemini' | 'codex' | 'ycode'
 * @returns {{ userTexts: string[], assistantTexts: string[], flags: string[] }}
 */
function extractTexts(rec, app) {
  const out = { userTexts: [], assistantTexts: [], flags: [] };
  if (!rec || typeof rec !== 'object') {
    return out;
  }
  const safeString = (v) => (typeof v === 'string' ? v : '');
  const safeStringify = (v) => {
    try {
      return typeof v === 'string' ? v : JSON.stringify(v);
    } catch {
      return '';
    }
  };

  // Common shape: { type: 'user'|'assistant', message: { role, content: string | array } }
  // (Claude Code, cmdc, OpenCode, Gemini — all close to this.)
  const msg = rec.message;
  if (msg && typeof msg === 'object') {
    const role = safeString(msg.role).toLowerCase();
    const target = role === 'assistant' ? out.assistantTexts : role === 'user' ? out.userTexts : null;
    if (target) {
      const c = msg.content;
      if (typeof c === 'string') {
        target.push(c);
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (!block || typeof block !== 'object') {
            continue;
          }
          if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') {
            target.push(safeString(block.text));
          }
        }
      } else if (c != null) {
        target.push(safeStringify(c));
      }
    }
  }

  // Codex: flatter — rec.role + rec.content.
  const flatRole = safeString(rec.role).toLowerCase();
  if (flatRole === 'user' || flatRole === 'human') {
    if (typeof rec.content === 'string') {
      out.userTexts.push(rec.content);
    } else if (Array.isArray(rec.content)) {
      for (const block of rec.content) {
        if (block && typeof block === 'object' && typeof block.text === 'string') {
          out.userTexts.push(block.text);
        }
      }
    }
  } else if (flatRole === 'assistant' || flatRole === 'model') {
    if (typeof rec.content === 'string') {
      out.assistantTexts.push(rec.content);
    } else if (Array.isArray(rec.content)) {
      for (const block of rec.content) {
        if (block && typeof block === 'object' && typeof block.text === 'string') {
          out.assistantTexts.push(block.text);
        }
      }
    }
  }

  // ZCode: a record is one API completion, NOT a single turn. We project it
  // into the common {user, assistant} view so the downstream preferenceSignals
  // and CLI-flag heuristics keep working. User-side text comes from
  // request.messages[].content (skip system — it's harness instructions, not
  // user intent). Assistant-side text comes from response.text and
  // response.reasoningText.
  if (rec.request && Array.isArray(rec.request.messages)) {
    for (const m of rec.request.messages) {
      if (!m || typeof m !== 'object') {
        continue;
      }
      const role = safeString(m.role).toLowerCase();
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
        continue; // system → harness boilerplate, not user intent
      }
      const target = role === 'user' ? out.userTexts : out.assistantTexts;
      const c = m.content;
      if (typeof c === 'string') {
        target.push(c);
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (!block || typeof block !== 'object') {
            continue;
          }
          if (block.type === 'text' || block.type === 'input_text') {
            target.push(safeString(block.text));
          }
          // 'image' / 'tool_use' / 'tool_result' blocks are intentionally
          // skipped — those would just blow up the preference signal
          // with implementation chatter.
        }
      }
    }
  }
  if (rec.response) {
    if (typeof rec.response.text === 'string') {
      out.assistantTexts.push(rec.response.text);
    }
    if (typeof rec.response.reasoningText === 'string') {
      // Reasoning text is assistant output too. Don't double-count on the
      // user side, but it's useful for the CLI-flag heuristic (e.g. when
      // a thinking block mentions a flag like "bypassPermissions" the model
      // is referencing user intent).
      out.assistantTexts.push(rec.response.reasoningText);
    }
  }

  // CLI flags: search the whole record stringified (cheap, robust to agent
  // quirks). The candidate set is small so this is O(few-hundred-bytes). We
  // skip empty/null records so the caller can rely on flags[0] being a
  // real payload (avoids noisy matches like "{}" on a stub record).
  const blob = safeStringify(rec).toLowerCase();
  if (blob && blob !== '{}' && blob !== 'null' && blob !== '[]') {
    out.flags.push(blob);
  }
  return out;
}

// ── Candidate generation (pure) ──────────────────────────────────────────

/**
 * Mine a single record for taste candidates. Returns a list of
 * `{ category, text, confidence, sources: { app, reason, count } }` — callers
 * collapse across records/sessions to dedup and bump confidence.
 *
 * @param {object} rec
 * @param {string} app
 * @param {string} [sessionId] - for tracing only; doesn't influence confidence
 * @returns {Array<{category: string, text: string, confidence: number, source: {app: string, reason: string}}>}
 */
function learnFromRecord(rec, app, sessionId) {
  const candidates = [];
  const { userTexts, assistantTexts, flags } = extractTexts(rec, app);
  const note = (reason) => ({
    app,
    reason,
    sessionId: sessionId || null,
  });

  // 1. preferenceSignals on user-side short meta-comments. We only run it on
  //    user turns to avoid false positives on assistant text mentioning
  //    these phrases.
  for (const t of userTexts) {
    const sig = detectPreferenceSignal(t);
    if (!sig) {
      continue;
    }
    const mapping = signalToTaste(sig);
    if (!mapping) {
      continue;
    }
    candidates.push({
      category: mapping.category,
      text: mapping.text,
      confidence: 0.6,
      source: { ...note(`preferenceSignal:${sig}`), record: 'user' },
    });
  }

  // 2. CLI flags. The user might set a flag in *one* session; the heuristic
  //    should not over-fire on a single occurrence. We attribute it at 0.55
  //    here and let commitCandidates() decide whether to promote.
  for (const t of flags) {
    if (typeof t !== 'string' || !t) {
      continue;
    }
    for (const pat of CLI_FLAG_PATTERNS) {
      if (pat.flagsAny.some((f) => t.includes(f))) {
        candidates.push({
          category: pat.category,
          text: pat.text,
          confidence: 0.55,
          source: { ...note(`flag:${pat.flag}`), record: 'flag' },
        });
      }
    }
  }

  // 3. Tool prefix hints (user turns only).
  for (const t of userTexts) {
    if (typeof t !== 'string') {
      continue;
    }
    const lower = t.toLowerCase();
    for (const hint of TOOL_PREFIX_HINTS) {
      if (lower.includes(hint.prefix)) {
        candidates.push({
          category: hint.category,
          text: hint.text,
          confidence: 0.55,
          source: { ...note(`prefix:${hint.prefix.trim()}`), record: 'user' },
        });
        break; // don't double-count within one record
      }
    }
  }

  return candidates;
}

// ── Dedup + confidence accumulation ───────────────────────────────────────

function _normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '')
    .trim();
}

function _dedupKey(category, text) {
  return `${category}::${_normalizeText(text)}`;
}

/**
 * Collapse a flat list of candidates (across many records) into a Map of
 * dedup keys → first-seen candidate with confidence bumped per distinct
 * session.
 *
 * @param {Array} candidates
 * @param {{ perSessionCap?: number }} [opts]
 * @returns {Array} deduplicated candidates with confidence bumped
 */
function collapseCandidates(candidates, opts = {}) {
  const perSessionCap = Number(opts.perSessionCap) || 5;
  const map = new Map();
  for (const c of candidates || []) {
    if (!c || typeof c.text !== 'string' || !c.text) {
      continue;
    }
    const key = _dedupKey(c.category, c.text);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        category: c.category,
        text: c.text,
        confidence: Math.max(0.4, Math.min(0.85, c.confidence || 0.6)),
        sessionIds: new Set([c.source && c.source.sessionId].filter(Boolean)),
        sources: [c.source],
      });
      continue;
    }
    if (c.source && c.source.sessionId) {
      existing.sessionIds.add(c.source.sessionId);
    }
    existing.sources.push(c.source);
    // Bump per distinct session, capped.
    const bump = Math.min(perSessionCap, existing.sessionIds.size) * 0.05;
    existing.confidence = Math.max(existing.confidence, 0.6 + bump);
  }
  return Array.from(map.values()).map((c) => ({
    category: c.category,
    text: c.text,
    confidence: Number(Math.min(0.85, c.confidence).toFixed(2)),
    sessionCount: c.sessionIds.size,
    sources: c.sources.slice(0, 3), // cap for downstream display
  }));
}

// ── File scanning (delegates to ccSwitch.usageScan) ──────────────────────

let _usageScan = null;
function _getUsageScan() {
  if (_usageScan !== null) {
    return _usageScan;
  }
  try {
    _usageScan = require('./domain/config/ccSwitch/usageScan');
  } catch {
    _usageScan = false; // remember the failure
  }
  return _usageScan || null;
}

// ── OpenClaw session discovery (kept out of ccSwitch on purpose) ────────
//
// Why not fold OpenClaw into ccSwitch.APPS?
//   - ccSwitch.APPS is the "provider-switch" surface: every entry maps to
//     a provider-card protocol and an externalApps/* config writer.
//     OpenClaw is an agent FRAMEWORK, not a model provider — it has no
//     provider card to switch to, and no externalApps/openclawAdapter.js
//     relationship with the rest of the switch ecosystem.
//   - Adding it to APPS would force APP_LABELS / PROTOCOL_DEFAULT_MODELS
//     decisions that don't apply. We just want to *read* its transcripts.
//
// OpenClaw transcript layout (verified Feb 2026 reference):
//   ~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl
// Overrides (precedence high→low): KHY_OPENCLAW_DATA_HOME, OPENCLAW_STATE_DIR,
// KHY_OPENCLAW_PROFILE (mirrors the official --profile flag).
// `utils/openclawHome.openclawStateDir` is the single source of truth for
// resolution; we use it and only have to add the agent-sibling walk.

const OPENCLAW_APP = 'openclaw';

// ── ZCode session discovery ─────────────────────────────────────────────
//
// ZCode is the official cross-vendor CLI (the same project that publishes
// `ycodeAdapter` for khy-os's provider switch). On the local box its
// session files live under:
//
//   ~/.zcode/cli/rollout/model-io-sess_*.jsonl
//
// Each line is one API completion, not a single user turn. Same reason as
// OpenClaw: it isn't a provider-client, so it does not belong in
// `ccSwitch.APPS` (which is the "provider card" surface). We project its
// records into the common {user, assistant} view inside extractTexts so the
// preferenceSignals / CLI-flag / tool-prefix heuristics keep working.
//
// Override: ZCODE_ROLLOUT_DIR (highest precedence). We intentionally do NOT
// re-use the YCode cache path (`%LocalAppData%/ycode/`) — that target was
// never written by this build; the real data lives in the path above.

const ZCODE_APP = 'zcode';

function _zcodeRolloutDir(env = process.env) {
  if (env && env.ZCODE_ROLLOUT_DIR && String(env.ZCODE_ROLLOUT_DIR).trim()) {
    return String(env.ZCODE_ROLLOUT_DIR).trim();
  }
  return path.join(os.homedir(), '.zcode', 'cli', 'rollout');
}

function _collectZcodeSessionFiles(env = process.env) {
  const dir = _zcodeRolloutDir(env);
  if (!dir) {
    return [];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) {
      continue;
    }
    const lower = e.name.toLowerCase();
    // YCode writes both `model-io-sess_*.jsonl` and legacy `sess_*.jsonl`
    // naming — accept both so a future rename doesn't break the miner.
    if (lower.endsWith('.jsonl') || lower.endsWith('.json')) {
      out.push({ app: ZCODE_APP, file: path.join(dir, e.name) });
    }
  }
  return out;
}

function _openclawAgentDirs(stateDir) {
  if (!stateDir) {
    return [];
  }
  const agentsDir = path.join(stateDir, 'agents');
  let entries = [];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(agentsDir, e.name, 'sessions'));
}

/**
 * Collect OpenClaw session JSONL files. Walks the agents/<id>/sessions
 * tree under the resolved state home. Best-effort: missing state home
 * or agents/ dir → empty array, never throws.
 *
 * @param {object} [env]
 * @returns {Array<{app: string, file: string}>}
 */
function _collectOpenclawSessionFiles(env = process.env) {
  let stateDir = '';
  try {
    const { openclawStateDir } = require('../utils/openclawHome');
    stateDir = openclawStateDir({ homedir: os.homedir(), env });
  } catch {
    return [];
  }
  if (!stateDir) {
    return [];
  }
  const out = [];
  for (const dir of _openclawAgentDirs(stateDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) {
        continue;
      }
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.jsonl') || lower.endsWith('.json')) {
        out.push({ app: OPENCLAW_APP, file: path.join(dir, e.name) });
      }
    }
  }
  return out;
}

/**
 * Discover session files for the given apps. Wraps ccSwitch.usageScan's
 * `collectSessionFiles` for the 6 provider-class tools (Claude Code, cmdc,
 * OpenCode, Gemini, Codex, YCode) AND adds OpenClaw on top — the latter is
 * owned here, not in ccSwitch, because OpenClaw is an agent framework
 * rather than a model-provider client.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.apps] - if set, limit to these app ids (others skipped)
 * @param {object} [opts.env] - env for per-app configDir resolvers
 * @returns {Array<{app: string, file: string}>}
 */
function discoverSessionFiles(opts = {}) {
  const env = opts.env || process.env;
  const apps = Array.isArray(opts.apps) && opts.apps.length ? new Set(opts.apps) : null;
  const out = [];
  const wantApp = (id) => !apps || apps.has(id);

  if (wantApp(OPENCLAW_APP)) {
    for (const f of _collectOpenclawSessionFiles(env)) {
      out.push(f);
    }
  }
  if (wantApp(ZCODE_APP)) {
    for (const f of _collectZcodeSessionFiles(env)) {
      out.push(f);
    }
  }

  // ccSwitch handles the 6 provider-class tools. We still skip the non-
  // session ones (deepseek / reasonix) by not requesting them — but the
  // ccSwitch directory resolver for those returns [] anyway, so it's safe
  // to iterate everything when no `apps` filter is given.
  const usageScan = _getUsageScan();
  if (usageScan) {
    let providerApps;
    try {
      const { APPS } = require('./domain/config/ccSwitch/constants');
      providerApps = Object.values(APPS);
    } catch {
      providerApps = [];
    }
    for (const app of providerApps) {
      if (!wantApp(app)) {
        continue;
      }
      try {
        const files = usageScan.collectSessionFiles(app, env);
        for (const f of files) {
          out.push({ app, file: f.file });
        }
      } catch {
        /* best-effort per app */
      }
    }
  }
  return out;
}

/**
 * Stream-read a JSONL session and yield every parsed record. JSON parse
 * errors on individual lines are skipped (mirroring cmdc's "torn lines
 * never block startup" guarantee). Non-JSONL `.json` files (OpenCode's
 * `ses_*.json` snapshot diffs) are read as a single-record file.
 *
 * @param {string} file
 * @returns {object[]}
 */
function readSessionRecords(file) {
  if (!file) {
    return [];
  }
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  if (file.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * Time-window filter: keep records whose timestamp is at or after `sinceMs`.
 * Records without a usable timestamp are kept (we don't want to silently
 * drop a session just because it lacks metadata).
 *
 * @param {object[]} records
 * @param {number} sinceMs
 * @returns {object[]}
 */
function filterByTime(records, sinceMs) {
  if (!sinceMs || !Array.isArray(records)) {
    return records || [];
  }
  return records.filter((rec) => {
    const ts = (rec && (rec.timestamp || (rec.message && rec.message.timestamp))) || null;
    if (!ts) {
      return true;
    }
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) {
      return true;
    }
    return ms >= sinceMs;
  });
}

// ── High-level entrypoint ────────────────────────────────────────────────

/**
 * Scan sessions for the given apps, mine candidates, and (optionally) commit
 * them to tasteService.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.apps]            - apps to scan (default: all 6)
 * @param {number}   [opts.sinceMs]         - only consider records after this timestamp
 * @param {number}   [opts.maxFiles]        - hard cap on session files scanned
 * @param {number}   [opts.minConfidence]   - drop candidates below this (default DEFAULT_AUTO_COMMIT_FLOOR)
 * @param {boolean}  [opts.dryRun]          - if true, return candidates without writing
 * @param {object}   [opts.env]
 * @returns {{
 *   scanned: { files: number, records: number, byApp: object },
 *   candidates: Array<{category, text, confidence, sessionCount, sources}>,
 *   committed: Array<{ok: boolean, category, text, confidence, location?, error?}>,
 *   errors: Array<{file: string, error: string}>,
 * }}
 */
function learnFromSessions(opts = {}) {
  const dryRun = !!opts.dryRun;
  const minConfidence = Number.isFinite(opts.minConfidence)
    ? opts.minConfidence
    : DEFAULT_AUTO_COMMIT_FLOOR;
  const maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : 200;

  const discovered = discoverSessionFiles({ apps: opts.apps, env: opts.env });
  // Sort newest-first when possible (mtime). ccSwitch.usageScan gives us
  // paths; we stat each to pick the most recent files first.
  const stats = [];
  for (const { app, file } of discovered) {
    try {
      const st = fs.statSync(file);
      stats.push({ app, file, mtime: st.mtimeMs || 0, size: st.size || 0 });
    } catch {
      stats.push({ app, file, mtime: 0, size: 0 });
    }
  }
  stats.sort((a, b) => b.mtime - a.mtime);
  const picked = stats.slice(0, maxFiles);

  const result = {
    scanned: { files: 0, records: 0, byApp: {} },
    candidates: [],
    committed: [],
    errors: [],
  };

  const allCandidates = [];
  for (const { app, file } of picked) {
    result.scanned.files += 1;
    result.scanned.byApp[app] = (result.scanned.byApp[app] || 0) + 1;
    let records = [];
    try {
      records = readSessionRecords(file);
    } catch (e) {
      result.errors.push({ file, error: (e && e.message) || 'read_failed' });
      continue;
    }
    if (opts.sinceMs) {
      records = filterByTime(records, opts.sinceMs);
    }
    result.scanned.records += records.length;
    const sessionId = path.basename(file, path.extname(file));
    for (const rec of records) {
      const cs = learnFromRecord(rec, app, sessionId);
      for (const c of cs) {
        allCandidates.push(c);
      }
    }
  }

  result.candidates = collapseCandidates(allCandidates, { perSessionCap: 5 });
  // Filter out very weak candidates before the (expensive-ish) commit step.
  result.candidates = result.candidates.filter((c) => c.confidence >= MIN_USEFUL_CONFIDENCE);

  if (dryRun) {
    return result;
  }

  // Commit the high-confidence ones to tasteService.
  let taste;
  try {
    taste = require('./tasteService');
  } catch (e) {
    result.errors.push({
      file: '<tasteService>',
      error: `tasteService unavailable: ${(e && e.message) || 'require_failed'}`,
    });
    return result;
  }

  for (const c of result.candidates) {
    if (c.confidence < minConfidence) {
      continue;
    }
    try {
      const out = taste.addPreference({
        category: c.category,
        text: c.text,
        confidence: c.confidence,
      });
      result.committed.push(out);
    } catch (e) {
      result.errors.push({
        file: `<taste:${c.category}/${c.text}>`,
        error: (e && e.message) || 'addPreference_failed',
      });
    }
  }
  return result;
}

module.exports = {
  // Pure
  extractTexts,
  learnFromRecord,
  collapseCandidates,
  filterByTime,
  readSessionRecords,
  // File / session
  discoverSessionFiles,
  _collectOpenclawSessionFiles,
  _collectZcodeSessionFiles,
  // Top-level
  learnFromSessions,
  // Constants (exported for tests / CLI help)
  CLI_FLAG_PATTERNS,
  TOOL_PREFIX_HINTS,
  MIN_USEFUL_CONFIDENCE,
  DEFAULT_AUTO_COMMIT_FLOOR,
  OPENCLAW_APP,
  ZCODE_APP,
};
