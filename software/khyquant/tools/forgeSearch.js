const { defineTool } = require('./_baseTool');
const forgeCore = require('../services/forge/forgeCore');
const forgeClient = require('../services/forge/forgeClient');

/**
 * forgeSearch — search public repositories on GitHub / Gitee / GitLab.
 *
 * Read-only: it only queries each forge's REST search endpoint and returns a
 * uniform list ({ fullName, description, stars, language, url, cloneUrl }) the
 * model can then hand to gitClone. Auth tokens (GITHUB_TOKEN / GITEE_TOKEN /
 * GITLAB_TOKEN) are read from the environment by the client only to raise rate
 * limits; they are never echoed back.
 */
module.exports = defineTool({
  name: 'forgeSearch',
  description: 'Search repositories on GitHub, Gitee, or GitLab by keyword. Returns top matches with full name, description, stars, language and clone URL. Use this to find a project before cloning it with gitClone.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: () => forgeCore.isEnabled(),
  inputSchema: {
    query: { type: 'string', required: true, description: 'Search keywords (e.g. "rust http framework").' },
    platform: { type: 'string', required: false, enum: ['github', 'gitee', 'gitlab'], description: 'Which forge to search (default: github).' },
    limit: { type: 'number', required: false, min: 1, max: 50, description: 'Max results to return (default 10, max 50).' },
  },
  async execute(params, _context) {
    const res = await forgeClient.searchRepos({
      platform: params.platform,
      query: params.query,
      limit: params.limit,
    });
    if (!res.ok) return { success: false, error: res.error };
    return {
      success: true,
      platform: res.platform,
      query: res.query,
      count: res.results.length,
      results: res.results,
    };
  },
});
