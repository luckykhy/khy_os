'use strict';

/**
 * Tests for IPC mailbox message types (MSG.ACK, MSG.QUEUE_STATUS).
 */
const { MSG, createMessage, parseMessage } = require('../../src/coordinator/ipcProtocol');

describe('IPC mailbox message types', () => {
  test('MSG.ACK type passes parseMessage validation', () => {
    const msg = createMessage(MSG.ACK, 'agent-1', { seq: 5 });
    const parsed = parseMessage(msg);
    expect(parsed.valid).toBe(true);
    expect(parsed.msg.type).toBe('ack');
    expect(parsed.msg.payload.seq).toBe(5);
  });

  test('MSG.QUEUE_STATUS type passes parseMessage validation', () => {
    const msg = createMessage(MSG.QUEUE_STATUS, 'agent-1', { queueSize: 3, maxSize: 20 });
    const parsed = parseMessage(msg);
    expect(parsed.valid).toBe(true);
    expect(parsed.msg.type).toBe('queue_status');
    expect(parsed.msg.payload.queueSize).toBe(3);
  });

  test('createMessage with ACK type produces valid envelope', () => {
    const msg = createMessage(MSG.ACK, 'pa-abc123', { seq: 42 });
    expect(msg._ipc).toBe(true);
    expect(msg.type).toBe('ack');
    expect(msg.agentId).toBe('pa-abc123');
    expect(typeof msg.requestId).toBe('string');
    expect(msg.requestId.length).toBe(12); // 6 bytes hex
    expect(msg.timestamp).toBeLessThanOrEqual(Date.now());
  });

  test('MSG enum includes new mailbox types', () => {
    expect(MSG.ACK).toBe('ack');
    expect(MSG.QUEUE_STATUS).toBe('queue_status');
  });
});
