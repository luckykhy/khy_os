'use strict';

/**
 * Tests for the s16 fix: structured request-response team protocols layered on
 * the s15 teammateBus.
 *
 * Covers the two protocols that share one pending->approved/rejected FSM:
 *   - shutdown handshake (Lead -> Teammate): graceful removal only after the
 *     teammate confirms, replacing the abrupt "kill the thread" of s15.
 *   - plan approval (Teammate -> Lead): request -> review -> decision delivered.
 * Plus the correlation guarantees: request_id linkage, type-validated
 * match_response, idempotent duplicate handling, and the unified
 * consume_lead_inbox that routes protocol responses before injection.
 */

const assert = require('assert');

const bus = require('../src/tools/teammateBus');
const TeamDeleteTool = require('../src/tools/TeamDeleteTool');

const TeamDelete = new TeamDeleteTool();
const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => bus._resetForTest());

describe('s16 â€?shutdown handshake', () => {
  test('full request -> confirm -> remove cycle, correlated by requestId', async () => {
    bus.setTeammateRunner(() => new Promise(() => {})); // keep it running
    const t = bus.createTeammate({ name: 'alice', task: 'write config' });

    // 1. Lead requests shutdown.
    const { requestId, status } = bus.requestShutdown(t.id, 'all done');
    expect(/^req_/.test(requestId)).toBeTruthy();
    expect(status).toBe('pending');
    expect(bus.getTeammate(t.id).status).toBe('stopping');
    expect(bus.getPendingRequest(requestId).type).toBe('shutdown');

    // 2. Teammate processes its inbox -> auto-replies shutdown_response.
    const disp = bus.dispatchTeammateInbox(t.id);
    expect(disp.shutdown).toBe(true);

    // 3. Lead consumes its inbox -> match_response approves and removes teammate.
    const text = bus.collectTeammateMessagesAsText();
    expect(text).toContain('type="shutdown_response"');
    expect(bus.getPendingRequest(requestId).status).toBe('approved');
    expect(bus.getTeammate(t.id)).toBe(null);
  });

  test('an already-finished teammate is shut down immediately (no handshake)', async () => {
    bus.setTeammateRunner(() => 'done');
    const t = bus.createTeammate({ name: 'bob', task: 'quick job' });
    await flush(); // runner completes -> status 'completed'
    bus.collectTeammateMessagesAsText(); // drain the completion message

    const res = bus.requestShutdown(t.id);
    expect(res.status).toBe('approved');
    expect(bus.getTeammate(t.id)).toBe(null);
  });

  test('requestShutdown on an unknown teammate errors', () => {
    expect(bus.requestShutdown('team_ghost').error).toBeTruthy();
  });
});

describe('s16 â€?plan approval', () => {
  test('teammate requests, lead approves, decision reaches the teammate', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'carol', task: 'refactor auth' });

    const { requestId } = bus.requestPlanApproval(t.id, 'Step 1: extract module');
    expect(requestId).toBeTruthy();
    // Request surfaces to the lead as a plan_approval_request.
    const leadText = bus.collectTeammateMessagesAsText();
    expect(leadText).toContain('type="plan_approval_request"');
    expect(bus.getPendingRequest(requestId).status).toBe('pending');

    // Lead reviews and approves.
    const r = bus.reviewPlan(requestId, true);
    expect(r.ok).toBe(true);
    expect(bus.getPendingRequest(requestId).status).toBe('approved');

    // Decision lands in the teammate's inbox.
    const disp = bus.dispatchTeammateInbox(t.id);
    expect(disp.planDecision).toBe('approved');
  });

  test('rejection carries feedback to the teammate', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'dave', task: 'migrate db' });
    const { requestId } = bus.requestPlanApproval(t.id, 'drop and recreate');
    bus.collectTeammateMessagesAsText();

    bus.reviewPlan(requestId, false, 'too risky, use a migration');
    expect(bus.getPendingRequest(requestId).status).toBe('rejected');
    const inbox = bus.drainTeammateInbox(t.id);
    const resp = inbox.find((m) => m.type === 'plan_approval_response');
    expect(resp).toBeTruthy();
    expect(resp.metadata.approve).toBe(false);
    expect(/too risky/.test(resp.metadata.feedback)).toBeTruthy();
  });

  test('reviewPlan rejects unknown or already-resolved requests', () => {
    expect(bus.reviewPlan('req_nope', true).error).toBeTruthy();
  });
});

describe('s16 â€?match_response correlation guarantees', () => {
  test('type mismatch does not resolve the wrong protocol', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'eve', task: 'work' });
    const { requestId } = bus.requestShutdown(t.id);

    // A plan_approval_response must NOT approve a shutdown request.
    expect(bus.matchResponse('plan_approval_response', requestId, true)).toBe(false);
    expect(bus.getPendingRequest(requestId).status).toBe('pending');

    // The correct type resolves it.
    expect(bus.matchResponse('shutdown_response', requestId, true)).toBe(true);
    expect(bus.getPendingRequest(requestId).status).toBe('approved');
  });

  test('a duplicate response is ignored (idempotent)', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'frank', task: 'work' });
    const { requestId } = bus.requestShutdown(t.id);

    expect(bus.matchResponse('shutdown_response', requestId, true)).toBe(true);
    assert.strictEqual(bus.matchResponse('shutdown_response', requestId, false), false,
      'second response must not flip an already-approved request');
    expect(bus.getPendingRequest(requestId).status).toBe('approved');
  });

  test('consumeLeadInbox routes responses before returning them', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'grace', task: 'work' });
    const { requestId } = bus.requestShutdown(t.id);
    bus.dispatchTeammateInbox(t.id); // teammate posts shutdown_response to lead

    const msgs = bus.consumeLeadInbox();
    expect(msgs.some((m) => m.type === 'shutdown_response')).toBeTruthy();
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'approved',
      'protocol state updated during consumption, not skipped');
  });
});

describe('s16 â€?TeamDelete graceful vs force', () => {
  test('default delete starts a graceful handshake for a running teammate', async () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'heidi', task: 'long job' });

    const res = await TeamDelete.execute({ teammate_id: t.id });
    expect(res.success).toBe(true);
    expect(res.mode).toBe('graceful');
    expect(res.stopping).toBe(t.id);
    expect(bus.getTeammate(t.id).status).toBe('stopping');

    // Drive the confirmation.
    bus.dispatchTeammateInbox(t.id);
    bus.consumeLeadInbox();
    expect(bus.getTeammate(t.id)).toBe(null);
  });

  test('force delete removes immediately without a handshake', async () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'ivan', task: 'stuck job' });
    const res = await TeamDelete.execute({ teammate_id: t.id, force: true });
    expect(res.success).toBe(true);
    expect(res.mode).toBe('force');
    expect(bus.getTeammate(t.id)).toBe(null);
  });

  test('delete on an unknown teammate reports not found', async () => {
    const res = await TeamDelete.execute({ teammate_id: 'team_missing' });
    expect(res.success).toBe(false);
    expect(/not found/.test(res.error)).toBeTruthy();
  });
});

