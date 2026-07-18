'use strict';

/**
 * pushNotifyCore.js — 纯叶子:把一条「标题 + 正文 + 优先级」的通知,按各推送服务商的报文格式
 * 构造成一个 HTTP 请求描述符(单一真源)。对齐 Claude Code 的 PushNotificationTool:让 khy 在长任务
 * 完成、或遇到阻塞性提示时,把消息推到**终端之外**(用户自己的手机/桌面)。
 *
 * 关键定位(诚实边界,绝不伪造能力):khy 不自带托管/推送后端。推送靠**用户自配的 endpoint**——
 * ntfy.sh 的 topic、Bark 的 key、Discord/Slack 的 webhook、或任意通用 webhook。本叶子只负责把通知
 * 翻译成对应服务商的 {url, method, headers, body};真正发请求(经 SSRF 守卫)与读配置由上层负责。
 *
 * 契约:零 IO、确定性(不依赖时钟/随机)、绝不抛(fail-soft)、env 门控 KHY_PUSH_NOTIFY 默认开。
 * 单一真源:服务商报文格式、优先级归一、target 脱敏只在这里;工具与 CLI 都委派本叶子。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  const raw = env && env.KHY_PUSH_NOTIFY;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// 服务商清单(单一真源)。target 的语义随服务商不同,描述见 hint。
const PROVIDERS = {
  ntfy: { label: 'ntfy', hint: 'topic 名或完整 URL,如 mytopic 或 https://ntfy.sh/mytopic' },
  bark: { label: 'Bark', hint: 'device key 或完整 base,如 abcd1234 或 https://api.day.app/abcd1234' },
  discord: { label: 'Discord', hint: 'Discord 频道 webhook URL' },
  slack: { label: 'Slack', hint: 'Slack incoming webhook URL' },
  webhook: { label: '通用 webhook', hint: '任意接收 JSON POST 的 URL' },
};

function isValidProvider(provider) {
  return typeof provider === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, provider.toLowerCase());
}

function normalizeProvider(provider) {
  const p = String(provider == null ? '' : provider).trim().toLowerCase();
  return isValidProvider(p) ? p : null;
}

// 优先级归一到 1(min)..5(max),默认 3。各服务商各自映射。
function normalizePriority(priority) {
  if (priority == null || priority === '') return 3;
  const named = { min: 1, low: 2, default: 3, normal: 3, high: 4, max: 5, urgent: 5 };
  const key = String(priority).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(named, key)) return named[key];
  const n = Math.round(Number(priority));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function _clip(s, max) {
  const v = String(s == null ? '' : s);
  return v.length > max ? v.slice(0, max) : v;
}

/** 脱敏:target 多含密钥(bark key / webhook 含 token),展示时只露少量字符。 */
function maskTarget(target) {
  const s = String(target == null ? '' : target);
  if (!s) return '(未配置)';
  // 对 URL:保留协议 + host,路径/查询整体打码。
  const m = s.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
  if (m) {
    const tail = m[2] || '';
    if (!tail || tail === '/') return m[1];
    return `${m[1]}/****（${tail.length} 字）`;
  }
  if (s.length <= 6) return `****（${s.length} 字）`;
  return `${s.slice(0, 3)}…${s.slice(-2)}（${s.length} 字）`;
}

/**
 * 把通知翻译成目标服务商的 HTTP 请求描述符。
 * @param {{provider:string, target:string, title?:string, body?:string, priority?:any}} input
 * @returns {{ok:true, request:{url:string,method:string,headers:object,body:(string|null)}, provider:string}|{ok:false, error:string}}
 */
function buildPushRequest(input = {}) {
  const provider = normalizeProvider(input.provider);
  if (!provider) {
    return { ok: false, error: `未知推送服务商「${input.provider}」。支持:${Object.keys(PROVIDERS).join(' / ')}。` };
  }
  const target = String(input.target == null ? '' : input.target).trim();
  if (!target) return { ok: false, error: '推送目标(target)未配置。' };
  const title = _clip(input.title, 200) || 'khy';
  const body = _clip(input.body, 4000);
  const prio = normalizePriority(input.priority);

  if (provider === 'ntfy') {
    // topic 或完整 URL 都接受
    const url = /^https?:\/\//i.test(target) ? target : `https://ntfy.sh/${encodeURIComponent(target)}`;
    return {
      ok: true,
      provider,
      request: {
        url,
        method: 'POST',
        headers: { Title: title, Priority: String(prio) },
        body: body || title,
      },
    };
  }

  if (provider === 'bark') {
    const base = /^https?:\/\//i.test(target) ? target.replace(/\/+$/, '') : `https://api.day.app/${encodeURIComponent(target)}`;
    // Bark:GET base/<title>/<body>;用查询参带 level(避免路径里塞奇怪字符,标题/正文做 encode)
    const level = prio >= 5 ? 'critical' : prio >= 4 ? 'timeSensitive' : 'active';
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body || ' ')}?level=${level}`;
    return { ok: true, provider, request: { url, method: 'GET', headers: {}, body: null } };
  }

  if (provider === 'discord') {
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'Discord 需要完整的 webhook URL。' };
    const content = body ? `**${title}**\n${body}` : `**${title}**`;
    return {
      ok: true,
      provider,
      request: { url: target, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: _clip(content, 1900) }) },
    };
  }

  if (provider === 'slack') {
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'Slack 需要完整的 webhook URL。' };
    const text = body ? `*${title}*\n${body}` : `*${title}*`;
    return {
      ok: true,
      provider,
      request: { url: target, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) },
    };
  }

  // generic webhook
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '通用 webhook 需要完整 URL。' };
  return {
    ok: true,
    provider,
    request: {
      url: target,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, priority: prio, source: 'khy' }),
    },
  };
}

function describeProviders() {
  return Object.keys(PROVIDERS).map((id) => ({ id, label: PROVIDERS[id].label, hint: PROVIDERS[id].hint }));
}

function buildNotConfiguredHint() {
  return '尚未配置推送。先设置:khy notify set <provider> <target>（provider: '
    + Object.keys(PROVIDERS).join(' / ') + ')。例如 `khy notify set ntfy my-topic`。';
}

module.exports = {
  PROVIDERS,
  isEnabled,
  isValidProvider,
  normalizeProvider,
  normalizePriority,
  maskTarget,
  buildPushRequest,
  describeProviders,
  buildNotConfiguredHint,
};
