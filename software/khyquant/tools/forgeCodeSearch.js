const { defineTool } = require('./_baseTool');
const forgeCore = require('../services/forge/forgeCore');
const forgeClient = require('../services/forge/forgeClient');

/**
 * forgeCodeSearch — search code across GitHub (the way you'd grep the whole forge
 * for a symbol, API call, or config pattern) to find real-world usage examples
 * before adopting a library or technique.
 *
 * Read-only. Wraps GitHub's `/search/code` endpoint. The query may include
 * GitHub code-search qualifiers (e.g. `language:rust`, `filename:Dockerfile`);
 * an optional `repo` narrows the search to one project. Returns matches as
 * { repo, path, name, url }.
 *
 * Honest boundary: only GitHub exposes a clean public code-search API. Gitee has
 * none and GitLab's depends on instance config, so this tool is GitHub-only and
 * says so plainly for other platforms rather than faking it. Code search usually
 * requires auth — set GITHUB_TOKEN (read from env, never echoed).
 */
module.exports = defineTool({
  name: 'forgeCodeSearch',
  description: 'Search code across GitHub by keyword/qualifiers (language:, filename:, path:) to find real usage examples. Optionally scope to one "owner/repo". Returns {repo, path, url} matches. GitHub-only (Gitee/GitLab have no clean public code-search API); usually needs GITHUB_TOKEN.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: () => forgeCore.isEnabled(),
  inputSchema: {
    query: { type: 'string', required: true, description: 'Code search expression. May include GitHub qualifiers, e.g. "createServer language:js".' },
    repo: { type: 'string', required: false, description: 'Narrow to one repository: "owner/repo".' },
    platform: { type: 'string', required: false, enum: ['github'], description: 'Only github is supported for code search.' },
    limit: { type: 'number', required: false, min: 1, max: 50, description: 'Max results (default 10, max 50).' },
  },
  async execute(params, _context) {
    const res = await forgeClient.searchCode({
      query: params.query,
      repo: params.repo,
      platform: params.platform,
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
