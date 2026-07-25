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

describe('s16 — shutdown handshake', () => {
  test('full request -> confirm -> remove cycle, correlated by requestId', async () => {
    bus.setTeammateRunner(() => new Promise(() => {})); // keep it running
    const t = bus.createTeammate({ name: 'alice', task: 'write config' });

    // 1. Lead requests shutdown.
    const { requestId, status } = bus.requestShutdown(t.id, 'all done');
    assert.ok(/^req_/.test(requestId));
    assert.strictEqual(status, 'pending');
    assert.strictEqual(bus.getTeammate(t.id).status, 'stopping');
    assert.strictEqual(bus.getPendingRequest(requestId).type, 'shutdown');

    // 2. Teammate processes its inbox -> auto-replies shutdown_response.
    const disp = bus.dispatchTeammateInbox(t.id);
    assert.strictEqual(disp.shutdown, true);

    // 3. Lead consumes its inbox -> match_response approves and removes teammate.
    const text = bus.collectTeammateMessagesAsText();
    assert.ok(text.includes('type="shutdown_response"'));
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'approved');
    assert.strictEqual(bus.getTeammate(t.id), null, 'teammate removed only after confirm');
  });

  test('an already-finished teammate is shut down immediately (no handshake)', async () => {
    bus.setTeammateRunner(() => 'done');
    const t = bus.createTeammate({ name: 'bob', task: 'quick job' });
    await flush(); // runner completes -> status 'completed'
    bus.collectTeammateMessagesAsText(); // drain the completion message

    const res = bus.requestShutdown(t.id);
    assert.strictEqual(res.status, 'approved');
    assert.strictEqual(bus.getTeammate(t.id), null);
  });

  test('requestShutdown on an unknown teammate errors', () => {
    assert.ok(bus.requestShutdown('team_ghost').error);
  });
});

describe('s16 — plan approval', () => {
  test('teammate requests, lead approves, decision reaches the teammate', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'carol', task: 'refactor auth' });

    const { requestId } = bus.requestPlanApproval(t.id, 'Step 1: extract module');
    assert.ok(requestId);
    // Request surfaces to the lead as a plan_approval_request.
    const leadText = bus.collectTeammateMessagesAsText();
    assert.ok(leadText.includes('type="plan_approval_request"'));
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'pending');

    // Lead reviews and approves.
    const r = bus.reviewPlan(requestId, true);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'approved');

    // Decision lands in the teammate's inbox.
    const disp = bus.dispatchTeammateInbox(t.id);
    assert.strictEqual(disp.planDecision, 'approved');
  });

  test('rejection carries feedback to the teammate', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'dave', task: 'migrate db' });
    const { requestId } = bus.requestPlanApproval(t.id, 'drop and recreate');
    bus.collectTeammateMessagesAsText();

    bus.reviewPlan(requestId, false, 'too risky, use a migration');
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'rejected');
    const inbox = bus.drainTeammateInbox(t.id);
    const resp = inbox.find((m) => m.type === 'plan_approval_response');
    assert.ok(resp);
    assert.strictEqual(resp.metadata.approve, false);
    assert.ok(/too risky/.test(resp.metadata.feedback));
  });

  test('reviewPlan rejects unknown or already-resolved requests', () => {
    assert.ok(bus.reviewPlan('req_nope', true).error);
  });
});

describe('s16 — match_response correlation guarantees', () => {
  test('type mismatch does not resolve the wrong protocol', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'eve', task: 'work' });
    const { requestId } = bus.requestShutdown(t.id);

    // A plan_approval_response must NOT approve a shutdown request.
    assert.strictEqual(bus.matchResponse('plan_approval_response', requestId, true), false);
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'pending');

    // The correct type resolves it.
    assert.strictEqual(bus.matchResponse('shutdown_response', requestId, true), true);
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'approved');
  });

  test('a duplicate response is ignored (idempotent)', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'frank', task: 'work' });
    const { requestId } = bus.requestShutdown(t.id);

    assert.strictEqual(bus.matchResponse('shutdown_response', requestId, true), true);
    assert.strictEqual(bus.matchResponse('shutdown_response', requestId, false), false,
      'second response must not flip an already-approved request');
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'approved');
  });

  test('consumeLeadInbox routes responses before returning them', () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'grace', task: 'work' });
    const { requestId } = bus.requestShutdown(t.id);
    bus.dispatchTeammateInbox(t.id); // teammate posts shutdown_response to lead

    const msgs = bus.consumeLeadInbox();
    assert.ok(msgs.some((m) => m.type === 'shutdown_response'));
    assert.strictEqual(bus.getPendingRequest(requestId).status, 'approved',
      'protocol state updated during consumption, not skipped');
  });
});

describe('s16 — TeamDelete graceful vs force', () => {
  test('default delete starts a graceful handshake for a running teammate', async () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'heidi', task: 'long job' });

    const res = await TeamDelete.execute({ teammate_id: t.id });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.mode, 'graceful');
    assert.strictEqual(res.stopping, t.id);
    assert.strictEqual(bus.getTeammate(t.id).status, 'stopping', 'not removed until confirmed');

    // Drive the confirmation.
    bus.dispatchTeammateInbox(t.id);
    bus.consumeLeadInbox();
    assert.strictEqual(bus.getTeammate(t.id), null);
  });

  test('force delete removes immediately without a handshake', async () => {
    bus.setTeammateRunner(() => new Promise(() => {}));
    const t = bus.createTeammate({ name: 'ivan', task: 'stuck job' });
    const res = await TeamDelete.execute({ teammate_id: t.id, force: true });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.mode, 'force');
    assert.strictEqual(bus.getTeammate(t.id), null);
  });

  test('delete on an unknown teammate reports not found', async () => {
    const res = await TeamDelete.execute({ teammate_id: 'team_missing' });
    assert.strictEqual(res.success, false);
    assert.ok(/not found/.test(res.error));
  });
});
