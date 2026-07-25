'use strict';

/**
 * Cron job scheduler for khy OS.
 * Aligned with Claude Code's ScheduleCron architecture.
 *
 * Supports:
 * - Standard 5-field cron expressions (minute hour dom month dow)
 * - One-shot jobs (recurring: false, auto-delete after firing)
 * - Recurring jobs (auto-expire after 7 days)
 * - Durable jobs (persisted to .khy/scheduled_tasks.json)
 * - Session-only jobs (in-memory, die with the process)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');

const DURABLE_FILE = process.env.KHY_CRON_DURABLE_FILE
  || path.join(os.homedir(), '.khy', 'scheduled_tasks.json');
const MAX_RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_JOBS = 50; // Aligned with CC CronCreateTool; bounds session lifetime

// Per-field inclusive bounds: minute, hour, day-of-month, month, day-of-week.
const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const CRON_FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];

/**
 * @typedef {Object} CronJob
 * @property {string} id
 * @property {string} cron - Standard 5-field cron expression
 * @property {string} prompt - The prompt to enqueue
 * @property {boolean} recurring - true = fire on every match; false = one-shot
 * @property {boolean} durable - true = persisted to disk
 * @property {number} createdAt - Unix timestamp (ms)
 * @property {number} [lastFired] - Unix timestamp (ms) of last fire
 * @property {number} [expiresAt] - Unix timestamp (ms) when auto-expires
 */

/** @type {Map<string, CronJob>} */
const _sessionJobs = new Map();

/** @type {Map<string, CronJob>} */
const _durableJobs = new Map();

/** @type {NodeJS.Timeout|null} */
let _tickInterval = null;

/**
 * Whether durable jobs have been loaded from disk in this process. Lets a
 * read-only consumer (CronList) reflect on-disk durable jobs even when the
 * scheduler was never explicitly started in this context, without re-reading
 * the file on every call.
 * @type {boolean}
 */
let _durableLoaded = false;

/** @type {function(string): void|null} */
let _enqueueCallback = null;

/**
 * Per-job same-minute dedup marker ("YYYY-MM-DD HH:MM").
 * Prevents a job from firing twice within the same wall-clock minute while
 * still allowing it to fire again the next day at the same time.
 * @type {Map<string, string>}
 */
const _lastFired = new Map();

/**
 * Build the date-aware minute marker used for same-minute dedup.
 * @param {Date} date
 * @returns {string} "YYYY-MM-DD HH:MM"
 */
function _minuteMarker(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}`;
}

/**
 * Generate a short unique job ID.
 * @returns {string}
 */
function generateJobId() {
  return 'cron_' + randomBytes(6).toString('hex');
}

/**
 * Parse a 5-field cron expression and check if it matches the given date.
 *
 * @param {string} expr - "M H DoM Mon DoW"
 * @param {Date} date
 * @returns {boolean}
 */
function cronMatches(expr, date) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay(); // 0=Sun

  if (!fieldMatches(parts[0], minute, 0, 59)) return false;
  if (!fieldMatches(parts[1], hour, 0, 23)) return false;
  if (!fieldMatches(parts[3], month, 1, 12)) return false;

  // Standard cron DOM/DOW semantics: when BOTH the day-of-month and
  // day-of-week fields are constrained (neither is "*"), a match on EITHER is
  // sufficient (OR). When only one is constrained, only that one applies.
  const domField = parts[2];
  const dowField = parts[4];
  const domUnconstrained = domField === '*';
  const dowUnconstrained = dowField === '*';
  const domOk = fieldMatches(domField, dom, 1, 31);
  const dowOk = fieldMatches(dowField, dow, 0, 7);

  if (domUnconstrained && dowUnconstrained) return true;
  if (domUnconstrained) return dowOk;
  if (dowUnconstrained) return domOk;
  return domOk || dowOk;
}

/**
 * Check if a cron field matches a value.
 * Supports: *, N, N-M, *​/N, N-M/N, comma-separated lists.
 *
 * @param {string} field
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {boolean}
 */
function fieldMatches(field, value, min, max) {
  // Handle comma-separated values
  if (field.includes(',')) {
    return field.split(',').some(part => fieldMatches(part.trim(), value, min, max));
  }

  // Handle step values
  if (field.includes('/')) {
    const [rangeStr, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    let rangeMin = min;
    let rangeMax = max;

    if (rangeStr !== '*') {
      if (rangeStr.includes('-')) {
        const [lo, hi] = rangeStr.split('-').map(Number);
        rangeMin = lo;
        rangeMax = hi;
      } else {
        rangeMin = parseInt(rangeStr, 10);
      }
    }

    if (value < rangeMin || value > rangeMax) return false;
    return (value - rangeMin) % step === 0;
  }

  // Handle ranges
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }

  // Wildcard
  if (field === '*') return true;

  // Exact match
  const num = parseInt(field, 10);
  // Day-of-week: 7 = 0 (both mean Sunday)
  if (max === 7 && num === 7 && value === 0) return true;
  return value === num;
}

/**
 * Validate a single atom (no commas) against [min, max] bounds.
 * Accepts: *, N, N-M, *​/S, N/S, N-M/S.
 * @returns {boolean}
 */
function _validateAtom(atom, min, max) {
  if (atom === '') return false;
  if (atom === '*') return true;

  let body = atom;
  if (atom.includes('/')) {
    const slashParts = atom.split('/');
    if (slashParts.length !== 2) return false;
    const step = Number(slashParts[1]);
    if (!Number.isInteger(step) || step <= 0) return false;
    body = slashParts[0];
    if (body === '*') return true;
  }

  if (body.includes('-')) {
    const rangeParts = body.split('-');
    if (rangeParts.length !== 2) return false;
    const lo = Number(rangeParts[0]);
    const hi = Number(rangeParts[1]);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
    return lo >= min && hi <= max && lo <= hi;
  }

  const n = Number(body);
  if (!Number.isInteger(n)) return false;
  return n >= min && n <= max;
}

/**
 * Validate one comma-separated cron field against [min, max] bounds.
 * @returns {boolean}
 */
function _validateField(field, min, max) {
  if (field == null || field === '') return false;
  return String(field).split(',').every((atom) => _validateAtom(atom.trim(), min, max));
}

/**
 * Validate a full 5-field cron expression.
 *
 * @param {string} expr
 * @returns {string|null} An error message if invalid, otherwise null.
 */
function validateCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    return 'Invalid cron expression: expression is empty';
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return `Invalid cron expression: expected 5 fields (minute hour dom month dow), `
      + `got ${parts.length}. Example: "0 9 * * 1-5"`;
  }
  for (let i = 0; i < 5; i++) {
    const [min, max] = CRON_FIELD_BOUNDS[i];
    if (!_validateField(parts[i], min, max)) {
      return `Invalid cron expression: bad ${CRON_FIELD_NAMES[i]} field "${parts[i]}" `
        + `(allowed range ${min}-${max})`;
    }
  }
  return null;
}

/**
 * Load durable jobs from disk.
 */
function loadDurableJobs() {
  // A missing file is the normal first-run state (no durable jobs created yet),
  // not an error: existsSync short-circuits and the in-memory set stays empty.
  try {
    _durableLoaded = true;
    if (!fs.existsSync(DURABLE_FILE)) return;
    const raw = fs.readFileSync(DURABLE_FILE, 'utf-8');
    const jobs = JSON.parse(raw);
    _durableJobs.clear();
    for (const job of jobs) {
      // Skip jobs with malformed cron expressions so one bad entry can't break
      // startup or wedge the scheduler thread later.
      if (!job || validateCron(job.cron)) continue;
      _durableJobs.set(job.id, job);
    }
  } catch {
    // Corrupted or missing file, start fresh
  }
}

/**
 * Ensure durable jobs have been loaded from disk at least once in this process.
 * Idempotent and side-effect-free beyond populating the in-memory durable set;
 * unlike startScheduler() it does NOT start the tick interval, so a read-only
 * lister can call it safely. Missing file → no-op (empty set).
 */
function ensureDurableLoaded() {
  if (_durableLoaded) return;
  loadDurableJobs();
}

/**
 * Save durable jobs to disk.
 */
function saveDurableJobs() {
  try {
    const dir = path.dirname(DURABLE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const jobs = Array.from(_durableJobs.values());
    fs.writeFileSync(DURABLE_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
  } catch {
    // Best-effort persistence
  }
}

/**
 * Create a new cron job.
 *
 * @param {object} opts
 * @param {string} opts.cron - 5-field cron expression
 * @param {string} opts.prompt - Prompt to enqueue
 * @param {boolean} [opts.recurring=true] - Recurring or one-shot
 * @param {boolean} [opts.durable=false] - Persist to disk
 * @returns {CronJob|{error: string}} The created job, or an error descriptor.
 */
function createJob({ cron, prompt, recurring = true, durable = false }) {
  const cronError = validateCron(cron);
  if (cronError) return { error: cronError };

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { error: 'Invalid job: prompt is required' };
  }

  if (listJobs().length >= MAX_JOBS) {
    return { error: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.` };
  }

  const now = Date.now();
  const job = {
    id: generateJobId(),
    cron,
    prompt,
    recurring,
    durable,
    createdAt: now,
    expiresAt: recurring ? now + MAX_RECURRING_LIFETIME_MS : undefined,
  };

  if (durable) {
    _durableJobs.set(job.id, job);
    saveDurableJobs();
  } else {
    _sessionJobs.set(job.id, job);
  }

  // Creating a job guarantees the scheduler is ticking — otherwise a job would
  // be registered but never fire (the scheduler thread is not started elsewhere).
  _ensureSchedulerRunning();

  return job;
}

/**
 * Delete a cron job by ID.
 *
 * @param {string} id
 * @returns {boolean} - True if the job was found and deleted
 */
function deleteJob(id) {
  if (_sessionJobs.has(id)) {
    _sessionJobs.delete(id);
    _lastFired.delete(id);
    return true;
  }
  if (_durableJobs.has(id)) {
    _durableJobs.delete(id);
    _lastFired.delete(id);
    saveDurableJobs();
    return true;
  }
  return false;
}

/**
 * List all jobs (session + durable).
 *
 * @returns {CronJob[]}
 */
function listJobs() {
  return [
    ...Array.from(_sessionJobs.values()),
    ...Array.from(_durableJobs.values()),
  ];
}

/**
 * Tick: check all jobs against the current time, fire matching ones.
 * Called once per minute.
 */
function tick() {
  const now = new Date();
  const marker = _minuteMarker(now);
  const allJobs = [
    ...Array.from(_sessionJobs.entries()),
    ...Array.from(_durableJobs.entries()),
  ];

  for (const [id, job] of allJobs) {
    try {
      // Check expiry
      if (job.expiresAt && Date.now() > job.expiresAt) {
        _sessionJobs.delete(id);
        _durableJobs.delete(id);
        _lastFired.delete(id);
        continue;
      }

      // Check if cron matches
      if (!cronMatches(job.cron, now)) continue;

      // Same-minute dedup: never fire a job twice within one wall-clock minute.
      if (_lastFired.get(id) === marker) continue;
      _lastFired.set(id, marker);

      // Fire the job
      job.lastFired = Date.now();

      const deliver = _enqueueCallback || _defaultEnqueue;
      try {
        deliver(job.prompt);
      } catch {
        // Don't crash the scheduler thread on a delivery failure.
      }

      // One-shot: remove after firing
      if (!job.recurring) {
        _sessionJobs.delete(id);
        _durableJobs.delete(id);
        _lastFired.delete(id);
      }
    } catch {
      // Per-job isolation: one malformed job must not kill the whole tick.
    }
  }

  // Persist changes to durable jobs
  if (_durableJobs.size > 0) {
    saveDurableJobs();
  }
}

/**
 * Default delivery when no explicit enqueue callback was registered via
 * startScheduler(). Routes the fired prompt into the agent as a follow-up turn
 * so a job still actually runs. Best-effort: never throws into the tick.
 *
 * @param {string} prompt
 */
function _defaultEnqueue(prompt) {
  try {
    const ai = require('../cli/ai');
    if (ai && typeof ai.chat === 'function') {
      Promise.resolve(ai.chat(`[Scheduled] ${prompt}`, { _isFollowUp: true }))
        .catch(() => { /* delivery is best-effort */ });
    }
  } catch {
    // cli/ai unavailable in this context (e.g. tests) — nothing to deliver to.
  }
}

/**
 * Ensure the 1-minute tick loop is running. Idempotent.
 */
function _ensureSchedulerRunning() {
  if (_tickInterval) return;
  _tickInterval = setInterval(tick, 60 * 1000);
  // Don't prevent process exit.
  if (_tickInterval.unref) _tickInterval.unref();
}

/**
 * Start the cron scheduler with an explicit delivery callback.
 *
 * @param {function(string): void} enqueueCallback - Called with prompt when a job fires
 */
function startScheduler(enqueueCallback) {
  _enqueueCallback = enqueueCallback || null;
  loadDurableJobs();
  _ensureSchedulerRunning();
}

/**
 * Stop the cron scheduler.
 */
function stopScheduler() {
  if (_tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
  _enqueueCallback = null;
}

/**
 * Reset all in-memory state. Test-only hook.
 */
function _resetForTest() {
  stopScheduler();
  _sessionJobs.clear();
  _durableJobs.clear();
  _lastFired.clear();
  _durableLoaded = false;
}

module.exports = {
  createJob,
  deleteJob,
  listJobs,
  loadDurableJobs,
  ensureDurableLoaded,
  startScheduler,
  stopScheduler,
  cronMatches,
  fieldMatches,
  validateCron,
  tick,
  MAX_JOBS,
  DURABLE_FILE,
  _resetForTest,
};
