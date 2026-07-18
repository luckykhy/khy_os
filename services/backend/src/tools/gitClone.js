const { defineTool } = require('./_baseTool');
const forgeCore = require('../services/forge/forgeCore');
const forgeClient = require('../services/forge/forgeClient');

/**
 * gitClone — clone a remote repository to a local directory.
 *
 * Accepts either `owner/repo` (resolved against the chosen platform's host) or a
 * full http(s)/ssh git URL. The repo argument is validated by forgeCore's
 * injection guard (rejects `ext::`, leading `-`, shell metacharacters) and the
 * clone runs via execFile('git', [...]) with `--` so it can never be coerced
 * into running a shell command or an extra git option.
 *
 * Risk model: cloning only WRITES a new local directory; it never mutates an
 * existing repo or remote → risk:'medium', non-destructive (no red line).
 * Unlike gitPush/gitStatus this tool does NOT require being inside a git repo —
 * you clone precisely to create one.
 */
module.exports = defineTool({
  name: 'gitClone',
  description: 'Clone a remote repository (GitHub/Gitee/GitLab) to a local folder. Pass either "owner/repo" with a platform, or a full git URL. Use forgeSearch first to find the repo. Cloning only creates a new local directory.',
  category: 'git',
  risk: 'medium',
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isEnabled: () => forgeCore.isEnabled(),
  inputSchema: {
    repo: { type: 'string', required: true, description: 'Repository to clone: "owner/repo" or a full http(s)/ssh git URL.' },
    platform: { type: 'string', required: false, enum: ['github', 'gitee', 'gitlab'], description: 'Forge host for "owner/repo" form (default inferred or github).' },
    dir: { type: 'string', required: false, description: 'Target directory name (default: the repo name).' },
    depth: { type: 'number', required: false, min: 1, description: 'Shallow clone depth (e.g. 1 for latest commit only).' },
    ssh: { type: 'boolean', required: false, description: 'Use the git@ SSH URL instead of https.' },
  },
  async execute(params, _context) {
    const res = await forgeClient.cloneRepo({
      input: params.repo,
      platform: params.platform,
      dir: params.dir,
      depth: params.depth,
      ssh: params.ssh === true,
      cwd: process.env.KHYQUANT_CWD || process.cwd(),
    });
    if (!res.ok) return { success: false, error: res.error };
    return { success: true, url: res.url, dir: res.dir, output: res.output };
  },
});
