'use strict';

// BUG-31: every update-block reason must carry its own remedy (rule 2.2).
// Before the fix, all six reasons printed "提交或暂存工作区改动" — advice that is
// only true for `dirty-worktree`.

const coordinator = require('../../../src/services/updateCoordinator');

const REASONS = [
  'detached-head',
  'no-upstream',
  'dirty-worktree',
  'diverged',
  'local-ahead',
  'target-changed',
];

describe('updateCoordinator.describeBlockedReason', () => {
  test.each(REASONS)('%s gets a remedy that names a concrete command', (reason) => {
    const text = coordinator.describeBlockedReason(reason, { ahead: 2, behind: 5 });
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(10);
    expect(text).toMatch(/git |khy update/);
  });

  test('the six remedies are not one string reused', () => {
    const texts = REASONS.map((r) => coordinator.describeBlockedReason(r, { ahead: 2, behind: 5 }));
    expect(new Set(texts).size).toBe(REASONS.length);
  });

  test('only dirty-worktree tells the user to commit or stash', () => {
    const others = REASONS.filter((r) => r !== 'dirty-worktree')
      .map((r) => coordinator.describeBlockedReason(r, {}));
    for (const text of others) expect(text).not.toMatch(/工作区有未提交改动/);
    expect(coordinator.describeBlockedReason('dirty-worktree', {})).toMatch(/工作区有未提交改动/);
  });

  test('diverged and local-ahead report the measured lead/lag', () => {
    expect(coordinator.describeBlockedReason('diverged', { ahead: 3, behind: 7 }))
      .toContain('领先 3、落后 7');
    expect(coordinator.describeBlockedReason('local-ahead', { ahead: 4 }))
      .toContain('领先 4');
  });

  test('an unknown reason still names something actionable', () => {
    const text = coordinator.describeBlockedReason('weird-thing', {});
    expect(text).toContain('weird-thing');
    expect(text).toMatch(/git status/);
  });

  test('state schema carries blockedHint alongside blockedReason', () => {
    const state = coordinator.blankState({ blockedReason: 'no-upstream' });
    expect(state).toHaveProperty('blockedHint', null);
    expect(state.blockedReason).toBe('no-upstream');
  });
});
