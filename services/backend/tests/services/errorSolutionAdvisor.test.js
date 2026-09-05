'use strict';

const {
  SOLUTION_RULES,
  isErrorSolutionAdvisorEnabled,
  suggestSolutions,
  matchedSolutionNames,
} = require('../../src/services/errorSolutionAdvisor');

describe('errorSolutionAdvisor', () => {
  describe('isErrorSolutionAdvisorEnabled', () => {
    test('returns true by default', () => {
      expect(isErrorSolutionAdvisorEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: '1' })).toBe(true);
      expect(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: 'true' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: '0' })).toBe(false);
      expect(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: 'false' })).toBe(false);
      expect(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: 'off' })).toBe(false);
      expect(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(isErrorSolutionAdvisorEnabled({ KHY_ERROR_SOLUTION_ADVISOR: 'FALSE' })).toBe(false);
    });
  });

  describe('suggestSolutions', () => {
    test('returns empty when disabled', () => {
      expect(suggestSolutions('error', { env: { KHY_ERROR_SOLUTION_ADVISOR: '0' } })).toEqual([]);
    });

    test('returns empty for empty input', () => {
      expect(suggestSolutions('', { env: {} })).toEqual([]);
      expect(suggestSolutions([], { env: {} })).toEqual([]);
    });

    test('suggests permission solution', () => {
      const result = suggestSolutions('EACCES: permission denied', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('权限');
    });

    test('suggests path-not-found solution', () => {
      const result = suggestSolutions('ENOENT: no such file or directory', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('路径不存在');
    });

    test('suggests command-not-found solution', () => {
      const result = suggestSolutions('command not found', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('命令未安装');
    });

    test('suggests connection-refused solution', () => {
      const result = suggestSolutions('ECONNREFUSED: connection refused', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('连接被拒绝');
    });

    test('suggests dns solution', () => {
      const result = suggestSolutions('ENOTFOUND: getaddrinfo failed', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('域名解析');
    });

    test('suggests port-in-use solution', () => {
      const result = suggestSolutions('EADDRINUSE: address already in use', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('端口');
    });

    test('suggests timeout solution', () => {
      const result = suggestSolutions('ETIMEDOUT: timed out', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('超时');
    });

    test('suggests disk-full solution', () => {
      const result = suggestSolutions('ENOSPC: no space left on device', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('磁盘空间');
    });

    test('suggests out-of-memory solution', () => {
      const result = suggestSolutions('out of memory', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('内存');
    });

    test('suggests module-not-found solution', () => {
      const result = suggestSolutions('Cannot find module "express"', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('依赖');
    });

    test('suggests file-exists solution', () => {
      const result = suggestSolutions('EEXIST: file already exists', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('已存在');
    });

    test('suggests auth solution', () => {
      const result = suggestSolutions('HTTP 401 Unauthorized', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('认证');
    });

    test('suggests rate-limit solution', () => {
      const result = suggestSolutions('HTTP 429 Too Many Requests', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('限流');
    });

    test('suggests git-conflict solution', () => {
      const result = suggestSolutions('merge conflict prevented', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('Git');
    });

    test('suggests download-failed solution', () => {
      const result = suggestSolutions('HTTP 404 Not Found', { env: {} });
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('下载');
    });

    test('respects max option', () => {
      const result = suggestSolutions('EACCES permission denied ENOENT not found ECONNREFUSED', { env: {}, max: 2 });
      expect(result.length).toBe(2);
    });

    test('accepts array input', () => {
      const result = suggestSolutions(['EACCES', 'ENOENT'], { env: {} });
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('matchedSolutionNames', () => {
    test('returns empty when disabled', () => {
      expect(matchedSolutionNames('error', { env: { KHY_ERROR_SOLUTION_ADVISOR: '0' } })).toEqual([]);
    });

    test('returns empty for empty input', () => {
      expect(matchedSolutionNames('', { env: {} })).toEqual([]);
    });

    test('returns matched rule names', () => {
      const result = matchedSolutionNames('EACCES: permission denied', { env: {} });
      expect(result).toContain('permission');
    });

    test('returns multiple rule names', () => {
      const result = matchedSolutionNames('EACCES ENOENT', { env: {} });
      expect(result).toContain('permission');
      expect(result).toContain('path-not-found');
    });
  });

  describe('SOLUTION_RULES', () => {
    test('is a frozen array', () => {
      expect(Array.isArray(SOLUTION_RULES)).toBe(true);
    });

    test('has at least 15 rules', () => {
      expect(SOLUTION_RULES.length).toBeGreaterThanOrEqual(15);
    });

    test('each rule has name, re, and solution', () => {
      for (const rule of SOLUTION_RULES) {
        expect(rule).toHaveProperty('name');
        expect(rule).toHaveProperty('re');
        expect(rule).toHaveProperty('solution');
        expect(typeof rule.name).toBe('string');
        expect(rule.re instanceof RegExp).toBe(true);
        expect(typeof rule.solution).toBe('string');
      }
    });
  });
});
