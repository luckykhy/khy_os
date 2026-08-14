import { ref, reactive, markRaw } from 'vue';
import request from '@/api/request';
import { authedFetch } from '@/api/authedFetch';
import { unwrap } from '@/api/unwrap';

/**
 * useWxBinding — 微信(个人号)多账号绑定管理的前端状态与契约客户端。
 *
 * 对接 `/api/wx/*`(挂载点已叠 authenticateToken + requireAdmin):
 *   - REST 走统一 `@/api/request`(axios,自动带 Bearer)。后端这些端点返回**裸对象**
 *     (非 {success,data} 信封),`unwrap()` 会原样透传,故直接读字段即可。
 *   - 扫码登录是 SSE:因 EventSource 无法携带 Authorization 头,复用 `authedFetch +
 *     res.body.getReader()` 帧解析范式(token 注入 + 401 登出 + stream 关闭超时)。
 *
 * 多会话并发:后端已按 sessionId 隔离并发扫码流(见 routes/wx.js `_loginSessions`),
 * 前端亦从单 `_controller` 升级为**多会话集合** `sessions`,每张二维码卡片 = 一路独立流:
 *   - 首帧 `event: session` 携带 `{ sessionId }`,写入该会话项,供取消/重试对齐后端会话。
 *   - 其后帧(qr / status|pending / confirmed|success / daemon / error / expired / done)
 *     只更新其所属会话项,多路互不干扰。
 *   - 超并发上限时后端以 HTTP 429 + {error} 应答,前端把文案展示到对应卡并停止该路流。
 *
 * 零硬编码:baseURL 取自 `request.defaults.baseURL`(= VITE_AI_API_BASE_URL),
 * 与 axios 客户端同源,不在业务代码里写死任何端点主机。
 */

/**
 * 解析单个 SSE 帧文本 → { event, data } 或 null(注释/空帧)。
 *
 * 后端帧格式(见 routes/wx.js):`event: <name>\ndata: <json>\n\n`(注意冒号后有空格)。
 * 纯函数,便于单测。JSON 解析失败时 data 置 null(调用方按需兜底)。
 * @param {string} frame
 * @returns {{event:string, data:any}|null}
 */
export function parseSseFrame(frame) {
  if (!frame || frame.startsWith(':')) return null; // keepalive comment
  const lines = frame.split('\n');
  const eventLine = lines.find((l) => l.startsWith('event:'));
  const dataLine = lines.find((l) => l.startsWith('data:'));
  const event = eventLine ? eventLine.slice(6).trim() : 'message';
  let data = null;
  if (dataLine) {
    const raw = dataLine.slice(5).trim();
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = null;
    }
  }
  return { event, data };
}

export function useWxBinding() {
  const accounts = ref([]);
  const daemonRunning = ref(false);
  const loading = ref(false);

  // 多会话并发:每项 = 一张待绑定二维码卡片(一路独立 SSE 流)。
  // { localId, sessionId, qr:{dataUrl,qrcodeUrl,attempt}, status, statusText, error, success,
  //   isNew, firstBoundAt, rebound, _controller, _cb, _promise }
  // status 机器态:connecting|pending|scanned|success|error|expired
  // isNew/firstBoundAt/rebound 来自后端 confirmed 帧:isNew=false 表示该微信此前已绑定(rebound)。
  const sessions = ref([]);
  let _seq = 0;

  // ── REST ───────────────────────────────────────────────────────────────
  async function fetchAccounts() {
    loading.value = true;
    try {
      const data = unwrap(await request.get('/api/wx/accounts')) || {};
      accounts.value = Array.isArray(data.accounts) ? data.accounts : [];
      daemonRunning.value = !!data.daemonRunning;
      return { accounts: accounts.value, daemonRunning: daemonRunning.value };
    } finally {
      loading.value = false;
    }
  }

  async function bind({ accountId, workspace, agent } = {}) {
    const body = { accountId, workspace };
    if (agent !== undefined && agent !== null && agent !== '') body.agent = agent;
    return unwrap(await request.post('/api/wx/bind', body));
  }

  async function unbindRoute(accountId) {
    return unwrap(await request.delete(`/api/wx/bind/${encodeURIComponent(accountId)}`));
  }

  async function removeAccount(accountId) {
    return unwrap(await request.delete(`/api/wx/accounts/${encodeURIComponent(accountId)}`));
  }

  async function setActive(accountId) {
    return unwrap(await request.post('/api/wx/active', { accountId }));
  }

  // ── 扫码流(SSE,多会话)─────────────────────────────────────────────────
  /** 中止某会话项本地 reader(不移除、不通知后端)。 */
  function _abortItem(item) {
    if (item && item._controller) {
      try {
        item._controller.abort();
      } catch {
        /* noop */
      }
      item._controller = null;
    }
  }

  /** confirmed/success:标记该项成功并刷新账号列表(复用 fetchAccounts),再回调调用方。 */
  async function _finishSuccess(item, account) {
    // isNew===false means this WeChat was already bound before; flag it as a
    // re-bind (refreshed login) so the card can render the right success copy.
    if (item.isNew === false) item.rebound = true;
    try {
      await fetchAccounts();
    } catch {
      /* 刷新失败不影响本卡成功态展示 */
    }
    const cb = item._cb;
    if (cb && typeof cb.onSuccess === 'function') {
      try {
        cb.onSuccess(item, account);
      } catch {
        /* 回调异常隔离 */
      }
    }
  }

  /** error/429:将文案写入该项并停止该路流,再回调调用方。 */
  function _failItem(item, message) {
    item.status = 'error';
    item.error = message;
    item.statusText = message;
    const cb = item._cb;
    if (cb && typeof cb.onError === 'function') {
      try {
        cb.onError(item, new Error(message));
      } catch {
        /* 回调异常隔离 */
      }
    }
  }

  // 将一帧应用到指定会话项(只影响该项)。返回帧的 event 名。
  function _applyFrame(item, parsed) {
    if (!parsed) return null;
    const { event, data } = parsed;
    switch (event) {
      case 'session':
        if (data && data.sessionId) item.sessionId = data.sessionId;
        break;
      case 'qr':
        if (data) {
          item.qr.dataUrl = data.dataUrl ?? null;
          item.qr.qrcodeUrl = data.qrcodeUrl || '';
          item.qr.attempt = Number(data.attempt || 0);
        }
        item.status = 'pending';
        item.statusText = `请使用微信扫码绑定新设备（二维码第 ${item.qr.attempt} 次刷新）`;
        break;
      case 'pending':
      case 'status':
        if (data && data.message) item.statusText = data.message;
        if (event === 'pending') item.status = 'pending';
        break;
      case 'confirmed':
      case 'success':
        item.status = 'success';
        item.success = true;
        // Backend 'confirmed' contract: { account, isNew:boolean, firstBoundAt:ISO }.
        if (data) {
          if (data.isNew !== undefined) item.isNew = !!data.isNew;
          if (data.firstBoundAt) item.firstBoundAt = data.firstBoundAt;
        }
        item.statusText = '扫码绑定成功，正在刷新账号列表…';
        _finishSuccess(item, data?.account || null);
        break;
      case 'daemon':
        item.statusText = data?.restarted
          ? '守护进程已重启，正在接管新账号'
          : '守护进程已启动，正在接管新账号';
        break;
      case 'expired':
        item.status = 'expired';
        item.statusText = '二维码已过期，请点击重试重新获取绑定二维码';
        break;
      case 'error':
        _failItem(item, data?.message || '扫码绑定失败，请重试');
        break;
      case 'done':
        break;
      default:
        break;
    }
    return event;
  }

  /** 驱动一路 SSE 流:解析首帧 session、逐帧更新该项;429/异常写入该项 error。 */
  async function _runSession(item) {
    const controller = new AbortController();
    item._controller = markRaw(controller);
    const base = request.defaults?.baseURL || '';

    try {
      const resp = await authedFetch(`${base}/api/wx/login/stream`, {
        signal: controller.signal,
        stream: true,
      });

      // 超并发上限:后端 429 + {error},展示到本卡并停止该路流。
      if (resp.status === 429) {
        let msg = '扫码绑定并发已达上限，请稍后重试';
        try {
          const body = await resp.json();
          if (body && body.error) msg = body.error;
        } catch {
          /* 解析失败用默认文案 */
        }
        _failItem(item, msg);
        return;
      }
      if (!resp.ok || !resp.body) throw new Error(`SSE failed: ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const event = _applyFrame(item, parseSseFrame(frame));
          if (event === 'done') return;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // 主动停止/取消,非错误
      _failItem(item, err?.message || '扫码连接失败，请重试');
    } finally {
      if (item._controller === controller) item._controller = null;
    }
  }

  /**
   * 新开一路扫码会话:新增一张卡片并开流,返回该会话项引用(响应式)。多次调用互不干扰。
   * @param {{onSuccess?:Function,onError?:Function}} [cb]
   * @returns {object} 会话项(reactive)
   */
  function startLoginSession(cb = {}) {
    const item = reactive({
      localId: `wx-login-${++_seq}-${Date.now()}`,
      sessionId: null,
      qr: { dataUrl: null, qrcodeUrl: '', attempt: 0 },
      status: 'connecting',
      statusText: '正在连接扫码服务，准备生成绑定二维码…',
      error: '',
      success: false,
      isNew: null,
      firstBoundAt: null,
      rebound: false,
      _controller: null,
      _cb: cb,
      _promise: null,
    });
    sessions.value.push(item);
    item._promise = markRaw(_runSession(item));
    return item;
  }

  /** 重试本卡:中止旧流、清空扫码态、以同一卡片重开一路流(保留卡片位置)。 */
  function retryLoginSession(item, cb) {
    if (!item) return null;
    _abortItem(item);
    if (cb) item._cb = cb;
    item.sessionId = null;
    item.qr.dataUrl = null;
    item.qr.qrcodeUrl = '';
    item.qr.attempt = 0;
    item.status = 'connecting';
    item.statusText = '正在重新连接扫码服务，准备生成绑定二维码…';
    item.error = '';
    item.success = false;
    item.isNew = null;
    item.firstBoundAt = null;
    item.rebound = false;
    item._promise = markRaw(_runSession(item));
    return item._promise;
  }

  /** 取消指定会话:中止本地 reader → 从集合移除 → 通知后端取消该 sessionId(fail-soft)。
   *  尚未收到 SSE 首帧 session(sessionId 为空)时后端还没有对应会话,POST 必然 400 且无意义,
   *  故只做本地结束、跳过 HTTP 取消调用。 */
  async function cancelLoginSession(item) {
    if (!item) return;
    _abortItem(item);
    const idx = sessions.value.indexOf(item);
    if (idx !== -1) sessions.value.splice(idx, 1);
    const sessionId = item.sessionId;
    if (!sessionId) return; // 无 sessionId:仅本地结束,不发起 HTTP cancel
    try {
      await request.post('/api/wx/login/cancel', { sessionId }, { silent: true });
    } catch {
      /* best-effort:后端取消失败不影响前端关流 */
    }
  }

  /** 组件卸载/离开时清场:中止全部本地流并逐一通知后端取消(fail-soft)。 */
  function cancelAllSessions() {
    const items = sessions.value.slice();
    sessions.value = [];
    for (const item of items) {
      _abortItem(item);
      if (item.sessionId) {
        request
          .post('/api/wx/login/cancel', { sessionId: item.sessionId }, { silent: true })
          .catch(() => {});
      }
    }
  }

  return {
    accounts,
    daemonRunning,
    loading,
    sessions,
    fetchAccounts,
    bind,
    unbindRoute,
    removeAccount,
    setActive,
    startLoginSession,
    retryLoginSession,
    cancelLoginSession,
    cancelAllSessions,
  };
}

export default useWxBinding;
