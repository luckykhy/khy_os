'use strict';

/**
 * protocol.unit.test.js — Unit tests for the cross-platform sync protocol builders and parsers.
 *
 * Covers: message type constants, all envelope builders, parseMessage, and type guards.
 */

const {
  ClientMessageTypes,
  ServerMessageTypes,
  PLATFORMS,
  ConnectionState,
  PROTOCOL_VERSION,
  authMessage,
  pingMessage,
  sessionJoinMessage,
  sessionLeaveMessage,
  sessionUpdateMessage,
  messageSendMessage,
  commandRouteMessage,
  deviceListMessage,
  parseMessage,
  isServerMessage,
  isClientMessage,
} = require('../../../src/services/crossPlatform/protocol');

describe('protocol — constants', () => {
  test('ClientMessageTypes are frozen', () => {
    expect(Object.isFrozen(ClientMessageTypes)).toBe(true);
    expect(ClientMessageTypes.AUTH).toBe('auth');
    expect(ClientMessageTypes.PING).toBe('ping');
    expect(ClientMessageTypes.SESSION_JOIN).toBe('session:join');
    expect(ClientMessageTypes.SESSION_LEAVE).toBe('session:leave');
    expect(ClientMessageTypes.SESSION_UPDATE).toBe('session:update');
    expect(ClientMessageTypes.MESSAGE_SEND).toBe('message:send');
    expect(ClientMessageTypes.COMMAND_ROUTE).toBe('command:route');
    expect(ClientMessageTypes.DEVICE_LIST).toBe('device:list');
  });

  test('ServerMessageTypes are frozen', () => {
    expect(Object.isFrozen(ServerMessageTypes)).toBe(true);
    expect(ServerMessageTypes.AUTH_OK).toBe('auth:ok');
    expect(ServerMessageTypes.AUTH_ERROR).toBe('auth:error');
    expect(ServerMessageTypes.PONG).toBe('pong');
    expect(ServerMessageTypes.ERROR).toBe('error');
  });

  test('PLATFORMS and ConnectionState are frozen', () => {
    expect(Object.isFrozen(PLATFORMS)).toBe(true);
    expect(Object.isFrozen(ConnectionState)).toBe(true);
  });

  test('PROTOCOL_VERSION is a number', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number');
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe('protocol — client message builders', () => {
  test('authMessage builds a complete auth envelope', () => {
    const msg = authMessage({
      token: 'tok-123',
      deviceId: 'd1',
      platform: 'web',
      deviceName: 'Chrome',
      userId: 'u1',
      capabilities: { screen: true },
    });
    expect(msg.type).toBe('auth');
    expect(msg.token).toBe('tok-123');
    expect(msg.deviceId).toBe('d1');
    expect(msg.platform).toBe('web');
    expect(msg.deviceName).toBe('Chrome');
    expect(msg.userId).toBe('u1');
    expect(msg.capabilities).toEqual({ screen: true });
    expect(msg.protocol).toBe(PROTOCOL_VERSION);
    expect(typeof msg.timestamp).toBe('number');
  });

  test('authMessage works with minimal args', () => {
    const msg = authMessage({ deviceId: 'd1', platform: 'terminal' });
    expect(msg.type).toBe('auth');
    expect(msg.deviceId).toBe('d1');
    expect(msg.platform).toBe('terminal');
  });

  test('pingMessage has type ping and timestamp', () => {
    const msg = pingMessage();
    expect(msg.type).toBe('ping');
    expect(typeof msg.timestamp).toBe('number');
  });

  test('sessionJoinMessage and sessionLeaveMessage round-trip', () => {
    const join = sessionJoinMessage('s1');
    expect(join.type).toBe('session:join');
    expect(join.sessionId).toBe('s1');

    const leave = sessionLeaveMessage('s1');
    expect(leave.type).toBe('session:leave');
    expect(leave.sessionId).toBe('s1');
  });

  test('sessionUpdateMessage includes delta', () => {
    const msg = sessionUpdateMessage('s1', { messages: ['a', 'b'] });
    expect(msg.type).toBe('session:update');
    expect(msg.sessionId).toBe('s1');
    expect(msg.delta).toEqual({ messages: ['a', 'b'] });
  });

  test('messageSendMessage includes target info', () => {
    const msg = messageSendMessage({
      targetDeviceId: 'd2',
      targetPlatform: null,
      payload: { text: 'hello' },
    });
    expect(msg.type).toBe('message:send');
    expect(msg.targetDeviceId).toBe('d2');
    expect(msg.payload).toEqual({ text: 'hello' });
  });

  test('commandRouteMessage includes command', () => {
    const msg = commandRouteMessage({
      targetPlatform: 'web',
      command: 'open',
      payload: { url: 'http://x' },
    });
    expect(msg.type).toBe('command:route');
    expect(msg.targetPlatform).toBe('web');
    expect(msg.command).toBe('open');
    expect(msg.payload).toEqual({ url: 'http://x' });
  });

  test('deviceListMessage has type device:list', () => {
    const msg = deviceListMessage();
    expect(msg.type).toBe('device:list');
    expect(typeof msg.timestamp).toBe('number');
  });
});

describe('protocol — parseMessage', () => {
  test('parses a JSON string into an object', () => {
    const parsed = parseMessage('{"type":"ping","timestamp":123}');
    expect(parsed).toEqual({ type: 'ping', timestamp: 123 });
  });

  test('passes through an already-parsed object', () => {
    const obj = { type: 'auth', deviceId: 'd1' };
    const parsed = parseMessage(obj);
    expect(parsed).toBe(obj);
  });

  test('returns error envelope for invalid JSON', () => {
    const parsed = parseMessage('not-json{{{');
    expect(parsed.type).toBe('error');
    expect(parsed.error).toBe('Invalid JSON');
  });

  test('returns error envelope for null', () => {
    const parsed = parseMessage(null);
    expect(parsed.type).toBe('error');
    expect(parsed.error).toBe('Missing message type');
  });

  test('returns error envelope for object missing type', () => {
    const parsed = parseMessage({ foo: 'bar' });
    expect(parsed.type).toBe('error');
    expect(parsed.error).toBe('Missing message type');
  });
});

describe('protocol — type guards', () => {
  test('isServerMessage recognises server messages', () => {
    expect(isServerMessage({ type: 'auth:ok' })).toBe(true);
    expect(isServerMessage({ type: 'pong' })).toBe(true);
    expect(isServerMessage({ type: 'auth' })).toBe(false);
    expect(isServerMessage({ type: 'unknown' })).toBe(false);
  });

  test('isClientMessage recognises client messages', () => {
    expect(isClientMessage({ type: 'auth' })).toBe(true);
    expect(isClientMessage({ type: 'ping' })).toBe(true);
    expect(isClientMessage({ type: 'auth:ok' })).toBe(false);
    expect(isClientMessage({ type: 'unknown' })).toBe(false);
  });
});
