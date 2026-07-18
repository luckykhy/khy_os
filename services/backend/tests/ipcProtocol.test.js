'use strict';

const { MSG, createMessage, parseMessage, createRequestResponse } = require('../src/coordinator/ipcProtocol');

describe('ipcProtocol', () => {
  // ── createMessage ─────────────────────────────────────────────────

  describe('createMessage', () => {
    test('creates valid envelope with all fields', () => {
      const msg = createMessage(MSG.INIT, 'agent-1', { context: {} });
      expect(msg._ipc).toBe(true);
      expect(msg.type).toBe('init');
      expect(msg.agentId).toBe('agent-1');
      expect(msg.payload).toEqual({ context: {} });
      expect(typeof msg.requestId).toBe('string');
      expect(msg.requestId.length).toBe(12); // 6 bytes hex
      expect(typeof msg.timestamp).toBe('number');
    });

    test('uses provided requestId', () => {
      const msg = createMessage(MSG.RESULT, 'a1', {}, 'req-123');
      expect(msg.requestId).toBe('req-123');
    });

    test('throws on invalid type', () => {
      expect(() => createMessage('bogus', 'a1')).toThrow('Invalid IPC message type');
    });

    test('throws on missing agentId', () => {
      expect(() => createMessage(MSG.INIT, '')).toThrow('agentId is required');
      expect(() => createMessage(MSG.INIT, null)).toThrow('agentId is required');
    });

    test('defaults payload to empty object', () => {
      const msg = createMessage(MSG.HEARTBEAT, 'a1');
      expect(msg.payload).toEqual({});
    });
  });

  // ── parseMessage ──────────────────────────────────────────────────

  describe('parseMessage', () => {
    test('validates a well-formed message', () => {
      const msg = createMessage(MSG.READY, 'a1', { pid: 1234 });
      const result = parseMessage(msg);
      expect(result.valid).toBe(true);
      expect(result.msg).toBe(msg);
    });

    test('rejects null', () => {
      expect(parseMessage(null)).toEqual({ valid: false, reason: 'Not an object' });
    });

    test('rejects missing _ipc marker', () => {
      expect(parseMessage({ type: 'init', agentId: 'a' })).toEqual({
        valid: false, reason: 'Missing _ipc marker',
      });
    });

    test('rejects unknown type', () => {
      expect(parseMessage({ _ipc: true, type: 'bogus', agentId: 'a' })).toEqual({
        valid: false, reason: expect.stringContaining('Unknown type'),
      });
    });

    test('rejects missing agentId', () => {
      expect(parseMessage({ _ipc: true, type: 'init' })).toEqual({
        valid: false, reason: 'Missing agentId',
      });
    });
  });

  // ── MSG constants ─────────────────────────────────────────────────

  describe('MSG constants', () => {
    test('all expected types exist', () => {
      const expected = [
        'INIT', 'TASK', 'FOLLOW_UP', 'KILL',
        'READY', 'PROGRESS', 'TOOL_CALL', 'RESULT', 'ERROR', 'METRICS',
        'HEARTBEAT',
      ];
      for (const key of expected) {
        expect(MSG[key]).toBeDefined();
        expect(typeof MSG[key]).toBe('string');
      }
    });

    test('MSG is frozen', () => {
      expect(Object.isFrozen(MSG)).toBe(true);
    });
  });

  // ── createRequestResponse ─────────────────────────────────────────

  describe('createRequestResponse', () => {
    let parentChannel, childListener;

    beforeEach(() => {
      // Mock IPC channel with send() and on('message')
      childListener = null;
      parentChannel = {
        send: jest.fn(),
        on: jest.fn((event, fn) => {
          if (event === 'message') childListener = fn;
        }),
        removeListener: jest.fn(),
      };
    });

    test('request sends message and resolves on response', async () => {
      const rpc = createRequestResponse(parentChannel, 'a1', { timeoutMs: 5000 });

      const promise = rpc.request(MSG.TASK, { prompt: 'hello' });

      // Extract the sent message to get the requestId
      expect(parentChannel.send).toHaveBeenCalledTimes(1);
      const sentMsg = parentChannel.send.mock.calls[0][0];
      expect(sentMsg.type).toBe(MSG.TASK);

      // Simulate response
      const response = createMessage(MSG.RESULT, 'a1', { text: 'world' }, sentMsg.requestId);
      childListener(response);

      const result = await promise;
      expect(result.type).toBe(MSG.RESULT);
      expect(result.payload.text).toBe('world');

      rpc.destroy();
    });

    test('request rejects on ERROR response', async () => {
      const rpc = createRequestResponse(parentChannel, 'a1', { timeoutMs: 5000 });

      const promise = rpc.request(MSG.TASK, {});
      const sentMsg = parentChannel.send.mock.calls[0][0];

      const errorResponse = createMessage(MSG.ERROR, 'a1', { message: 'boom' }, sentMsg.requestId);
      childListener(errorResponse);

      await expect(promise).rejects.toThrow('boom');
      rpc.destroy();
    });

    test('request rejects on timeout', async () => {
      jest.useFakeTimers();
      const rpc = createRequestResponse(parentChannel, 'a1', { timeoutMs: 100 });

      const promise = rpc.request(MSG.INIT, {});
      jest.advanceTimersByTime(200);

      await expect(promise).rejects.toThrow('timed out');
      rpc.destroy();
      jest.useRealTimers();
    });

    test('notify does not wait for response', () => {
      const rpc = createRequestResponse(parentChannel, 'a1');
      rpc.notify(MSG.HEARTBEAT, { ping: true });
      expect(parentChannel.send).toHaveBeenCalledTimes(1);
      rpc.destroy();
    });

    test('destroy rejects pending requests', async () => {
      const rpc = createRequestResponse(parentChannel, 'a1', { timeoutMs: 60000 });

      const promise = rpc.request(MSG.TASK, {});
      rpc.destroy();

      await expect(promise).rejects.toThrow('destroyed');
    });
  });
});
