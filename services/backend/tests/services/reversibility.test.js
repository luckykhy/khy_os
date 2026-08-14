'use strict';

/**
 * reversibility.test.js — Phase A of the CB-SSP redesign (design doc §1.3 / §4.A).
 *
 * Asserts the mathematical / structural properties the design doc requires of
 * the reversibility layering:
 *   1. Classification A_safe (read-only/reversible) vs A_commit (irreversible).
 *   2. Speculation guard: under a speculative context only A_safe may run; any
 *      A_commit action is refused — "任何不可逆动作绝不被投机执行".
 *   3. Bounded read-only lookahead: beam width k clamped to <= 3, commits filtered.
 *   4. Budget conservation at executeTool: a speculative commit is blocked BEFORE
 *      the handler runs (no side effect, no irreversible-step budget consumed),
 *      while the normal (non-speculative) path and read-only speculation proceed.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  classifyAction,
  isReversible,
  speculationGuard,
  resolveReversibility,
  boundedReadOnlyLookahead,
  lookaheadWidth,
} = require('../../src/services/reversibility');

describe('classifyAction: A_safe vs A_commit', () => {
  test('read-only & non-destructive is safe', () => {
    expect(classifyAction({ isReadOnly: true, isDestructive: false })).toBe('safe');
    expect(isReversible({ isReadOnly: true })).toBe(true);
  });

  test('destructive is always commit, even if flagged read-only', () => {
    expect(classifyAction({ isReadOnly: true, isDestructive: true })).toBe('commit');
  });

  test('writes / unknown actions default to commit (never speculate on the unknown)', () => {
    expect(classifyAction({ isReadOnly: false })).toBe('commit');
    expect(classifyAction({})).toBe('commit');
    expect(classifyAction()).toBe('commit');
  });
});

describe('speculationGuard: irreversible never runs speculatively', () => {
  test('blocks a commit action under speculation', () => {
    const r = speculationGuard({ isReadOnly: false }, true);
    expect(r).not.toBeNull();
    expect(r.blocked).toBe(true);
    expect(r.error).toMatch(/A_commit|speculativ/i);
  });

  test('allows a read-only action under speculation', () => {
    expect(speculationGuard({ isReadOnly: true }, true)).toBeNull();
  });

  test('non-speculative commit is always allowed (default path untouched)', () => {
    expect(speculationGuard({ isReadOnly: false }, false)).toBeNull();
    expect(speculationGuard({ isDestructive: true }, false)).toBeNull();
  });
});

describe('resolveReversibility: grounded in the real tool registry', () => {
  test('a real read-only tool resolves to safe', () => {
    expect(classifyAction(resolveReversibility('readFile', { file_path: '/tmp/x' }, {}))).toBe('safe');
  });

  test('a real write tool resolves to commit', () => {
    expect(classifyAction(resolveReversibility('writeFile', { file_path: '/tmp/x' }, {}))).toBe('commit');
  });

  test('falls back to the supplied assessment when the registry has no tool', () => {
    const rev = resolveReversibility('__no_such_tool__', {}, { isReadOnly: true, isDestructive: false });
    expect(rev.isReadOnly).toBe(true);
  });
});

describe('boundedReadOnlyLookahead: beam width <= 3, commits filtered', () => {
  test('keeps only A_safe candidates', () => {
    const cands = [
      { isReadOnly: true }, { isReadOnly: false }, { isReadOnly: true }, { isDestructive: true },
    ];
    const kept = boundedReadOnlyLookahead(cands, { width: 10 });
    expect(kept).toHaveLength(2);
    expect(kept.every(isReversible)).toBe(true);
  });

  test('caps the beam at width 3 even when more safe candidates exist', () => {
    const safe = Array.from({ length: 8 }, () => ({ isReadOnly: true }));
    expect(boundedReadOnlyLookahead(safe, { width: 8 })).toHaveLength(3);
    expect(boundedReadOnlyLookahead(safe)).toHaveLength(Math.min(3, lookaheadWidth()));
  });

  test('lookaheadWidth is clamped to [0, 3] regardless of env', () => {
    const prev = process.env.KHY_LOOKAHEAD_WIDTH;
    process.env.KHY_LOOKAHEAD_WIDTH = '99';
    expect(lookaheadWidth()).toBe(3);
    process.env.KHY_LOOKAHEAD_WIDTH = '-5';
    expect(lookaheadWidth()).toBe(0);
    if (prev === undefined) delete process.env.KHY_LOOKAHEAD_WIDTH;
    else process.env.KHY_LOOKAHEAD_WIDTH = prev;
  });
});

describe('executeTool integration: budget conservation under speculation', () => {
  const toolCalling = require('../../src/services/toolCalling');
  const TOOL = '__spec_destructive_probe__';
  let handlerCalls = 0;

  beforeAll(() => {
    toolCalling.registerTool({
      name: TOOL,
      description: 'test-only destructive probe',
      risk: 'safe', // auto-approve so the non-speculative path reaches the handler
      handler: async () => { handlerCalls++; return { success: true, output: 'ran' }; },
    });
  });

  beforeEach(() => { handlerCalls = 0; });

  test('a speculative commit is refused BEFORE the handler runs (no side effect)', async () => {
    const res = await toolCalling.executeTool(TOOL, { x: 1 }, { speculative: true });
    expect(res._speculativeBlocked).toBe(true);
    expect(res.success).toBe(false);
    expect(handlerCalls).toBe(0); // never executed → no world change, no budget spent
  });

  test('the normal (non-speculative) path is unaffected — handler runs', async () => {
    const res = await toolCalling.executeTool(TOOL, { x: 1 }, {});
    expect(res.success).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  test('a real read-only tool IS allowed to run speculatively', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-spec-')), 'f.txt');
    fs.writeFileSync(tmp, 'hello speculation', 'utf-8');
    const res = await toolCalling.executeTool('readFile', { file_path: tmp }, { speculative: true });
    expect(res._speculativeBlocked).toBeUndefined();
    try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
