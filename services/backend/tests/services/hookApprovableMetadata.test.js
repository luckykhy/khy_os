'use strict';

/**
 * Tests that a function guard's `approvable`/`source` metadata survives the
 * hookRunner block path (previously only `reason` did), so downstream callers
 * can turn a soft block into a user approval.
 */

const { runHooks } = require('../../src/cli/hooks/hookRunner');

function fnHook(handler, source = 'test:guard') {
  return { type: 'function', handler, timeout: 1000, source };
}

describe('hookRunner — approvable block metadata pass-through', () => {
  test('approvable block carries approvable=true and source to hr', async () => {
    const hooks = [fnHook(() => ({
      action: 'block', reason: 'outside root',
      approvable: true, source: 'EditBoundaryGuard',
    }))];
    const hr = await runHooks(hooks, { toolName: 'write_file' });
    expect(hr.blocked).toBe(true);
    expect(hr.reason).toBe('outside root');
    expect(hr.approvable).toBe(true);
    expect(hr.source).toBe('EditBoundaryGuard');
  });

  test('plain block (no approvable flag) defaults approvable to false', async () => {
    const hooks = [fnHook(() => ({ action: 'block', reason: 'path traversal' }))];
    const hr = await runHooks(hooks, { toolName: 'write_file' });
    expect(hr.blocked).toBe(true);
    expect(hr.approvable).toBe(false);
    expect(hr.source).toBeUndefined();
  });

  test('first blocking hook wins; later hooks do not run', async () => {
    let secondRan = false;
    const hooks = [
      fnHook(() => ({ action: 'block', reason: 'first', approvable: true, source: 'A' }), 'A'),
      fnHook(() => { secondRan = true; return { action: 'block', reason: 'second' }; }, 'B'),
    ];
    const hr = await runHooks(hooks, {});
    expect(hr.reason).toBe('first');
    expect(hr.source).toBe('A');
    expect(secondRan).toBe(false);
  });
});
