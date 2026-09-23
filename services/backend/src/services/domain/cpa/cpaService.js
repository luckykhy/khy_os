'use strict';

/**
 * cpaService — CPA (CLIProxyAPI) 接入层服务（DESIGN-CPA-002 P1）。
 *
 * 组合三个已验证的构件，对外给出单一接入面：
 *   - cpaKeyPool.js          账号 CRUD + 冷却退避 + 热重载（凭据 AES-256-GCM 落盘）
 *   - cpaProtocolConverter   协议转换纯函数（anthropic/gemini ⇄ OpenAI）
 *   - 端口顺延自愈           请求端口被占 → 探测下一个可用端口并回报实际值（绝不 EADDRINUSE 崩溃）
 *
 * 端点/参数单一真源：constants/serviceDefaults（CPA_SERVICE / CPA_KEY_POOL）。
 * 绝不硬编码 host:port —— 实际端口永远经探测顺延，动态发现。
 */

const net = require('node:net');
const path = require('node:path');

const pool = require('./cpaKeyPool');
const cvt = require('./cpaProtocolConverter');
const { CPA_KEY_POOL, CPA_SERVICE } = require('../../../constants/serviceDefaults');
const { encryptApiKey, decryptApiKey } = require('../../channelApiCrypto');

// ── 账号 CRUD（透传 cpaKeyPool）──────────────────────────────────────────
function addAccount(spec) {
  return pool.addAccount(spec);
}
function listAccounts() {
  return pool.listAccounts();
}
function getAccount(id) {
  return pool.getAccount(id);
}
function updateAccount(id, patch) {
  return pool.updateAccount(id, patch);
}
function removeAccount(id) {
  return pool.removeAccount(id);
}
function getAccountState(id) {
  return pool.getAccountState(id);
}
function setAccountState(id, status) {
  return pool.setAccountState(id, status);
}
function reportResult(id, result) {
  if (result && result.ok) {
    pool.markSuccess(id);
  } else {
    pool.markFailure(
      id,
      result && result.statusCode,
      result && result.error,
      result && result.retryAfterSec
    );
  }
}
function revealAccountCredential(id) {
  return pool.revealCredential(id).credential;
}

// 测试钩子（S2 惰性恢复用）
const __testHooks = {
  forceCooldownExpiry: (id) => pool.__testHooks.forceCooldownExpiry(id),
  clearCooldown: (id) => pool.__testHooks.clearCooldown(id),
};

// ── 协议转换（透传 cpaProtocolConverter，未知协议 → null）────────────────
function convertRequest(protocol, body) {
  switch (String(protocol || '').toLowerCase()) {
    case 'anthropic':
      return cvt.anthropicToOpenaiRequest(body);
    case 'gemini':
      return cvt.geminiToOpenaiRequest(body);
    default:
      return null; // 未知协议不猜（S4）
  }
}

function convertResponse(protocol, body) {
  switch (String(protocol || '').toLowerCase()) {
    case 'anthropic':
      return cvt.openaiToAnthropicResponse(body);
    case 'gemini':
      return cvt.openaiToGeminiResponse(body);
    default:
      return null;
  }
}

// ── 端口顺延自愈（S5）────────────────────────────────────────────────────
/** 探测某回环端口是否已被占用（connect 成功 → true 被占；失败 → false 空闲）。 */
function probePort(port) {
  return new Promise((resolve) => {
    const host = CPA_SERVICE.LOOPBACK_HOST;
    const s = net
      .createConnection({ host, port }, () => {
        s.destroy();
        resolve(true); // 连上了 = 端口被占
      })
      .on('error', () => resolve(false)); // 连不上 = 空闲
    s.setTimeout(1500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

/**
 * 找一个可用端口：被占 → 逐个探测到 P+scanLimit 为止，回报实际落点。
 * @param {number} requested  请求端口
 * @param {object} [opts]
 * @param {number} [opts.scanLimit=20]  最多顺延探测多少个
 * @returns {Promise<{port:number, requested:number, shifted:boolean}>}
 */
async function findAvailablePort(requested, opts = {}) {
  const limit = Number.isFinite(opts.scanLimit) ? opts.scanLimit : 20;
  const start = Number(requested);
  if (!Number.isFinite(start) || start <= 0) {
    throw new Error('findAvailablePort: requested 端口非法（' + requested + '）');
  }
  // 先探请求端口本身
  if (!(await probePort(start))) {
    return { port: start, requested: start, shifted: false };
  }
  // 被占 → 顺延探测下一个（绝不 EADDRINUSE 崩溃，S5 契约）
  for (let i = start + 1; i <= start + limit; i += 1) {
    if (!(await probePort(i))) {
      return { port: i, requested: start, shifted: true };
    }
  }
  // 顺延区间全被占（极端）→ 抛诚实错误而非静默选一个
  throw new Error(
    `findAvailablePort: ${start}..${start + limit} 全被占，顺延失败，请释放端口或调大 scanLimit`
  );
}

module.exports = {
  // 账号 CRUD / 状态
  addAccount,
  listAccounts,
  getAccount,
  updateAccount,
  removeAccount,
  getAccountState,
  setAccountState,
  reportResult,
  revealAccountCredential,
  // 协议转换
  convertRequest,
  convertResponse,
  // 端口自愈
  probePort,
  findAvailablePort,
  // 参数真源透传（供调用方读冷却参数）
  CPA_KEY_POOL,
  __testHooks,
};
