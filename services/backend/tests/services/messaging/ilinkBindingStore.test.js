'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 把底座数据家指向临时目录(必须在 require 存储层之前,getBaseHome 会缓存)。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilink-bind-'));
process.env.KHYOS_HOME = TMP_HOME;

const store = require('../../../src/services/messaging/ilinkBindingStore');

beforeEach(() => {
  for (const f of [store._bindingsFile(), `${store._bindingsFile().replace(/\.json$/, '')}.bak`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

test('未绑定时:getBinding=null, listBindings=[]', () => {
  assert.strictEqual(store.getBinding('bot-1'), null);
  assert.deepStrictEqual(store.listBindings(), []);
});

test('bindAccount + getBinding 往返;workspace/agent 落地', () => {
  const r = store.bindAccount('bot-1', { workspace: 'ws-a', agent: 'agent-x' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accountId, 'bot-1');
  assert.deepStrictEqual(r.binding, { workspace: 'ws-a', agent: 'agent-x' });

  const got = store.getBinding('bot-1');
  assert.deepStrictEqual(got, { workspace: 'ws-a', agent: 'agent-x' });
});

test('bindAccount: agent 可选,缺省为空串', () => {
  const r = store.bindAccount('bot-1', { workspace: 'ws-a' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.binding, { workspace: 'ws-a', agent: '' });
  assert.strictEqual(store.getBinding('bot-1').agent, '');
});

test('绑定文件权限 0600 且结构为 { bindings, updatedAt }', () => {
  store.bindAccount('bot-1', { workspace: 'ws-a', agent: 'agent-x' });
  const st = fs.statSync(store._bindingsFile());
  if (process.platform !== 'win32') {
    assert.strictEqual(st.mode & 0o777, 0o600, '绑定表必须 0600');
  }
  const raw = JSON.parse(fs.readFileSync(store._bindingsFile(), 'utf-8'));
  assert.ok(raw.updatedAt, '应记录写入时间');
  assert.deepStrictEqual(raw.bindings['bot-1'], { workspace: 'ws-a', agent: 'agent-x' });
});

test('bindAccount 校验:非法 accountId 一律拒绝且不抛', () => {
  for (const bad of ['', '../evil', 'a/b', 'a b', 'a\nb', null, 123]) {
    const r = store.bindAccount(bad, { workspace: 'ws-a' });
    assert.strictEqual(r.ok, false, `应拒绝: ${String(bad)}`);
    assert.ok(r.error, '应带错误说明');
  }
  // 合法集:字母数字 _ . @ = -
  assert.strictEqual(store.bindAccount('a.b_c-d@e=', { workspace: 'ws-a' }).ok, true);
});

test('bindAccount 校验:缺 workspace(缺失/空串/非字符串)一律拒绝', () => {
  for (const bad of [undefined, '', '   ', null, 123, {}]) {
    const r = store.bindAccount('bot-1', { workspace: bad });
    assert.strictEqual(r.ok, false, `应拒绝 workspace=${String(bad)}`);
    assert.ok(r.error, '应带错误说明');
  }
  assert.strictEqual(store.bindAccount('bot-1', undefined).ok, false, 'data 缺失也应拒绝');
});

test('getBinding: 命中/未命中/非法 id', () => {
  store.bindAccount('bot-1', { workspace: 'ws-a' });
  assert.ok(store.getBinding('bot-1'), '命中');
  assert.strictEqual(store.getBinding('bot-nope'), null, '未命中返回 null');
  assert.strictEqual(store.getBinding('../evil'), null, '非法 id 返回 null 而不是抛');
});

test('bindAccount 覆盖同账号的既有绑定', () => {
  store.bindAccount('bot-1', { workspace: 'ws-a', agent: 'agent-x' });
  store.bindAccount('bot-1', { workspace: 'ws-b', agent: 'agent-y' });
  assert.deepStrictEqual(store.getBinding('bot-1'), { workspace: 'ws-b', agent: 'agent-y' });
});

test('unbindAccount: 删除后 getBinding=null', () => {
  store.bindAccount('bot-1', { workspace: 'ws-a' });
  const r = store.unbindAccount('bot-1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accountId, 'bot-1');
  assert.strictEqual(store.getBinding('bot-1'), null);
});

test('unbindAccount 幂等:不存在也算成功', () => {
  const r = store.unbindAccount('bot-never');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accountId, 'bot-never');
  // 未绑定过 → 不该创建文件
  assert.strictEqual(fs.existsSync(store._bindingsFile()), false, '幂等空解绑不应写盘');
});

test('unbindAccount: 非法 id 拒绝且不抛', () => {
  const r = store.unbindAccount('../evil');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('unbindAccount 只删指定账号,其他绑定不受影响', () => {
  store.bindAccount('bot-1', { workspace: 'ws-a' });
  store.bindAccount('bot-2', { workspace: 'ws-b', agent: 'agent-y' });
  store.unbindAccount('bot-1');
  assert.strictEqual(store.getBinding('bot-1'), null);
  assert.deepStrictEqual(store.getBinding('bot-2'), { workspace: 'ws-b', agent: 'agent-y' });
});

test('listBindings 列出全部绑定', () => {
  store.bindAccount('bot-1', { workspace: 'ws-a', agent: 'agent-x' });
  store.bindAccount('bot-2', { workspace: 'ws-b' });
  const list = store.listBindings();
  assert.strictEqual(list.length, 2);
  const byId = Object.fromEntries(list.map((b) => [b.accountId, b]));
  assert.deepStrictEqual(byId['bot-1'], { accountId: 'bot-1', workspace: 'ws-a', agent: 'agent-x' });
  assert.deepStrictEqual(byId['bot-2'], { accountId: 'bot-2', workspace: 'ws-b', agent: '' });
});

test('损坏的绑定文件:fail-soft 成空,绝不抛', () => {
  fs.writeFileSync(store._bindingsFile(), '{ this is not json');
  assert.strictEqual(store.getBinding('bot-1'), null);
  assert.deepStrictEqual(store.listBindings(), []);
});
