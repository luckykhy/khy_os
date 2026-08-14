'use strict';

/**
 * rename.test.js — `/rename` 薄壳契约(node:test)。
 *
 * 锁定:门控关(KHY_RENAME=off)→ false 不接管;无参 → 诚实提示需显式给名(true,绝不偷起模型);
 * 无活动会话 → 提示且接管(true);正常 → 委托既有 sessionPersistence.renameSession(不另起炉灶);
 * renameSession 返回 false(无快照)→ 诚实报错不崩。
 * 经 require.cache 桩 formatters + sessionForestService + sessionPersistence;绝不触真 IO。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/rename');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const FOREST_PATH = require.resolve('../../../src/services/session/sessionForestService');
const PERSIST_PATH = require.resolve('../../../src/services/sessionPersistence');

let calls;
let forestStub;
let persistStub;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/rename');
}

beforeEach(() => {
  calls = { info: [], error: [], success: [] };
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
    printSuccess: (m) => calls.success.push(String(m)),
  });
  forestStub = { getCurrentSessionId: () => 'sess_1' };
  cacheStub(FOREST_PATH, forestStub);
  persistStub = { renameSession: () => true };
  cacheStub(PERSIST_PATH, persistStub);
  delete process.env.KHY_RENAME;
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[FOREST_PATH];
  delete require.cache[PERSIST_PATH];
  delete process.env.KHY_RENAME;
});

describe('门控关 → 不接管', () => {
  test('KHY_RENAME=off → false', async () => {
    process.env.KHY_RENAME = 'off';
    const { handleRename } = freshHandler();
    const r = await handleRename('hi', [], {});
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /KHY_RENAME|未启用/.test(m)));
  });
});

describe('无参 → 诚实提示(绝不偷起模型)', () => {
  test('全空 → 提示需显式给名(true)', async () => {
    const { handleRename } = freshHandler();
    const r = await handleRename(undefined, [], {});
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /显式给出标题|用法/.test(m)));
  });
});

describe('无活动会话', () => {
  test('getCurrentSessionId 空 → 提示且接管', async () => {
    forestStub.getCurrentSessionId = () => null;
    const { handleRename } = freshHandler();
    const r = await handleRename('new', ['title'], {});
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /暂无活动会话/.test(m)));
  });
});

describe('正常 → 委托 renameSession', () => {
  test('多词拼成标题并调 renameSession', async () => {
    let captured = null;
    persistStub.renameSession = (id, title) => { captured = { id, title }; return true; };
    const { handleRename } = freshHandler();
    const r = await handleRename('my', ['great', 'session'], {});
    assert.equal(r, true);
    assert.deepEqual(captured, { id: 'sess_1', title: 'my great session' });
    assert.ok(calls.success.some((m) => /已重命名为:my great session/.test(m)));
  });

  test('renameSession 返回 false → 诚实报错(快照缺失)', async () => {
    persistStub.renameSession = () => false;
    const { handleRename } = freshHandler();
    const r = await handleRename('x', [], {});
    assert.equal(r, true);
    assert.ok(calls.error.some((m) => /未找到当前会话的快照/.test(m)));
  });
});
