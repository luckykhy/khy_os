'use strict';

/**
 * guardApproval.test.js — soft-guard block → user-approval bridge.
 *
 * Verifies that requestGuardApproval:
 *  - allows when the host approves, and stamps EXEC_APPROVED onto params;
 *  - persists a forever rule on 'allow-always';
 *  - fails closed on deny, on no control channel, and on a throwing channel.
 */

const { requestGuardApproval } = require('../../src/services/guardApproval');
const { EXEC_APPROVED } = require('../../src/services/execApproval');

describe('guardApproval — soft block to user approval', () => {
  test('GA-1: approval allows and stamps EXEC_APPROVED onto params', async () => {
    const onControlRequest = async () => ({ behavior: 'allow' });
    const verdict = await requestGuardApproval({
      toolName: 'write_file',
      params: { file_path: '/tmp/x.txt', content: 'hi' },
      reason: 'outside root', source: 'EditBoundaryGuard',
      onControlRequest,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.params[EXEC_APPROVED]).toBe(true);
    expect(verdict.params.file_path).toBe('/tmp/x.txt');
  });

  test('GA-2: raw boolean true (TUI shape) is treated as allow', async () => {
    const verdict = await requestGuardApproval({
      toolName: 'write_file', params: { file_path: '/tmp/y.txt' },
      onControlRequest: async () => true,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.params[EXEC_APPROVED]).toBe(true);
  });

  test('GA-3: allow-always persists a forever rule in permissionStore', async () => {
    const permStore = require('../../src/services/permissionStore');
    const calls = [];
    const orig = permStore.approve;
    permStore.approve = (tool, scope) => { calls.push({ tool, scope }); };
    try {
      const verdict = await requestGuardApproval({
        toolName: 'write_file', params: { file_path: '/tmp/z.txt' },
        onControlRequest: async () => ({ behavior: 'allow-always' }),
      });
      expect(verdict.allowed).toBe(true);
      expect(calls.some(c => c.scope === 'forever')).toBe(true);
    } finally {
      permStore.approve = orig;
    }
  });

  test('GA-4: deny fails closed (allowed=false, no stamp)', async () => {
    const verdict = await requestGuardApproval({
      toolName: 'write_file', params: { file_path: '/tmp/d.txt' },
      onControlRequest: async () => ({ behavior: 'deny' }),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.params[EXEC_APPROVED]).toBeUndefined();
  });

  test('GA-5: no control channel fails closed', async () => {
    const verdict = await requestGuardApproval({
      toolName: 'write_file', params: { file_path: '/tmp/n.txt' },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.params[EXEC_APPROVED]).toBeUndefined();
  });

  test('GA-6: a throwing control channel fails closed', async () => {
    const verdict = await requestGuardApproval({
      toolName: 'write_file', params: { file_path: '/tmp/t.txt' },
      onControlRequest: async () => { throw new Error('channel down'); },
    });
    expect(verdict.allowed).toBe(false);
  });

  test('GA-7: missing params object does not throw and stays fail-closed', async () => {
    const verdict = await requestGuardApproval({
      toolName: 'write_file',
      onControlRequest: async () => ({ behavior: 'deny' }),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.params).toEqual({});
  });

  test('GA-8: a red-line source is refused even when the channel would approve (§4.D irreducibility)', async () => {
    // A red line is a ⊥ fixed point of relaxation: relax(⊥)=⊥. Even an approving
    // channel (and a mis-set approvable) must NOT lift it to an allow.
    let prompted = false;
    const verdict = await requestGuardApproval({
      toolName: 'editFile',
      params: { file_path: '/etc/passwd', approvable: true },
      reason: 'path traversal', source: 'builtin:PathTraversalGuard',
      onControlRequest: async () => { prompted = true; return { behavior: 'allow' }; },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.params[EXEC_APPROVED]).toBeUndefined();
    expect(prompted).toBe(false); // never even reached the prompt
  });
});
