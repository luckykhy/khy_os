'use strict';

/**
 * PR / MR Creation Tool — create pull requests from the CLI.
 *
 * Wraps `gh pr create` (GitHub) and `glab mr create` (GitLab) with
 * AI-powered description generation.
 *
 * @module prCreateService
 */

const { execSync, spawnSync } = require('child_process');
const log = require('../utils/logger');

// ── Constants ──────────────────────────────────────────────────────

const MAX_DIFF_CHARS = 6000;

// ── Platform Detection ─────────────────────────────────────────────

/**
 * Detect which Git hosting platform CLI is available.
 * @returns {'github' | 'gitlab' | null}
 */
function detectPlatform() {
  try {
    execSync('gh --version', { stdio: 'ignore', timeout: 5000 });
    return 'github';
  } catch { /* not github */ }

  try {
    execSync('glab --version', { stdio: 'ignore', timeout: 5000 });
    return 'gitlab';
  } catch { /* not gitlab */ }

  return null;
}

/**
 * Get current branch name.
 * @param {string} cwd
 * @returns {string | null}
 */
function getCurrentBranch(cwd) {
  try {
    return execSync('git branch --show-current', { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Get the default base branch.
 * @param {string} cwd
 * @returns {string}
 */
function getBaseBranch(cwd) {
  try {
    const remote = execSync('git remote show origin', { cwd, encoding: 'utf-8', timeout: 10000 });
    const match = remote.match(/HEAD branch:\s*(\S+)/);
    if (match) return match[1];
  } catch { /* ignore */ }

  // Fallback: check if main or master exists
  try {
    execSync('git rev-parse --verify main', { cwd, stdio: 'ignore', timeout: 3000 });
    return 'main';
  } catch { /* not main */ }
  return 'master';
}

/**
 * Collect diff and log summary between current branch and base.
 * @param {string} cwd
 * @param {string} baseBranch
 * @returns {{ log: string, diffStat: string, diff: string }}
 */
function collectPRContext(cwd, baseBranch) {
  const opts = { cwd, encoding: 'utf-8', timeout: 15000 };
  let commitLog = '';
  let diffStat = '';
  let diff = '';

  try {
    commitLog = execSync(`git log ${baseBranch}..HEAD --oneline`, opts);
  } catch { /* ignore */ }

  try {
    diffStat = execSync(`git diff ${baseBranch}...HEAD --stat`, opts);
  } catch { /* ignore */ }

  try {
    diff = execSync(`git diff ${baseBranch}...HEAD`, opts);
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)';
    }
  } catch { /* ignore */ }

  return { log: commitLog, diffStat, diff };
}

/**
 * Build AI prompt for PR description generation.
 * @param {object} context - From collectPRContext()
 * @param {object} [options]
 * @param {string} [options.userContext] - Additional context
 * @returns {string}
 */
function buildDescriptionPrompt(context, options = {}) {
  let prompt = `Generate a pull request title and description based on the changes below.

Format your response EXACTLY as:
TITLE: <concise title under 72 chars>
---
BODY:
## Summary
<1-3 bullet points describing the changes>

## Changes
<bullet list of specific changes>

## Test Plan
<how to verify the changes>

Rules:
- Be specific about what changed and why
- Use English
- Keep the title under 72 chars
- Focus on the "why" not the "what"

--- Commit log ---
${context.log || '(no commits)'}

--- Diff stat ---
${context.diffStat || '(no stat)'}

--- Diff ---
${context.diff || '(no diff)'}`;

  if (options.userContext) {
    prompt += `\n\nDeveloper notes: ${options.userContext}`;
  }

  return prompt;
}

/**
 * Parse AI response into title and body.
 * @param {string} response
 * @returns {{ title: string, body: string }}
 */
function _parseDescriptionResponse(response) {
  const titleMatch = response.match(/TITLE:\s*(.+)/);
  const bodyMatch = response.match(/BODY:\s*([\s\S]+)/);

  let title = titleMatch ? titleMatch[1].trim() : '';
  let body = bodyMatch ? bodyMatch[1].trim() : response.trim();

  // Cleanup
  title = title.replace(/^["']|["']$/g, '');
  body = body.replace(/^```[\s\S]*?\n/, '').replace(/\n```\s*$/, '');

  if (!title && body) {
    // Extract first line as title
    const lines = body.split('\n');
    title = lines[0].replace(/^#+\s*/, '').trim();
    body = lines.slice(1).join('\n').trim();
  }

  return { title, body };
}

/**
 * Create a pull request / merge request.
 *
 * @param {object} deps - { callModel }
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.title] - Override title (skip AI generation)
 * @param {string} [options.body] - Override body
 * @param {string} [options.base] - Base branch
 * @param {boolean} [options.draft=false] - Create as draft
 * @param {string} [options.userContext] - Context hint for AI
 * @returns {Promise<{ success: boolean, url?: string, title?: string, error?: string }>}
 */
async function createPR(deps, options = {}) {
  const cwd = options.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const platform = detectPlatform();
  if (!platform) {
    return { success: false, error: 'No GitHub CLI (gh) or GitLab CLI (glab) found. Install gh: https://cli.github.com/' };
  }

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    return { success: false, error: 'Cannot determine current branch' };
  }

  const base = options.base || getBaseBranch(cwd);
  if (branch === base) {
    return { success: false, error: `Current branch "${branch}" is the same as base "${base}". Create a feature branch first.` };
  }

  // Push branch if not yet pushed
  try {
    execSync(`git push -u origin ${branch}`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
  } catch { /* might already be pushed */ }

  // Generate title/body if not provided
  let title = options.title || '';
  let body = options.body || '';

  if (!title) {
    const context = collectPRContext(cwd, base);
    const prompt = buildDescriptionPrompt(context, { userContext: options.userContext });

    try {
      const result = await deps.callModel(prompt, { effort: 'low', _isFollowUp: true });
      const response = result?.reply || result?.content || '';
      const parsed = _parseDescriptionResponse(response);
      title = parsed.title || `Update ${branch}`;
      body = body || parsed.body;
    } catch (err) {
      log.debug('PR description generation failed:', err.message);
      title = `Update ${branch}`;
    }
  }

  // Create PR
  const execOpts = { cwd, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' };

  try {
    let cmd;
    if (platform === 'github') {
      const args = ['pr', 'create', '--title', title, '--body', body || '', '--base', base];
      if (options.draft) args.push('--draft');
      const result = spawnSync('gh', args, execOpts);
      if (result.status !== 0) {
        return { success: false, error: (result.stderr || result.stdout || '').trim() };
      }
      const url = (result.stdout || '').trim();
      return { success: true, url, title };
    } else {
      // GitLab
      const args = ['mr', 'create', '--title', title, '--description', body || '', '--source-branch', branch, '--target-branch', base];
      if (options.draft) args.push('--draft');
      const result = spawnSync('glab', args, execOpts);
      if (result.status !== 0) {
        return { success: false, error: (result.stderr || result.stdout || '').trim() };
      }
      const url = (result.stdout || '').match(/(https?:\/\/\S+)/)?.[1] || '';
      return { success: true, url, title };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  createPR,
  detectPlatform,
  getCurrentBranch,
  getBaseBranch,
  collectPRContext,
  buildDescriptionPrompt,
};
