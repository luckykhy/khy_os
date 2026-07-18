'use strict';

const {
  remoteApprovalBridge,
  remoteStatePersistence,
  listPersistenceAlerts,
  markPersistenceAlertsAcknowledged,
  resetRemoteStateForTests,
} = require('../../src/services/remote');

function createPersistFailureAlert(index) {
  remoteApprovalBridge.createTicket({
    traceId: `trace-persist-alert-${index}`,
    connectionId: `conn-persist-alert-${index}`,
    hostAlias: 'demo',
    commands: [`rm -rf /tmp/persist-alert-${index}`],
    idempotencyKey: `idem-persist-alert-${index}`,
    riskContext: { source: 'unit-test' },
  });
}

describe('remote persistence alerts acknowledgement', () => {
  const originalIsEnabled = remoteStatePersistence.isEnabled;
  const originalSave = remoteStatePersistence.save;

  beforeEach(() => {
    resetRemoteStateForTests();
    remoteStatePersistence.isEnabled = () => true;
    remoteStatePersistence.save = () => ({
      saved: false,
      reason: 'mocked_persist_failure',
    });
  });

  afterEach(() => {
    remoteStatePersistence.isEnabled = originalIsEnabled;
    remoteStatePersistence.save = originalSave;
    resetRemoteStateForTests();
  });

  test('acknowledges alerts with upToId and keeps later alerts unacked', () => {
    createPersistFailureAlert(1);
    createPersistFailureAlert(2);
    createPersistFailureAlert(3);

    const allAlerts = listPersistenceAlerts({ afterId: 0, limit: 20 });
    expect(allAlerts.length).toBeGreaterThanOrEqual(3);
    const orderedIds = allAlerts.map((item) => item.alert_id);
    const upToId = orderedIds[1];

    const ackResult = markPersistenceAlertsAcknowledged({
      upToId,
      reviewer: 'reviewer-a',
    });
    expect(ackResult.ok).toBe(true);
    expect(ackResult.acked_count).toBe(2);
    expect(ackResult.alerts.every((item) => item.acked === true)).toBe(true);
    expect(ackResult.alerts.every((item) => item.acked_by === 'reviewer-a')).toBe(true);
    expect(ackResult.alerts.every((item) => item.alert_id <= upToId)).toBe(true);

    const unacked = listPersistenceAlerts({ afterId: 0, limit: 20, onlyUnacked: true });
    expect(unacked.length).toBeGreaterThanOrEqual(1);
    expect(unacked.every((item) => item.acked === false)).toBe(true);
    expect(unacked.some((item) => item.alert_id <= upToId)).toBe(false);
  });

  test('returns zero acknowledged count for empty or duplicate upToId ranges', () => {
    createPersistFailureAlert(1);
    createPersistFailureAlert(2);

    const allAlerts = listPersistenceAlerts({ afterId: 0, limit: 20 });
    expect(allAlerts.length).toBeGreaterThanOrEqual(2);
    const firstId = allAlerts[0].alert_id;
    const lastId = allAlerts[allAlerts.length - 1].alert_id;

    const invalidRange = markPersistenceAlertsAcknowledged({
      upToId: 0,
      reviewer: 'reviewer-b',
    });
    expect(invalidRange.ok).toBe(false);
    expect(invalidRange.code).toBe('ack_target_required');
    expect(invalidRange.acked_count).toBe(0);

    const firstPass = markPersistenceAlertsAcknowledged({
      upToId: lastId,
      reviewer: 'reviewer-b',
    });
    expect(firstPass.ok).toBe(true);
    expect(firstPass.acked_count).toBeGreaterThanOrEqual(2);

    const duplicatePass = markPersistenceAlertsAcknowledged({
      upToId: lastId,
      reviewer: 'reviewer-b',
    });
    expect(duplicatePass.ok).toBe(true);
    expect(duplicatePass.acked_count).toBe(0);
    expect(duplicatePass.alerts).toEqual([]);
  });

  test('prioritizes alertId when alertId and upToId are both provided', () => {
    createPersistFailureAlert(1);
    createPersistFailureAlert(2);
    createPersistFailureAlert(3);

    const allAlerts = listPersistenceAlerts({ afterId: 0, limit: 20 });
    expect(allAlerts.length).toBeGreaterThanOrEqual(3);
    const targetId = allAlerts[2].alert_id;

    const ackResult = markPersistenceAlertsAcknowledged({
      alertId: targetId,
      upToId: targetId,
      reviewer: 'reviewer-c',
    });
    expect(ackResult.ok).toBe(true);
    expect(ackResult.acked_count).toBe(1);
    expect(ackResult.alerts).toHaveLength(1);
    expect(ackResult.alerts[0].alert_id).toBe(targetId);
    expect(ackResult.alerts[0].acked).toBe(true);
    expect(ackResult.alerts[0].acked_by).toBe('reviewer-c');

    const remainingUnacked = listPersistenceAlerts({
      afterId: 0,
      limit: 20,
      onlyUnacked: true,
    });
    expect(remainingUnacked.length).toBeGreaterThanOrEqual(2);
    expect(remainingUnacked.some((item) => item.alert_id === targetId)).toBe(false);
  });
});
