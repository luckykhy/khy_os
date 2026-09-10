'use strict';

/**
 * Tests for the s13 gap-closure:
 *   (1) shellCommand `run_in_background` â€?slow shell commands dispatch detached
 *       and flow back through the same collectBackgroundResults() â†?
 *       <task_notification> keystone used by background sub-agents.
 *   (2) spawnWithIdleTimeout interactive-prompt watchdog â€?an idle stall that is
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

describe('s13 gap â€?detectInteractivePrompt', () => {
  test('detects common confirmation prompts', () => {
    expect(detectInteractivePrompt('Proceed? (y/n) ')).toBe();
    expect(detectInteractivePrompt('Overwrite existing file? [Y/n]')).toBe();
    expect(detectInteractivePrompt('Are you sure you want to continue?')).toBe();
    expect(detectInteractivePrompt('Password: ')).toBe();
    expect(detectInteractivePrompt('Do you want to remove it?')).toBe();
    expect(detectInteractivePrompt('Press any key to continue . . .')).toBe();
    expect(detectInteractivePrompt('Continue (yes/no)?')).toBe();
  });

  test('detects the prompt even with leading log noise', () => {
    const log = 'Resolving deps...\nDownloading...\nThis will modify 12 files. Continue? (y/n) ';
    expect(detectInteractivePrompt(log)).toBe();
  });

  test('does NOT fire on ordinary output', () => {
    expect(!detectInteractivePrompt('Build succeeded in 4.2s')).toBe();
    expect(!detectInteractivePrompt('Installed 120 packages')).toBe();
    expect(!detectInteractivePrompt('All tests passed')).toBe();
    expect(!detectInteractivePrompt('')).toBe();
    expect(!detectInteractivePrompt(null)).toBe();
  });
});

describe('s13 gap â€?spawnWithIdleTimeout interactive watchdog', () => {
  test('an interactive prompt followed by silence rejects with interactive=true', async () => {
    // Print a prompt, then go silent forever â€?the watchdog must classify it.
    const script = 'process.stdout.write("Continue? (y/n) "); setInterval(() => {}, 1000);';
    let err;
    try {
      await spawnWithIdleTimeout(NODE, ['-e', script], { idleMs: 400, label: 'prompttest' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.interactive).toBe(true);
    expect(/äº¤äº’è¾“å…¥/.test(err.message)).toBe();
  });

  test('a plain silent stall rejects with interactive=false', async () => {
    const script = 'setInterval(() => {}, 1000);'; // never writes anything
    let err;
    try {
      await spawnWithIdleTimeout(NODE, ['-e', script], { idleMs: 400, label: 'stalltest' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.interactive).toBe(false);
    expect(/ç©ºé—²è¶…æ—¶/.test(err.message)).toBe();
  });

  test('a productive process that finishes is not killed', async () => {
    const script = 'process.stdout.write("hello"); process.exit(0);';
    const result = await spawnWithIdleTimeout(NODE, ['-e', script], { idleMs: 1000, label: 'oktest' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('hello');
  });
});

describe('s13 gap â€?shellCommand run_in_background', () => {
  afterEach(() => {
    try { backgroundShellRegistry.backgroundShells.clear(); } catch { /* ignore */ }
  });

  test('exposes the collectBackgroundResults contract', () => {
    expect(typeof backgroundShellRegistry.collectBackgroundResults).toBe('function');
    expect(Array.isArray(backgroundShellRegistry.collectBackgroundResults())).toBe();
  });

  test('returns immediately with a backgroundTaskId and does not block', async () => {
    const res = await shellCommand.execute({ command: 'echo bg-marker', run_in_background: true });
    expect(res.success).toBe(true);
    expect(/^bgsh-/.test(res.backgroundTaskId)).toBe();
    expect(/task_notification/.test(res.output)).toBe();
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
    expect(drained.length).toBe(1);
    expect(drained[0].taskId).toBe(id);
    expect(drained[0].status).toBe('completed');
    expect(drained[0].command).toBe('echo bg-done');
    expect(drained[0].summary).toContain('bg-done');

    // One-shot: a second drain must not re-emit the same completion.
    expect(backgroundShellRegistry.collectBackgroundResults()).toBe([]);
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
    expect(drained.length).toBe(1);
    expect(drained[0].taskId).toBe(id);
    expect(drained[0].status).toBe('failed');
  });
});

