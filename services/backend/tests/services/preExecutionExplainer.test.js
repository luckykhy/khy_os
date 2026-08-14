'use strict';

/**
 * preExecutionExplainer.test.js — Part D「面向小白的执行前说明」。
 *
 * 验证：
 *  · 说明深浅随「难易/重要程度」缩放（L0 一行 / L1 标准 / L2 详尽）；
 *  · 内容基于 khyos 已采集数据（分级 reasons、破坏性、工作区上下文）；
 *  · 工作区缺失时主动获取（gather-if-missing），且全程 fail-soft 不抛。
 */

const { ACTIONS, buildIntent } = require('../../src/services/syscallGateway/intentSchema');
const explainer = require('../../src/services/syscallGateway/preExecutionExplainer');

const CWD = '/proj';
const HOME = '/home/u';

function intent({ tool, params = {}, isReadOnly, isDestructive, risk }) {
  return buildIntent({ tool, params, isReadOnly, isDestructive, risk, cwd: CWD, home: HOME });
}

// A stub workspace so tests never touch real git.
const WS = {
  isGitRepo: true, root: CWD, branch: 'main', mainBranch: 'main',
  hasRemote: true, hasUpstream: true, ahead: 0, behind: 0,
  remoteUrl: 'git@h:o/r.git', remoteUrlSafe: 'git@h:o/r.git',
  isDirty: false, dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
  additionalDirs: [],
};

describe('深浅随难易/重要程度缩放', () => {
  test('只读 → brief：仅一行，无风险/撤销噪音', () => {
    const e = explainer.explain(intent({ tool: 'read_file', params: { path: `${CWD}/a.txt` }, isReadOnly: true }), { workspace: WS });
    expect(e.level).toBe('L0');
    expect(e.depth).toBe('brief');
    expect(e.difficulty).toBe('easy');
    expect(e.text.split('\n').filter(Boolean).length).toBe(1);
    expect(e.risks).toEqual([]);
    expect(e.howToUndo).toBeNull();
  });

  test('项目内写入 → standard：含撤销方式与工作区', () => {
    const e = explainer.explain(intent({ tool: 'write_file', params: { path: `${CWD}/src/a.txt` } }), { workspace: WS });
    expect(e.level).toBe('L1');
    expect(e.depth).toBe('standard');
    expect(e.text).toMatch(/撤销方式/);
    expect(e.text).toMatch(/当前工作区/);
    expect(e.workspace).toBeTruthy();
  });

  test('破坏性删除 → detailed：含「为什么确认/后果/撤销」', () => {
    const e = explainer.explain(intent({ tool: 'deleteFile', params: { path: `${CWD}/x` }, isDestructive: true }), { workspace: WS });
    expect(e.level).toBe('L2');
    expect(e.depth).toBe('detailed');
    expect(e.importance).toBe('high');
    expect(e.difficulty).toBe('hard');
    expect(e.text).toMatch(/可能的后果/);
    expect(e.text).toMatch(/撤销方式/);
    expect(e.headline).toMatch(/⚠ 高风险/);
  });
});

describe('内容基于 khyos 已采集数据', () => {
  test('reasons 取自分级裁决', () => {
    const e = explainer.explain(intent({ tool: 'deleteFile', params: { path: `${CWD}/x` }, isDestructive: true }), { workspace: WS });
    expect(Array.isArray(e.reasons)).toBe(true);
    expect(e.reasons.length).toBeGreaterThan(0);
  });

  test('force-push 类破坏性写入：后果点明「破坏性」', () => {
    const e = explainer.explain(intent({ tool: 'gitPush', params: { force: true }, isDestructive: true }), { workspace: WS });
    expect(e.level).toBe('L2');
    expect(e.risks.join(' ')).toMatch(/破坏性|修改或销毁/);
  });
});

describe('gather-if-missing + fail-soft', () => {
  test('未传 workspace → 调用注入的采集器主动获取', () => {
    let called = false;
    const collectWorkspace = () => { called = true; return WS; };
    const e = explainer.explain(intent({ tool: 'write_file', params: { path: `${CWD}/src/a.txt` } }), { collectWorkspace, cwd: CWD });
    expect(called).toBe(true);
    expect(e.workspace).toBeTruthy();
  });

  test('采集器抛错 → 说明仍可生成（workspace=null）', () => {
    const collectWorkspace = () => { throw new Error('git boom'); };
    const e = explainer.explain(intent({ tool: 'write_file', params: { path: `${CWD}/src/a.txt` } }), { collectWorkspace, cwd: CWD });
    expect(e.workspace).toBeNull();
    expect(e.text).toBeTruthy();
  });

  test('describe 抛错 → 保守按高危且不抛', () => {
    const describe = () => { throw new Error('classify boom'); };
    const e = explainer.explain(intent({ tool: 'whatever' }), { describe, workspace: WS });
    expect(e.level).toBe('L2');
    expect(e.text).toBeTruthy();
  });

  test('只读不附带工作区（减噪）', () => {
    let called = false;
    const collectWorkspace = () => { called = true; return WS; };
    explainer.explain(intent({ tool: 'read_file', params: { path: `${CWD}/a.txt` }, isReadOnly: true }), { collectWorkspace, cwd: CWD });
    expect(called).toBe(false);
  });
});
