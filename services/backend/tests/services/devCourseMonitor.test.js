'use strict';

/**
 * devCourseMonitor.test.js — 开发过程「在途纠偏」纯模块单测。
 *
 * 守护(goal 2026-06-25「开发过程主动监听避免大错误,及时修正航向避免完成后大改」):
 *   1. 健康短任务零误报(改几处 + 跑过测试 = 无纠偏)。
 *   2. 测试回归(绿→红 / 失败数变多)→ high 信号。
 *   3. 未验证 churn(改一堆没跑测试)→ medium 信号;一旦跑测试即清零。
 *   4. 反复改同一文件 → thrash 信号。
 *   5. 连续失败 → failure-streak 信号;中途成功即归零。
 *   6. episode 去重(条件持续不重复打扰)+ 解除后重新武装可再触发。
 *   7. off / 子 agent(由 loop 控制,此处验 isEnabled)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const m = require('../../src/services/devCourseMonitor');

const ON = { KHY_DEV_COURSE_MONITOR: 'on' };
const edit = (path) => ({ tool: 'edit_file', params: { path }, result: { success: true } });
const fail = (tool = 'bash') => ({ tool, params: {}, result: { success: false } });
const ok = (tool = 'bash') => ({ tool, params: {}, result: { success: true } });
const testFinding = (over = {}) => ({ kind: 'test', framework: 'jest', passed: 10, failed: 0, total: 10, green: true, failures: [], ...over });

describe('devCourseMonitor — 健康任务零误报', () => {
  test('改几处 + 跑过测试全绿 → 不跑偏', () => {
    const st = m.createState();
    m.recordIteration(st, { toolResults: [edit('a.js'), edit('b.js')], testFindings: [testFinding()] }, ON);
    const a = m.assess(st, ON);
    assert.equal(a.drift, false);
    assert.equal(m.hasCorrections(st), false);
  });
});

describe('devCourseMonitor — 测试回归(最强信号)', () => {
  test('之前绿、现在红 → high regression', () => {
    const st = m.createState();
    m.recordIteration(st, { toolResults: [edit('a.js')], testFindings: [testFinding({ green: true, failed: 0 })] }, ON);
    assert.equal(m.assess(st, ON).drift, false);
    m.recordIteration(st, { toolResults: [edit('a.js')], testFindings: [testFinding({ green: false, failed: 3, failures: ['t1', 't2'] })] }, ON);
    const a = m.assess(st, ON);
    assert.equal(a.drift, true);
    assert.equal(a.signals[0].type, 'regression');
    assert.equal(a.signals[0].severity, 'high');
    assert.match(a.directive, /回归|失败/);
  });

  test('首次测试就红(没绿过)不算回归;后续失败数变多才算', () => {
    const st = m.createState();
    m.recordIteration(st, { toolResults: [], testFindings: [testFinding({ green: false, failed: 2 })] }, ON);
    assert.equal(m.assess(st, ON).drift, false, '首次红不是回归(那是起点)');
    // 修了一些,降到 1 失败,仍红但在改善 → 不告警
    m.recordIteration(st, { toolResults: [], testFindings: [testFinding({ green: false, failed: 1 })] }, ON);
    assert.equal(m.assess(st, ON).drift, false, '改善中不告警');
    // 又冒出新失败,涨到 4 → 比最好(1)更差 → 回归
    m.recordIteration(st, { toolResults: [], testFindings: [testFinding({ green: false, failed: 4 })] }, ON);
    const a = m.assess(st, ON);
    assert.equal(a.drift, true);
    assert.equal(a.signals[0].type, 'regression');
  });
});

describe('devCourseMonitor — 未验证 churn', () => {
  test('改一堆文件没跑测试 → medium;跑测试后清零', () => {
    const st = m.createState();
    const env = { ...ON, KHY_DEV_COURSE_CHURN_EDITS: '4', KHY_DEV_COURSE_CHURN_FILES: '3' };
    m.recordIteration(st, { toolResults: [edit('a'), edit('b'), edit('c'), edit('d')], testFindings: [] }, env);
    const a = m.assess(st, env);
    assert.equal(a.drift, true);
    assert.equal(a.signals.some(s => s.type === 'unverified-churn'), true);
    // 跑一次测试 → churn 计数清零,条件解除并重新武装
    m.recordIteration(st, { toolResults: [], testFindings: [testFinding()] }, env);
    const b = m.assess(st, env);
    assert.equal(b.signals.some(s => s.type === 'unverified-churn'), false);
  });
});

describe('devCourseMonitor — 反复改同一文件 thrash', () => {
  test('同一文件改到阈值 → thrash', () => {
    const st = m.createState();
    const env = { ...ON, KHY_DEV_COURSE_THRASH: '3', KHY_DEV_COURSE_CHURN_EDITS: '99' };
    for (let i = 0; i < 3; i += 1) m.recordIteration(st, { toolResults: [edit('hot.js')], testFindings: [] }, env);
    const a = m.assess(st, env);
    assert.equal(a.signals.some(s => s.type === 'thrash'), true);
  });
});

describe('devCourseMonitor — 连续失败 failure-streak', () => {
  test('连续失败到阈值 → 信号;中途成功归零', () => {
    const st = m.createState();
    const env = { ...ON, KHY_DEV_COURSE_STREAK: '3' };
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    assert.equal(m.assess(st, env).drift, false, '2 轮未到阈值');
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    assert.equal(m.assess(st, env).signals.some(s => s.type === 'failure-streak'), true);
    // 成功一轮 → 归零,条件解除
    m.recordIteration(st, { toolResults: [ok()], testFindings: [] }, env);
    assert.equal(m.assess(st, env).drift, false);
  });
});

describe('devCourseMonitor — episode 去重与重新武装', () => {
  test('同一条件持续不重复打扰;解除后重现可再触发', () => {
    const st = m.createState();
    const env = { ...ON, KHY_DEV_COURSE_STREAK: '2' };
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    assert.equal(m.assess(st, env).drift, true, '首次触发');
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    assert.equal(m.assess(st, env).drift, false, '持续期去重不重复打扰');
    // 成功一轮解除,再连续失败 → 重新触发
    m.recordIteration(st, { toolResults: [ok()], testFindings: [] }, env);
    m.assess(st, env); // 让 streak 条件从 announced 移除
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    m.recordIteration(st, { toolResults: [fail()], testFindings: [] }, env);
    assert.equal(m.assess(st, env).drift, true, '重新武装后可再触发');
  });
});

describe('devCourseMonitor — 开关与摘要契约', () => {
  test('off → 不监听、assess 不跑偏', () => {
    const off = { KHY_DEV_COURSE_MONITOR: 'off' };
    assert.equal(m.isEnabled(off), false);
    const st = m.createState();
    m.recordIteration(st, { toolResults: [fail(), fail(), fail()], testFindings: [] }, off);
    assert.equal(m.assess(st, off).drift, false);
  });

  test('summarize 暴露 iterations/edits/filesTouched/verified/corrections/byType', () => {
    const st = m.createState();
    m.recordIteration(st, { toolResults: [edit('a.js')], testFindings: [testFinding({ green: true })] }, ON);
    m.recordIteration(st, { toolResults: [edit('a.js')], testFindings: [testFinding({ green: false, failed: 2 })] }, ON);
    m.assess(st, ON);
    const s = m.summarize(st);
    assert.equal(typeof s.iterations, 'number');
    assert.equal(typeof s.edits, 'number');
    assert.equal(s.filesTouched, 1);
    assert.equal(s.verified, 2);
    assert.ok(Array.isArray(s.corrections));
    assert.ok(s.byType.regression >= 1);
  });
});
