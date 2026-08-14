'use strict';

/**
 * aiManagementKhyosWs 本机管理动作(悬浮球触发)测试(node:test,零依赖)。
 *   node --test services/backend/tests/aiManagementKhyosWsLocalActions.test.js
 *
 * 覆盖 handleKhyosTrayStart / handleKhyosMdOpen 的门控回退与关键分支。spawn 被打桩,
 * 绝不真起托盘;md 用不存在的 KHY_MD_TOOLS_DIR 强制走「未找到工具目录」确定性分支。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

const mod = require('../src/services/aiManagementKhyosWs');

// 装一个捕获式 wsSend:把每条 WS 帧收进 session._sent 便于断言。
function makeSession() {
  const sent = [];
  const session = { _sent: sent, ws: { send: () => {} } };
  return { session, sent };
}
mod.setKhyosDeps({
  wsSend: (session, frame) => { session._sent.push(frame); },
});

function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; }
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('_webLocalActionsEnabled: 默认开;falsy 值关(字节回退语义)', () => {
  withEnv({ KHY_WEB_LOCAL_ACTIONS: undefined }, () => {
    assert.equal(mod._webLocalActionsEnabled({}), true);
  });
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(mod._webLocalActionsEnabled({ KHY_WEB_LOCAL_ACTIONS: v }), false, v);
  }
  assert.equal(mod._webLocalActionsEnabled({ KHY_WEB_LOCAL_ACTIONS: '1' }), true);
});

test('handleKhyosTrayStart: 门关 → disabled,绝不 spawn', () => {
  const orig = cp.spawn;
  let spawned = false;
  cp.spawn = () => { spawned = true; return { on() {}, unref() {} }; };
  try {
    withEnv({ KHY_WEB_LOCAL_ACTIONS: 'off' }, () => {
      const { session, sent } = makeSession();
      mod.handleKhyosTrayStart(session, {});
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'khyos_tray_status');
      assert.equal(sent[0].status, 'disabled');
    });
    assert.equal(spawned, false);
  } finally { cp.spawn = orig; }
});

test('handleKhyosTrayStart: 门开 → 以 `khy tray --detach` 后台拉起并回 starting', () => {
  const orig = cp.spawn;
  let argv = null; let opts = null;
  cp.spawn = (cmd, a, o) => { argv = [cmd, ...a]; opts = o; return { on() {}, unref() {} }; };
  try {
    withEnv({ KHY_WEB_LOCAL_ACTIONS: undefined }, () => {
      const { session, sent } = makeSession();
      mod.handleKhyosTrayStart(session, {});
      assert.deepEqual(argv, ['khy', 'tray', '--detach']);
      assert.equal(opts.detached, true);
      assert.equal(opts.stdio, 'ignore');
      const last = sent[sent.length - 1];
      assert.equal(last.type, 'khyos_tray_status');
      assert.equal(last.status, 'starting');
    });
  } finally { cp.spawn = orig; }
});

test('handleKhyosMdOpen: 门关 → disabled', async () => {
  await withEnv({ KHY_WEB_LOCAL_ACTIONS: 'no' }, async () => {
    const { session, sent } = makeSession();
    await mod.handleKhyosMdOpen(session, {});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'khyos_md_status');
    assert.equal(sent[0].status, 'disabled');
  });
});

test('handleKhyosMdOpen: 门开但工具目录缺失 → error /未找到/(确定性,不起真桥)', async () => {
  // 打桩 resolveToolsDir → null,强制走「未找到工具目录」分支,绝不加载/启动真桥接器。
  const md = require('../src/cli/handlers/md');
  const origResolve = md.resolveToolsDir;
  md.resolveToolsDir = () => null;
  try {
    await withEnv({ KHY_WEB_LOCAL_ACTIONS: undefined }, async () => {
      const { session, sent } = makeSession();
      await mod.handleKhyosMdOpen(session, {});
      const last = sent[sent.length - 1];
      assert.equal(last.type, 'khyos_md_status');
      assert.equal(last.status, 'error');
      assert.match(last.message, /未找到|工具目录/);
    });
  } finally { md.resolveToolsDir = origResolve; }
});

// ── handleKhyosTasksGet(TUI 任务记录 → 网页同步)──────────────────────────
test('_toWireTask: 只出安全字段,缺失归一为空/默认,坏输入 → null', () => {
  assert.equal(mod._toWireTask(null), null);
  assert.equal(mod._toWireTask('x'), null);
  const w = mod._toWireTask({ id: 7, subject: '改鉴权', activeForm: '正在改鉴权', status: 'in_progress', owner: 'a', blockedBy: [1, 2], secret: 'sk-xxx' });
  assert.deepEqual(w, { id: '7', subject: '改鉴权', activeForm: '正在改鉴权', status: 'in_progress', owner: 'a', blockedBy: ['1', '2'] });
  assert.equal('secret' in w, false); // 绝不外泄非白名单字段
  const bare = mod._toWireTask({ id: 't1' });
  assert.deepEqual(bare, { id: 't1', subject: '', activeForm: '', status: 'pending', owner: '', blockedBy: [] });
});

test('handleKhyosTasksGet: 门关 → disabled + 空任务', () => {
  withEnv({ KHY_WEB_LOCAL_ACTIONS: 'off' }, () => {
    const { session, sent } = makeSession();
    mod.handleKhyosTasksGet(session, {});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'khyos_tasks');
    assert.equal(sent[0].status, 'disabled');
    assert.deepEqual(sent[0].tasks, []);
  });
});

test('handleKhyosTasksGet: 门开 → 读 _taskStore.list() 并映射为线格式', () => {
  const store = require('../src/tools/_taskStore');
  const origList = store.list;
  store.list = () => ([
    { id: 1, subject: 'A', status: 'completed', blockedBy: [] },
    { id: 2, subject: 'B', activeForm: '正在做 B', status: 'in_progress', owner: 'agent', blockedBy: [1] },
  ]);
  try {
    withEnv({ KHY_WEB_LOCAL_ACTIONS: undefined }, () => {
      const { session, sent } = makeSession();
      mod.handleKhyosTasksGet(session, {});
      const last = sent[sent.length - 1];
      assert.equal(last.type, 'khyos_tasks');
      assert.equal(last.status, 'ok');
      assert.equal(last.tasks.length, 2);
      assert.deepEqual(last.tasks[0], { id: '1', subject: 'A', activeForm: '', status: 'completed', owner: '', blockedBy: [] });
      assert.deepEqual(last.tasks[1].blockedBy, ['1']);
      assert.equal(last.tasks[1].activeForm, '正在做 B');
    });
  } finally { store.list = origList; }
});

test('handleKhyosTasksGet: store 抛错 → error + 空任务(fail-soft,不打断)', () => {
  const store = require('../src/tools/_taskStore');
  const origList = store.list;
  store.list = () => { throw new Error('store boom'); };
  try {
    withEnv({ KHY_WEB_LOCAL_ACTIONS: undefined }, () => {
      const { session, sent } = makeSession();
      mod.handleKhyosTasksGet(session, {});
      const last = sent[sent.length - 1];
      assert.equal(last.type, 'khyos_tasks');
      assert.equal(last.status, 'error');
      assert.deepEqual(last.tasks, []);
      assert.match(last.message, /读取任务记录失败/);
    });
  } finally { store.list = origList; }
});
