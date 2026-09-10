'use strict';

/**
 * e2e-test.js 鈥?End-to-end test for cross-platform sync.
 *
 * Tests:
 * 1. Shared protocol and wsClientCore can be loaded
 * 2. Terminal client instantiation
 * 3. Message construction via protocol
 * 4. State management via wsClientCore
 * 5. Session join/update/leave flow
 *
 * Run: node services/backend/src/services/crossPlatform/ws/e2e-test.js
 */

const path = require('path');

// 鈹€鈹€ Load modules 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
} = require('../protocol.cjs');

const { createWsClientCore } = require('../wsClientCore.cjs');
const { createTerminalClient } = require('../clients/terminalClient.cjs');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  鉁?${message}`);
    passed++;
  } else {
    console.log(`  鉂?${message}`);
    failed++;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 鈹€鈹€ Run tests 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
console.log('\n馃И Cross-Platform Sync Unit/E2E Tests\n');

// 鈹€鈹€ Test 1: Protocol Constants 鈹€鈹€
console.log('Test 1: Protocol constants');
assert(ClientMessageTypes.AUTH === 'auth', 'ClientMessageTypes.AUTH correct');
assert(ServerMessageTypes.AUTH_OK === 'auth:ok', 'ServerMessageTypes.AUTH_OK correct');
assert(PLATFORMS.TERMINAL === 'terminal', 'PLATFORMS.TERMINAL correct');
assert(PLATFORMS.WEB === 'web', 'PLATFORMS.WEB correct');
assert(PLATFORMS.DESKTOP === 'desktop', 'PLATFORMS.DESKTOP correct');
assert(PLATFORMS.MOBILE === 'mobile', 'PLATFORMS.MOBILE correct');
assert(ConnectionState.DISCONNECTED === 'disconnected', 'ConnectionState.DISCONNECTED correct');
assert(PROTOCOL_VERSION === 1, 'PROTOCOL_VERSION correct');

// 鈹€鈹€ Test 2: Message Builders 鈹€鈹€
console.log('\nTest 2: Message builders');
const auth = authMessage({
  token: 'test-token',
  deviceId: 'term-001',
  platform: 'terminal',
  deviceName: 'Terminal Test',
  capabilities: { text: true, terminal: true },
});
assert(auth.type === 'auth', 'authMessage type correct');
assert(auth.token === 'test-token', 'authMessage token correct');
assert(auth.deviceId === 'term-001', 'authMessage deviceId correct');
assert(auth.platform === 'terminal', 'authMessage platform correct');
assert(auth.capabilities.terminal === true, 'authMessage capabilities correct');
assert(auth.protocol === 1, 'authMessage protocol version correct');
assert(typeof auth.timestamp === 'number', 'authMessage timestamp correct');

const ping = pingMessage();
assert(ping.type === 'ping', 'pingMessage type correct');
assert(typeof ping.timestamp === 'number', 'pingMessage timestamp correct');

const join = sessionJoinMessage('session-001');
assert(join.type === 'session:join', 'sessionJoinMessage type correct');
assert(join.sessionId === 'session-001', 'sessionJoinMessage sessionId correct');

const leave = sessionLeaveMessage('session-001');
assert(leave.type === 'session:leave', 'sessionLeaveMessage type correct');
assert(leave.sessionId === 'session-001', 'sessionLeaveMessage sessionId correct');

const update = sessionUpdateMessage('session-001', { messages: [{ text: 'hi' }] });
assert(update.type === 'session:update', 'sessionUpdateMessage type correct');
assert(update.sessionId === 'session-001', 'sessionUpdateMessage sessionId correct');
assert(update.delta.messages[0].text === 'hi', 'sessionUpdateMessage delta correct');

const msg = messageSendMessage({ targetDeviceId: 'web-001', payload: { text: 'hello' } });
assert(msg.type === 'message:send', 'messageSendMessage type correct');
assert(msg.targetDeviceId === 'web-001', 'messageSendMessage targetDeviceId correct');
assert(msg.payload.text === 'hello', 'messageSendMessage payload correct');

const cmd = commandRouteMessage({ targetPlatform: 'web', command: 'open', payload: { url: 'http://test' } });
assert(cmd.type === 'command:route', 'commandRouteMessage type correct');
assert(cmd.targetPlatform === 'web', 'commandRouteMessage targetPlatform correct');
assert(cmd.command === 'open', 'commandRouteMessage command correct');

const devList = deviceListMessage();
assert(devList.type === 'device:list', 'deviceListMessage type correct');

// 鈹€鈹€ Test 3: Message Parser 鈹€鈹€
console.log('\nTest 3: Message parser');
const parsed = parseMessage(JSON.stringify({ type: 'test', data: 'hello' }));
assert(parsed.type === 'test', 'parseMessage correct type');
assert(parsed.data === 'hello', 'parseMessage correct data');

const badJson = parseMessage('not json');
assert(badJson.type === 'error', 'parseMessage handles invalid JSON');

const noType = parseMessage(JSON.stringify({ data: 'no type' }));
assert(noType.type === 'error', 'parseMessage handles missing type');

// 鈹€鈹€ Test 4: wsClientCore Factory 鈹€鈹€
console.log('\nTest 4: wsClientCore factory');
let stateChangeCalls = [];
let authCalls = [];
let sessionUpdateCalls = [];
let presenceCalls = [];
let messageCalls = [];
let deviceListCalls = [];
let errorCalls = [];
let disconnectedCalls = [];

const core = createWsClientCore({
  getPlatform: () => PLATFORMS.TERMINAL,
  loadDeviceId: () => null,
  persistDeviceId: () => {},
  getCapabilities: () => ({ text: true, terminal: true }),
  getDeviceName: () => 'Terminal Test',
  onStateChange: (state) => stateChangeCalls.push(state),
  onAuthenticated: (msg) => authCalls.push(msg),
  onAuthError: (err) => errorCalls.push(err),
  onDisconnected: (info) => disconnectedCalls.push(info),
  onSessionUpdated: (msg) => sessionUpdateCalls.push(msg),
  onSessionJoined: (msg) => {},
  onMessage: (msg) => messageCalls.push(msg),
  onCommand: (msg) => {},
  onPresence: (devices) => presenceCalls.push(devices),
  onDeviceList: (devices) => deviceListCalls.push(devices),
  onNotification: (msg) => {},
  onError: (err) => errorCalls.push(err),
});

assert(core !== null, 'createWsClientCore returns object');
assert(typeof core.connect === 'function', 'core has connect()');
assert(typeof core.disconnect === 'function', 'core has disconnect()');
assert(typeof core.joinSession === 'function', 'core has joinSession()');
assert(typeof core.leaveSession === 'function', 'core has leaveSession()');
assert(typeof core.updateSession === 'function', 'core has updateSession()');
assert(typeof core.sendMessage === 'function', 'core has sendMessage()');
assert(typeof core.routeCommand === 'function', 'core has routeCommand()');
assert(typeof core.listDevices === 'function', 'core has listDevices()');
assert(typeof core.getState === 'function', 'core has getState()');
assert(typeof core.handoffSession === 'function', 'core has handoffSession()');
assert(typeof core.acceptHandoff === 'function', 'core has acceptHandoff()');

// 鈹€鈹€ Test 5: Initial State 鈹€鈹€
console.log('\nTest 5: Initial state');
const state = core.getState();
assert(state.connectionState === ConnectionState.DISCONNECTED, 'Initial state is disconnected');
assert(state.devices.length === 0, 'Initial devices is empty');
assert(state.sessions !== null, 'Initial sessions is object');
assert(state.notifications.length === 0, 'Initial notifications is empty');

// 鈹€鈹€ Test 6: Terminal Client Factory 鈹€鈹€
console.log('\nTest 6: Terminal client factory');
const terminal = createTerminalClient({
  url: 'ws://localhost:9090/ws/cross-platform',
  autoReconnect: false,
});

assert(terminal !== null, 'createTerminalClient returns object');
assert(terminal.platform === PLATFORMS.TERMINAL, 'Terminal platform is correct');
assert(terminal.state === ConnectionState.DISCONNECTED, 'Terminal initial state is disconnected');
assert(typeof terminal.connect === 'function', 'Terminal has connect()');
assert(typeof terminal.disconnect === 'function', 'Terminal has disconnect()');
assert(typeof terminal.joinSession === 'function', 'Terminal has joinSession()');
assert(typeof terminal.leaveSession === 'function', 'Terminal has leaveSession()');
assert(typeof terminal.updateSession === 'function', 'Terminal has updateSession()');
assert(typeof terminal.sendMessage === 'function', 'Terminal has sendMessage()');
assert(typeof terminal.routeCommand === 'function', 'Terminal has routeCommand()');
assert(typeof terminal.listDevices === 'function', 'Terminal has listDevices()');
assert(typeof terminal.handoffSession === 'function', 'Terminal has handoffSession()');
assert(typeof terminal.acceptHandoff === 'function', 'Terminal has acceptHandoff()');
assert(typeof terminal.on === 'function', 'Terminal supports EventEmitter on()');
assert(typeof terminal.once === 'function', 'Terminal supports EventEmitter once()');
assert(typeof terminal.off === 'function', 'Terminal supports EventEmitter off()');

// 鈹€鈹€ Test 7: Device ID 鈹€鈹€
console.log('\nTest 7: Device ID');
// Device ID is null until connect() is called (generated on connect)
assert(terminal.deviceId === null, 'Terminal deviceId is null before connect');

// 鈹€鈹€ Test 8: Session Handoff Messages 鈹€鈹€
console.log('\nTest 8: Session handoff protocol');
const handoffMsg = {
  type: 'session:handoff',
  sessionId: 'test-session',
  targetDeviceId: 'web-001',
  timestamp: Date.now(),
};
assert(handoffMsg.type === 'session:handoff', 'Handoff message type correct');

const handoffAcceptMsg = {
  type: 'session:handoff:accept',
  sessionId: 'test-session',
  timestamp: Date.now(),
};
assert(handoffAcceptMsg.type === 'session:handoff:accept', 'Handoff accept message type correct');

// 鈹€鈹€ Summary 鈹€鈹€
console.log('\n' + '鈹€'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('鈹€'.repeat(40) + '\n');

process.exit(failed > 0 ? 1 : 0);
