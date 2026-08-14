'use strict';

/**
 * workspaceContext.test.js — Part C「工作区一等概念」数据真源。
 *
 * 覆盖：脏文件计数解析（纯函数）、真实仓库采集出结构完整且 fail-soft、
 * 非 git 目录降级、formatSummary 对各形态给出可读中文。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  collectWorkspaceContext,
  formatSummary,
  redactRemote,
  _countDirty,
} = require('../../src/services/workspace/workspaceContext');

describe('redactRemote — 远端 URL 凭据脱敏', () => {
  test('剥离 oauth2 token', () => {
    const out = redactRemote('https://oauth2:glpat-SECRET@gitlab.example.com/o/r.git');
    expect(out).toBe('https://***@gitlab.example.com/o/r.git');
    expect(out).not.toMatch(/SECRET/);
  });
  test('剥离 user:pass', () => {
    expect(redactRemote('https://user:pw@host/r.git')).toBe('https://***@host/r.git');
  });
  test('无凭据 URL 原样保留', () => {
    expect(redactRemote('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(redactRemote('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
  test('空值安全', () => {
    expect(redactRemote('')).toBe('');
    expect(redactRemote(null)).toBe('');
  });
});

describe('_countDirty — 解析 git status --short', () => {
  test('区分已暂存/未暂存/未跟踪', () => {
    const status = [
      'M  staged.js',     // staged (X=M, Y=space)
      ' M unstaged.js',   // unstaged (X=space, Y=M)
      'MM both.js',       // staged + unstaged
      '?? new.txt',       // untracked
      'A  added.js',      // staged add
    ].join('\n');
    const c = _countDirty(status);
    expect(c.total).toBe(5);
    expect(c.staged).toBe(3);     // staged.js, both.js, added.js
    expect(c.unstaged).toBe(2);   // unstaged.js, both.js
    expect(c.untracked).toBe(1);  // new.txt
  });

  test('空状态 → 全零', () => {
    expect(_countDirty('')).toEqual({ staged: 0, unstaged: 0, untracked: 0, total: 0 });
    expect(_countDirty(null)).toEqual({ staged: 0, unstaged: 0, untracked: 0, total: 0 });
  });

  test('忽略分支头 (##)', () => {
    const c = _countDirty('## main...origin/main\n M a.js');
    expect(c.total).toBe(1);
    expect(c.unstaged).toBe(1);
  });
});

describe('collectWorkspaceContext — 真实仓库', () => {
  test('在本仓库内采集出完整结构', () => {
    const ctx = collectWorkspaceContext(process.cwd(), { force: true });
    expect(ctx.isGitRepo).toBe(true);
    expect(typeof ctx.root).toBe('string');
    expect(ctx.root.length).toBeGreaterThan(0);
    expect(typeof ctx.branch).toBe('string');
    expect(ctx.dirtyCounts).toEqual(expect.objectContaining({
      staged: expect.any(Number), unstaged: expect.any(Number),
      untracked: expect.any(Number), total: expect.any(Number),
    }));
    expect(typeof ctx.ahead).toBe('number');
    expect(typeof ctx.behind).toBe('number');
    expect(Array.isArray(ctx.additionalDirs)).toBe(true);
  });
});

describe('collectWorkspaceContext — 非 git 目录降级', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ws-'));
  });
  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('非仓库 → isGitRepo:false 且安全默认，绝不抛', () => {
    const ctx = collectWorkspaceContext(tmp, { force: true });
    expect(ctx.isGitRepo).toBe(false);
    expect(ctx.root).toBe(tmp);
    expect(ctx.branch).toBe('');
    expect(ctx.hasRemote).toBe(false);
    expect(ctx.isDirty).toBe(false);
    expect(ctx.dirtyCounts.total).toBe(0);
  });
});

describe('formatSummary — 小白中文摘要', () => {
  test('非 git 仓库说明版本控制不可用', () => {
    const s = formatSummary({ isGitRepo: false, root: '/x', additionalDirs: [] });
    expect(s).toMatch(/非 git 仓库/);
  });

  test('干净仓库说明无未保存内容', () => {
    const s = formatSummary({
      isGitRepo: true, root: '/x', branch: 'main', mainBranch: 'main',
      hasRemote: true, hasUpstream: true, ahead: 0, behind: 0, remoteUrl: 'git@h:o/r.git',
      isDirty: false, dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
      additionalDirs: [],
    });
    expect(s).toMatch(/干净/);
    expect(s).toMatch(/与远端同步/);
  });

  test('脏仓库 + 落后远端 → 提示待保存与落后', () => {
    const s = formatSummary({
      isGitRepo: true, root: '/x', branch: 'feat', mainBranch: 'main',
      hasRemote: true, hasUpstream: true, ahead: 2, behind: 3, remoteUrl: 'git@h:o/r.git',
      isDirty: true, dirtyCounts: { staged: 1, unstaged: 2, untracked: 0, total: 3 },
      additionalDirs: ['/extra'],
    });
    expect(s).toMatch(/待保存/);
    expect(s).toMatch(/领先 2/);
    expect(s).toMatch(/落后 3/);
    expect(s).toMatch(/额外目录/);
  });

  test('无远端仓库提示需先加 origin', () => {
    const s = formatSummary({
      isGitRepo: true, root: '/x', branch: 'main', mainBranch: 'main',
      hasRemote: false, hasUpstream: false, ahead: 0, behind: 0, remoteUrl: '',
      isDirty: false, dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
      additionalDirs: [],
    });
    expect(s).toMatch(/未配置/);
  });
});
