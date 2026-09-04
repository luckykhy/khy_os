'use strict';

/**
 * ccSwitch opencodeGoQuota — OpenCode Go 订阅额度查询（CC Switch v3.20.1 最低优先项）。
 *
 * OpenCode Go 的用量端点只认 Bearer 认证（与推理侧只认 x-api-key 相反），按
 * 5 小时 / 周 / 月三个窗口返回用量百分比与重置时间。
 *
 * 零硬编码红线：本模块**不内联**任何第三方额度端点字面量。端点必须由环境变量
 * `KHY_OPENCODE_GO_QUOTA_URL` 提供（或经 serviceDefaults 注册）——未配置时
 * 诚实返回「未配置」而不是伪造一张空用量卡。这符合 AGENTS.md「生产端点必须从
 * constants/serviceDefaults.js 导入或 env 覆盖」的规则，也避免把非公开端点
 * 固化进源码（v3.19.0 release notes 明示 xAI 等额度端点可能失效）。
 */

const { request: nativeRequest } = require('../../../../utils/nativeHttp');

const WINDOWS = ['5h', 'week', 'month'];

/**
 * 解析额度端点（env 优先；未配置返回 null）。
 * @param {object} [env]
 * @returns {string|null}
 */
function resolveQuotaUrl(env = process.env) {
  const raw = String((env && env.KHY_OPENCODE_GO_QUOTA_URL) || '').trim();
  return raw || null;
}

/**
 * 查询 OpenCode Go 订阅额度。
 *
 * @param {{ apiKey?: string, timeoutMs?: number, env?: object }} opts
 * @returns {Promise<{ ok: boolean, configured: boolean, windows?: Array<{window:string, percent:number, resetAt:string|null}>, error?: string }>}
 */
async function fetchOpenCodeGoQuota({ apiKey, timeoutMs, env } = {}) {
  const url = resolveQuotaUrl(env || process.env);
  if (!url) {
    return {
      ok: false,
      configured: false,
      error: '未配置 KHY_OPENCODE_GO_QUOTA_URL（零硬编码：额度端点必须由 env 提供）',
    };
  }
  if (!apiKey) {
    return { ok: false, configured: true, error: '缺少 API 密钥（该端点只认 Bearer 认证）' };
  }
  try {
    const resp = await nativeRequest(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000,
    });
    if (resp.status === 403) {
      return {
        ok: false,
        configured: true,
        error: 'HTTP 403：密钥有效但未订阅 OpenCode Go 计划',
        status: 403,
      };
    }
    if (resp.status !== 200) {
      return {
        ok: false,
        configured: true,
        error: `HTTP ${resp.status}`,
        status: resp.status,
      };
    }
    const body = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body;
    const windows = parseWindows(body);
    if (!windows.length) {
      return {
        ok: false,
        configured: true,
        error: '无法识别的用量响应形状',
        status: 200,
      };
    }
    return { ok: true, configured: true, windows };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      error: (e && e.message) || String(e),
    };
  }
}

/**
 * 从响应体解析三窗口用量。宽容提取：接受
 *   { windows: { 5h: {...}, week: {...}, month: {...} } }  或
 *   { 5h: { percent, resetAt }, week: ..., month: ... }    或
 *   { usage: [ { window:'5h', percent, resetAt }, ... ] }
 * 零用量窗口丢弃占位重置时间（对齐 v3.20.1：不显示上游的假重置时间）。
 *
 * @param {*} body
 * @returns {Array<{window:string, percent:number, resetAt:string|null}>}
 */
function parseWindows(body) {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const src =
    (body.windows && typeof body.windows === 'object' ? body.windows : null) ||
    (body.usage && Array.isArray(body.usage) ? { _arr: body.usage } : null) ||
    body;
  const out = [];
  for (const windowName of WINDOWS) {
    const entry = src[windowName] || (src._arr && src._arr.find((x) => (x && x.window) === windowName));
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const pct = Number(entry.percent);
    if (!Number.isFinite(pct)) {
      continue;
    }
    const resetAt = typeof entry.resetAt === 'string' && entry.resetAt.trim() ? entry.resetAt : null;
    // 零用量窗口丢弃上游的占位重置时间（对齐 v3.20.1）。
    if (pct <= 0 && !resetAt) {
      out.push({ window: windowName, percent: 0, resetAt: null });
      continue;
    }
    out.push({ window: windowName, percent: Math.max(0, Math.min(100, pct)), resetAt });
  }
  return out;
}

module.exports = { fetchOpenCodeGoQuota, parseWindows, resolveQuotaUrl, WINDOWS };
