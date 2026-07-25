'use strict';

/**
 * Cron Scheduler — persistent cron job scheduling with cross-channel delivery.
 *
 * Inspired by Hermes Agent's cron system:
 *   - 5-field cron expression parsing (min hour dom month dow)
 *   - 3-minute hard interrupt per job execution
 *   - noAgent mode: shell-only, deliver stdout only if non-empty
 *   - contextFrom: chain jobs — previous job's lastResult injected into next prompt
 *   - Cross-channel delivery via MessageRouter
 *
 * Data file: <dataHome>/growth/cron_jobs.json（默认 ~/.khy；env KHY_CRON_JOBS_FILE 可覆盖）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

const DEFAULT_GROWTH_DIR = path.join(getDataHome(), 'growth');
const GROWTH_DIR = process.env.KHY_CRON_GROWTH_DIR || DEFAULT_GROWTH_DIR;
const JOBS_FILE = process.env.KHY_CRON_JOBS_FILE || path.join(GROWTH_DIR, 'cron_jobs.json');
const LEGACY_JOBS_FILE = path.join(getLegacyDataHome(), 'growth', 'cron_jobs.json');
const TICK_INTERVAL_MS = 60_000; // Check every 60 seconds
const DEFAULT_MAX_RUNTIME_MS = 300_000; // 5-minute default (activity-aware for shell, wall-clock for AI)

let _tickTimer = null;
let _running = false;

// ── Data Persistence ───────────────────────────────────────────────────

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const _ensureDir = require('../utils/ensureDirSync');

// 一次性 legacy 迁移：读旧写新，绝不删旧。仅在未设显式 env 覆盖时生效。
function _migrateLegacy() {
  try {
    if (process.env.KHY_CRON_JOBS_FILE || process.env.KHY_CRON_GROWTH_DIR) return;
    if (JOBS_FILE !== LEGACY_JOBS_FILE
      && !fs.existsSync(JOBS_FILE)
      && fs.existsSync(LEGACY_JOBS_FILE)) {
      _ensureDir(GROWTH_DIR);
      fs.writeFileSync(JOBS_FILE, fs.readFileSync(LEGACY_JOBS_FILE, 'utf8'), 'utf8');
    }
  } catch { /* migration is best-effort */ }
}

function _loadJobs() {
  _migrateLegacy();
  try {
    if (fs.existsSync(JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    }
  } catch { /* corrupt file */ }
  return { version: 1, jobs: {} };
}

function _saveJobs(data) {
  _ensureDir(GROWTH_DIR);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Cron Expression Parser ─────────────────────────────────────────────

/**
 * Parse a single cron field into a Set of matching values.
 * Supports: *, N, N-M, N/step, *\/step, N-M/step, comma-separated.
 *
 * @param {string} field - Cron field string
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {Set<number>}
 */
function _parseCronField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      let start = min, end = max;

      if (base !== '*') {
        const rangeMatch = base.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          start = parseInt(rangeMatch[1], 10);
          end = parseInt(rangeMatch[2], 10);
        } else {
          start = parseInt(base, 10);
        }
      }

      // Guard against a zero/negative step (e.g. `*/0`) that would spin forever.
      let _stepOk = true;
      try {
        const _g = require('./cronStepGuard').cronStepUsable(step, process.env);
        if (_g !== null) _stepOk = _g;
      } catch { /* fail-soft → legacy loop below */ }
      if (!_stepOk) continue;

      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    const num = parseInt(trimmed, 10);
    if (!isNaN(num)) values.add(num);
  }

  return values;
}

/**
 * Check if a Date matches a 5-field cron expression.
 *
 * @param {string} cronExpr - "min hour dom month dow"
 * @param {Date} date
 * @returns {boolean}
 */
function matchesCron(cronExpr, date) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minF, hourF, domF, monF, dowF] = fields;

  const minute = _parseCronField(minF, 0, 59);
  const hour = _parseCronField(hourF, 0, 23);
  const dom = _parseCronField(domF, 1, 31);
  const month = _parseCronField(monF, 1, 12);
  const dow = _parseCronField(dowF, 0, 7); // 0 and 7 both = Sunday

  const d = date;
  const dayOfWeek = d.getDay(); // 0=Sunday

  // Minute / hour / month always AND together.
  if (!minute.has(d.getMinutes())) return false;
  if (!hour.has(d.getHours())) return false;
  if (!month.has(d.getMonth() + 1)) return false;

  // Day-of-month vs day-of-week follow the Vixie-cron rule: when BOTH fields
  // are restricted (neither is `*`), a match on EITHER fires the job (OR);
  // when at least one is `*`, they AND together as usual. This is the standard
  // crontab semantics ("* * 13 * 5" = the 13th OR any Friday, not their
  // intersection) — without it a constrained DOM+DOW pair under-fires.
  const domRestricted = domF.trim() !== '*';
  const dowRestricted = dowF.trim() !== '*';
  const domMatch = dom.has(d.getDate());
  const dowMatch = dow.has(dayOfWeek) || (dayOfWeek === 0 && dow.has(7));

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Add a new cron job.
 *
 * @param {{ cron: string, prompt: string, channel?: string, noAgent?: boolean, contextFrom?: string, maxRuntimeMs?: number }} spec
 * @returns {{ id: string, job: object }}
 */
function addJob(spec) {
  if (!spec || !spec.cron || !spec.prompt) {
    throw new Error('cron and prompt are required');
  }

  // Validate cron expression
  const fields = spec.cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);

  const data = _loadJobs();
  const id = 'cj-' + crypto.randomBytes(3).toString('hex');
  const job = {
    cron: spec.cron.trim(),
    prompt: spec.prompt,
    channel: spec.channel || null,
    enabled: true,
    noAgent: spec.noAgent || false,
    contextFrom: spec.contextFrom || null,
    maxRuntimeMs: spec.maxRuntimeMs || DEFAULT_MAX_RUNTIME_MS,
    lastRunAt: null,
    lastResult: null,
    createdAt: new Date().toISOString(),
  };

  data.jobs[id] = job;
  _saveJobs(data);
  return { id, job };
}

/**
 * Remove a cron job.
 * @param {string} id
 * @returns {boolean}
 */
function removeJob(id) {
  const data = _loadJobs();
  if (!data.jobs[id]) return false;
  delete data.jobs[id];
  _saveJobs(data);
  return true;
}

/**
 * Enable a cron job.
 * @param {string} id
 * @returns {boolean}
 */
function enableJob(id) {
  const data = _loadJobs();
  if (!data.jobs[id]) return false;
  data.jobs[id].enabled = true;
  _saveJobs(data);
  return true;
}

/**
 * Disable a cron job.
 * @param {string} id
 * @returns {boolean}
 */
function disableJob(id) {
  const data = _loadJobs();
  if (!data.jobs[id]) return false;
  data.jobs[id].enabled = false;
  _saveJobs(data);
  return true;
}

/**
 * List all cron jobs.
 * @returns {Array<{ id: string, cron: string, prompt: string, enabled: boolean, lastRunAt: string|null }>}
 */
function listJobs() {
  const data = _loadJobs();
  return Object.entries(data.jobs).map(([id, job]) => ({
    id,
    cron: job.cron,
    prompt: job.prompt,
    channel: job.channel,
    enabled: job.enabled,
    noAgent: job.noAgent,
    lastRunAt: job.lastRunAt,
    createdAt: job.createdAt,
  }));
}

/**
 * Get a single job by ID.
 * @param {string} id
 * @returns {object|null}
 */
function getJob(id) {
  const data = _loadJobs();
  return data.jobs[id] || null;
}

// ── Scheduler ──────────────────────────────────────────────────────────

/**
 * Start the scheduler tick loop.
 */
function start() {
  if (_running) return;
  _running = true;
  _tickTimer = setInterval(() => _tick(), TICK_INTERVAL_MS);
  _tickTimer.unref?.();
}

/**
 * Stop the scheduler.
 */
function stop() {
  _running = false;
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
}

/**
 * Check the current minute for matching jobs and execute them.
 * Exported for testing.
 *
 * @param {Date} [now] - Override current time (for testing)
 * @returns {Promise<string[]>} IDs of jobs that were triggered
 */
async function _tick(now) {
  const date = now || new Date();
  const data = _loadJobs();
  const triggered = [];

  for (const [id, job] of Object.entries(data.jobs)) {
    if (!job.enabled) continue;
    if (!matchesCron(job.cron, date)) continue;

    // Prevent double-run within same minute
    if (job.lastRunAt) {
      const lastRun = new Date(job.lastRunAt);
      if (lastRun.getFullYear() === date.getFullYear()
        && lastRun.getMonth() === date.getMonth()
        && lastRun.getDate() === date.getDate()
        && lastRun.getHours() === date.getHours()
        && lastRun.getMinutes() === date.getMinutes()) {
        continue;
      }
    }

    triggered.push(id);

    // Mark lastRunAt BEFORE executing so that the next tick reads it from disk
    data.jobs[id].lastRunAt = date.toISOString();
    _saveJobs(data);

    // Execute asynchronously with timeout
    _executeJob(id, job, data).catch(err => {
      // Log but don't crash the scheduler
      try {
        process.stderr.write(`[CronScheduler] Job ${id} failed: ${err.message}\n`);
      } catch { /* ignore */ }
    });
  }

  return triggered;
}

/**
 * Execute a single cron job with hard timeout.
 */
async function _executeJob(id, job, data) {
  const startTime = Date.now();

  // Build prompt (inject contextFrom if set)
  let prompt = job.prompt;
  if (job.contextFrom) {
    const sourceJob = data.jobs[job.contextFrom];
    if (sourceJob && sourceJob.lastResult) {
      prompt = `Context from previous job:\n${sourceJob.lastResult}\n\n---\n\n${prompt}`;
    }
  }

  let result = '';

  if (job.noAgent) {
    // Shell-only mode: activity-aware idle timeout via spawn.
    // The process stays alive as long as it produces output; only killed
    // after `idleMs` of silence (or absolute wall-clock limit).
    const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
    const idleMs = job.maxRuntimeMs || DEFAULT_MAX_RUNTIME_MS;
    try {
      result = await new Promise((resolve, reject) => {
        let stdout = '';
        let idleTimer = null;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            safeKill(proc);
            resolve(stdout.trim());
          }, idleMs);
          idleTimer.unref?.();
        };
        const shellCmd = process.platform === 'win32' ? 'cmd' : 'sh';
        const shellArgs = process.platform === 'win32' ? ['/c', prompt] : ['-c', prompt];
        const proc = spawn(shellCmd, shellArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: idleMs * 3, // absolute wall-clock safety net
        });
        proc.stdout.on('data', (chunk) => { stdout += chunk; resetIdle(); });
        proc.stderr.on('data', (chunk) => { stdout += chunk; resetIdle(); });
        proc.on('close', () => { if (idleTimer) clearTimeout(idleTimer); resolve(stdout.trim()); });
        proc.on('error', (err) => { if (idleTimer) clearTimeout(idleTimer); reject(err); });
        resetIdle(); // start initial idle timer
      });
    } catch (err) {
      result = err.stdout ? String(err.stdout).trim() : `Error: ${err.message}`;
    }
  } else {
    // Agent mode: use AI pipeline.
    // In tests we skip real gateway execution by default to avoid long-lived
    // async side effects that outlive the Jest environment.
    const disableAgentInTest = process.env.NODE_ENV === 'test'
      && String(process.env.KHY_CRON_ENABLE_AGENT_IN_TEST || '').toLowerCase() !== 'true';
    if (disableAgentInTest) {
      result = '[test-mode] agent execution skipped';
    } else {
      let hardTimer = null;
      try {
        const gateway = require('./gateway/aiGateway');
        const aiResult = await Promise.race([
          gateway.generate(prompt),
          new Promise((_, rej) => {
            hardTimer = setTimeout(() => rej(new Error('Cron job hard timeout')), job.maxRuntimeMs || DEFAULT_MAX_RUNTIME_MS);
            hardTimer.unref?.();
          }),
        ]);
        result = typeof aiResult === 'string' ? aiResult : (aiResult.text || aiResult.reply || JSON.stringify(aiResult));
      } catch (err) {
        result = `Error: ${err.message}`;
      } finally {
        if (hardTimer) clearTimeout(hardTimer);
      }
    }
  }

  // Save result
  const freshData = _loadJobs();
  if (freshData.jobs[id]) {
    freshData.jobs[id].lastResult = result.slice(0, 10000); // cap at 10KB
    _saveJobs(freshData);
  }

  // Deliver to channel if configured and result is non-empty
  if (job.channel && result) {
    try {
      const { getMessageRouter } = require('./channels/messageRouter');
      const router = getMessageRouter();
      await router.sendToChannel(job.channel, `[Cron: ${id}] ${result.slice(0, 4000)}`);
    } catch { /* channel delivery is best-effort */ }
  }
}

/** @internal Reset for testing */
function _resetForTest() {
  stop();
  try {
    if (fs.existsSync(JOBS_FILE)) fs.unlinkSync(JOBS_FILE);
  } catch (err) {
    const code = String(err && err.code || '');
    // Some CI/sandbox environments mount home as read-only.
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') return;
    throw err;
  }
}

module.exports = {
  addJob,
  removeJob,
  enableJob,
  disableJob,
  listJobs,
  getJob,
  start,
  stop,
  matchesCron,
  _tick,
  _resetForTest,
  JOBS_FILE,
  DEFAULT_MAX_RUNTIME_MS,
};
