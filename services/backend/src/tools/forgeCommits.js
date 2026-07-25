const { defineTool } = require('./_baseTool');
const forgeCore = require('../services/forge/forgeCore');
const forgeClient = require('../services/forge/forgeClient');

/**
 * forgeCommits — read a repository's recent commit history AND assess its
 * commit-message quality, the way a senior engineer sizes up how well a project
 * is maintained before reusing or contributing to it.
 *
 * Read-only. Given "owner/repo" (or a full git URL) it fetches the latest
 * commits from the forge's REST API and runs a deterministic quality score:
 *   - Conventional Commits compliance (feat/fix/docs…: subject)
 *   - vague / low-signal subjects (wip, update, fix-alone)
 *   - over-long subjects
 * Returns the commit list plus a { score, grade, notes } verdict so the model
 * can judge project health, not just list commits.
 *
 * Auth tokens (GITHUB_TOKEN / GITEE_TOKEN / GITLAB_TOKEN) are read from the
 * environment only to raise rate limits and reach private repos; never echoed.
 */
module.exports = defineTool({
  name: 'forgeCommits',
  description: 'Read a GitHub/Gitee/GitLab repo\'s recent commits and score commit-message quality (Conventional Commits compliance, vague/over-long subjects). Returns the commit list plus a {score, grade, notes} verdict to judge how well a project is maintained before reusing or contributing.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: () => forgeCore.isEnabled(),
  inputSchema: {
    repo: { type: 'string', required: true, description: 'Repository to inspect: "owner/repo" or a full http(s)/ssh git URL.' },
    platform: { type: 'string', required: false, enum: ['github', 'gitee', 'gitlab'], description: 'Forge host for "owner/repo" form (default inferred or github).' },
    limit: { type: 'number', required: false, min: 1, max: 100, description: 'How many recent commits to fetch (default 20, max 100).' },
    ref: { type: 'string', required: false, description: 'Branch/tag/commit to read history from (default: the repo default branch).' },
    path: { type: 'string', required: false, description: 'Only commits touching this file/directory path.' },
  },
  async execute(params, _context) {
    const res = await forgeClient.getCommits({
      input: params.repo,
      platform: params.platform,
      limit: params.limit,
      ref: params.ref,
      path: params.path,
    });
    if (!res.ok) return { success: false, error: res.error };
    return {
      success: true,
      platform: res.platform,
      count: res.commits.length,
      commits: res.commits,
      quality: res.quality,
    };
  },
});
