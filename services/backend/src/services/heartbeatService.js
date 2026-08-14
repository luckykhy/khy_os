'use strict';

/**
 * heartbeatService.js — declarative companion patrol (借鉴分析 #9).
 *
 * DesireCore's Heartbeat lets a companion periodically check its declared
 * sources (email / CI / calendar …), stay SILENT when nothing changed (the
 * green pill), and only NOTIFY on real events — deduped over 24h, and crucially
 * "通知只提醒，操作仍走审批" (a heartbeat NEVER executes anything itself).
 *
 * Khy-OS already had the unwired pieces: heartbeatRunner.js (phase-aligned
 * scheduling), heartbeatCooldown.js (intent matrix), and an AgentFS
 * `heartbeat/HEARTBEAT.md` asset + seed template. The missing layer — built
 * here — is the patrol spine that actually:
 *   1. parses the active companion's HEARTBEAT.md checklist,
 *   2. emits a silent/notify two-state result,
 *   3. dedupes events over a 24h window,
 *   4. produces reminder data ONLY — no operation is ever executed.
 *
 * This module deliberately does NOT reach out to email/CI/calendar. Real probes
 * are a pluggable seam: the caller passes `findings`, the spine decides what is
 * worth surfacing. That keeps the safety invariant trivially true — there is no
 * code path here that can run a tool or mutate anything outside the dedup ledger.
 *
 * Hard safety invariants (never relaxed):
 *   - Silent by default: no checklist / all-commented / no findings → silent.
 *   - 24h dedup: the same event key notifies at most once per window.
 *   - Never bypasses approval: patrol() returns reminder data only; it has no
 *     execute/run-tool capability. Any actual operation still goes through
 *     permissionStore / criticalGate (借鉴分析 #6).
 *   - Dedup writes are best-effort; on failure we fail-open (may re-notify,
 *     which is harmless) rather than swallow a real event.
 *
 * Storage: getDataDir('heartbeat', 'events.json'). No new dependencies.
 */

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('../utils/dataHome');

const EVENTS_FILE = 'events.json';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h dedup window

// ── 巡逻节流(heartbeatCooldown 接线,KHY_HEARTBEAT_COOLDOWN 默认开)──────────
// heartbeatService.js 头注声明 heartbeatCooldown.js(intent matrix)是配套部件,此前从未
// require —— 本段把它接成「巡逻节流层」:每次真实执行 patrol 记一次 run start,min-spacing 内
// 再次触发 → {status:'throttled'},flood 窗口内频繁触发 → 同样 throttled。门关 /
// AgentCooldownTracker 不可用 → 逐字节回退(不节流,与今日行为一致)。stamp 注入(测试确定性)
// 时跳过节流判定 —— 测试靠注入时间验证 24h dedup,节流若掺入会破坏确定性。
const {
  AgentCooldownTracker,
  DEFAULT_MIN_WAKE_SPACING_MS,
  DEFAULT_FLOOD_THRESHOLD,
} = require('./heartbeatCooldown');

const _patrolTracker = new AgentCooldownTracker({ defaultIntervalMs: DEFAULT_MIN_WAKE_SPACING_MS });

function _patrolCooldownEnabled(env = process.env) {
  const raw = env && env.KHY_HEARTBEAT_COOLDOWN;
  const v = String(raw == null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 判定本次 patrol 是否应被节流(仅在启用节流且未注入 stamp 时生效)。
 * @param {object} opts
 * @param {string} [opts.companionId]
 * @param {string} [opts.stamp] ISO 时间(注入 → 跳过节流,保测试确定性)
 * @param {object} [opts.env]
 * @returns {{defer:boolean, reason?:'min-spacing'|'flood'}}
 */
function _throttleCheck(opts = {}) {
  if (opts.stamp) {
    return { defer: false };
  } // 确定性测试路径不过节流
  if (!_patrolCooldownEnabled(opts.env || process.env)) {
    return { defer: false };
  }
  const id = opts.companionId || null;
  if (!id) {
    return { defer: false };
  }
  try {
    // manual 意图永不 defer;这里把「心跳巡检」当 event 意图 —— 有上次运行才受 min-spacing/flood 约束。
    const tracker = _patrolTracker;
    if (typeof tracker.registerAgent !== 'function') {
      return { defer: false };
    }
    tracker.registerAgent(id, DEFAULT_MIN_WAKE_SPACING_MS);
    const decision = tracker.shouldDefer(id, 'event');
    if (decision && decision.defer) {
      return { defer: true, reason: decision.reason || 'min-spacing' };
    }
    return { defer: false };
  } catch {
    return { defer: false }; // 节流器异常 → 放行(与关闭节流等价)
  }
}

function _recordPatrolRun(id) {
  if (!id) {
    return;
  }
  try {
    const tracker = _patrolTracker;
    if (typeof tracker.recordStart === 'function') {
      tracker.recordStart(id);
    }
  } catch {
    /* best-effort */
  }
}

// ── Dedup ledger I/O ──────────────────────────────────────────────────────────

function _eventsPath() {
  return path.join(getDataDir('heartbeat'), EVENTS_FILE);
}

function _load() {
  try {
    const raw = fs.readFileSync(_eventsPath(), 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.events && typeof data.events === 'object') {
      return data;
    }
  } catch {
    /* missing or corrupt — start fresh */
  }
  return { version: 1, events: {} };
}

function _save(data) {
  try {
    fs.writeFileSync(_eventsPath(), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function _globalEnabled() {
  return (
    String(process.env.KHY_HEARTBEAT || 'on')
      .trim()
      .toLowerCase() !== 'off'
  );
}

// ── Checklist parsing ─────────────────────────────────────────────────────────

const _SOURCE_HEAD_RE = /数据源|data\s*sources?|sources?/i;
const _CRITERIA_HEAD_RE = /判断标准|判断|标准|criteri/i;

/**
 * Parse a HEARTBEAT.md checklist into structured sections.
 *
 * A line is an ACTIVE bullet only if (trimmed) it starts with "- " and does NOT
 * start with "#". Commented example bullets (`# - …`) and blockquotes (`> …`)
 * are ignored, so the seed template — whose every bullet is commented — yields
 * `enabled:false`. Uncommenting any bullet flips the checklist on.
 *
 * @param {string} md
 * @returns {{ enabled:boolean, sources:string[], criteria:string[], raw:string }}
 */
function parseChecklist(md) {
  const raw = String(md || '');
  const sources = [];
  const criteria = [];
  let section = null; // 'sources' | 'criteria' | null

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }

    if (t.startsWith('#')) {
      const head = t.replace(/^#+\s*/, '');
      // "# - …" is a commented example bullet — ignore, keep current section.
      if (/^-\s+/.test(head)) {
        continue;
      }
      if (_SOURCE_HEAD_RE.test(head)) {
        section = 'sources';
        continue;
      }
      if (_CRITERIA_HEAD_RE.test(head)) {
        section = 'criteria';
        continue;
      }
      section = null; // any other heading ends the current section
      continue;
    }
    if (t.startsWith('>')) {
      continue;
    } // blockquote / note

    if (t.startsWith('- ')) {
      const item = t.slice(2).trim();
      if (!item) {
        continue;
      }
      if (section === 'sources') {
        sources.push(item);
      } else if (section === 'criteria') {
        criteria.push(item);
      }
    }
  }

  return { enabled: sources.length > 0 || criteria.length > 0, sources, criteria, raw };
}

// ── 24h dedup ─────────────────────────────────────────────────────────────────

/**
 * Whether an event key should notify now (not seen within the dedup window).
 * @param {{ key:string, stamp?:string, windowMs?:number }} opts
 * @returns {boolean}
 */
function shouldNotify(opts = {}) {
  const key = opts.key;
  if (!key) {
    return false;
  }
  const windowMs =
    Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : DEFAULT_WINDOW_MS;
  const now = opts.stamp ? Date.parse(opts.stamp) : Date.now();

  const entry = _load().events[key];
  if (!entry || !entry.lastNotified) {
    return true;
  }
  const last = Date.parse(entry.lastNotified);
  if (!Number.isFinite(last) || !Number.isFinite(now)) {
    return true;
  } // fail-open
  return now - last >= windowMs;
}

/**
 * Record that an event key was notified (advances the dedup window).
 * @param {{ key:string, stamp?:string }} opts
 */
function recordEvent(opts = {}) {
  const key = opts.key;
  if (!key) {
    return;
  }
  const data = _load();
  const now = opts.stamp || new Date().toISOString();
  const entry = data.events[key] || { lastNotified: null, count: 0, firstSeen: now };
  entry.lastNotified = now;
  entry.count = (entry.count || 0) + 1;
  entry.firstSeen = entry.firstSeen || now;
  data.events[key] = entry;
  _save(data);
}

// ── Patrol (silent / notify two-state) ────────────────────────────────────────

/**
 * Run one patrol for a companion: read its checklist, filter caller-supplied
 * findings through the 24h dedup, and return reminder data. NEVER executes
 * anything — operations stay behind the approval path.
 *
 * @param {object} [opts]
 * @param {string} [opts.companionId]   defaults to the active companion
 * @param {Array<{key:string,message?:string,severity?:string}>} [opts.findings]
 * @param {string} [opts.stamp]         ISO timestamp (injected for determinism)
 * @returns {{ status:'silent'|'notify', companionId:string|null, enabled:boolean,
 *             notified:Array, suppressed:Array, reason?:string }}
 */
function patrol(opts = {}) {
  const result = {
    status: 'silent',
    companionId: opts.companionId || null,
    enabled: false,
    notified: [],
    suppressed: [],
  };

  if (!_globalEnabled()) {
    result.reason = 'disabled';
    return result;
  }

  const svc = require('./agentFs/agentFsService');
  let id = opts.companionId;
  if (!id) {
    try {
      id = svc.getActiveAgentId();
    } catch {
      id = null;
    }
  }
  if (!id) {
    result.reason = 'no-active-companion';
    return result;
  }
  result.companionId = id;

  let md = '';
  try {
    md = svc.readAsset(id, svc.ASSET_FILES.heartbeat) || '';
  } catch {
    md = '';
  }
  const checklist = parseChecklist(md);
  result.enabled = checklist.enabled;
  if (!checklist.enabled) {
    result.reason = 'no-checklist';
    return result;
  }

  // 巡逻节流(heartbeatCooldown 接线):同一 companion 在 min-spacing/flood 内被再次触发 →
  // 本次 throttled,不进入 dedup/notify 处理。门 KHY_HEARTBEAT_COOLDOWN 关 / 注入 stamp →
  // 逐字节回退(不节流)。记录发生在「确认要处理 findings」之后,避免干跑也计节流。
  const throttle = _throttleCheck({ companionId: id, stamp: opts.stamp, env: opts.env });
  if (throttle.defer) {
    result.status = 'throttled';
    result.reason = throttle.reason;
    return result;
  }

  const findings = Array.isArray(opts.findings) ? opts.findings : [];
  for (const f of findings) {
    if (!f || !f.key) {
      continue;
    }
    const dedupKey = `${id}:${f.key}`;
    if (shouldNotify({ key: dedupKey, stamp: opts.stamp })) {
      recordEvent({ key: dedupKey, stamp: opts.stamp });
      result.notified.push(f);
    } else {
      result.suppressed.push(f);
    }
  }

  result.status = result.notified.length > 0 ? 'notify' : 'silent';
  // 真实执行完一轮 patrol(无论 notify 还是 silent)记一次 run start,供下次节流判定。
  if (!opts.stamp) {
    _recordPatrolRun(id);
  }
  return result;
}

// ── Inspection / maintenance ──────────────────────────────────────────────────

/** Return the raw dedup ledger (for CLI display). */
function getEvents() {
  return _load();
}

/** Clear the dedup ledger. */
function reset() {
  return _save({ version: 1, events: {} });
}

module.exports = {
  parseChecklist,
  patrol,
  shouldNotify,
  recordEvent,
  getEvents,
  reset,
  // 节流接线(heartbeatCooldown):测试/诊断可直接读门控与判定。
  patrolCooldownEnabled: _patrolCooldownEnabled,
  get EVENTS_PATH() {
    return _eventsPath();
  },
};
