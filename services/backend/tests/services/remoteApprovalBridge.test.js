'use strict';

const { createRemoteApprovalBridge } = require('../../src/services/remote/remoteApprovalBridge');

describe('RemoteApprovalBridge state import/export', () => {
  test('importState skips expired pending ticket and keeps active ticket', () => {
    const bridge = createRemoteApprovalBridge();
    const now = Date.now();

    const importedCount = bridge.importState([
      {
        ticket_id: 'expired-pending',
        status: 'pending',
        risk_level: 'dangerous',
        reason: 'expired pending',
        commands: [],
        created_at: new Date(now - 30_000).toISOString(),
        expires_at: new Date(now - 1_000).toISOString(),
      },
      {
        ticket_id: 'active-approved',
        status: 'approved',
        risk_level: 'dangerous',
        reason: 'approved',
        commands: [],
        created_at: new Date(now - 10_000).toISOString(),
        expires_at: new Date(now + 600_000).toISOString(),
      },
    ]);

    expect(importedCount).toBe(1);
    expect(bridge.getTicket('expired-pending')).toBeNull();
    expect(bridge.getTicket('active-approved')).toBeTruthy();
  });

  test('exportState reflects created and consumed ticket fields', () => {
    const bridge = createRemoteApprovalBridge();
    const ticket = bridge.createTicket({
      traceId: 'trace-bridge-1',
      connectionId: 'conn-bridge-1',
      hostAlias: 'demo',
      commands: ['rm -rf /tmp/data'],
      idempotencyKey: 'idem-bridge-1',
      riskContext: { source: 'unit-test' },
    });
    bridge.approveTicket(ticket.ticket_id, 'reviewer');
    const consumed = bridge.consumeApprovedTicket(ticket.ticket_id, 'idem-bridge-1');
    expect(consumed.ok).toBe(true);

    const exported = bridge.exportState();
    expect(Array.isArray(exported)).toBe(true);
    expect(exported.length).toBe(1);
    expect(exported[0].ticket_id).toBe(ticket.ticket_id);
    expect(exported[0].consumed_at).toBeTruthy();
    expect(exported[0].consumed_by_idempotency_key).toBe('idem-bridge-1');
  });
});
