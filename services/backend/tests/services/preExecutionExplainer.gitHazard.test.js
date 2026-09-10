'use strict';
/**
 * preExecutionExplainer.gitHazard.test.js — git 危险操作专项说明(确定性)。
 *
 * 锁定 preExecutionExplainer 对 force-push / reset --hard / clean -fd 三类高破坏
 * git 命令:
 *   ① _gitHazardHint 精确命中三类、放行普通 push/status;
 *   ② detailed 深度 explain 输出含专项「后果」与「撤销」文案(而非泛化 NETWORK 文案);
 *   ③ -f 短旗、--force-with-lease 也算强推;--set-upstream 不误报。
 */
const explainer = require('../../src/services/syscallGateway/preExecutionExplainer');
const { ACTIONS } = require('../../src/services/syscallGateway/intentSchema');
function explainDetailed(intent) {
  return explainer.explain(intent, {
    describe: () => ({ isRedLine: true, level: 'L2', reasons: [], summary: '' }),
    collectWorkspace: () => null,
  });
}

describe('Pre Execution Explainer git Hazard', () => {
  test('_gitHazardHint 命中 force-push / reset-hard / clean-fd', () => {
      expect(explainer._gitHazardHint({ resource: 'git push origin main --force' }).key).toBe('force-push');
      expect(explainer._gitHazardHint({ resource: 'git push -f origin main' }).key).toBe('force-push');
      expect(explainer._gitHazardHint({ resource: 'git push --force-with-lease' }).key).toBe('force-push');
      expect(explainer._gitHazardHint({ raw: 'git reset --hard HEAD~1' }).key).toBe('reset-hard');
      expect(explainer._gitHazardHint({ resource: 'git clean -fd' }).key).toBe('clean-fd');
      expect(explainer._gitHazardHint({ resource: 'git clean -df .' }).key).toBe('clean-fd');
  });

  test('_gitHazardHint 放行普通 push/status/commit/set-upstream', () => {
      expect(explainer._gitHazardHint({ resource: 'git push origin main' })).toBe(null);
      expect(explainer._gitHazardHint({ resource: 'git push --set-upstream origin main' })).toBe(null);
      expect(explainer._gitHazardHint({ resource: 'git status' })).toBe(null);
      expect(explainer._gitHazardHint({ resource: 'git commit -a -m fix' })).toBe(null);
  });

  test('_gitHazardHint fail-soft:空/非字符串 → null', () => {
      expect(explainer._gitHazardHint({})).toBe(null);
      expect(explainer._gitHazardHint({ resource: '' })).toBe(null);
      expect(explainer._gitHazardHint(null)).toBe(null);
      expect(explainer._gitHazardHint({ resource: 123 })).toBe(null);
  });

  test('detailed explain(force-push):后果与撤销含专项文案', () => {
      const out = explainDetailed({
        resource: 'git push origin main --force', raw: 'git push origin main --force',
        action: ACTIONS.NETWORK, isDestructive: true,
      });
      expect(out.whatHappens.includes('强制推送')).toBeTruthy();
      expect(out.risks.some((r) => r).toContain('覆盖远程'), '后果应含覆盖远程');
      expect(/reflog/.test(out.howToUndo)).toBeTruthy();
  });

  test('detailed explain(reset --hard):撤销提醒未 commit 改动不可恢复', () => {
      const out = explainDetailed({
        resource: 'git reset --hard HEAD~2', raw: 'git reset --hard HEAD~2',
        action: ACTIONS.PROCESS, isDestructive: true,
      });
      expect(out.whatHappens.includes('硬重置')).toBeTruthy();
      expect(out.risks.some((r) => r).toContain('未提交'), '后果应含未提交改动被丢弃');
      expect(out.howToUndo.includes('reflog') || out.howToUndo.includes('快照')).toBeTruthy();
  });

  test('detailed explain(clean -fd):讲清永久删除未跟踪文件', () => {
      const out = explainDetailed({
        resource: 'git clean -fd', raw: 'git clean -fd',
        action: ACTIONS.DELETE, isDestructive: true,
      });
      expect(out.whatHappens.includes('清理') || out.whatHappens.includes('删除')).toBeTruthy();
      expect(out.risks.some((r) => r.includes('未被 git 跟踪') || r).toContain('直接删除'), '后果应含未跟踪文件被删');
      expect(out.howToUndo.includes('不可逆') || out.howToUndo.includes('-nd')).toBeTruthy();
  });

  test('普通 git push 不注入专项文案(回退泛化)', () => {
      const out = explainDetailed({
        resource: 'git push origin main', raw: 'git push origin main',
        action: ACTIONS.NETWORK, isDestructive: false,
      });
      expect(!out.whatHappens.includes('强制推送')).toBeTruthy();
  });

});
