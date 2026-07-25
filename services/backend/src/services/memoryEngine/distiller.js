/**
 * memoryEngine/distiller.js — periodic memory distillation.
 *
 * "记忆定期蒸馏，明白哪些该忘记哪些该记住" — over time a memory store accumulates
 * stale, empty, and near-duplicate entries that dilute proactive recall. This
 * module decides, transparently and reversibly, what to KEEP and what to FORGET.
 *
 * Safety contract (honors the project red line: never silently destroy user data):
 *   - analyze() is pure: it produces a PLAN ({keep, forget, merge}) with a reason
 *     for every decision. It changes nothing on disk.
 *   - "forget" means ARCHIVE (move into <memoryDir>/.archive/ with a manifest),
 *     never hard-delete. Archived memories are fully restorable.
 *   - Dry-run is the default everywhere; mutation requires an explicit apply flag.
 *   - Periodic runs default to report-only (KHY_MEMORY_DISTILL_AUTO=report); they
 *     only archive when an operator explicitly opts in (=archive).
 *
 * What to FORGET (in priority order):
 *   1. empty       — body shorter than KHY_MEMORY_MIN_BODY_CHARS (default 12).
 *   2. duplicate   — near-duplicate (token Jaccard ≥ KHY_MEMORY_DUP_THRESHOLD,
 *                    default 0.82) of a higher-value memory → the weaker one goes.
 *   3. stale       — older than a per-type staleness horizon (user≫feedback≈
 *                    reference≫project), so durable identity/preferences survive
 *                    while finished project notes age out.
 *
 * Everything else is KEPT, with a transparent value score for inspection.
 *
 * All thresholds are env-tunable (zero hardcoding).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const memdir = require('../../memdir');
const memoryTier = require('../memoryTier');

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];

// ── tunables ─────────────────────────────────────────────────────────────

function _int(envKey, dflt) {
  const v = parseInt(process.env[envKey] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
function _float(envKey, dflt) {
  const v = parseFloat(process.env[envKey] || '');
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function minBodyChars() { return _int('KHY_MEMORY_MIN_BODY_CHARS', 12); }
function dupThreshold() { return _float('KHY_MEMORY_DUP_THRESHOLD', 0.82); }
function distillIntervalDays() { return _float('KHY_MEMORY_DISTILL_INTERVAL_DAYS', 7); }

/** Per-type staleness horizon in days. user is effectively immortal. */
function staleThresholdDays(type) {
  const t = String(type || '').toLowerCase();
  const perType = {
    user: _float('KHY_MEMORY_STALE_DAYS_USER', 3650),
    feedback: _float('KHY_MEMORY_STALE_DAYS_FEEDBACK', 540),
    reference: _float('KHY_MEMORY_STALE_DAYS_REFERENCE', 365),
    project: _float('KHY_MEMORY_STALE_DAYS_PROJECT', 180),
  };
  return perType[t] || _float('KHY_MEMORY_STALE_DAYS', 365);
}

/** Durability weight by type (higher ⇒ more worth keeping), for the value score. */
function _durabilityWeight(type) {
  const t = String(type || '').toLowerCase();
  return ({ user: 1.0, feedback: 0.9, reference: 0.6, project: 0.5 })[t] || 0.5;
}

// ── similarity ─────────────────────────────────────────────────────────────

/** Token set of a memory's combined name + description + body. */
function _memTokens(entry, body) {
  const fm = entry.frontmatter || {};
  const text = `${fm.name || ''} ${fm.description || ''} ${body || ''}`;
  return memdir._tokenizeForRecall(text);
}

/** Jaccard similarity between two token sets. */
function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── analysis ─────────────────────────────────────────────────────────────

/**
 * A transparent "worth keeping" score: durability(type) × recency × richness.
 * Used to pick the survivor among near-duplicates and to explain keep decisions.
 */
function _valueScore(type, modifiedAtMs, bodyLen, nowMs) {
  const ageDays = Math.max(0, (nowMs - modifiedAtMs) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / Math.max(1, staleThresholdDays(type)));
  const richness = Math.min(1, bodyLen / 400); // saturates around a paragraph
  return _durabilityWeight(type) * (0.5 + 0.5 * recency) * (0.4 + 0.6 * richness);
}

/**
 * Analyze the memory store and produce a distillation plan. Pure: no disk writes.
 *
 * @param {object} [opts]
 * @param {number} [opts.nowMs] - injectable clock for deterministic tests
 * @returns {{
 *   keep: Array<{filename,type,value}>,
 *   forget: Array<{filename,type,reason,detail}>,
 *   merge: Array<{survivor,absorbed:string[],reason}>,
 *   stats: object
 * }}
 */
function analyze(opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  let list;
  try { list = memdir.listMemories(); } catch { list = []; }

  // Hydrate each memory with body + tokens + value, skipping unreadable files.
  const mems = [];
  for (const entry of list) {
    const parsed = memdir.readMemory(entry.filename);
    if (!parsed.exists) continue;
    const body = String(parsed.body || '').trim();
    const type = String((entry.frontmatter || {}).type || '').toLowerCase();
    const modifiedAtMs = entry.modifiedAt instanceof Date
      ? entry.modifiedAt.getTime()
      : Number(entry.modifiedAt) || nowMs;
    mems.push({
      filename: entry.filename,
      frontmatter: entry.frontmatter || {},
      type,
      // 保留层 + 是否可被自动遗忘:permanent 层(默认含 type=user)永不进 forget,
      // 把原本靠 per-type 保鲜期(user=3650 天)近似的「永久」升级为硬不变量。
      // 门控关闭时 isForgetEligible 一律 true → 行为回退到既有 per-type 老化。
      tier: memoryTier.classifyTier(entry.frontmatter || {}),
      forgetEligible: memoryTier.isForgetEligible(entry.frontmatter || {}),
      body,
      bodyLen: body.length,
      modifiedAtMs,
      tokens: _memTokens(entry, body),
      value: _valueScore(type, modifiedAtMs, body.length, nowMs),
    });
  }

  const forget = [];
  const merge = [];
  const forgotten = new Set();

  // 1) Empty / near-empty bodies. permanent 层即便正文短也不自动遗忘(免疫)。
  const minБody = minBodyChars();
  for (const m of mems) {
    if (m.bodyLen < minБody && m.forgetEligible) {
      forget.push({ filename: m.filename, type: m.type, reason: 'empty', detail: `正文仅 ${m.bodyLen} 字符` });
      forgotten.add(m.filename);
    }
  }

  // 2) Near-duplicates: among survivors, cluster by similarity; keep the highest
  //    value, archive the rest. Process by descending value so survivors win.
  const survivors = mems.filter((m) => !forgotten.has(m.filename))
    .sort((a, b) => b.value - a.value || b.modifiedAtMs - a.modifiedAtMs || a.filename.localeCompare(b.filename));
  const threshold = dupThreshold();
  const kept = [];
  for (const m of survivors) {
    if (forgotten.has(m.filename)) continue;
    let absorbedInto = null;
    for (const k of kept) {
      if (jaccard(m.tokens, k.tokens) >= threshold) { absorbedInto = k; break; }
    }
    if (absorbedInto && m.forgetEligible) {
      forget.push({
        filename: m.filename,
        type: m.type,
        reason: 'duplicate',
        detail: `与 ${absorbedInto.filename} 高度重复`,
      });
      forgotten.add(m.filename);
      const grp = merge.find((g) => g.survivor === absorbedInto.filename);
      if (grp) grp.absorbed.push(m.filename);
      else merge.push({ survivor: absorbedInto.filename, absorbed: [m.filename], reason: 'near-duplicate' });
    } else {
      // 非重复,或虽近似但属 permanent 层(免疫遗忘)→ 保留。
      kept.push(m);
    }
  }

  // 3) Staleness: among remaining survivors, age out per-type horizons.
  for (const m of kept.slice()) {
    if (forgotten.has(m.filename)) continue;
    const ageDays = (nowMs - m.modifiedAtMs) / 86_400_000;
    const horizon = staleThresholdDays(m.type);
    if (ageDays > horizon && m.forgetEligible) {
      forget.push({
        filename: m.filename,
        type: m.type,
        reason: 'stale',
        detail: `已 ${Math.round(ageDays)} 天未更新，超过 ${m.type || '默认'} 类型 ${Math.round(horizon)} 天保鲜期`,
      });
      forgotten.add(m.filename);
    }
  }

  const keep = kept
    .filter((m) => !forgotten.has(m.filename))
    .map((m) => ({ filename: m.filename, type: m.type, value: Number(m.value.toFixed(4)) }))
    .sort((a, b) => b.value - a.value);

  const stats = {
    total: mems.length,
    keep: keep.length,
    forget: forget.length,
    mergeGroups: merge.length,
    byReason: forget.reduce((acc, f) => { acc[f.reason] = (acc[f.reason] || 0) + 1; return acc; }, {}),
  };

  return { keep, forget, merge, stats };
}

// ── archive (reversible "forget") ──────────────────────────────────────────

function _archiveDir() {
  return path.join(memdir.getMemoryDir(), '.archive');
}
function _manifestPath() {
  return path.join(_archiveDir(), 'manifest.json');
}

function _readManifest() {
  try {
    const raw = fs.readFileSync(_manifestPath(), 'utf8');
    const m = JSON.parse(raw);
    return Array.isArray(m) ? m : [];
  } catch { return []; }
}
function _writeManifest(entries) {
  fs.mkdirSync(_archiveDir(), { recursive: true });
  fs.writeFileSync(_manifestPath(), JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

/** Remove the given filenames from the MEMORY.md index (best-effort). */
function _removeFromIndex(filenames) {
  try {
    const idxPath = memdir.getMemoryIndexPath();
    if (!fs.existsSync(idxPath)) return;
    const set = new Set(filenames);
    const lines = fs.readFileSync(idxPath, 'utf8').split('\n');
    const filtered = lines.filter((line) => {
      const match = line.match(/\(([^)]+)\)/);
      return !(match && set.has(match[1]));
    });
    fs.writeFileSync(idxPath, filtered.join('\n'), 'utf8');
  } catch { /* best effort */ }
}

/**
 * Apply a plan's "forget" set by ARCHIVING (moving) each file into .archive/ and
 * recording it in the manifest. Reversible. Returns a result summary.
 *
 * @param {object} plan - output of analyze()
 * @param {object} [opts]
 * @param {string} [opts.stamp] - ISO-ish stamp string for manifest (injectable)
 * @returns {{archived: string[], failed: Array<{filename,error}>}}
 */
function applyPlan(plan, opts = {}) {
  const dir = memdir.getMemoryDir();
  const archiveDir = _archiveDir();
  fs.mkdirSync(archiveDir, { recursive: true });

  const manifest = _readManifest();
  const archived = [];
  const failed = [];
  const stamp = opts.stamp || _isoStamp(Number.isFinite(opts.nowMs) ? opts.nowMs : null);

  for (const item of plan.forget || []) {
    const src = path.join(dir, item.filename);
    let dest = path.join(archiveDir, item.filename);
    try {
      if (!fs.existsSync(src)) { failed.push({ filename: item.filename, error: 'not found' }); continue; }
      // Avoid clobbering a prior archived file of the same name.
      if (fs.existsSync(dest)) {
        const ext = path.extname(item.filename);
        const base = item.filename.slice(0, item.filename.length - ext.length);
        dest = path.join(archiveDir, `${base}.${archived.length}_${manifest.length}${ext}`);
      }
      fs.renameSync(src, dest);
      manifest.push({
        filename: item.filename,
        archivedAs: path.basename(dest),
        reason: item.reason,
        detail: item.detail,
        type: item.type,
        archivedAt: stamp,
      });
      archived.push(item.filename);
    } catch (err) {
      failed.push({ filename: item.filename, error: err && err.message ? err.message : String(err) });
    }
  }

  if (archived.length) {
    _writeManifest(manifest);
    _removeFromIndex(archived);
  }
  return { archived, failed };
}

/**
 * Restore archived memories back into the live memory dir.
 *
 * @param {object} [opts]
 * @param {string} [opts.filename] - restore one original filename; omit ⇒ all
 * @returns {{restored: string[], failed: Array<{filename,error}>}}
 */
function restore(opts = {}) {
  const dir = memdir.getMemoryDir();
  const archiveDir = _archiveDir();
  const manifest = _readManifest();
  const restored = [];
  const failed = [];
  const remaining = [];

  for (const rec of manifest) {
    const wantOne = opts.filename && rec.filename !== opts.filename;
    if (wantOne) { remaining.push(rec); continue; }
    const src = path.join(archiveDir, rec.archivedAs || rec.filename);
    const dest = path.join(dir, rec.filename);
    try {
      if (!fs.existsSync(src)) { failed.push({ filename: rec.filename, error: 'archive missing' }); continue; }
      if (fs.existsSync(dest)) { failed.push({ filename: rec.filename, error: '目标已存在，跳过以免覆盖' }); remaining.push(rec); continue; }
      fs.renameSync(src, dest);
      restored.push(rec.filename);
    } catch (err) {
      failed.push({ filename: rec.filename, error: err && err.message ? err.message : String(err) });
      remaining.push(rec);
    }
  }

  _writeManifest(remaining);
  return { restored, failed };
}

/** List currently archived memories (from the manifest). */
function listArchived() {
  return _readManifest();
}

// ── periodic gating ──────────────────────────────────────────────────────

function _statePath() {
  return path.join(memdir.getMemoryDir(), '.distill.json');
}
function _readState() {
  try { return JSON.parse(fs.readFileSync(_statePath(), 'utf8')) || {}; } catch { return {}; }
}
function _writeState(state) {
  try {
    fs.mkdirSync(memdir.getMemoryDir(), { recursive: true });
    fs.writeFileSync(_statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch { /* best effort */ }
}

function _isoStamp(nowMs) {
  // Avoid new Date() with no args being flagged; accept an injected clock.
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  return new Date(ms).toISOString();
}

/** True when at least the configured interval has elapsed since the last run. */
function intervalElapsed(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const state = _readState();
  const last = Number(state.lastRunMs) || 0;
  const intervalMs = distillIntervalDays() * 86_400_000;
  return now - last >= intervalMs;
}

function _stampRun(nowMs, plan) {
  _writeState({
    lastRunMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
    lastRunAt: _isoStamp(Number.isFinite(nowMs) ? nowMs : null),
    lastStats: plan ? plan.stats : null,
  });
}

// ── orchestration ──────────────────────────────────────────────────────────

/**
 * Run a distillation cycle.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false] - when true, ARCHIVE the forget set
 * @param {number}  [opts.nowMs]
 * @returns {{plan, applied: boolean, result: object|null}}
 */
function distill(opts = {}) {
  const plan = analyze({ nowMs: opts.nowMs });
  let result = null;
  let applied = false;
  if (opts.apply && plan.forget.length) {
    result = applyPlan(plan, { nowMs: opts.nowMs });
    applied = true;
  }
  _stampRun(opts.nowMs, plan);
  return { plan, applied, result };
}

/**
 * Periodic entry point: only acts when the interval has elapsed. The auto action
 * is governed by KHY_MEMORY_DISTILL_AUTO:
 *   'off'     — disabled entirely.
 *   'report'  — (default) analyze + stamp; returns the plan, changes nothing.
 *   'archive' — analyze + ARCHIVE the forget set (still reversible).
 *
 * Fail-soft: returns {skipped:true,...} on any problem; never throws.
 *
 * @param {object} [opts] - { nowMs, force }
 * @returns {{skipped:boolean, reason?:string, plan?:object, applied?:boolean, result?:object}}
 */
function maybeDistill(opts = {}) {
  try {
    const mode = String(process.env.KHY_MEMORY_DISTILL_AUTO || 'report').toLowerCase();
    if (mode === 'off') return { skipped: true, reason: 'disabled' };
    if (process.env.KHY_DISABLE_MEMORY === '1' || process.env.KHY_DISABLE_MEMORY === 'true') {
      return { skipped: true, reason: 'memory-disabled' };
    }
    if (!opts.force && !intervalElapsed(opts.nowMs)) return { skipped: true, reason: 'interval-not-elapsed' };
    const out = distill({ apply: mode === 'archive', nowMs: opts.nowMs });
    return { skipped: false, ...out, mode };
  } catch (err) {
    return { skipped: true, reason: 'error', error: err && err.message ? err.message : String(err) };
  }
}

// ── presentation ───────────────────────────────────────────────────────────

const REASON_LABEL = { empty: '空记忆', duplicate: '重复', stale: '陈旧' };

/** Render a distillation plan as human-readable lines (for the CLI). */
function formatPlan(plan) {
  const lines = [];
  const s = plan.stats || {};
  lines.push(`共 ${s.total || 0} 条记忆 → 保留 ${s.keep || 0} · 建议忘记 ${s.forget || 0}`);
  if (plan.forget && plan.forget.length) {
    lines.push('');
    lines.push('建议忘记（归档，可恢复）:');
    for (const f of plan.forget) {
      lines.push(`  - [${REASON_LABEL[f.reason] || f.reason}] ${f.filename} — ${f.detail}`);
    }
  }
  if (plan.merge && plan.merge.length) {
    lines.push('');
    lines.push('合并组（保留首项，其余归档）:');
    for (const g of plan.merge) {
      lines.push(`  - 保留 ${g.survivor} ← 吸收 ${g.absorbed.join(', ')}`);
    }
  }
  if (plan.keep && plan.keep.length) {
    lines.push('');
    lines.push('保留（价值高→低，前 10 条）:');
    for (const k of plan.keep.slice(0, 10)) {
      lines.push(`  - ${k.filename} (${k.type || '?'}, 价值 ${k.value})`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  VALID_TYPES,
  // analysis
  analyze,
  jaccard,
  staleThresholdDays,
  // actions
  applyPlan,
  restore,
  listArchived,
  distill,
  maybeDistill,
  // periodic
  intervalElapsed,
  // presentation
  formatPlan,
};
