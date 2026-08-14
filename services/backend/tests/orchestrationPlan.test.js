'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildOrchestrationPlan,
  summarizePlanProgress,
  VALID_MODES,
} = require('../src/services/orchestrator/orchestrationPlan');

test('sequential mode chains each step to the previous one', () => {
  const plan = buildOrchestrationPlan({
    mode: 'sequential',
    steps: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }],
  });
  assert.strictEqual(plan.mode, 'sequential');
  assert.strictEqual(plan.stepCount, 3);
  assert.deepStrictEqual(plan.steps.map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepStrictEqual(plan.steps[0].dependsOn, []);
  assert.deepStrictEqual(plan.steps[1].dependsOn, ['s1']);
  assert.deepStrictEqual(plan.steps[2].dependsOn, ['s2']);
});

test('parallel mode produces no dependency edges', () => {
  const plan = buildOrchestrationPlan({
    mode: 'parallel',
    steps: [{ prompt: 'a' }, { prompt: 'b' }],
  });
  assert.strictEqual(plan.mode, 'parallel');
  assert.ok(plan.steps.every((s) => s.dependsOn.length === 0));
});

test('phase mode makes each phase depend on ALL steps of the previous phase', () => {
  const plan = buildOrchestrationPlan({
    mode: 'phase',
    phases: [
      { name: 'research', steps: [{ prompt: 'r1' }, { prompt: 'r2' }] },
      { name: 'build', steps: [{ prompt: 'b1' }] },
      { name: 'verify', steps: [{ prompt: 'v1' }, { prompt: 'v2' }] },
    ],
  });
  assert.strictEqual(plan.stepCount, 5);
  // phase 0 steps: no deps
  assert.deepStrictEqual(plan.steps[0].dependsOn, []);
  assert.deepStrictEqual(plan.steps[1].dependsOn, []);
  // phase 1 (b1=s3) depends on both phase-0 steps s1,s2
  assert.deepStrictEqual(plan.steps[2].dependsOn, ['s1', 's2']);
  // phase 2 (v1=s4, v2=s5) depend on phase-1 step s3
  assert.deepStrictEqual(plan.steps[3].dependsOn, ['s3']);
  assert.deepStrictEqual(plan.steps[4].dependsOn, ['s3']);
  assert.strictEqual(plan.steps[0].phaseName, 'research');
  assert.strictEqual(plan.steps[2].phaseIndex, 1);
});

test('step normalization: role default, subagent_type and model carried', () => {
  const plan = buildOrchestrationPlan({
    mode: 'parallel',
    steps: [
      { prompt: ' explore the repo ', subagent_type: 'Explore', model: 'claude-opus-4-8' },
      { prompt: 'x', role: 'verify' },
    ],
  });
  assert.strictEqual(plan.steps[0].prompt, 'explore the repo');
  assert.strictEqual(plan.steps[0].role, 'general');
  assert.strictEqual(plan.steps[0].subagentType, 'Explore');
  assert.strictEqual(plan.steps[0].model, 'claude-opus-4-8');
  assert.strictEqual(plan.steps[1].role, 'verify');
  assert.strictEqual(plan.steps[1].subagentType, undefined);
});

test('defensive: bad mode / empty steps / missing prompt throw clear errors', () => {
  assert.throws(() => buildOrchestrationPlan(null), /spec must be an object/);
  assert.throws(() => buildOrchestrationPlan({ mode: 'nope', steps: [{ prompt: 'a' }] }), /mode must be one of/);
  assert.throws(() => buildOrchestrationPlan({ mode: 'sequential', steps: [] }), /non-empty "steps"/);
  assert.throws(() => buildOrchestrationPlan({ mode: 'phase', phases: [] }), /non-empty "phases"/);
  assert.throws(() => buildOrchestrationPlan({ mode: 'phase', phases: [{ steps: [] }] }), /non-empty "steps"/);
  assert.throws(() => buildOrchestrationPlan({ mode: 'parallel', steps: [{ role: 'x' }] }), /missing a non-empty "prompt"/);
  assert.deepStrictEqual(VALID_MODES.slice().sort(), ['parallel', 'phase', 'sequential']);
});

test('summarizePlanProgress counts done/failed/running/pending', () => {
  const plan = buildOrchestrationPlan({
    mode: 'parallel',
    steps: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }, { prompt: 'd' }],
  });
  const prog = summarizePlanProgress(plan, { s1: 'done', s2: 'blocked', s3: 'running' });
  assert.deepStrictEqual(prog, { total: 4, done: 1, failed: 1, running: 1, pending: 1 });
  // empty / null plan is safe
  assert.deepStrictEqual(summarizePlanProgress(null, {}), { total: 0, done: 0, failed: 0, running: 0, pending: 0 });
});
