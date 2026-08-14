'use strict';

/**
 * replayHandler.test.js — DESIGN-ARCH-048 PHASE 5 (`khy replay` CLI).
 *
 * Verifies the handler dispatches its four subcommands, that the command schema
 * advertises `replay` with its subcommands, and that an unknown / empty session
 * yields a friendly message instead of crashing. The handler is exercised end to
 * end against a real exported bundle produced through the replay ledger (no AI).
 *
 * KHY_PROJECT_DATA_HOME / write roots are set before requiring funnel modules.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p5-home-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DEP_HEALING = 'off';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p5-work-'));
process.env.KHY_WRITE_EXTRA_ROOTS = WORK;

const { handleReplay } = require('../../../src/cli/handlers/replay');
const replayLedger = require('../../../src/services/trajectoryReplay/replayLedger');
const replayBundle = require('../../../src/services/trajectoryReplay/replayBundle');
const commandSchema = require('../../../src/constants/commandSchema');

/** Capture console.log/error output emitted during fn(). */
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

test('command schema advertises replay with its subcommands', () => {
  assert.ok(commandSchema.getRouterCommandNames().includes('replay'));
  const subs = commandSchema.getRouterSubCommands().replay;
  assert.deepStrictEqual(subs.sort(), ['export', 'list', 'run', 'verify']);
});

test('unknown subcommand is reported, not thrown', async () => {
  const out = await capture(() => handleReplay('bogus', [], {}));
  assert.match(out, /未知子命令/);
});

test('list with no replay ledgers is friendly, not a crash', async () => {
  const out = await capture(() => handleReplay('list', [], {}));
  // Either no sessions at all or none with a ledger — both are friendly text.
  assert.match(out, /暂无/);
});

test('export of a session with no ledger warns instead of crashing', async () => {
  const out = await capture(() => handleReplay('export', ['no-such-session'], {}));
  assert.match(out, /无回放账本|未找到/);
});

test('export → verify → run reproduces a deleted artifact through the CLI', async () => {
  const sessionId = 'p5-cli';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'cli-artifact.txt');
  recordWrite(sessionId, target, 'cli-content');

  // export
  const exportOut = await capture(() => handleReplay('export', [sessionId], {}));
  assert.match(exportOut, /回放包已导出/);
  const bundleDir = replayBundle.bundleDirFor(sessionId);
  assert.ok(fs.existsSync(path.join(bundleDir, 'manifest.json')));

  // verify
  const verifyOut = await capture(() => handleReplay('verify', [sessionId], {}));
  assert.match(verifyOut, /完整/);

  // delete (if present), then run reproduces from the content store
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const runOut = await capture(() => handleReplay('run', [sessionId], { force: true }));
  assert.match(runOut, /回放完成/);
  assert.ok(fs.existsSync(target));
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'cli-content');
});

test('run halts visibly on a tampered bundle (diverged)', async () => {
  const sessionId = 'p5-diverge';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'cli-diverge.txt');
  recordWrite(sessionId, target, 'genuine');
  await capture(() => handleReplay('export', [sessionId], {}));

  // Tamper the recorded hash inside the exported manifest.
  const bundleDir = replayBundle.bundleDirFor(sessionId);
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  m.steps[0].artifacts[0].sha256 = 'f'.repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(m));

  if (fs.existsSync(target)) fs.unlinkSync(target);
  const out = await capture(() => handleReplay('run', [sessionId], { force: true }));
  assert.match(out, /分歧|HALT/);
});
