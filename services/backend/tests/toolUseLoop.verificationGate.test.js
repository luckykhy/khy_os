'use strict';

/**
 * Stage 6 — hard verification gate.
 *
 * When the model concludes after successful edits, the loop must run a
 * syntax + adversarial verification pass and, on FAIL, force another
 * iteration (bounded by KHY_VERIFY_MAX_ROUNDS) instead of ending silently.
 *
 * The PreToolUse "prior-read" guard is disabled here by mocking the hook
 * system to register zero hooks — this test exercises the gate, not the
 * guards — so edits run straight through the mocked executeTool.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BROKEN = 'const x = ;\n';
const FIXED = 'const x = 1;\n';

function tmpJs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-verifygate-'));
  const file = path.join(dir, 'mod.js');
  fs.writeFileSync(file, BROKEN, 'utf-8');
  return { dir, file };
}

function disableHooks() {
  jest.doMock('../src/cli/hooks/hookSystem', () => ({
    isInitialized: () => true,
    init: () => {},
    registry: { count: 0 }, // → _getHookSystem() returns null, no PreToolUse guard
    trigger: async () => ({ blocked: false }),
  }));
}

function mockToolCalling(file, onEdit) {
  jest.doMock('../src/services/toolCalling', () => ({
    setPreflightContext: jest.fn(),
    executeTool: jest.fn(async (name) => {
      if (/^(editFile|edit_file|edit|write_file|writeFile)$/i.test(name)) {
        onEdit();
        return { success: true, file };
      }
      return { success: true, output: 'ok' };
    }),
  }));
}

// Each block carries distinct input so the loop's duplicate-tool-call
// detection doesn't skip the re-edit forced by the gate.
const editBlock = (file, id) => ({ name: 'editFile', input: { file_path: file, old_string: `old_${id}`, new_string: `new_${id}` }, id });

describe('toolUseLoop hard verification gate', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.KHY_VERIFY_MAX_ROUNDS;
    delete process.env.KHY_VERIFY_GATE;
  });

  test('FAIL forces another iteration, then PASS lets the turn conclude', async () => {
    const { dir, file } = tmpJs();

    let edits = 0;
    disableHooks();
    mockToolCalling(file, () => {
      edits++;
      fs.writeFileSync(file, edits === 1 ? BROKEN : FIXED, 'utf-8'); // first stays broken, second fixes
    });

    const toolUseLoop = require('../src/services/toolUseLoop');

    let turn = 0;
    const chat = jest.fn(async (_msg, opts = {}) => {
      if (opts._verificationProbe) {
        return { reply: 'Command run: node -c mod.js\nResult: PASS\nVERDICT: PASS', provider: 'mock' };
      }
      turn++;
      if (turn === 1) return { reply: 'editing', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [editBlock(file, 'e1')] };
      if (turn === 2) return { reply: 'done', provider: 'mock' };  // conclude #1 → syntax FAIL → forced continue
      if (turn === 3) return { reply: 'fixing', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [editBlock(file, 'e2')] };
      return { reply: 'all done', provider: 'mock' };              // conclude #2 → syntax PASS + adversarial PASS
    });

    const result = await toolUseLoop.runToolUseLoop('fix the module', {
      chat,
      chatOpts: { cwd: dir },
      maxIterations: 12,
      sessionId: 's1',
      requestId: 'r1',
    });

    expect(edits).toBeGreaterThanOrEqual(2);                  // gate forced the re-edit
    expect(turn).toBe(4);                                     // edit, conclude-fail, edit, conclude-pass
    expect(result.finalResponse).not.toContain('验证未通过');  // concluded cleanly
    expect(fs.readFileSync(file, 'utf-8')).toBe(FIXED);
  }, 30000);

  test('reaching the retry ceiling concludes with an annotation (no deadlock)', async () => {
    process.env.KHY_VERIFY_MAX_ROUNDS = '1';
    const { dir, file } = tmpJs();

    disableHooks();
    mockToolCalling(file, () => fs.writeFileSync(file, BROKEN, 'utf-8')); // never fixed

    const toolUseLoop = require('../src/services/toolUseLoop');

    let turn = 0;
    const chat = jest.fn(async (_msg, opts = {}) => {
      if (opts._verificationProbe) return { reply: 'VERDICT: FAIL', provider: 'mock' };
      turn++;
      if (turn === 1 || turn === 3) return { reply: 'editing', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [editBlock(file, `e${turn}`)] };
      return { reply: 'done', provider: 'mock' }; // conclude attempts (turn 2 = round 1 fail, turn 4 = ceiling)
    });

    const result = await toolUseLoop.runToolUseLoop('fix the module', {
      chat,
      chatOpts: { cwd: dir },
      maxIterations: 14,
      sessionId: 's2',
      requestId: 'r2',
    });

    expect(result.finalResponse).toContain('验证未通过'); // ceiling annotation present
  }, 30000);
});
