'use strict';

/**
 * aiBridge.test.js — DESIGN-ARCH-049 G3 (AI repair hook).
 *
 * The hook drives an injected AgentTool stub (no real model). Verifies:
 *   - it builds a tightly-scoped prompt naming the target path + required sha256
 *     and forbidding hash-forcing;
 *   - it returns the structured {attempted, ok, reason, agent} contract;
 *   - per-seq cap enforces one attempt (KHY_TRAJ_REPAIR_MAX=1, mirrors MAX_LOOP=1);
 *   - onControlRequest is forwarded into the sub-agent's traceContext;
 *   - an AgentTool throw is caught (never propagates out of the hook).
 *
 * End-to-end with the engine (G2 seam): the stub writes the artifact, the engine
 * re-verifies the recorded sha256 and records 'repaired'.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g3-home-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DEP_HEALING = 'off';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g3-work-'));
process.env.KHY_WRITE_EXTRA_ROOTS = WORK;
process.env.KHY_TRAJ_REPAIR_MAX = '1';

const aiBridge = require('../../../src/services/trajectoryGuide/aiBridge');
const replayEngine = require('../../../src/services/trajectoryReplay/replayEngine');
const artifactHash = require('../../../src/services/trajectoryReplay/artifactHash');

function step(target, content, seq = 0) {
  const sha256 = artifactHash.sha256Hex(content);
  return {
    seq,
    name: 'write_file',
    tier: 'NETWORK_AI',
    params: { path: target, content },
    writeDiff: { filePath: target, beforeHash: null, afterHash: sha256 },
    artifacts: [{ path: target, sha256, op: 'create' }],
  };
}

test('prompt names the target path + required hash and forbids hash-forcing', () => {
  const s = step('/abs/out.txt', 'hello');
  const prompt = aiBridge._buildRepairPrompt(s, 'network_ai');
  assert.match(prompt, /\/abs\/out\.txt/);
  assert.match(prompt, new RegExp(artifactHash.sha256Hex('hello')));
  assert.match(prompt, /do NOT/);
  assert.match(prompt, /sole success criterion/);
});

test('hook returns the structured contract and forwards onControlRequest', async () => {
  const target = path.join(WORK, 'g3-ok.txt');
  const content = 'g3-bridged';
  if (fs.existsSync(target)) fs.unlinkSync(target);

  let seenContext = null;
  let seenParams = null;
  const stub = {
    async execute(params, context) {
      seenParams = params;
      seenContext = context;
      // Perform the recorded operation; do NOT touch any hash.
      fs.writeFileSync(target, content);
      return { success: true, output: 'done', toolCalls: 1 };
    },
  };
  const sentinel = async () => ({ behavior: 'allow' });
  const hook = aiBridge.createRepairHook({ agentTool: stub, onControlRequest: sentinel });

  const out = await hook(step(target, content), { kind: 'network_ai' });
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, true);
  assert.ok(out.agent && out.agent.success);
  assert.strictEqual(seenParams.subagent_type, 'verify');
  assert.strictEqual(seenContext.traceContext.onControlRequest, sentinel);
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), content);
});

test('per-seq cap enforces a single attempt (MAX_LOOP=1)', async () => {
  let calls = 0;
  const stub = { async execute() { calls += 1; return { success: false, error: 'nope' }; } };
  const hook = aiBridge.createRepairHook({ agentTool: stub });
  const s = step('/tmp/whatever.txt', 'x', 7);

  const first = await hook(s, { kind: 'exec' });
  const second = await hook(s, { kind: 'exec' });
  assert.strictEqual(calls, 1, 'agent invoked at most once for the same seq');
  assert.strictEqual(first.attempted, true);
  assert.strictEqual(second.attempted, false);
  assert.match(second.reason, /budget exhausted/);
});

test('an AgentTool throw is caught and surfaced, never propagated', async () => {
  const stub = { async execute() { throw new Error('kaboom'); } };
  const hook = aiBridge.createRepairHook({ agentTool: stub });
  const out = await hook(step('/tmp/z.txt', 'z'), { kind: 'post-verify' });
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /repair agent error: kaboom/);
});

test('end-to-end: hook + engine reproduce a deleted artifact and verify the hash', async () => {
  const target = path.join(WORK, 'g3-e2e.txt');
  const content = 'g3-e2e-bytes';
  const sha256 = artifactHash.sha256Hex(content);
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const stub = {
    async execute() { fs.writeFileSync(target, content); return { success: true }; },
  };
  const hook = aiBridge.createRepairHook({ agentTool: stub });

  const manifest = {
    v: 1, kind: 'khyos-replay-bundle', sessionId: 'g3', env: null,
    steps: [{
      seq: 0, name: 'write_file', tier: 'NETWORK_AI',
      params: { path: target, content },
      writeDiff: { filePath: target, beforeHash: null, afterHash: sha256 },
      artifacts: [{ path: target, sha256, op: 'create' }],
    }],
  };

  const report = await replayEngine.replay(manifest, { force: true, repair: hook });
  assert.strictEqual(report.status, 'completed');
  assert.strictEqual(report.summary.repaired, 1);
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), content);
});
