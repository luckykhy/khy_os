'use strict';

/**
 * Tests for the s13 gap-closure:
 *   (1) shellCommand `run_in_background` — slow shell commands dispatch detached
 *       and flow back through the same collectBackgroundResults() →
 *       <task_notification> keystone used by background sub-agents.
 *   (2) spawnWithIdleTimeout interactive-prompt watchdog — an idle stall that is
 *       actually a child waiting on (y/n)/password input is surfaced with a
 *       precise, actionable reason instead of a silent generic kill.
 */

const assert = require('assert');

const {
  spawnWithIdleTimeout,
  detectInteractivePrompt,
} = require('../src/utils/spawnWithIdleTimeout');
const shellCommand = require('../src/tools/shellCommand');
const backgroundShellRegistry = require('../src/tools/backgroundShellRegistry');

const NODE = process.execPath;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('s13 gap — detectInteractivePrompt', () => {
  test('detects common confirmation prompts', () => {
    assert.ok(detectInteractivePrompt('Proceed? (y/n) '));
    assert.ok(detectInteractivePrompt('Overwrite existing file? [Y/n]'));
    assert.ok(detectInteractivePrompt('Are you sure you want to continue?'));
    assert.ok(detectInteractivePrompt('Password: '));
    assert.ok(detectInteractivePrompt('Do you want to remove it?'));
    assert.ok(detectInteractivePrompt('Press any key to continue . . .'));
    assert.ok(detectInteractivePrompt('Continue (yes/no)?'));
  });

  test('detects the prompt even with leading log noise', () => {
    const log = 'Resolving deps...\nDownloading...\nThis will modify 12 files. Continue? (y/n) ';
    assert.ok(detectInteractivePrompt(log));
  });

  test('does NOT fire on ordinary output', () => {
    assert.ok(!detectInteractivePrompt('Build succeeded in 4.2s'));
    assert.ok(!detectInteractivePrompt('Installed 120 packages'));
    assert.ok(!detectInteractivePrompt('All tests passed'));
    assert.ok(!detectInteractivePrompt(''));
    assert.ok(!detectInteractivePrompt(null));
  });
});

describe('s13 gap — spawnWithIdleTimeout interactive watchdog', () => {
  test('an interactive prompt followed by silence rejects with interactive=true', async () => {
    // Print a prompt, then go silent forever — the watchdog must classify it.
    const script = 'process.stdout.write("Continue? (y/n) "); setInterval(() => {}, 1000);';
    let err;
    try {
      await spawnWithIdleTimeout(NODE, ['-e', script], { idleMs: 400, label: 'prompttest' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected the watchdog to reject');
    assert.strictEqual(err.interactive, true);
    assert.ok(/交互输入/.test(err.message), `message should mention interactive input: ${err.message}`);
  });

  test('a plain silent stall rejects with interactive=false', async () => {
    const script = 'setInterval(() => {}, 1000);'; // never writes anything
    let err;
    try {
      await spawnWithIdleTimeout(NODE, ['-e', script], { idleMs: 400, label: 'stalltest' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected the watchdog to reject');
    assert.strictEqual(err.interactive, false);
    assert.ok(/空闲超时/.test(err.message), `message should be a generic idle timeout: ${err.message}`);
  });

  test('a productive process that finishes is not killed', async () => {
    const script = 'process.stdout.write("hello"); process.exit(0);';
    const result = await spawnWithIdleTimeout(NODE, ['-e', script], { idleMs: 1000, label: 'oktest' });
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('hello'));
  });
});

describe('s13 gap — shellCommand run_in_background', () => {
  afterEach(() => {
    try { backgroundShellRegistry.backgroundShells.clear(); } catch { /* ignore */ }
  });

  test('exposes the collectBackgroundResults contract', () => {
    assert.strictEqual(typeof backgroundShellRegistry.collectBackgroundResults, 'function');
    assert.ok(Array.isArray(backgroundShellRegistry.collectBackgroundResults()));
  });

  test('returns immediately with a backgroundTaskId and does not block', async () => {
    const res = await shellCommand.execute({ command: 'echo bg-marker', run_in_background: true });
    assert.strictEqual(res.success, true);
    assert.ok(/^bgsh-/.test(res.backgroundTaskId), `expected a bgsh- id, got ${res.backgroundTaskId}`);
    assert.ok(/task_notification/.test(res.output), 'output should explain the notification flow');
  });

  test('a finished background command drains as a <task_notification> descriptor', async () => {
    const res = await shellCommand.execute({ command: 'echo bg-done', run_in_background: true });
    const id = res.backgroundTaskId;

    // Wait for the detached command to finish (echo is near-instant).
    let drained = [];
    for (let i = 0; i < 50 && drained.length === 0; i++) {
      await sleep(40);
      drained = backgroundShellRegistry.collectBackgroundResults();
    }
    assert.strictEqual(drained.length, 1, 'expected exactly one drained completion');
    assert.strictEqual(drained[0].taskId, id);
    assert.strictEqual(drained[0].status, 'completed');
    assert.strictEqual(drained[0].command, 'echo bg-done', 'descriptor must carry the shell command');
    assert.ok(drained[0].summary.includes('bg-done'), `summary should include output: ${drained[0].summary}`);

    // One-shot: a second drain must not re-emit the same completion.
    assert.deepStrictEqual(backgroundShellRegistry.collectBackgroundResults(), []);
  });

  test('a failing background command drains as failed', async () => {
    const res = await shellCommand.execute({
      command: 'node -e "process.exit(3)"',
      run_in_background: true,
    });
    const id = res.backgroundTaskId;
    let drained = [];
    for (let i = 0; i < 50 && drained.length === 0; i++) {
      await sleep(40);
      drained = backgroundShellRegistry.collectBackgroundResults();
    }
    assert.strictEqual(drained.length, 1);
    assert.strictEqual(drained[0].taskId, id);
    assert.strictEqual(drained[0].status, 'failed');
  });
});
