'use strict';

/**
 * toolCalling.planReadOnly.test.js — P4 of the KHY⇄CC mode-alignment work.
 *
 * Claude Code keeps the agent in a strict read-only sandbox while a plan is
 * being generated/reviewed: explore freely, but no writes/exec until the user
 * approves via ExitPlanMode. KHY's EnterPlanMode declared read-only *intent*
 * (isReadOnly()=true) but never enforced it, so a model could write files while
 * "just planning". P4 makes it a hard deny at the tool funnel: during the plan
 * read-only window (planModeService.isPlanReadOnly()), any non-read-only tool is
 * blocked with a re-injection instruction. Kill switch: KHY_PLAN_READONLY=off.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-plan-ro-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// Isolate the plan-mode gate from the other funnel guards.
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const planModeService = require('../src/services/planModeService');
const planModeSink = require('../src/services/planModeSink');
const toolCalling = require('../src/services/toolCalling');

describe('plan-mode hard read-only gate (P4)', () => {
  // toolCalling reads the flag through the zero-dependency sink seam
  // ([DESIGN-ARCH-051] §6.11), not by importing planModeService. Force the
  // read-only window by registering a stub provider at that seam — the same
  // path production uses (planModeService self-registers its isPlanReadOnly on
  // load). Restoring the real provider after each test keeps the seam honest.
  const realProvider = planModeService.isPlanReadOnly;

  afterEach(() => {
    planModeSink.setPlanReadOnlyProvider(realProvider);
    delete process.env.KHY_PLAN_READONLY;
  });

  test('isPlanReadOnly derives from state: generating/reviewing only', () => {
    // Default idle → writes allowed.
    assert.equal(planModeService.isPlanReadOnly(), false);
  });

  test('during plan read-only, a write tool is hard-denied with a re-injection reason', async () => {
    planModeSink.setPlanReadOnlyProvider(() => true);
    const res = await toolCalling.executeTool('Write', { file_path: path.join(TMP_HOME, 'x.txt'), content: 'hi' });
    assert.equal(res.success, false);
    assert.equal(res.denied, true);
    assert.equal(res._planReadOnlyBlocked, true);
    assert.match(res.error, /计划模式/);
    // The file must NOT have been written.
    assert.equal(fs.existsSync(path.join(TMP_HOME, 'x.txt')), false);
  });

  test('during plan read-only, a read-only tool still passes the gate', async () => {
    planModeSink.setPlanReadOnlyProvider(() => true);
    const target = path.join(TMP_HOME, 'readable.txt');
    fs.writeFileSync(target, 'content-here');
    const res = await toolCalling.executeTool('Read', { file_path: target });
    // Not blocked by the plan gate (success or a non-plan error, but never _planReadOnlyBlocked).
    assert.notEqual(res._planReadOnlyBlocked, true);
  });

  test('KHY_PLAN_READONLY=off disables the gate (write no longer plan-blocked)', async () => {
    process.env.KHY_PLAN_READONLY = 'off';
    planModeSink.setPlanReadOnlyProvider(() => true);
    const res = await toolCalling.executeTool('Write', { file_path: path.join(TMP_HOME, 'y.txt'), content: 'hi' });
    assert.notEqual(res._planReadOnlyBlocked, true);
  });

  test('when not in plan read-only, writes are not plan-blocked', async () => {
    planModeSink.setPlanReadOnlyProvider(() => false);
    const res = await toolCalling.executeTool('Write', { file_path: path.join(TMP_HOME, 'z.txt'), content: 'hi' });
    assert.notEqual(res._planReadOnlyBlocked, true);
  });
});
