'use strict';

/**
 * wx.js — 微信(ilink)多账号绑定管理的 HTTP 路由(Web 端管理面的契约真源)。
 *
 * 与 CLI `khy wx …`(handlers/wx.js)同源,全部薄封装底层 store,不含业务逻辑:
 *   GET    /api/wx/accounts          列出全部账号(已脱敏)+ 绑定/会话/心跳聚合 + 守护进程状态
 *   GET    /api/wx/login/stream      SSE 扫码登录流(session / qr / status / confirmed / daemon / error / done)
 *   POST   /api/wx/login/cancel      取消当前扫码会话
 *   POST   /api/wx/bind              {accountId, workspace, agent?} → 绑定账号到工作空间/Agent
 *   DELETE /api/wx/bind/:accountId   解除路由绑定(幂等)
 *   DELETE /api/wx/accounts/:accountId  移除账号(连带解绑孤儿绑定 + fail-soft 重启守护进程)
 *   POST   /api/wx/active            {accountId} → 切换当前活动账号
 *
 * 安全契约:**绝不**读 _readCreds / 明文 token,一律只用已脱敏的 listAccounts();任何 store
 * 返回 {ok:false,error} 时以 4xx + {error} 应答,绝不 500 / 抛。鉴权在挂载点(getWxApp)统一叠加。
 *
 * @module routes/wx
 */

const crypto = require('crypto');

const express = require('express');

const daemon = require('../services/daemonManager');
const store = require('../services/domain/messaging/messaging/ilinkAccountStore.js');
const bindingStore = require('../services/domain/messaging/messaging/ilinkBindingStore.js');
const login = require('../services/domain/messaging/messaging/ilinkLogin.js');

const router = express.Router();

// 多会话并发:按 sessionId 隔离,各持独立 AbortController;互不打断。
// sessionId(uuid) → { ac: AbortController, createdAt: number }
const _loginSessions = new Map();

// 并发上限走 env,零硬编码;非法/缺省回退默认 5。
const _DEFAULT_MAX_LOGIN_SESSIONS = 5;
function _maxLoginSessions() {
  const n = Number.parseInt(process.env.KHY_WX_MAX_LOGIN_SESSIONS, 10);
  return Number.isInteger(n) && n > 0 ? n : _DEFAULT_MAX_LOGIN_SESSIONS;
}

/** 守护进程是否在跑。daemonStatus 会探活。fail-soft。 */
async function _daemonRunning() {
  try {
    const st = await daemon.daemonStatus();
    return !!(st && st.running);
  } catch {
    return false;
  }
}

/**
 * confirmed 后与 CLI _handleLogin 一致:未运行则 start,运行则 restart,让守护进程接管新账号。
 * 全程 fail-soft,返回 {ok, restarted} 供前端展示,绝不抛。
 */
async function _daemonTakeover() {
  try {
    const running = await _daemonRunning();
    const r = running ? await daemon.daemonRestart() : await daemon.daemonStart();
    return { ok: !(r && r.ok === false), restarted: running };
  } catch {
    return { ok: false, restarted: false };
  }
}

// ── GET /accounts ────────────────────────────────────────────────────────
// 每个 account = listAccounts()(脱敏)项 join 绑定 + 会话过期 + 心跳龄。
router.get('/accounts', async (req, res) => {
  const accounts = store.listAccounts().map((a) => {
    const binding = bindingStore.getBinding(a.accountId);
    const session = store.getSessionState(a.accountId);
    const hb = store.getHeartbeat(a.accountId);
    return {
      accountId: a.accountId,
      userId: a.userId,
      token: a.token,
      active: a.active,
      createdAt: a.createdAt,
      workspace: binding ? binding.workspace : '',
      agent: binding ? binding.agent : '',
      expired: !!(session && session.expired),
      heartbeatAgeMs: hb ? hb.ageMs : null,
    };
  });
  res.json({ accounts, daemonRunning: await _daemonRunning() });
});

// ── GET /login/stream (SSE)────────────────────────────────────────────────
router.get('/login/stream', (req, res) => {
  // 并发隔离:每条新流分配独立 sessionId 与 AbortController,不打断已有会话;超上限先 429。
  const max = _maxLoginSessions();
  if (_loginSessions.size >= max) {
    console.warn(`[wx-login] 微信扫码会话已达上限 (${_loginSessions.size}/${max})，拒绝新建会话`);
    return res.status(429).json({
      error: `微信扫码会话已达上限 (${_loginSessions.size}/${max})，请关闭一个后重试`,
    });
  }

  const sessionId = crypto.randomUUID();
  const ac = new AbortController();
  _loginSessions.set(sessionId, { ac, createdAt: Date.now() });

  const cleanup = () => {
    const s = _loginSessions.get(sessionId);
    if (!s) {
      return;
    }
    _loginSessions.delete(sessionId);
    try {
      s.ac.abort();
    } catch {
      /* best-effort */
    }
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* 断流即弃 */
    }
  };

  // 首帧下发 sessionId(供 cancel 定向取消);连接 close/error → abort 本会话并清理孤儿。
  send('session', { sessionId });

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  (async () => {
    try {
      const result = await login.login({
        signal: ac.signal,
        onQr: async ({ qrcodeUrl, attempt }) => {
          const dataUrl = await login.renderQrToDataUrl(qrcodeUrl);
          send('qr', { attempt, qrcodeUrl, dataUrl });
        },
        onStatus: (message) => send('status', { message }),
      });
      if (!result.ok) {
        send('error', { message: result.error || '未知错误' });
      } else {
        const acc = result.account || {};
        send('confirmed', {
          account: { accountId: acc.accountId, userId: acc.userId, preview: acc.preview },
          isNew: result.isNew,
          firstBoundAt: result.firstBoundAt,
        });
        const takeover = await _daemonTakeover();
        send('daemon', takeover);
      }
    } catch (e) {
      send('error', { message: (e && e.message) || String(e) });
    } finally {
      send('done', {});
      try {
        res.end();
      } catch {
        /* best-effort */
      }
      cleanup();
    }
  })();
});

// ── POST /login/cancel ─────────────────────────────────────────────────────
router.post('/login/cancel', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: '取消微信扫码会话失败:缺少必填参数 sessionId' });
  }
  const s = _loginSessions.get(sessionId);
  const cancelled = !!s;
  if (s) {
    _loginSessions.delete(sessionId);
    try {
      s.ac.abort();
    } catch {
      /* best-effort */
    }
  }
  return res.json({ ok: true, cancelled });
});

// ── POST /bind ─────────────────────────────────────────────────────────────
router.post('/bind', (req, res) => {
  const { accountId, workspace, agent } = req.body || {};
  const r = bindingStore.bindAccount(accountId, { workspace, agent });
  return r.ok ? res.json(r) : res.status(400).json({ error: r.error });
});

// ── DELETE /bind/:accountId ────────────────────────────────────────────────
router.delete('/bind/:accountId', (req, res) => {
  const r = bindingStore.unbindAccount(req.params.accountId);
  return r.ok ? res.json(r) : res.status(400).json({ error: r.error });
});

// ── DELETE /accounts/:accountId ────────────────────────────────────────────
// 移除凭据 → 清理孤儿绑定(幂等)→ fail-soft 让守护进程重启以停掉该账号轮询。
router.delete('/accounts/:accountId', async (req, res) => {
  const id = req.params.accountId;
  const r = store.clearAccount(id);
  if (!r.ok) {
    return res.status(400).json({ error: r.error });
  }
  bindingStore.unbindAccount(id);
  const takeover = await _daemonTakeover();
  return res.json({ ok: true, accountId: id, daemon: takeover });
});

// ── POST /active ───────────────────────────────────────────────────────────
router.post('/active', (req, res) => {
  const r = store.setActiveAccount((req.body || {}).accountId);
  return r.ok ? res.json(r) : res.status(400).json({ error: r.error });
});

module.exports = router;
