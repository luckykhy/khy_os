'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { defineTool } = require('./_baseTool');
const repoDiscipline = require('../services/repoDisciplineRisk');

/**
 * repoAudit — audit the LOCAL repository for discipline & risk before a commit/push.
 *
 * Read-only. Inspects the staged change set (falling back to the unstaged working
 * tree when nothing is staged) and runs it through the `repoDisciplineRisk` SSOT:
 *   - secret-content scan over the diff (AWS / GitHub / private-key / generic …)
 *   - large-file / binary-artifact risk by byte size
 *   - commit-message quality (Conventional Commits, vague-subject) if a message is given
 *   - path-tier advisory (touching immutable/guarded areas)
 *   - branch / force-push / --no-verify / git-add-all / --amend discipline reminders
 *
 * Returns a deterministic verdict (clean / caution / block) plus findings, so the
 * model can warn the user BEFORE a risky git operation instead of after. It never
 * runs git mutations and never echoes a full secret (matches are masked).
 *
 * Gated by KHY_REPO_DISCIPLINE (default on); when off the tool reports disabled.
 */

const _GIT_OPTS = { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] };

function _git(args, cwd) {
  return execFileSync('git', args, { ..._GIT_OPTS, cwd }).toString();
}

function _gitSoft(args, cwd) {
  try {
    return { ok: true, out: _git(args, cwd).trim() };
  } catch (err) {
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    return { ok: false, out: '', err: (stderr || (err && err.message) || String(err)).trim() };
  }
}

function _detectMainBranch(cwd) {
  const ref = _gitSoft(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (ref.ok && ref.out.includes('/')) return ref.out.split('/').pop();
  return undefined; // leaf falls back to {main, master}
}

function _statSize(cwd, rel) {
  try {
    return fs.statSync(path.join(cwd, rel)).size;
  } catch {
    return undefined; // deleted/renamed files have no current blob — leave size unknown
  }
}

module.exports = defineTool({
  name: 'repoAudit',
  description: 'Audit the LOCAL git repo for discipline & risk before committing/pushing: scans the staged diff for leaked secrets, flags large/binary files, scores the commit message (Conventional Commits), warns on immutable/guarded paths, and checks branch/force-push/--no-verify/git-add-all/--amend discipline. Returns a clean/caution/block verdict with findings. Read-only; never mutates git; secrets are masked.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: () => repoDiscipline.isEnabled(),
  inputSchema: {
    message: { type: 'string', required: false, description: 'Pending commit message to score (optional). If omitted, commit-message quality is not assessed.' },
    force: { type: 'boolean', required: false, description: 'Set true if the intended push is a force push (raises force-push-to-main to a blocker).' },
    noVerify: { type: 'boolean', required: false, description: 'Set true if the intended commit/push skips hooks (--no-verify).' },
    amend: { type: 'boolean', required: false, description: 'Set true if the intended commit is an --amend.' },
  },
  async execute(params = {}, _context) {
    const cwd = process.cwd();

    const inside = _gitSoft(['rev-parse', '--is-inside-work-tree'], cwd);
    if (!inside.ok || inside.out !== 'true') {
      return { success: false, error: '当前目录不是一个 Git 版本库(repoAudit 需要在仓库内运行)。' };
    }

    const branchRes = _gitSoft(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const branch = branchRes.ok ? branchRes.out : undefined;
    const mainBranch = _detectMainBranch(cwd);

    // Prefer the staged change set (what you're about to commit). If nothing is
    // staged, audit the unstaged working tree so the tool is still useful.
    const stagedNames = _gitSoft(['diff', '--cached', '--name-only'], cwd);
    const staged = stagedNames.ok && stagedNames.out ? stagedNames.out.split(/\r?\n/).filter(Boolean) : [];
    const useStaged = staged.length > 0;
    const cachedArg = useStaged ? ['diff', '--cached'] : ['diff'];
    const nameArg = useStaged ? ['diff', '--cached', '--name-only'] : ['diff', '--name-only'];

    const diffRes = _gitSoft(cachedArg, cwd);
    const diffText = diffRes.ok ? diffRes.out : '';
    const namesRes = _gitSoft(nameArg, cwd);
    const names = namesRes.ok && namesRes.out ? namesRes.out.split(/\r?\n/).filter(Boolean) : [];
    const files = names.map((rel) => ({ path: rel, size: _statSize(cwd, rel) }));

    const report = repoDiscipline.assessRepoRisk({
      branch,
      mainBranch,
      force: !!params.force,
      noVerify: !!params.noVerify,
      amend: !!params.amend,
      addAll: false, // the model declares its staging intent separately; default off
      files,
      diffText,
      message: params.message,
    });

    return {
      success: true,
      scope: useStaged ? 'staged' : 'working-tree',
      branch: branch || null,
      mainBranch: mainBranch || null,
      filesAudited: files.length,
      verdict: report.verdict,
      summary: report.summary,
      findings: report.findings,
      commitQuality: report.commitQuality,
    };
  },
});
