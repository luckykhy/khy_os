'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const HANDLER = path.resolve(__dirname, '../../../src/cli/handlers/claimMain.js');
const FORMATTERS = path.resolve(__dirname, '../../../src/cli/formatters.js');
const STORE = path.resolve(__dirname, '../../../src/services/claimMain/claimMainStore.js');

let infoLog, errLog, storeState;

function _stub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function _install({ pointer = null, alive = false } = {}) {
  storeState = { pointer, alive, written: null, cleared: false };
  _stub(FORMATTERS, {
    printInfo: (m) => infoLog.push(String(m)),
    printError: (m) => errLog.push(String(m)),
  });
  _stub(STORE, {
    pointerPath: () => '/tmp/main.json',
    readPointer: () => storeState.pointer,
    writePointer: (d) => { storeState.written = d; storeState.pointer = d; return d; },
    clearPointer: () => { storeState.cleared = true; storeState.pointer = null; return true; },
    isPidAlive: () => storeState.alive,
  });
}

beforeEach(() => { infoLog = []; errLog = []; delete require.cache[HANDLER]; });
afterEach(() => {
  for (const p of [HANDLER, FORMATTERS, STORE]) delete require.cache[p];
  delete process.env.KHY_CLAIM_MAIN;
});

test('门控关 → 不接管', async () => {
  process.env.KHY_CLAIM_MAIN = '0';
  _install({});
  const { handleClaimMain } = require(HANDLER);
  assert.strictEqual(await handleClaimMain('claim-main', [], {}), false);
});

test('claim 无持有者 → 写指针并认领', async () => {
  _install({ pointer: null });
  const { handleClaimMain } = require(HANDLER);
  const took = await handleClaimMain('claim-main', [], {});
  assert.strictEqual(took, true);
  assert.ok(storeState.written, '应写入指针');
  assert.strictEqual(storeState.written.pid, process.pid);
  assert.strictEqual(storeState.written.role, 'main');
  assert.match(infoLog.join('\n'), /已认领主角色/);
});

test('claim 已是本进程 → no-op 不写', async () => {
  _install({ pointer: { pid: process.pid }, alive: true });
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', [], {});
  assert.strictEqual(storeState.written, null, '已是自己不应再写');
  assert.match(infoLog.join('\n'), /已是主角色/);
});

test('claim 持有者已死 → 接管并写', async () => {
  _install({ pointer: { pid: 999999 }, alive: false });
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', [], {});
  assert.ok(storeState.written, '陈旧应接管写入');
  assert.match(infoLog.join('\n'), /已接管/);
});

test('claim 持有者活着且非本进程 → 覆盖式认领并写', async () => {
  _install({ pointer: { pid: 999999 }, alive: true });
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', [], {});
  assert.ok(storeState.written, '覆盖应写入');
  assert.match(infoLog.join('\n'), /覆盖式认领/);
});

test('status → 只读披露,不写不清', async () => {
  _install({ pointer: { pid: process.pid }, alive: true });
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', ['status'], {});
  assert.strictEqual(storeState.written, null);
  assert.strictEqual(storeState.cleared, false);
  assert.match(infoLog.join('\n'), /当前主角色/);
});

test('release 本进程持有 → 清除', async () => {
  _install({ pointer: { pid: process.pid } });
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', ['release'], {});
  assert.strictEqual(storeState.cleared, true);
  assert.match(infoLog.join('\n'), /已释放/);
});

test('release 非本进程 → 拒绝,不清', async () => {
  _install({ pointer: { pid: 999999 } });
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', ['release'], {});
  assert.strictEqual(storeState.cleared, false);
  assert.match(infoLog.join('\n'), /拒绝替他人释放/);
});

test('help → 帮助文本', async () => {
  _install({});
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', ['help'], {});
  assert.match(infoLog.join('\n'), /\/claim-main/);
});

test('未知子命令 → 错误转述', async () => {
  _install({});
  const { handleClaimMain } = require(HANDLER);
  await handleClaimMain('claim-main', ['wat'], {});
  assert.match(errLog.join('\n'), /未知子命令/);
});
