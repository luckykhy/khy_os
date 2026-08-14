'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// 覆盖任务 #3 的三块纯逻辑:`#N`/accountId 解析、scope 校验分支、status 多账号遍历诊断。
// 经 require.cache 桩掉 wx.js 的全部惰性依赖(store/core/daemon/defaults/config)与 formatters,
// 绝不触真 IO。参考同目录 subscribePr.test.js 的桩法。

const HANDLER = path.resolve(__dirname, '../../../src/cli/handlers/wx.js');
const FORMATTERS = path.resolve(__dirname, '../../../src/cli/formatters.js');
const STORE = path.resolve(__dirname, '../../../src/services/messaging/ilinkAccountStore.js');
const CORE = path.resolve(__dirname, '../../../src/services/messaging/ilinkCore.js');
const DAEMON = path.resolve(__dirname, '../../../src/services/daemonManager.js');
const DEFAULTS = path.resolve(__dirname, '../../../src/constants/serviceDefaults.js');
const CONFIG = path.resolve(__dirname, '../../../src/cli/handlers/config.js');
const BINDING = path.resolve(__dirname, '../../../src/services/messaging/ilinkBindingStore.js');

let infoLog, errLog, warnLog, successLog, tableLog, state;

function _stub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function _install({
  accounts = [],
  enabled = true,
  daemonRunning = true,
  sessions = {},
  heartbeats = {},
  staleMs = 240000,
  bindings = {},
} = {}) {
  state = { setActiveCalls: [], envPatches: [], bindCalls: [], unbindCalls: [] };
  _stub(FORMATTERS, {
    printInfo: (m) => infoLog.push(String(m)),
    printError: (m) => errLog.push(String(m)),
    printWarn: (m) => warnLog.push(String(m)),
    printSuccess: (m) => successLog.push(String(m)),
    printTable: (head, rows) => tableLog.push({ head, rows }),
    // Error panel maps to the same error collector: title/message/reason form the
    // error line, and suggestions surface as info hints (mirrors real UX split).
    printErrorPanel: (opts) => {
      const o = opts || {};
      errLog.push([o.title, o.message, o.reason].filter(Boolean).join(' '));
      for (const s of Array.isArray(o.suggestions) ? o.suggestions : []) infoLog.push(String(s));
    },
  });
  _stub(STORE, {
    listAccounts: () => accounts.slice(),
    getSessionState: (id) => sessions[id] || null,
    getHeartbeat: (id) => heartbeats[id] || null,
    setActiveAccount: (id) => {
      state.setActiveCalls.push(id);
      const hit = accounts.find((a) => a.accountId === id);
      return hit ? { ok: true, accountId: id } : { ok: false, error: '账号不存在' };
    },
  });
  _stub(CORE, { isEnabled: () => enabled });
  _stub(DAEMON, { daemonStatus: async () => ({ running: daemonRunning }) });
  _stub(DEFAULTS, {
    ILINK_SESSION_SCOPE: 'per-account-channel-peer',
    ILINK_SESSION_SCOPES: ['main', 'per-peer', 'per-channel-peer', 'per-account-channel-peer'],
    ILINK_HEARTBEAT_STALE_MS: staleMs,
  });
  _stub(CONFIG, {
    _writeEnvPatch: (map) => { state.envPatches.push(map); return '/sandbox/.env'; },
  });
  // 绑定薄 IO 层桩:内存表 + 记录调用,复刻真 store 的 workspace 必填校验与幂等语义,绝不触盘。
  _stub(BINDING, {
    bindAccount: (id, data) => {
      state.bindCalls.push({ id, data });
      const d = data || {};
      if (typeof d.workspace !== 'string' || !d.workspace.trim()) return { ok: false, error: '缺少 workspace' };
      const binding = { workspace: String(d.workspace), agent: String(d.agent || '') };
      bindings[id] = binding;
      return { ok: true, accountId: id, binding };
    },
    unbindAccount: (id) => {
      state.unbindCalls.push(id);
      delete bindings[id];
      return { ok: true, accountId: id };
    },
    getBinding: (id) => bindings[id] || null,
    listBindings: () => Object.keys(bindings).map((id) => ({ accountId: id, ...bindings[id] })),
  });
}

beforeEach(() => {
  infoLog = []; errLog = []; warnLog = []; successLog = []; tableLog = [];
  delete require.cache[HANDLER];
});
afterEach(() => {
  for (const p of [HANDLER, FORMATTERS, STORE, CORE, DAEMON, DEFAULTS, CONFIG, BINDING]) delete require.cache[p];
});

// ── A. accountId 解析 ──────────────────────────────────────────────

test('_resolveAccountId: #N 按顺序取第 N 个(1-based)', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const list = [{ accountId: 'bot-a' }, { accountId: 'bot-b' }, { accountId: 'bot-c' }];
  assert.deepStrictEqual(_resolveAccountId(list, '#2'), { ok: true, accountId: 'bot-b' });
});

test('_resolveAccountId: 纯数字等价于 #N', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const list = [{ accountId: 'bot-a' }, { accountId: 'bot-b' }];
  assert.deepStrictEqual(_resolveAccountId(list, '1'), { ok: true, accountId: 'bot-a' });
});

test('_resolveAccountId: 非数字当作 accountId 直接匹配', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const list = [{ accountId: 'bot-a' }, { accountId: 'bot-b' }];
  assert.deepStrictEqual(_resolveAccountId(list, 'bot-b'), { ok: true, accountId: 'bot-b' });
});

test('_resolveAccountId: 序号越界 → 明确报错', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const r = _resolveAccountId([{ accountId: 'bot-a' }], '#5');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /超出范围/);
});

test('_resolveAccountId: 未知 accountId → 明确报错', () => {
  _install({ accounts: [] });
  const { _resolveAccountId } = require(HANDLER);
  const r = _resolveAccountId([{ accountId: 'bot-a' }], 'nope');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /未找到账号/);
});

// ── A. wx use 切换 ─────────────────────────────────────────────────

test('wx use #2 → setActiveAccount(第2个) 并给出成功与提示', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }, { accountId: 'bot-b' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('use', ['#2'], {});
  assert.strictEqual(rc, 0);
  assert.deepStrictEqual(state.setActiveCalls, ['bot-b']);
  assert.match(successLog.join('\n'), /切换为 bot-b/);
  assert.match(infoLog.join('\n'), /各账号仍在各自轮询/);
});

test('wx use 无参 → 用法提示且不切换', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('use', [], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.setActiveCalls.length, 0);
  assert.match(errLog.join('\n'), /用法/);
});

test('wx use 账号列表为空 → 清晰提示先绑定', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('select', ['#1'], {});
  assert.strictEqual(rc, 1);
  assert.match(errLog.join('\n'), /尚未绑定/);
});

// ── B. wx scope 校验分支 ───────────────────────────────────────────

test('wx scope 无参 → 展示当前策略与全部可选值表', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('scope', [], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(tableLog.length, 1);
  assert.strictEqual(tableLog[0].rows.length, 4, '应列出 4 种策略');
  assert.strictEqual(state.envPatches.length, 0, '无参不应写盘');
});

test('wx scope <合法> → 持久化 KHY_ILINK_SESSION_SCOPE 并提示重启', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('scope', ['per-peer'], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(state.envPatches.length, 1);
  assert.strictEqual(state.envPatches[0].KHY_ILINK_SESSION_SCOPE, 'per-peer');
  assert.match(infoLog.join('\n'), /重启守护进程/);
});

test('wx scope <非法> → 报错并列出可选值,不写盘', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('scope', ['bogus'], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.envPatches.length, 0);
  assert.match(errLog.join('\n'), /非法的会话隔离策略/);
  assert.match(infoLog.join('\n'), /per-account-channel-peer/);
});

// ── C. status 多账号遍历诊断 ───────────────────────────────────────

test('status: 逐账号诊断,某账号会话过期 → 返回非 0 且各账号各一行', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }, { accountId: 'bot-b' }],
    daemonRunning: true,
    sessions: { 'bot-b': { expired: true, at: '2026-01-01' } },
    heartbeats: { 'bot-a': { ageMs: 1000 } },
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 1, '有账号过期应返回非 0');
  assert.match(errLog.join('\n'), /bot-b 的会话已过期/);
  assert.match(successLog.join('\n'), /bot-a 正在长轮询/);
});

test('status: 某账号心跳陈旧 → 返回非 0', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }],
    daemonRunning: true,
    heartbeats: { 'bot-a': { ageMs: 999999 } },
    staleMs: 240000,
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 1);
  assert.match(errLog.join('\n'), /bot-a[\s\S]*已 \d+ 秒没有心跳/);
});

test('status: 守护进程未运行且无过期 → 返回 0,逐账号提示等待启动', async () => {
  _install({
    accounts: [{ accountId: 'bot-a', active: true }, { accountId: 'bot-b' }],
    daemonRunning: false,
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  assert.match(warnLog.join('\n'), /守护进程未运行/);
  assert.match(infoLog.join('\n'), /bot-a 会话有效,等待守护进程启动/);
  assert.match(infoLog.join('\n'), /bot-b 会话有效,等待守护进程启动/);
});

test('status: 未绑定账号 → info 提示并返回 0', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  assert.match(infoLog.join('\n'), /尚未绑定微信账号/);
});

test('status: KHY_MSG=off → 警告并返回 0,不做逐账号诊断', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }], enabled: false });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('status', [], {});
  assert.strictEqual(rc, 0);
  assert.match(warnLog.join('\n'), /KHY_MSG=off/);
});

// ── D. wx bind 路由绑定 ────────────────────────────────────────────

test('wx bind #1 --workspace <path> --agent <name> → bindAccount 成功并提示即时生效', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }, { accountId: 'bot-b' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#1'], { workspace: '/ws/alpha', agent: 'quant' });
  assert.strictEqual(rc, 0);
  assert.strictEqual(state.bindCalls.length, 1);
  assert.deepStrictEqual(state.bindCalls[0], { id: 'bot-a', data: { workspace: '/ws/alpha', agent: 'quant' } });
  assert.match(successLog.join('\n'), /bot-a 绑定到工作空间 \/ws\/alpha/);
  assert.match(successLog.join('\n'), /Agent:quant/);
  assert.match(infoLog.join('\n'), /绑定已即时生效/);
  assert.match(infoLog.join('\n'), /khy wx start 才能开始收消息/);
});

test('wx bind 精确 accountId 无 --agent → agent 省略传 undefined,仍成功', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['bot-a'], { workspace: '/ws/beta' });
  assert.strictEqual(rc, 0);
  assert.strictEqual(state.bindCalls.length, 1);
  assert.strictEqual(state.bindCalls[0].data.workspace, '/ws/beta');
  assert.strictEqual(state.bindCalls[0].data.agent, undefined);
});

test('wx bind 缺 --workspace → 用法报错且不调 bindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#1'], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /缺少 --workspace/);
});

test('wx bind 非法 id(未找到)→ 报错且不调 bindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['nope'], { workspace: '/ws/x' });
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /未找到账号/);
});

test('wx bind 序号越界 → 报错且不调 bindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#9'], { workspace: '/ws/x' });
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /超出范围/);
});

test('wx bind 账号列表为空 → 提示先绑定,不调 bindAccount', async () => {
  _install({ accounts: [] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bind', ['#1'], { workspace: '/ws/x' });
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.bindCalls.length, 0);
  assert.match(errLog.join('\n'), /尚未绑定微信账号/);
});

// ── E. wx unbind 幂等 ──────────────────────────────────────────────

test('wx unbind #1 幂等:连调两次均返回 0 且都落 unbindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }], bindings: { 'bot-a': { workspace: '/ws/x', agent: '' } } });
  const { handleWx } = require(HANDLER);
  const rc1 = await handleWx('unbind', ['#1'], {});
  const rc2 = await handleWx('unbind', ['#1'], {});
  assert.strictEqual(rc1, 0);
  assert.strictEqual(rc2, 0);
  assert.deepStrictEqual(state.unbindCalls, ['bot-a', 'bot-a']);
  assert.match(successLog.join('\n'), /已解除账号 bot-a 的路由绑定/);
});

test('wx unbind 无参 → 用法报错且不调 unbindAccount', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }] });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('unbind', [], {});
  assert.strictEqual(rc, 1);
  assert.strictEqual(state.unbindCalls.length, 0);
  assert.match(errLog.join('\n'), /用法/);
});

// ── F. wx bindings 路由视图(只读) ─────────────────────────────────

test('wx bindings 空列表 → info 提示如何绑定,不出表,返回 0', async () => {
  _install({ accounts: [{ accountId: 'bot-a' }], bindings: {} });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bindings', [], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(tableLog.length, 0, '空列表不应出表');
  assert.match(infoLog.join('\n'), /尚无路由绑定/);
  assert.match(infoLog.join('\n'), /khy wx bind/);
});

test('wx bindings 非空 → 打印账号→工作空间/Agent 路由表', async () => {
  _install({
    accounts: [{ accountId: 'bot-a' }, { accountId: 'bot-b' }],
    bindings: {
      'bot-a': { workspace: '/ws/alpha', agent: 'quant' },
      'bot-b': { workspace: '/ws/beta', agent: '' },
    },
  });
  const { handleWx } = require(HANDLER);
  const rc = await handleWx('bindings', [], {});
  assert.strictEqual(rc, 0);
  assert.strictEqual(tableLog.length, 1, '非空应出 1 张表');
  assert.deepStrictEqual(tableLog[0].head, ['账号ID', '绑定工作空间', '绑定Agent']);
  assert.strictEqual(tableLog[0].rows.length, 2);
  assert.deepStrictEqual(tableLog[0].rows[0], ['bot-a', '/ws/alpha', 'quant']);
  assert.deepStrictEqual(tableLog[0].rows[1], ['bot-b', '/ws/beta', '-'], '无 agent 应回退为 -');
});
