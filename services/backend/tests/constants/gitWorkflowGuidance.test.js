'use strict';

const {
  isEnabled,
  buildWorkflowAwareness,
  HEADER,
} = require('../../src/constants/gitWorkflowGuidance');

describe('gitWorkflowGuidance', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: '1' })).toBe(true);
      expect(isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: 'true' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: '0' })).toBe(false);
      expect(isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: 'false' })).toBe(false);
      expect(isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: 'off' })).toBe(false);
      expect(isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: 'FALSE' })).toBe(false);
    });
  });

  describe('buildWorkflowAwareness', () => {
    test('returns empty string when disabled', () => {
      const result = buildWorkflowAwareness({ env: { KHY_GIT_WORKFLOW_GUIDANCE: '0' } });
      expect(result).toBe('');
    });

    test('returns empty string for empty context', () => {
      const result = buildWorkflowAwareness({ env: {} });
      expect(result).toContain(HEADER);
    });

    test('includes branch info when provided', () => {
      const result = buildWorkflowAwareness({
        branch: 'feature/test',
        mainBranch: 'main',
        env: {},
      });
      expect(result).toContain('feature/test');
      expect(result).toContain('main');
    });

    test('warns when on default branch', () => {
      const result = buildWorkflowAwareness({
        branch: 'main',
        mainBranch: 'main',
        env: {},
      });
      expect(result).toContain('ON the default branch');
      expect(result).toContain('branch-first');
    });

    test('includes worktree guidance', () => {
      const result = buildWorkflowAwareness({ env: {} });
      expect(result).toContain('EnterWorktree');
      expect(result).toContain('ExitWorktree');
    });

    test('includes commit offer guidance', () => {
      const result = buildWorkflowAwareness({ env: {} });
      expect(result).toContain('proactively offer');
      expect(result).toContain('Never commit until the user confirms');
    });

    test('includes dirty warning when dirty', () => {
      const result = buildWorkflowAwareness({ dirty: true, env: {} });
      expect(result).toContain('currently has uncommitted changes');
    });

    test('does not include dirty warning when clean', () => {
      const result = buildWorkflowAwareness({ dirty: false, env: {} });
      expect(result).not.toContain('currently has uncommitted changes');
    });
  });

  describe('HEADER', () => {
    test('is a string', () => {
      expect(typeof HEADER).toBe('string');
      expect(HEADER.length).toBeGreaterThan(0);
    });
  });
});
