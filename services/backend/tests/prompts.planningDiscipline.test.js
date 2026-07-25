'use strict';

/**
 * prompts.planningDiscipline.test.js — P5 of the KHY⇄CC mode-alignment work.
 *
 * CC keeps planning/task-tracking discipline live for any multi-step task. KHY's
 * on-demand prompt gating only fired the planning_verification /
 * task_progress_management sections on a 'medium' task scale (which taskScale.js
 * never emits) or on explicit plan keywords, so ordinary multi-step coding tasks
 * got no planning discipline at all — and frontier/lean (T0) models skipped the
 * planning sections entirely.
 *
 * P5 (KHY_PLANNING_DISCIPLINE, default on):
 *  - adds a "multi-step work expected" activation path so engineering tasks fire
 *    the two planning sections without relying on keywords or 'large' scale, and
 *  - gives lean/T0 models a compact one-bullet task-discipline cue instead of a
 *    total skip.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('../src/constants/prompts');

const PLAN_IDS = ['planning_verification', 'task_progress_management'];

function planSections(userMessage, taskScale, enabledTools = ['Read', 'Edit', 'Bash']) {
  const decision = prompts.getOnDemandPromptSectionDecision({ userMessage, taskScale, enabledTools });
  return decision.ids.filter(id => PLAN_IDS.includes(id));
}

describe('planning discipline heuristic (P5)', () => {
  afterEach(() => { delete process.env.KHY_PLANNING_DISCIPLINE; });

  test('a normal-scale engineering task triggers both planning sections', () => {
    const got = planSections('重构这个数据库连接池模块并补充对应的边界检查', 'normal');
    assert.deepEqual(got.sort(), [...PLAN_IDS].sort());
  });

  test('an enumerated multi-action engineering request triggers planning discipline', () => {
    const got = planSections('帮我做两件事：1. 修复登录接口的空密码bug 2. 更新调用处与文档', 'small');
    assert.deepEqual(got.sort(), [...PLAN_IDS].sort());
  });

  test('a purely conversational request does NOT trigger planning discipline', () => {
    // Long enough to clear the short-request fallback, no engineering/plan signal.
    const got = planSections('能不能跟我聊聊你平时都喜欢做些什么有趣的事情呀我很好奇', 'small');
    assert.deepEqual(got, []);
  });

  test('KHY_PLANNING_DISCIPLINE=off removes the heuristic activation', () => {
    process.env.KHY_PLANNING_DISCIPLINE = 'off';
    // Engineering intent with no plan keyword and no >=medium scale → no sections.
    const got = planSections('给登录函数加一个空密码校验并更新所有调用处', 'normal');
    assert.deepEqual(got, []);
  });

  test('large-scale tasks still trigger planning discipline regardless of flag default', () => {
    const got = planSections('全面重构整个鉴权模块', 'large');
    assert.deepEqual(got.sort(), [...PLAN_IDS].sort());
  });

  test('compact task-discipline section is non-empty and single-topic', () => {
    const section = prompts.getCompactTaskDisciplineSection();
    assert.ok(typeof section === 'string' && section.trim().length > 0);
    assert.match(section, /# Task discipline/);
    assert.match(section, /multi-step/i);
    // Compact: just a heading + one bullet, far shorter than the full sections.
    const full = prompts.getTaskAndProgressManagementSection();
    assert.ok(section.length < full.length);
  });
});

describe('closing-summary discipline (rich task summary)', () => {
  test('planning/verification section instructs a structured closing summary', () => {
    const section = prompts.getPlanningAndVerificationSection();
    assert.ok(typeof section === 'string' && section.trim().length > 0);
    // The closing-summary cue mirrors the rich plan/report skeleton: why it was
    // done, what was done, expected vs actual, what was verified, what remains.
    assert.match(section, /closing summary/i);
    assert.match(section, /residual/i);
    assert.match(section, /verif/i);
  });

  test('does NOT duplicate the closing-summary cue (noise principle: single layer)', () => {
    const section = prompts.getPlanningAndVerificationSection();
    const occurrences = (section.match(/closing summary/gi) || []).length;
    assert.equal(occurrences, 1);
  });
});
