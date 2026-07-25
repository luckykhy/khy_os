'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const { defineTool } = require('./_baseTool');

/**
 * PushNotify — 把一条通知推到**终端之外**(用户自己的手机/桌面)。对齐 Claude Code 的
 * PushNotificationTool:长任务完成、或遇到需要用户决策的阻塞点时,主动提醒用户,而不必盯着终端。
 *
 * 诚实边界:khy 不自带推送后端。推送目标(ntfy topic / Bark key / Discord·Slack·通用 webhook)
 * 由**用户预先配置**(`khy notify set <provider> <target>`,落 ~/.khyos/push.json 0600)。
 * 本工具读配置、经纯叶子 pushNotifyCore 构造服务商报文、过 SSRF 守卫后发出;target 在任何返回里都脱敏。
 */

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

/** 单次请求(不跟随重定向)。resolve 成结果对象,绝不抛。 */
function _send(urlStr, { method, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(urlStr); } catch { resolve({ _err: `非法 URL：${urlStr}` }); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const reqHeaders = Object.assign({}, headers || {});
    let payload = null;
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    let req;
    try {
      req = lib.request(target, { method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage || '', body: Buffer.concat(chunks).toString('utf-8') }));
      });
    } catch (e) { resolve({ _err: (e && e.message) || String(e) }); return; }
    req.on('error', (err) => resolve({ _err: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ _err: `请求超时（${timeoutMs}ms）` }); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

module.exports = defineTool({
  name: 'PushNotify',
  description:
    'Send a push notification to the user OFF-TERMINAL (their phone/desktop) — e.g. when a long task '
    + 'finishes or you hit a blocking decision point. The destination (ntfy / Bark / Discord / Slack / generic '
    + 'webhook) must be configured first via `khy notify set <provider> <target>`. Give a short title and body.',
  category: 'coordinator',
  risk: 'low',
  isReadOnly: () => false,
  isConcurrencySafe: true,
  aliases: ['push', 'notify', 'pushNotify', 'push_notify'],
  searchHint: 'push notification alert notify mobile phone ntfy bark discord slack webhook done finished',
  inputSchema: {
    title: { type: 'string', required: true, description: 'Short notification title (e.g. "Build finished").' },
    body: { type: 'string', required: false, description: 'Notification body / details.' },
    priority: { type: 'string', required: false, description: 'min | low | default | high | max (or 1-5).' },
  },

  getActivityDescription(input) {
    const t = input && input.title ? String(input.title) : '';
    return `Push notify: ${t.length > 50 ? `${t.slice(0, 50)}…` : t}`;
  },

  async execute(params, _context) {
    const core = require('../services/pushNotifyCore');
    if (!core.isEnabled()) {
      return { success: false, error: 'Push notifications are disabled (KHY_PUSH_NOTIFY=off).' };
    }
    const store = require('../services/pushConfigStore');
    const { assertPublicHttpUrlResolved } = require('../services/urlSafety');

    const cfg = store.getConfig();
    if (!cfg) {
      return { success: false, error: core.buildNotConfiguredHint() };
    }

    const title = String((params && params.title) || '').trim();
    if (!title) return { success: false, error: 'title is required.' };

    const built = core.buildPushRequest({
      provider: cfg.provider,
      target: cfg.target,
      title,
      body: (params && params.body) || '',
      priority: params && params.priority,
    });
    if (!built.ok) return { success: false, error: built.error };

    const { url, method, headers, body } = built.request;
    const masked = core.maskTarget(cfg.target);

    // SSRF 守卫:用户自配的目标也走一遍(协议 + 私网 + DNS rebinding 防护)。失败即拒发。
    try {
      await assertPublicHttpUrlResolved(url, '推送目标');
    } catch (e) {
      // 错误信息可能含 target,脱敏后再回。
      const msg = String((e && e.message) || e).split(cfg.target).join(masked);
      return { success: false, error: `推送目标未通过安全校验:${msg}（自托管内网地址不被允许)。` };
    }

    const res = await _send(url, { method, headers, body, timeoutMs: DEFAULT_TIMEOUT_MS });
    if (res._err) {
      return { success: false, error: `推送失败(${cfg.provider} → ${masked}):${res._err}` };
    }
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      return { success: false, error: `推送被拒(HTTP ${res.status} ${res.statusText})`, status: res.status };
    }
    return {
      success: true,
      data: { provider: cfg.provider, target: masked, title, summary: `已推送通知到 ${core.PROVIDERS[cfg.provider].label}(${masked})。` },
    };
  },
});
