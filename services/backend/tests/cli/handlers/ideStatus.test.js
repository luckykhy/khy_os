'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const HANDLER = path.resolve(__dirname, '../../../src/cli/handlers/ideStatus.js');
const FORMATTERS = path.resolve(__dirname, '../../../src/cli/formatters.js');
const DETECTOR = path.resolve(__dirname, '../../../src/services/gateway/adapters/ideDetector.js');
const BRIDGE = path.resolve(__dirname, '../../../src/bridge/bridgeServer.js');

let infoLog, errLog;

function _stub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function _install({ detections = [], bridge = { running: false }, detectorBroken = false, bridgeBroken = false } = {}) {
  _stub(FORMATTERS, {
    printInfo: (m) => infoLog.push(String(m)),
    printError: (m) => errLog.push(String(m)),
  });
  _stub(DETECTOR, detectorBroken ? {} : { detectAll: () => detections });
  _stub(BRIDGE, bridgeBroken ? {} : { getStatusSnapshot: () => bridge });
}

beforeEach(() => { infoLog = []; errLog = []; delete require.cache[HANDLER]; });
afterEach(() => {
  for (const p of [HANDLER, FORMATTERS, DETECTOR, BRIDGE]) delete require.cache[p];
  delete process.env.KHY_IDE_COMMAND;
});

test('门控关 → 不接管', async () => {
  process.env.KHY_IDE_COMMAND = '0';
  _install({});
  const { handleIdeStatus } = require(HANDLER);
  assert.strictEqual(await handleIdeStatus('ide', [], {}), false);
});

test('status → 合并 IDE 探测 + bridge 状态', async () => {
  _install({
    detections: [{ name: 'vscode', available: true }],
    bridge: { running: true, url: 'http://x:1', clientCount: 1 },
  });
  const { handleIdeStatus } = require(HANDLER);
  const took = await handleIdeStatus('ide', [], {});
  assert.strictEqual(took, true);
  const out = infoLog.join('\n');
  assert.match(out, /vscode/);
  assert.match(out, /bridge 运行中/);
});

test('list → 仅列出探测到的 IDE', async () => {
  _install({ detections: [{ name: 'idea', available: false }] });
  const { handleIdeStatus } = require(HANDLER);
  await handleIdeStatus('ide', ['list'], {});
  assert.match(infoLog.join('\n'), /idea/);
});

test('help → 帮助文本', async () => {
  _install({});
  const { handleIdeStatus } = require(HANDLER);
  await handleIdeStatus('ide', ['help'], {});
  assert.match(infoLog.join('\n'), /\/ide/);
});

test('未知子命令 → 错误转述', async () => {
  _install({});
  const { handleIdeStatus } = require(HANDLER);
  await handleIdeStatus('ide', ['wat'], {});
  assert.match(errLog.join('\n'), /未知子命令/);
});

test('探测器不可用 → 不崩,如实无 IDE', async () => {
  _install({ detectorBroken: true, bridge: { running: false } });
  const { handleIdeStatus } = require(HANDLER);
  const took = await handleIdeStatus('ide', [], {});
  assert.strictEqual(took, true);
  assert.match(infoLog.join('\n'), /未探测到可用 IDE/);
});

test('bridge 不可用 → 不崩,如实 bridge 未运行', async () => {
  _install({ detections: [{ name: 'vscode', available: true }], bridgeBroken: true });
  const { handleIdeStatus } = require(HANDLER);
  await handleIdeStatus('ide', [], {});
  assert.match(infoLog.join('\n'), /bridge 未运行/);
});
