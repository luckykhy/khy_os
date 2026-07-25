'use strict';

/**
 * Commit Message Service — AI-powered commit message generation.
 *
 * Analyzes staged diff and generates a descriptive commit message.
 * Supports conventional commits format and configurable style.
 *
 * @module commitMessageService
 */

const { execSync } = require('child_process');
const log = require('../utils/logger');

// ── Constants ──────────────────────────────────────────────────────

const MAX_DIFF_CHARS = 8000;
const MAX_STAT_CHARS = 2000;

const COMMIT_STYLES = {
  conventional: {
    prompt: `Generate a conventional commit message based on the diff below.
Format: <type>(<scope>): <description>

Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build
Scope: the primary module or area affected (short, lowercase)
Description: imperative, lowercase, no period at end, under 72 chars

If the change is large, add a body paragraph (separated by blank line) summarizing the key changes.

Rules:
- Analyze the ACTUAL changes, not just file names
- Be specific about what changed and why
- Use English for the commit message
- Do NOT include the diff in your response
- Output ONLY the commit message, nothing else`,
  },
  descriptive: {
    prompt: `Generate a clear, descriptive commit message based on the diff below.
First line: concise summary under 72 chars, imperative mood.
Optional body: blank line then detailed explanation of what and why.

Rules:
- Analyze the ACTUAL changes, not just file names
- Be specific and informative
- Use English
- Output ONLY the commit message, nothing else`,
  },
};

// ── Diff Collection ────────────────────────────────────────────────

/**
 * Collect the staged diff and diff stat for commit message generation.
 *
 * @param {string} [cwd]
 * @returns {{ diff: string, stat: string, files: string[], error?: string }}
 */
function collectStagedChanges(cwd) {
  cwd = cwd || process.env.KHYQUANT_CWD || process.cwd();
  const opts = { cwd, encoding: 'utf-8', timeout: 15000 };

  try {
    let diff = '';
    let stat = '';
    let files = [];

    try {
      diff = execSync('git diff --cached', opts);
    } catch { /* no staged changes */ }

    // If no staged diff, try unstaged
    if (!diff.trim()) {
      try {
        diff = execSync('git diff', opts);
      } catch { /* ignore */ }
    }

    try {
      stat = execSync('git diff --cached --stat', opts);
    } catch {
      try { stat = execSync('git diff --stat', opts); } catch { /* ignore */ }
    }

    try {
      const nameOnly = execSync('git diff --cached --name-only', opts);
      files = nameOnly.trim().split('\n').filter(Boolean);
    } catch {
      try {
        const nameOnly = execSync('git diff --name-only', opts);
        files = nameOnly.trim().split('\n').filter(Boolean);
      } catch { /* ignore */ }
    }

    // Truncate diff
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + '\n... (diff truncated)';
    }
    if (stat.length > MAX_STAT_CHARS) {
      stat = stat.slice(0, MAX_STAT_CHARS) + '\n...';
    }

    return { diff, stat, files };
  } catch (err) {
    return { diff: '', stat: '', files: [], error: err.message };
  }
}

/**
 * Build the prompt for AI commit message generation.
 *
 * @param {object} changes - From collectStagedChanges()
 * @param {object} [options]
 * @param {string} [options.style='conventional'] - Commit style
 * @param {string} [options.extraContext] - Additional context from user
 * @returns {string} The AI prompt
 */
function buildPrompt(changes, options = {}) {
  const style = COMMIT_STYLES[options.style || 'conventional'] || COMMIT_STYLES.conventional;

  let prompt = style.prompt;

  if (options.extraContext) {
    prompt += `\n\nAdditional context from the developer:\n${options.extraContext}`;
  }

  prompt += '\n\n--- Diff stat ---\n';
  prompt += changes.stat || '(no stat available)';
  prompt += '\n\n--- Diff ---\n';
  prompt += changes.diff || '(no diff available)';

  return prompt;
}

/**
 * Generate a commit message using AI.
 *
 * @param {object} deps - { callModel }
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.style='conventional']
 * @param {string} [options.extraContext]
 * @returns {Promise<{ message: string, files: string[], error?: string }>}
 */
async function generateCommitMessage(deps, options = {}) {
  const changes = collectStagedChanges(options.cwd);
  if (changes.error) {
    return { message: '', files: [], error: changes.error };
  }
  if (!changes.diff.trim() && changes.files.length === 0) {
    return { message: '', files: [], error: 'No changes detected' };
  }

  const prompt = buildPrompt(changes, options);

  try {
    const result = await deps.callModel(prompt, {
      effort: 'low',
      _isFollowUp: true,
    });

    let message = result?.reply || result?.content || '';
    // Clean up: remove surrounding quotes or code fences
    message = message.replace(/^```[\s\S]*?\n/, '').replace(/\n```\s*$/, '').trim();
    message = message.replace(/^["']|["']$/g, '').trim();

    if (!message) {
      return { message: '', files: changes.files, error: 'AI returned empty message' };
    }

    return { message, files: changes.files };
  } catch (err) {
    log.debug('Commit message generation failed:', err.message);
    return { message: '', files: changes.files, error: err.message };
  }
}

/**
 * Generate a commit message and create the commit.
 *
 * @param {object} deps - { callModel }
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.style='conventional']
 * @param {string} [options.extraContext]
 * @param {string[]} [options.files] - Files to stage before commit
 * @param {boolean} [options.dryRun=false] - Only generate message, don't commit
 * @returns {Promise<{ message: string, committed: boolean, output?: string, error?: string }>}
 */
async function autoCommit(deps, options = {}) {
  const cwd = options.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const opts = { cwd, encoding: 'utf-8', timeout: 15000 };

  // Stage files if specified
  if (options.files && options.files.length > 0) {
    try {
      const fileList = options.files.map(f => `"${f}"`).join(' ');
      execSync(`git add ${fileList}`, opts);
    } catch (err) {
      return { message: '', committed: false, error: `Failed to stage files: ${err.message}` };
    }
  }

  // Generate message
  const result = await generateCommitMessage(deps, { ...options, cwd });
  if (result.error || !result.message) {
    return { message: result.message || '', committed: false, error: result.error };
  }

  if (options.dryRun) {
    return { message: result.message, committed: false };
  }

  // Create commit
  try {
    // Use heredoc-style via stdin to avoid shell escaping issues
    const escaped = result.message.replace(/"/g, '\\"');
    const output = execSync(`git commit -m "${escaped}"`, opts);
    return { message: result.message, committed: true, output: output || '' };
  } catch (err) {
    return { message: result.message, committed: false, error: `Commit failed: ${err.message}` };
  }
}

module.exports = {
  collectStagedChanges,
  buildPrompt,
  generateCommitMessage,
  autoCommit,
  COMMIT_STYLES,
};
