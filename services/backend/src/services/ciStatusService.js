'use strict';

/**
 * CI/CD Status Service — poll CI pipeline status from GitHub Actions / GitLab CI.
 *
 * Provides polling for:
 *   - GitHub Actions workflow runs (via gh CLI)
 *   - GitLab CI pipelines (via glab CLI)
 *
 * @module ciStatusService
 */

const { execSync, spawnSync } = require('child_process');
const log = require('../utils/logger');

// ── Constants ──────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15000; // 15 seconds between polls
const MAX_POLL_ATTEMPTS = 40;   // 10 minutes max
const TERMINAL_STATES = new Set([
  // GitHub
  'completed', 'cancelled', 'timed_out', 'action_required', 'stale',
  // GitLab
  'success', 'failed', 'canceled', 'skipped', 'manual',
]);

// ── Classifiers ────────────────────────────────────────────────────

/**
 * Classify a CI conclusion/status into pass/fail/pending.
 * @param {string} status
 * @param {string} [conclusion]
 * @returns {'pass' | 'fail' | 'pending' | 'unknown'}
 */
function classifyCi(status, conclusion) {
  // GitHub: status = 'completed', conclusion = 'success'|'failure'
  if (status === 'completed' || status === 'success') {
    if (conclusion === 'success' || !conclusion) return 'pass';
    if (conclusion === 'failure' || conclusion === 'timed_out') return 'fail';
    return 'unknown';
  }
  if (status === 'failed' || status === 'cancelled' || status === 'canceled') return 'fail';
  if (status === 'in_progress' || status === 'queued' || status === 'waiting' ||
      status === 'pending' || status === 'running' || status === 'created') {
    return 'pending';
  }
  if (status === 'skipped') return 'pass';
  return 'unknown';
}

// ── GitHub Actions ─────────────────────────────────────────────────

/**
 * Get the latest workflow run status for a branch.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.branch]
 * @returns {{ status: string, conclusion: string, url: string, name: string, event: string, startedAt: string } | null}
 */
function getGitHubRunStatus(options = {}) {
  const cwd = options.cwd || process.cwd();
  const branchArg = options.branch ? `--branch ${options.branch}` : '';

  try {
    const output = execSync(
      `gh run list ${branchArg} --limit 1 --json status,conclusion,url,name,event,startedAt`,
      { cwd, encoding: 'utf-8', timeout: 15000, stdio: 'pipe' }
    );
    const runs = JSON.parse(output);
    if (runs.length === 0) return null;
    return runs[0];
  } catch (err) {
    log.debug('GitHub run status check failed:', err.message);
    return null;
  }
}

/**
 * Get detailed check status for a specific run.
 * @param {string} runId
 * @param {string} [cwd]
 * @returns {Array<{ name: string, status: string, conclusion: string }>}
 */
function getGitHubRunJobs(runId, cwd) {
  try {
    const output = execSync(
      `gh run view ${runId} --json jobs`,
      { cwd: cwd || process.cwd(), encoding: 'utf-8', timeout: 15000, stdio: 'pipe' }
    );
    const data = JSON.parse(output);
    return (data.jobs || []).map(j => ({
      name: j.name,
      status: j.status,
      conclusion: j.conclusion || '',
    }));
  } catch {
    return [];
  }
}

// ── GitLab CI ──────────────────────────────────────────────────────

/**
 * Get the latest pipeline status for a branch.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.branch]
 * @returns {{ status: string, url: string, id: string, source: string, createdAt: string } | null}
 */
function getGitLabPipelineStatus(options = {}) {
  const cwd = options.cwd || process.cwd();
  const branchArg = options.branch ? `--branch ${options.branch}` : '';

  try {
    const result = spawnSync('glab', ['ci', 'list', branchArg, '--per-page', '1', '-F', 'json'].filter(Boolean), {
      cwd, encoding: 'utf-8', timeout: 15000, stdio: 'pipe',
    });
    if (result.status !== 0) return null;
    const pipelines = JSON.parse(result.stdout);
    if (!Array.isArray(pipelines) || pipelines.length === 0) return null;
    const p = pipelines[0];
    return { status: p.status, url: p.web_url || '', id: String(p.id), source: p.source, createdAt: p.created_at };
  } catch {
    return null;
  }
}

// ── Unified API ────────────────────────────────────────────────────

/**
 * Check CI status for the current branch (auto-detects platform).
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.branch]
 * @returns {{ platform: string, classification: string, status: string, conclusion?: string, url: string, name?: string } | { error: string }}
 */
function checkCIStatus(options = {}) {
  // Try GitHub first
  const ghRun = getGitHubRunStatus(options);
  if (ghRun) {
    return {
      platform: 'github',
      classification: classifyCi(ghRun.status, ghRun.conclusion),
      status: ghRun.status,
      conclusion: ghRun.conclusion || '',
      url: ghRun.url || '',
      name: ghRun.name || '',
    };
  }

  // Try GitLab
  const glPipeline = getGitLabPipelineStatus(options);
  if (glPipeline) {
    return {
      platform: 'gitlab',
      classification: classifyCi(glPipeline.status),
      status: glPipeline.status,
      url: glPipeline.url || '',
    };
  }

  return { error: 'No CI platform detected. Ensure gh or glab CLI is installed and authenticated.' };
}

/**
 * Poll CI status until terminal state or timeout.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.branch]
 * @param {number} [options.intervalMs] - Poll interval
 * @param {number} [options.maxAttempts] - Max polls
 * @param {Function} [options.onPoll] - Callback on each poll (status) => void
 * @returns {Promise<{ classification: string, status: string, polls: number, url: string }>}
 */
async function pollCIStatus(options = {}) {
  const intervalMs = options.intervalMs || POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts || MAX_POLL_ATTEMPTS;
  let polls = 0;

  while (polls < maxAttempts) {
    polls++;
    const result = checkCIStatus(options);

    if (result.error) {
      return { classification: 'unknown', status: 'error', polls, url: '', error: result.error };
    }

    if (options.onPoll) {
      try { options.onPoll(result); } catch { /* ignore */ }
    }

    if (result.classification !== 'pending') {
      return { classification: result.classification, status: result.status, polls, url: result.url };
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return { classification: 'pending', status: 'timeout', polls, url: '' };
}

module.exports = {
  checkCIStatus,
  pollCIStatus,
  classifyCi,
  getGitHubRunStatus,
  getGitHubRunJobs,
  getGitLabPipelineStatus,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
};
