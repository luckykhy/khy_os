'use strict';

/**
 * aiManagementServer.fileSyncBusHost.test.js — locks the host-side wiring of the
 * file-level realtime sync bus inside aiManagementServer:
 *   - _getFileSyncBus: lazy createBus + instance caching + restoreRegistry,
 *     build failure → null (realtime sync 不可用不得拖垮 WS 服务)
 *   - the injected send port: unknown session / session without ws → false,
 *     open ws session → ws.send(JSON) → true
 *   - _handleFileSyncMessage: only claims messages the bus claims
 *     (handled !== true → false, old message types fall through to the legacy
 *     switch default), reply is wsSend'd, bus throw → MERGE_FALLBACK result + true
 *   - _fileSyncDropSession: releases leases via handleDisconnect, fail-soft
 * file_sync_bus is stubbed; only the host contract is asserted. Each test gets a
 * fresh module instance (jest.resetModules) so the lazy _fileSyncBus state is
 * isolated per case — a plain delete require.cache does NOT work under jest.
 */

// `mock` prefix makes this object admissible inside the jest.mock factory.
const mockBus = {
  handleMessage: jest.fn(),
  handleDisconnect: jest.fn(),
  restoreRegistry: jest.fn(),
  sweep: jest.fn(),
};

jest.mock('../src/services/file_sync_bus', () => ({
  createBus: jest.fn(() => mockBus),
  SCHEMA: {},
}));

const SERVER_PATH = require.resolve('../src/services/aiManagementServer');
const BUS_PATH = require.resolve('../src/services/file_sync_bus');

function freshServer() {
  jest.resetModules();
  const { createBus } = require(BUS_PATH);
  const { __test__ } = require(SERVER_PATH);
  for (const fn of [
    mockBus.handleMessage,
    mockBus.handleDisconnect,
    mockBus.restoreRegistry,
    mockBus.sweep,
  ]) {
    fn.mockReset();
  }
  return { __test__, createBus };
}

function openWs() {
  // wsSend compares readyState against ws.WebSocket.OPEN (=== 1)
  return { readyState: 1, sent: [], send(d) { this.sent.push(d); } };
}

describe('aiManagementServer 文件同步总线宿主接线', () => {
  test('_getFileSyncBus 懒建并缓存同一实例（createBus 只调一次 + restoreRegistry）', () => {
    const { __test__, createBus } = freshServer();
    const bus = __test__._getFileSyncBus();
    expect(bus).toBe(mockBus);
    expect(createBus).toHaveBeenCalledTimes(1);
    expect(mockBus.restoreRegistry).toHaveBeenCalledTimes(1);
    expect(__test__._getFileSyncBus()).toBe(mockBus);
    expect(createBus).toHaveBeenCalledTimes(1);
  });

  test('createBus 抛错 → 总线置 null（实时同步不可用，回落到文件锁路径）', () => {
    const { __test__, createBus } = freshServer();
    createBus.mockImplementation(() => {
      throw new Error('bus ctor boom');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(__test__._getFileSyncBus()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('send 端口：未知会话 → false；无 ws 的会话 → false；打开的 ws 会话 → ws.send(JSON) 且 true', () => {
    const { __test__, createBus } = freshServer();
    __test__._getFileSyncBus();
    const sendPort = createBus.mock.calls[0][0].send;
    const sessions = __test__._sessionsForTest();
    sessions.set('no-ws', { id: 'no-ws', authenticated: true });
    sessions.set('open', { id: 'open', authenticated: true, ws: openWs() });

    expect(sendPort('ghost', { a: 1 })).toBe(false);
    expect(sendPort('no-ws', { a: 1 })).toBe(false);
    expect(sendPort('open', { a: 1 })).toBe(true);
    const ws = sessions.get('open').ws;
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ a: 1 });
  });

  test('_handleFileSyncMessage：总线未认领（handled≠true）→ false，交由旧 switch default', () => {
    const { __test__ } = freshServer();
    mockBus.handleMessage.mockReturnValue({ handled: false });
    const session = { id: 's1', ws: openWs() };
    expect(__test__._handleFileSyncMessage(session, { type: 'chat' })).toBe(false);
    // 总线确实收到了消息（只是没认领）
    expect(mockBus.handleMessage).toHaveBeenCalledTimes(1);
  });

  test('_handleFileSyncMessage：认领且带 reply → wsSend reply 并返回 true', () => {
    const { __test__ } = freshServer();
    mockBus.handleMessage.mockReturnValue({ handled: true, reply: { ok: true } });
    const session = { id: 's1', ws: openWs() };
    expect(__test__._handleFileSyncMessage(session, { type: 'file_write' })).toBe(true);
    expect(JSON.parse(session.ws.sent[0])).toEqual({ ok: true });
  });

  test('_handleFileSyncMessage：总线真抛 → wsSend MERGE_FALLBACK（code+fallback=file_lock）并返回 true', () => {
    const { __test__ } = freshServer();
    mockBus.handleMessage.mockImplementation(() => {
      throw new Error('merger exploded');
    });
    const session = { id: 's1', ws: openWs() };
    expect(__test__._handleFileSyncMessage(session, { type: 'file_write' })).toBe(true);
    const reply = JSON.parse(session.ws.sent[0]);
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('MERGE_FALLBACK');
    expect(reply.error.fallback).toBe('file_lock');
    expect(reply.error.message).toContain('merger exploded');
  });

  test('_handleFileSyncMessage：总线为 null（构造失败）→ false（不吞消息类型）', () => {
    const { __test__, createBus } = freshServer();
    createBus.mockImplementation(() => {
      throw new Error('ctor off');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const session = { id: 's1', ws: openWs() };
    expect(__test__._handleFileSyncMessage(session, { type: 'file_write' })).toBe(false);
    expect(mockBus.handleMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('_fileSyncDropSession：有总线 → handleDisconnect(id)；总线抛错被吞', () => {
    const { __test__ } = freshServer();
    __test__._getFileSyncBus();
    expect(() => __test__._fileSyncDropSession('s9')).not.toThrow();
    expect(mockBus.handleDisconnect).toHaveBeenCalledWith('s9');

    mockBus.handleDisconnect.mockImplementation(() => {
      throw new Error('disc boom');
    });
    expect(() => __test__._fileSyncDropSession('s9')).not.toThrow();
  });

  test('_fileSyncDropSession：无总线（构造失败）→ 静默 no-op', () => {
    const { __test__, createBus } = freshServer();
    createBus.mockImplementation(() => {
      throw new Error('ctor off');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => __test__._fileSyncDropSession('s9')).not.toThrow();
    expect(mockBus.handleDisconnect).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
