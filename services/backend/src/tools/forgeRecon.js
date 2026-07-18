const { defineTool } = require('./_baseTool');
const forgeCore = require('../services/forge/forgeCore');
const forgeClient = require('../services/forge/forgeClient');

/**
 * forgeRecon — reconnoiter a remote repository broad-to-narrow, the way a senior
 * engineer sizes up an unfamiliar project before reusing or deploying it.
 *
 * Read-only. Given "owner/repo" (or a full git URL) it fans out over a forge's
 * REST API in widening passes:
 *   1. metadata   — stars, default branch, license, topics, language, open issues
 *   2. top-level  — the root file/dir listing (README.md, CLAUDE.md, packages/, …)
 *   3. key files  — fetches ONLY the agent-guide / manifest files that actually
 *                   exist (README, CLAUDE.md/AGENTS.md, package.json, pyproject…)
 *   4. hints      — deterministic insights: is it a monorepo? does it ship an
 *                   agent guide? which package manager? build / deploy commands?
 *
 * Use this to decide whether a project is a good REFERENCE for something you are
 * about to build, or to learn how to DEPLOY it, before cloning with gitClone.
 *
 * Auth tokens (GITHUB_TOKEN / GITEE_TOKEN / GITLAB_TOKEN) are read from the
 * environment only to raise rate limits and reach private repos; they are never
 * echoed back in the result.
 */
module.exports = defineTool({
  name: 'forgeRecon',
  description: 'Reconnoiter a GitHub/Gitee/GitLab repo broad-to-narrow: metadata (stars/license/topics), top-level structure, key files (README, CLAUDE.md, package.json…), and deterministic hints (monorepo? agent guide? build & deploy commands). Use to evaluate a project as a reference or to learn how to deploy it before cloning.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: () => forgeCore.isEnabled(),
  inputSchema: {
    repo: { type: 'string', required: true, description: 'Repository to inspect: "owner/repo" or a full http(s)/ssh git URL.' },
    platform: { type: 'string', required: false, enum: ['github', 'gitee', 'gitlab'], description: 'Forge host for "owner/repo" form (default inferred or github).' },
    ref: { type: 'string', required: false, description: 'Branch/tag/commit to read from (default: the repo default branch).' },
  },
  async execute(params, _context) {
    const res = await forgeClient.reconRepo({
      input: params.repo,
      platform: params.platform,
      ref: params.ref,
    });
    if (!res.ok) return { success: false, error: res.error };
    // keyFiles can be large; hand back text but let the model summarize. We keep
    // the structured shape so downstream reasoning is deterministic.
    return {
      success: true,
      platform: res.platform,
      meta: res.meta,
      tree: res.tree,
      keyFiles: res.keyFiles,
      hints: res.hints,
    };
  },
});
