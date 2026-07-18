'use strict';

/**
 * replayHandlerAi.test.js — DESIGN-ARCH-049 G4 (AI replay CLI wiring).
 *
 * Verifies the `khy replay run` handler gates the AI repair bridge correctly:
 *   - without --ai and with KHY_TRAJ_AI_REPLAY off, no AI line is printed and the
 *     run reproduces deterministically (pure 048 path);
 *   - with --ai the "AI 修桥已启用" banner appears and the run still completes
 *     (a FILE step is reproduced deterministically; the hook is constructed but
 *     never invoked, so no model is needed);
 *   - the env knob KHY_TRAJ_AI_REPLAY=on enables the banner without the flag.
 *
 * KHY_PROJECT_DATA_HOME / write roots set before requiring funnel modules.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g4-home-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DEP_HEALING = 'off';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g4-work-'));
process.env.KHY_WRITE_EXTRA_ROOTS = WORK;
delete process.env.KHY_TRAJ_AI_REPLAY;

const { handleReplay } = require('../../../src/cli/handlers/replay');
const replayLedger = require('../../../src/services/trajectoryReplay/replayLedger');

async function capture(fn) {
  const lines = [];
  const sinks = ['log', 'error', 'warn', 'info'];
  const orig = {};
  for (const s of sinks) { orig[s] = console[s]; console[s] = (...a) => lines.push(a.join(' ')); }
  try { await fn(); } finally { for (const s of sinks) console[s] = orig[s]; }
  return lines.join('\n');
}

function recordWrite(sessionId, absPath, content) {
  replayLedger.recordToolTurn({
    sessionId,
    name: 'write_file',
    params: { path: absPath, content },
    result: { success: true },
    writeDiff: { filePath: absPath, beforeContent: '', afterContent: content },
  });
}

function seed(sessionId, name) {
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, name);
  recordWrite(sessionId, target, 'g4-content');
  return target;
}

test('without --ai (env off): no AI banner, deterministic reproduction', async () => {
  delete process.env.KHY_TRAJ_AI_REPLAY;
  const target = seed('g4-off', 'g4-off.txt');
  await capture(() => handleReplay('export', ['g4-off'], {}));
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const out = await capture(() => handleReplay('run', ['g4-off'], { force: true }));
  assert.doesNotMatch(out, /AI 修桥已启用/);
  assert.match(out, /回放完成/);
  assert.ok(fs.existsSync(target));
});

test('with --ai: AI banner shown, run still completes for a FILE step', async () => {
  delete process.env.KHY_TRAJ_AI_REPLAY;
  const target = seed('g4-flag', 'g4-flag.txt');
  await capture(() => handleReplay('export', ['g4-flag'], {}));
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const out = await capture(() => handleReplay('run', ['g4-flag'], { force: true, ai: true }));
  assert.match(out, /AI 修桥已启用/);
  assert.match(out, /回放完成/);
  assert.ok(fs.existsSync(target));
});

test('KHY_TRAJ_AI_REPLAY=on enables the banner without the flag', async () => {
  const target = seed('g4-env', 'g4-env.txt');
  await capture(() => handleReplay('export', ['g4-env'], {}));
  if (fs.existsSync(target)) fs.unlinkSync(target);

  process.env.KHY_TRAJ_AI_REPLAY = 'on';
  try {
    const out = await capture(() => handleReplay('run', ['g4-env'], { force: true }));
    assert.match(out, /AI 修桥已启用/);
    assert.match(out, /回放完成/);
  } finally {
    delete process.env.KHY_TRAJ_AI_REPLAY;
  }
});
