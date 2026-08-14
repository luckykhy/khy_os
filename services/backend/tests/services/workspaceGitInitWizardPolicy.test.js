'use strict';

/**
 * workspaceGitInitWizardPolicy.test.js — 纯叶子:init 向导后续步骤判定的确定性测试。
 *
 * 锁定:① 有 git 身份 + 无 .gitignore → 建 .gitignore + commit + 规范主线;
 * ② 无身份 + fallback 门开(默认)→ 用 fallback 身份 commit;③ 无身份 + fallback 门关 →
 * 旧行为跳过 commit;④ 已有 .gitignore → 不重建;⑤ wizard 门控关 → 全 false;⑥ 坏输入 fail-soft。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const pol = require('../../src/services/workspaceGitInitWizardPolicy');

const ON = { KHY_GIT_INIT_WIZARD: 'true' };
const OFF = { KHY_GIT_INIT_WIZARD: 'off' };
// fallback 子门显式关(无身份时回退旧「跳过 commit」)。
const FALLBACK_OFF = { KHY_GIT_INIT_WIZARD: 'true', KHY_GIT_INIT_FALLBACK_IDENTITY: 'off' };

describe('workspaceGitInitWizardPolicy.planInitWizard', () => {
  test('有身份 + 无 .gitignore → 建 gitignore + commit + 规范主线', () => {
    const r = pol.planInitWizard({ hasGitignore: false, hasGitIdentity: true, env: ON });
    assert.equal(r.enabled, true);
    assert.equal(r.writeGitignore, true);
    assert.equal(r.commit, true);
    assert.equal(r.useFallbackIdentity, false, '有身份不需 fallback');
    assert.equal(r.setDefaultBranch, true);
    assert.equal(r.reason, 'full-wizard');
  });

  test('无身份 + fallback 门开(默认)→ 用 fallback 身份 commit + 规范主线', () => {
    const r = pol.planInitWizard({ hasGitignore: false, hasGitIdentity: false, env: ON });
    assert.equal(r.writeGitignore, true);
    assert.equal(r.commit, true, '无身份也提交(fallback)');
    assert.equal(r.useFallbackIdentity, true);
    assert.equal(r.setDefaultBranch, true);
    assert.equal(r.reason, 'fallback-identity-commit');
  });

  test('无身份 + fallback 门关 → 旧行为:跳过 commit,仍建 gitignore', () => {
    const r = pol.planInitWizard({ hasGitignore: false, hasGitIdentity: false, env: FALLBACK_OFF });
    assert.equal(r.writeGitignore, true);
    assert.equal(r.commit, false);
    assert.equal(r.useFallbackIdentity, false);
    assert.equal(r.setDefaultBranch, false);
    assert.equal(r.reason, 'no-git-identity-skip-commit');
  });

  test('已有 .gitignore + 有身份 → 不重建 gitignore,仍 commit', () => {
    const r = pol.planInitWizard({ hasGitignore: true, hasGitIdentity: true, env: ON });
    assert.equal(r.writeGitignore, false);
    assert.equal(r.commit, true);
    assert.equal(r.reason, 'gitignore-exists');
  });

  test('wizard 门控关 → 全 false', () => {
    const r = pol.planInitWizard({ hasGitignore: false, hasGitIdentity: true, env: OFF });
    assert.equal(r.enabled, false);
    assert.equal(r.writeGitignore, false);
    assert.equal(r.commit, false);
    assert.equal(r.useFallbackIdentity, false);
    assert.equal(r.setDefaultBranch, false);
  });

  test('坏输入 fail-soft(缺字段 → 保守)', () => {
    const r = pol.planInitWizard(null);
    // null ctx: env 回退 process.env(wizard + fallback 均默认开),字段全缺 → 无身份走 fallback commit。
    assert.equal(typeof r.enabled, 'boolean');
    assert.equal(typeof r.commit, 'boolean');
  });

  test('INITIAL_COMMIT_MESSAGE / DEFAULT_BRANCH / FALLBACK_IDENTITY 稳定', () => {
    assert.equal(pol.INITIAL_COMMIT_MESSAGE, 'chore: initial commit');
    assert.equal(pol.DEFAULT_BRANCH, 'main');
    assert.equal(typeof pol.FALLBACK_IDENTITY.name, 'string');
    assert.match(pol.FALLBACK_IDENTITY.email, /@/);
  });

  test('isFallbackIdentityEnabled 默认开,仅 {0,false,off,no} 关', () => {
    assert.equal(pol.isFallbackIdentityEnabled({}), true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(pol.isFallbackIdentityEnabled({ KHY_GIT_INIT_FALLBACK_IDENTITY: v }), false, `${v} 应关`);
    }
    assert.equal(pol.isFallbackIdentityEnabled({ KHY_GIT_INIT_FALLBACK_IDENTITY: '1' }), true);
  });
});
