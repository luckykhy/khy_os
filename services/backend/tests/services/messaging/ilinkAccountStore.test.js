'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 把底座数据家指向临时目录(必须在 require 存储层之前,getBaseHome 会缓存)。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilink-'));
process.env.KHYOS_HOME = TMP_HOME;

const store = require('../../../src/services/messaging/ilinkAccountStore');

const ACC = {
  botToken: 'tok_abcdefghij0123456789',
  accountId: 'bot-1',
  userId: 'user-1',
  baseUrl: 'https://ilinkai.weixin.qq.com',
};

beforeEach(() => {
  for (const f of [store._credFile(), store._cursorFile(), store._ctxTokenFile(), `${store._credFile().replace(/\.json$/, '')}.bak`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

test('未配置时:getAccount=null, isConfigured=false, listAccounts=[]', () => {
  assert.strictEqual(store.getAccount(), null);
  assert.strictEqual(store.isConfigured(), false);
  assert.deepStrictEqual(store.listAccounts(), []);
});

test('saveAccount + getAccount 往返;preview 已脱敏', () => {
  const r = store.saveAccount(ACC);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accountId, 'bot-1');
  assert.ok(!r.preview.includes(ACC.botToken), 'preview 绝不可含完整 token');

  const got = store.getAccount();
  assert.strictEqual(got.botToken, ACC.botToken, 'getAccount 供发请求用,须是明文');
  assert.strictEqual(got.userId, 'user-1');
  assert.strictEqual(store.isConfigured(), true);
});

test('凭据文件权限 0600 且落盘内容不含未脱敏泄漏之外的意外字段', () => {
  store.saveAccount(ACC);
  const st = fs.statSync(store._credFile());
  if (process.platform !== 'win32') {
    assert.strictEqual(st.mode & 0o777, 0o600, '长期凭据必须 0600');
  }
  const raw = JSON.parse(fs.readFileSync(store._credFile(), 'utf-8'));
  assert.strictEqual(raw.active, 'bot-1');
  assert.ok(raw.updatedAt, '应记录写入时间');
  assert.strictEqual(raw.accounts['bot-1'].botToken, ACC.botToken);
});

test('listAccounts 一律脱敏,且标出当前活动账号', () => {
  store.saveAccount(ACC);
  store.saveAccount({ ...ACC, accountId: 'bot-2', botToken: 'tok_zzzzzzzzzzzzzzzzzzzz' });
  const list = store.listAccounts();
  assert.strictEqual(list.length, 2);
  for (const a of list) {
    assert.ok(!a.token.includes('tok_abcdefghij'), 'listAccounts 绝不可回显完整 token');
    assert.ok(!a.token.includes('tok_zzzzzzzz'));
  }
  assert.deepStrictEqual(list.filter((a) => a.active).map((a) => a.accountId), ['bot-2'], '最后保存的是活动账号');
});

test('saveAccount 保留首次 createdAt(重复扫码不刷新绑定时间)', async () => {
  store.saveAccount(ACC);
  const first = store.getAccount().createdAt;
  await new Promise((r) => setTimeout(r, 5));
  store.saveAccount({ ...ACC, botToken: 'tok_rotated_value_xxxx' });
  assert.strictEqual(store.getAccount().createdAt, first);
  assert.strictEqual(store.getAccount().botToken, 'tok_rotated_value_xxxx', 'token 应被更新');
});

test('saveAccount 首次绑定:isNew=true 且 firstBoundAt=落盘 createdAt', () => {
  const r = store.saveAccount(ACC);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.isNew, true, '槽位此前不存在 → 新增');
  assert.strictEqual(r.firstBoundAt, store.getAccount().createdAt, 'firstBoundAt 必须等于落盘 createdAt');
});

test('saveAccount 重复登录:isNew=false 且 firstBoundAt 沿用首次 createdAt、token 仍刷新', async () => {
  const first = store.saveAccount(ACC);
  assert.strictEqual(first.isNew, true);
  const firstBoundAt = first.firstBoundAt;
  await new Promise((r) => setTimeout(r, 5));
  const again = store.saveAccount({ ...ACC, botToken: 'tok_rotated_value_xxxx' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.isNew, false, '槽位已存在 → 重新登录');
  assert.strictEqual(again.firstBoundAt, firstBoundAt, 'firstBoundAt 应沿用首次绑定时间');
  assert.strictEqual(store.getAccount().botToken, 'tok_rotated_value_xxxx', '重新登录仍刷新 token');
});

test('accountId 字符集校验:拒绝路径穿越与异常输入', () => {
  for (const bad of ['', '../evil', 'a/b', 'a b', 'a\nb', null, 123]) {
    assert.strictEqual(store.saveAccount({ ...ACC, accountId: bad }).ok, false, `应拒绝: ${String(bad)}`);
  }
  assert.strictEqual(store.saveAccount({ ...ACC, botToken: '' }).ok, false, '缺 token 应拒绝');
  // 合法集:字母数字 _ . @ = -
  assert.strictEqual(store.saveAccount({ ...ACC, accountId: 'a.b_c-d@e=' }).ok, true);
});

test('getAccount(id) 对非法 id 返回 null 而不是抛', () => {
  store.saveAccount(ACC);
  assert.strictEqual(store.getAccount('../evil'), null);
  assert.strictEqual(store.getAccount('nonexistent'), null);
});

test('无 active 但只有一个账号时:getAccount 回落到那一个', () => {
  store.saveAccount(ACC);
  const raw = JSON.parse(fs.readFileSync(store._credFile(), 'utf-8'));
  raw.active = '';
  fs.writeFileSync(store._credFile(), JSON.stringify(raw));
  assert.strictEqual(store.getAccount().accountId, 'bot-1');
});

test('损坏的凭据文件:fail-soft 成空态,绝不抛', () => {
  fs.writeFileSync(store._credFile(), '{ this is not json');
  assert.strictEqual(store.getAccount(), null);
  assert.deepStrictEqual(store.listAccounts(), []);
  assert.strictEqual(store.isConfigured(), false);
});

test('clearAccount(id) 只删指定账号并连带清该账号游标', () => {
  store.saveAccount(ACC);
  store.saveAccount({ ...ACC, accountId: 'bot-2' });
  store.setSyncBuf('bot-1', 'cursor-1');
  store.setSyncBuf('bot-2', 'cursor-2');

  assert.strictEqual(store.clearAccount('bot-1').ok, true);
  assert.strictEqual(store.getAccount('bot-1'), null);
  assert.ok(store.getAccount('bot-2'), 'bot-2 应保留');
  assert.strictEqual(store.getSyncBuf('bot-1'), '', '游标应连带清除');
  assert.strictEqual(store.getSyncBuf('bot-2'), 'cursor-2', '其他账号游标不受影响');
  // 删掉 active 后只剩一个 → 自动成为 active
  assert.strictEqual(store.getAccount().accountId, 'bot-2');
});

test('clearAccount() 清空全部并删除游标文件', () => {
  store.saveAccount(ACC);
  store.setSyncBuf('bot-1', 'c');
  assert.strictEqual(store.clearAccount().ok, true);
  assert.strictEqual(fs.existsSync(store._credFile()), false);
  assert.strictEqual(fs.existsSync(store._cursorFile()), false);
  assert.strictEqual(store.isConfigured(), false);
});

// ── 游标(高频写,独立文件)───────────────────────────────────────────────────

test('游标与凭据是两个文件(高频写不该反复重写长期凭据)', () => {
  assert.notStrictEqual(store._credFile(), store._cursorFile());
  store.saveAccount(ACC);
  const credMtime = fs.statSync(store._credFile()).mtimeMs;
  store.setSyncBuf('bot-1', 'c1');
  store.setSyncBuf('bot-1', 'c2');
  assert.strictEqual(fs.statSync(store._credFile()).mtimeMs, credMtime, '写游标不得触碰凭据文件');
  assert.strictEqual(store.getSyncBuf('bot-1'), 'c2');
});

test('setSyncBuf/getSyncBuf 往返;空串即清除;非法 id 拒绝', () => {
  assert.strictEqual(store.getSyncBuf('bot-1'), '', '未写过应为空串');
  assert.strictEqual(store.setSyncBuf('bot-1', 'buf'), true);
  assert.strictEqual(store.getSyncBuf('bot-1'), 'buf');
  store.setSyncBuf('bot-1', '');
  assert.strictEqual(store.getSyncBuf('bot-1'), '');
  assert.strictEqual(store.setSyncBuf('../evil', 'x'), false);
  assert.strictEqual(store.getSyncBuf('../evil'), '');
});

test('损坏的游标文件:fail-soft 成空,不影响凭据', () => {
  store.saveAccount(ACC);
  fs.writeFileSync(store._cursorFile(), 'not json at all');
  assert.strictEqual(store.getSyncBuf('bot-1'), '');
  assert.ok(store.getAccount(), '凭据不受游标损坏影响');
});

// ── 会话状态(跨进程可见)─────────────────────────────────────────────────────

test('会话状态: 默认无记录;置位后可读回', () => {
  store.saveAccount(ACC);
  assert.strictEqual(store.getSessionState('bot-1'), null, '默认应无记录');
  assert.strictEqual(store.setSessionExpired('bot-1', true, 'ret=-14'), true, '首次置位应写盘');
  const s = store.getSessionState('bot-1');
  assert.strictEqual(s.expired, true);
  assert.strictEqual(s.reason, 'ret=-14');
  assert.ok(s.at, '应记录发生时间');
});

test('会话状态: 只在变化时写盘(恢复后每轮都会调,不能变成高频写)', () => {
  store.saveAccount(ACC);
  assert.strictEqual(store.setSessionExpired('bot-1', true), true, 'false→true 应写');
  assert.strictEqual(store.setSessionExpired('bot-1', true), false, '重复置位不该再写');
  const mtime = fs.statSync(store._stateFile()).mtimeMs;
  for (let i = 0; i < 5; i++) store.setSessionExpired('bot-1', true);
  assert.strictEqual(fs.statSync(store._stateFile()).mtimeMs, mtime, '无变化不得触碰文件');

  assert.strictEqual(store.setSessionExpired('bot-1', false), true, 'true→false 应写');
  assert.strictEqual(store.setSessionExpired('bot-1', false), false, '已清除后不该再写');
  assert.strictEqual(store.getSessionState('bot-1'), null);
});

test('会话状态: 独立于游标文件与凭据文件', () => {
  store.saveAccount(ACC);
  store.setSyncBuf('bot-1', 'c1');
  const credM = fs.statSync(store._credFile()).mtimeMs;
  const curM = fs.statSync(store._cursorFile()).mtimeMs;
  store.setSessionExpired('bot-1', true);
  assert.strictEqual(fs.statSync(store._credFile()).mtimeMs, credM, '不得重写长期凭据');
  assert.strictEqual(fs.statSync(store._cursorFile()).mtimeMs, curM, '不得重写游标');
});

test('会话状态: 重新扫码成功后自动清除(否则 status 永远误报已过期)', () => {
  store.saveAccount(ACC);
  store.setSessionExpired('bot-1', true, 'ret=-14');
  assert.strictEqual(store.getSessionState('bot-1').expired, true);
  store.saveAccount({ ...ACC, botToken: 'tok_new_after_rescan_x' });   // 重新扫码
  assert.strictEqual(store.getSessionState('bot-1'), null, '重新绑定必须清掉陈旧的过期标志');
});

test('会话状态: 解绑连带清除;全清删掉状态文件', () => {
  store.saveAccount(ACC);
  store.saveAccount({ ...ACC, accountId: 'bot-2' });
  store.setSessionExpired('bot-1', true);
  store.setSessionExpired('bot-2', true);
  store.clearAccount('bot-1');
  assert.strictEqual(store.getSessionState('bot-1'), null);
  assert.strictEqual(store.getSessionState('bot-2').expired, true, '其他账号不受影响');
  store.clearAccount();
  assert.strictEqual(fs.existsSync(store._stateFile()), false, '全清应删掉状态文件');
});

test('会话状态: 非法 id 与损坏文件一律 fail-soft', () => {
  assert.strictEqual(store.setSessionExpired('../evil', true), false);
  assert.strictEqual(store.getSessionState('../evil'), null);
  fs.writeFileSync(store._stateFile(), 'not json');
  assert.strictEqual(store.getSessionState('bot-1'), null, '损坏文件应读成空而不是抛');
});

// ── setActiveAccount(多账号切换)────────────────────────────────────────────

test('setActiveAccount: 账号存在 → ok 并切换 active', () => {
  store.saveAccount(ACC);
  store.saveAccount({ ...ACC, accountId: 'bot-2', botToken: 'tok_zzzzzzzzzzzzzzzzzzzz' });
  // 最后保存的 bot-2 是 active,切回 bot-1
  const r = store.setActiveAccount('bot-1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.accountId, 'bot-1');
  assert.strictEqual(store.getAccount().accountId, 'bot-1', 'active 应已切到 bot-1');
  const raw = JSON.parse(fs.readFileSync(store._credFile(), 'utf-8'));
  assert.strictEqual(raw.active, 'bot-1', 'active 应已落盘');
});

test('setActiveAccount: 账号不存在 → {ok:false}', () => {
  store.saveAccount(ACC);
  const r = store.setActiveAccount('bot-nope');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error, '应带错误说明');
  assert.strictEqual(store.getAccount().accountId, 'bot-1', 'active 不应被改动');
});

test('setActiveAccount: 非法 id → {ok:false} 且不抛', () => {
  store.saveAccount(ACC);
  for (const bad of ['', '../evil', 'a/b', 'a b', null, 123]) {
    assert.strictEqual(store.setActiveAccount(bad).ok, false, `应拒绝: ${String(bad)}`);
  }
  assert.strictEqual(store.getAccount().accountId, 'bot-1', 'active 不受非法输入影响');
});

// ── context-token(主动发送凭据,按 accountId→userId 归档)──────────────────────

test('context-token: set + get 往返;按 accountId→userId 归档、彼此隔离', () => {
  assert.strictEqual(store.setContextToken('bot-1', 'user-1', 'ctx-a'), true);
  assert.strictEqual(store.setContextToken('bot-1', 'user-2', 'ctx-b'), true);
  assert.strictEqual(store.setContextToken('bot-2', 'user-1', 'ctx-c'), true);
  assert.strictEqual(store.getContextToken('bot-1', 'user-1'), 'ctx-a');
  assert.strictEqual(store.getContextToken('bot-1', 'user-2'), 'ctx-b');
  assert.strictEqual(store.getContextToken('bot-2', 'user-1'), 'ctx-c', '不同账号同用户互不串');
  assert.strictEqual(store.getContextToken('bot-2', 'user-2'), '', '未写过的会话→空串');
});

test('context-token: 缺失 / 非法输入 → 空串,绝不抛', () => {
  assert.strictEqual(store.getContextToken('bot-1', 'never'), '');
  assert.strictEqual(store.getContextToken('../evil', 'user-1'), '');
  assert.strictEqual(store.getContextToken('bot-1', ''), '');
  assert.strictEqual(store.getContextToken('bot-1', null), '');
});

test('context-token: 非法 accountId / 空 userId → false 且不落盘', () => {
  assert.strictEqual(store.setContextToken('../evil', 'user-1', 'x'), false);
  assert.strictEqual(store.setContextToken('bot-1', '', 'x'), false);
  assert.strictEqual(store.setContextToken('bot-1', null, 'x'), false);
  assert.strictEqual(fs.existsSync(store._ctxTokenFile()), false, '全非法输入不该创建文件');
});

test('context-token: 空 token 清除该会话条目;桶空后删账号键', () => {
  store.setContextToken('bot-1', 'user-1', 'ctx-a');
  store.setContextToken('bot-1', 'user-2', 'ctx-b');
  assert.strictEqual(store.setContextToken('bot-1', 'user-1', ''), true);
  assert.strictEqual(store.getContextToken('bot-1', 'user-1'), '', '空 token 应清除条目');
  assert.strictEqual(store.getContextToken('bot-1', 'user-2'), 'ctx-b', '同账号其他会话不受影响');
  // 清掉最后一个 → 账号键应被删除。
  store.setContextToken('bot-1', 'user-2', '');
  const raw = JSON.parse(fs.readFileSync(store._ctxTokenFile(), 'utf-8'));
  assert.strictEqual(raw['bot-1'], undefined, '桶空后应删掉账号键');
});

test('context-token: 文件结构 { [accountId]: { [userId]: token } } 且权限 0600', () => {
  store.setContextToken('bot-1', 'user-1', 'ctx-a');
  const raw = JSON.parse(fs.readFileSync(store._ctxTokenFile(), 'utf-8'));
  assert.deepStrictEqual(raw, { 'bot-1': { 'user-1': 'ctx-a' } });
  if (process.platform !== 'win32') {
    const st = fs.statSync(store._ctxTokenFile());
    assert.strictEqual(st.mode & 0o777, 0o600, 'context-token 文件必须 0600');
  }
});
