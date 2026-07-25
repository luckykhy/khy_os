'use strict';

/**
 * decideAutoFixApproval — pure decision for how /review obtains auto-fix
 * approval. Regression for the "/review topples the Ink TUI" bug: under the
 * Ink TUI ink owns stdin in raw mode, yet stdin.isTTY is still true, so the
 * old non-TTY guard did not catch it and the handler called inquirer.prompt,
 * which fought ink for stdin and exited the whole UI. The 'tui' decision MUST
 * be reached BEFORE any inquirer path so the prompt is never constructed.
 */

const path = require('path');
const review = require('../../src/cli/handlers/review');
const { decideAutoFixApproval } = review;

describe('decideAutoFixApproval', () => {
  test('autoApprove wins over everything', () => {
    expect(decideAutoFixApproval({ autoApprove: true, inkActive: true, stdinTTY: true, stdoutTTY: true }))
      .toBe('auto');
  });

  test('Ink TUI active → tui (default-allow, never inquirer) even with a TTY', () => {
    expect(decideAutoFixApproval({ autoApprove: false, inkActive: true, stdinTTY: true, stdoutTTY: true }))
      .toBe('tui');
  });

  test('non-TTY pipe → non-tty default-allow', () => {
    expect(decideAutoFixApproval({ autoApprove: false, inkActive: false, stdinTTY: false, stdoutTTY: true }))
      .toBe('non-tty');
    expect(decideAutoFixApproval({ autoApprove: false, inkActive: false, stdinTTY: true, stdoutTTY: false }))
      .toBe('non-tty');
  });

  test('interactive classic REPL → prompt (inquirer)', () => {
    expect(decideAutoFixApproval({ autoApprove: false, inkActive: false, stdinTTY: true, stdoutTTY: true }))
      .toBe('prompt');
  });

  test('only the classic-REPL path ever reaches inquirer', () => {
    const cases = [
      { autoApprove: true, inkActive: false, stdinTTY: true, stdoutTTY: true },
      { autoApprove: false, inkActive: true, stdinTTY: true, stdoutTTY: true },
      { autoApprove: false, inkActive: false, stdinTTY: false, stdoutTTY: false },
    ];
    for (const c of cases) {
      expect(decideAutoFixApproval(c)).not.toBe('prompt');
    }
  });
});

describe('review.js does not eagerly require inquirer at module load', () => {
  test('inquirer is only required lazily inside the prompt branch', () => {
    // Module-load must not pull in inquirer — it is required lazily only on the
    // classic-REPL prompt path. This keeps the TUI/non-TTY paths free of any
    // readline that could grab stdin.
    const src = require('fs').readFileSync(
      path.join(__dirname, '../../src/cli/handlers/review.js'), 'utf8');
    // The single require must sit inside the else (prompt) branch, not at top.
    const topOfFile = src.slice(0, src.indexOf('function decideAutoFixApproval'));
    expect(topOfFile).not.toMatch(/require\(['"]inquirer['"]\)/);
  });
});
