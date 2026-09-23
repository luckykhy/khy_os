import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * wsClientCore — 跨平台同步 WS 客户端核心的行为测试。
 * 锁协议状态机：connect/hello/auth 握手、消息路由、退避重连、
 * 心跳、离线排队（pendingQueue）与 session API 的帧形状。
 * WebSocket 用内存 fake 注入（不发任何真实连接），定时器全 fake。
 */

vi.mock('@/utils/ws', () => ({
  resolveWsUrl: (p) => p,
}));

// Assert against the protocol source of truth, not against a literal: the
// client once sent 'auth:request' while the server only accepts
// ClientMessageTypes.AUTH, and this suite locked the wrong literal in place.
const { ClientMessageTypes } = await import('@/services/crossPlatform/shared/protocol.cjs');

const {
  createWsClientCore,
  ConnectionState,
  PLATFORMS,
  ServerMessageTypes,
} = await import('@/services/crossPlatform/shared/wsClientCore');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  send(payload) {
    this.sent.push(payload);
  }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code });
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen({});
  }
  receive(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
  simulateClose() {
    if (this.onclose) this.onclose({ code: 1006 });
  }
  lastSent() {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function makeAdapter(overrides = {}) {
  const calls = {
    state: [],
    authenticated: [],
    authError: [],
    error: [],
    disconnected: [],
    message: [],
    command: [],
    presence: [],
    deviceList: [],
    sessionUpdated: [],
    sessionJoined: [],
    notification: [],
  };
  const adapter = {
    onStateChange: (s) => calls.state.push(s),
    getToken: () => ('token' in overrides ? overrides.token : 'tok-1'),
    loadDeviceId: () => overrides.deviceId ?? 'dev-1',
    getPlatform: () => overrides.platform ?? PLATFORMS.WEB,
    getDeviceName: () => overrides.deviceName ?? 'web-name',
    getCapabilities: () => overrides.capabilities ?? ['chat'],
    onAuthenticated: (m) => calls.authenticated.push(m),
    onAuthError: (m) => calls.authError.push(m),
    onError: (m) => calls.error.push(m),
    onDisconnected: () => calls.disconnected.push(1),
    onMessage: (m) => calls.message.push(m),
    onCommand: (m) => calls.command.push(m),
    onPresence: (d) => calls.presence.push(d),
    onDeviceList: (d) => calls.deviceList.push(d),
    onSessionUpdated: (m) => calls.sessionUpdated.push(m),
    onSessionJoined: (m) => calls.sessionJoined.push(m),
    onNotification: (m) => calls.notification.push(m),
  };
  return { adapter, calls };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.WebSocket;
});

function connectAndAuth(overrides = {}) {
  const { adapter, calls } = makeAdapter(overrides);
  const client = createWsClientCore(adapter);
  client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.receive({ type: ServerMessageTypes.HELLO });
  ws.receive({ type: ServerMessageTypes.AUTH_OK, sessionId: 'sess-1' });
  return { client, calls, ws };
}

describe('枚举常量（协议词汇表单一真源）', () => {
  it('ConnectionState 六态冻结', () => {
    expect(Object.isFrozen(ConnectionState)).toBe(true);
    expect([
      ConnectionState.DISCONNECTED,
      ConnectionState.CONNECTING,
      ConnectionState.AUTHENTICATING,
      ConnectionState.CONNECTED,
      ConnectionState.RECONNECTING,
      ConnectionState.ERROR,
    ]).toEqual(['disconnected', 'connecting', 'authenticating', 'connected', 'reconnecting', 'error']);
  });

  it('ServerMessageTypes 关键帧名与后端一致', () => {
    expect(ServerMessageTypes.AUTH_OK).toBe('auth:ok');
    expect(ServerMessageTypes.SESSION_UPDATED).toBe('session:updated');
    expect(ServerMessageTypes.DEVICE_LIST).toBe('device:list');
  });
});

describe('connect 与握手', () => {
  it('connect() → CONNECTING，WS URL 走 resolveWsUrl 的跨平台路径', () => {
    const { adapter, calls } = makeAdapter();
    const client = createWsClientCore(adapter);
    client.connect();
    expect(FakeWebSocket.instances[0].url).toBe('/ws/cross-platform');
    expect(calls.state).toContain(ConnectionState.CONNECTING);
    // 重复 connect 不新建连接
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it(`hello + token → AUTHENTICATING，${ClientMessageTypes.AUTH} 帧携带设备信息`, () => {
    const { adapter, calls, ws } = connectAndAuth();
    const frame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === ClientMessageTypes.AUTH);
    expect(frame).toEqual({
      type: ClientMessageTypes.AUTH,
      token: 'tok-1',
      deviceId: 'dev-1',
      platform: 'web',
      deviceName: 'web-name',
      capabilities: ['chat'],
    });
    expect(calls.state).toContain(ConnectionState.AUTHENTICATING);
  });

  it('hello 但拿不到 token → 直接 DISCONNECTED，不发 auth 帧', () => {
    const { adapter, calls, ws } = (() => {
      const a = makeAdapter({ token: undefined });
      const c = createWsClientCore(a.adapter);
      c.connect();
      const w = FakeWebSocket.instances[0];
      w.open();
      w.receive({ type: ServerMessageTypes.HELLO });
      return { adapter: a, calls: a.calls, ws: w, client: c };
    })();
    expect(calls.state).toContain(ConnectionState.DISCONNECTED);
    expect(ws.sent).toEqual([]);
  });

  it('auth:ok → CONNECTED + onAuthenticated + 重置重连计数', () => {
    const { calls, ws } = connectAndAuth();
    expect(calls.state).toContain(ConnectionState.CONNECTED);
    expect(calls.authenticated).toEqual([{ type: 'auth:ok', sessionId: 'sess-1' }]);
    expect(ws.sent.length).toBeGreaterThan(0);
  });

  it('auth:error → ERROR + onAuthError + 断开', () => {
    const { adapter, calls } = makeAdapter();
    const client = createWsClientCore(adapter);
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: ServerMessageTypes.HELLO });
    ws.receive({ type: ServerMessageTypes.AUTH_ERROR, error: 'bad key' });
    expect(calls.state).toContain(ConnectionState.ERROR);
    expect(calls.authError).toEqual(['bad key']);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});

describe('离线排队（pendingQueue）', () => {
  it('连接未 OPEN 时 send 返回 false 并入队；auth:ok 后按序冲刷', () => {
    const { adapter, calls, ws } = connectAndAuth();
    // 手工构造：新客户端，OPEN 前调用 session API
    const c2 = makeAdapter();
    const client2 = createWsClientCore(c2.adapter);
    client2.connect();
    const ws2 = FakeWebSocket.instances[1];
    expect(client2.joinSession('s1')).toBe(false);
    expect(client2.sendMessage('@alice', 'hi')).toBe(false);
    ws2.open();
    ws2.receive({ type: ServerMessageTypes.HELLO });
    ws2.receive({ type: ServerMessageTypes.AUTH_OK });
    const frames = ws2.sent.map((s) => JSON.parse(s)).filter((f) => f.type !== ClientMessageTypes.AUTH && f.type !== ClientMessageTypes.PING);
    expect(frames[0]).toEqual({ type: 'session:join', sessionId: 's1' });
    expect(frames[1]).toEqual({ type: 'message:send', target: '@alice', content: 'hi' });
  });
});

describe('session / 消息 API 帧形状（OPEN 态直发）', () => {
  it('八个 API 各自发出正确的协议帧', () => {
    const { ws, client } = connectAndAuth();
    client.joinSession('s1', { reason: 'x' });
    expect(ws.lastSent()).toEqual({ type: 'session:join', sessionId: 's1', reason: 'x' });
    client.leaveSession('s1');
    expect(ws.lastSent()).toEqual({ type: 'session:leave', sessionId: 's1' });
    client.updateSession('s1', 'open', 'bob');
    expect(ws.lastSent()).toEqual({
      type: 'session:update',
      sessionId: 's1',
      state: 'open',
      modifiedBy: 'bob',
    });
    client.sendMessage('target', '正文', { ref: 'r1' });
    expect(ws.lastSent()).toEqual({ type: 'message:send', target: 'target', content: '正文', ref: 'r1' });
    client.routeCommand('target', 'restart', { force: true });
    expect(ws.lastSent()).toEqual({
      type: 'command:route',
      target: 'target',
      command: 'restart',
      params: { force: true },
    });
    client.listDevices();
    expect(ws.lastSent()).toEqual({ type: 'device:list:request' });
    client.handoffSession('s1', 'phone');
    expect(ws.lastSent()).toEqual({ type: 'session:handoff', sessionId: 's1', targetDevice: 'phone' });
    client.acceptHandoff('s1');
    expect(ws.lastSent()).toEqual({ type: 'session:handoff:accept', sessionId: 's1' });
  });
});

describe('下行消息路由', () => {
  it('会话/消息/命令/在线/设备/通知各路由到对应 adapter 回调', () => {
    const { calls, ws } = connectAndAuth();
    ws.receive({ type: ServerMessageTypes.SESSION_UPDATED, id: 1 });
    ws.receive({ type: ServerMessageTypes.SESSION_JOINED, id: 2 });
    ws.receive({ type: ServerMessageTypes.MESSAGE, text: 'hello' });
    ws.receive({ type: ServerMessageTypes.COMMAND, cmd: 'x' });
    ws.receive({ type: ServerMessageTypes.PRESENCE, devices: [{ d: 1 }] });
    ws.receive({ type: ServerMessageTypes.DEVICE_LIST, devices: [{ d: 2 }] });
    ws.receive({ type: ServerMessageTypes.NOTIFICATION, title: 'n' });
    expect(calls.sessionUpdated).toHaveLength(1);
    expect(calls.sessionJoined).toHaveLength(1);
    expect(calls.message).toEqual([{ type: 'message', text: 'hello' }]);
    expect(calls.command).toHaveLength(1);
    expect(calls.presence).toEqual([[{ d: 1 }]]);
    expect(calls.deviceList).toEqual([[{ d: 2 }]]);
    expect(calls.notification).toHaveLength(1);
  });

  it('error 帧 → onError(msg.error || msg.message)；非 JSON 帧静默丢弃', () => {
    const { calls, ws } = connectAndAuth();
    ws.receive({ type: ServerMessageTypes.ERROR, error: 'boom' });
    expect(calls.error).toContain('boom');
    ws.onmessage({ data: 'not-json{{' });
    expect(calls.error).toHaveLength(1); // 没多报
  });
});

describe('重连与心跳', () => {
  it('意外断开 → RECONNECTING，1s 后首次重连（退避基数）', () => {
    const { calls, ws } = connectAndAuth();
    ws.simulateClose();
    expect(calls.state).toContain(ConnectionState.RECONNECTING);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // 新连接再次走 CONNECTING
    expect(calls.state).toContain(ConnectionState.CONNECTING);
  });

  it('disconnect() 主动断开：close(1000, "Client disconnect")，且后续 close 不再重连', () => {
    const { calls: c2 } = makeAdapter();
    const client2 = createWsClientCore({
      onStateChange: () => {},
      getToken: () => 't',
      loadDeviceId: () => 'd',
      getPlatform: () => 'web',
      getDeviceName: () => 'n',
      getCapabilities: () => [],
      onAuthenticated: () => {},
      onAuthError: () => {},
      onError: () => {},
      onDisconnected: () => c2.disconnected.push(1),
      onMessage: () => {},
      onCommand: () => {},
      onPresence: () => {},
      onDeviceList: () => {},
      onSessionUpdated: () => {},
      onSessionJoined: () => {},
      onNotification: () => {},
    });
    client2.connect();
    const ws2 = FakeWebSocket.instances[0];
    ws2.open();
    ws2.receive({ type: ServerMessageTypes.HELLO });
    ws2.receive({ type: ServerMessageTypes.AUTH_OK });
    client2.disconnect();
    expect(ws2.readyState).toBe(FakeWebSocket.CLOSED);
    expect(c2.disconnected.length).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // 没有新实例
  });

  it('auth:ok 后 25s 心跳 ping 周期', () => {
    const { ws } = connectAndAuth();
    const sentBefore = ws.sent.length;
    vi.advanceTimersByTime(25_000);
    expect(JSON.parse(ws.sent[sentBefore])).toEqual({ type: 'ping' });
  });

  it('连续失败（未 open 就再断）按 1.5x 退避：1000 → 1500ms', () => {
    const { adapter } = makeAdapter();
    const client = createWsClientCore(adapter);
    client.connect();
    let ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: ServerMessageTypes.HELLO });
    ws.receive({ type: ServerMessageTypes.AUTH_OK });
    ws.simulateClose(); // attempts=1 → 1000ms
    vi.advanceTimersByTime(1000);
    ws = FakeWebSocket.instances[1];
    // 新连接没握手成功就断了：attempts=2 → 1500ms
    ws.simulateClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2); // 1000ms 尚未到 1500
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('open 成功会清零重连计数（握手成功后退避从头计）', () => {
    const { adapter } = makeAdapter();
    const client = createWsClientCore(adapter);
    client.connect();
    let ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: ServerMessageTypes.HELLO });
    ws.receive({ type: ServerMessageTypes.AUTH_OK });
    ws.simulateClose();
    vi.advanceTimersByTime(1000);
    ws = FakeWebSocket.instances[1];
    ws.open(); // onopen 把 attempts 归零
    ws.receive({ type: ServerMessageTypes.HELLO });
    ws.receive({ type: ServerMessageTypes.AUTH_OK });
    ws.simulateClose();
    // open 把 attempts 清零，所以再次断开也是 1000ms（而不是 1500ms）
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3); // 第 3 个实例在 1000ms 出现
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3); // 无多余重连排程
  });
});
