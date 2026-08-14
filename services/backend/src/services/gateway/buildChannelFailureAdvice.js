'use strict';

/**
 * buildChannelFailureAdvice.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 排障「所有 AI 通道均不可用」的笼统墙:generate 级联穷尽所有通道后
 * (aiGatewayGenerateMethod 末端 guidanceContent),除了 `_prependFailureReason`
 * 已经逐通道列出的「真实失败原因」,本叶子再把**高频可操作**的确定性信号翻译成
 * **下一步指引**,供调用方前置到兜底清单之前:
 *
 *   ① server_error (5xx: 502/503/504) → 上游/代理瞬时故障,稍后重试或检查代理。
 *   ② auth / 401 / 403        → API key 无效或权限不足,检查密钥与账号。
 *   ③ rate_limit / 429        → 通道被限流,降并发、稍后重试。
 *   ④ network / 代理隧道不通   → 传输层故障,检查网络与代理。
 *   ⑤ model_not_found / 404   → 模型名无效或账号未领取,检查模型串/领取。
 *   ⑥ 混合多因                → 逐因列出。
 *
 * 诚实边界:只翻译**已发生**的信号,不做任何写入/网络/重试/猜测;所有分支 fail-soft,
 * 无匹配 → null(逐字节回退今日行为:只显示通用兜底墙)。
 *
 * 契约:纯叶子——零副作用、绝不抛(任何异常 → null)、只吃 { attempts, env }。
 * 门控 KHY_CHANNEL_FAILURE_ADVICE(默认开);关门 → null。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _enabled(env) {
  try {
    const raw = env && env.KHY_CHANNEL_FAILURE_ADVICE;
    const v = String(raw == null ? '' : raw)
      .trim()
      .toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

function _isServerError(att) {
  try {
    if (!att) {
      return false;
    }
    if (att.errorType === 'server_error') {
      return true;
    }
    const sc = Number(att.statusCode);
    if (Number.isFinite(sc) && sc >= 500 && sc <= 599) {
      return true;
    }
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return /502|503|504|bad gateway|service unavailable|gateway timeout|server_error|upstream/.test(
      msg
    );
  } catch {
    return false;
  }
}

function _isAuthFailure(att) {
  try {
    if (!att) {
      return false;
    }
    if (att.errorType === 'auth' || att.errorType === 'permission') {
      return true;
    }
    const sc = Number(att.statusCode);
    if (sc === 401 || sc === 403) {
      return true;
    }
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return /invalid api key|incorrect api key|401|403|unauthorized|forbidden|authentication failed|api key.*(invalid|wrong|missing)|密钥.*(无效|错误|缺失)|没有权限/.test(
      msg
    );
  } catch {
    return false;
  }
}

function _isRateLimited(att) {
  try {
    if (!att) {
      return false;
    }
    if (att.errorType === 'rate_limit') {
      return true;
    }
    if (Number(att.statusCode) === 429) {
      return true;
    }
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return /rate.?limit|too many requests|(^|\D)429(\D|$)|请求过多|并发|限流|code\s*1302/.test(msg);
  } catch {
    return false;
  }
}

function _isNetworkFailure(att) {
  try {
    if (!att) {
      return false;
    }
    if (att.errorType === 'network') {
      return true;
    }
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return /socket hang up|econnreset|econnrefused|enetunreach|ehostunreach|etimedout|eai_again|getaddrinfo|socket disconnected|network (?:error|failure)|连接(?:被)?重置|连接超时|无法连接到|tunneling socket|proxy (?:error|tunnel)|timeout of \d+ms exceeded/.test(
      msg
    );
  } catch {
    return false;
  }
}

function _isModelNotFound(att) {
  try {
    if (!att) {
      return false;
    }
    if (att.errorType === 'model_not_found') {
      return true;
    }
    if (Number(att.statusCode) === 404) {
      return true;
    }
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return /model_not_found|model not found|does not exist|not found|模型.*不存在|未领取/.test(msg);
  } catch {
    return false;
  }
}

const _SERVER_ERROR_FIX =
  '  → 上游/代理瞬时故障(5xx):稍等片刻重试;若持续,运行 `khy gateway status` 检查通道,或 `/proxy` 检查代理。';
const _AUTH_FIX =
  '  → 密钥无效或权限不足:运行 `ai config` 检查/更新该通道的 API key,或确认账号余额与权限。';
const _RATE_LIMITED_FIX = '  → 通道被限流:降低并发、别连发,稍等几分钟待限流窗口重置后重试。';
const _NETWORK_FIX =
  '  → 网络/代理不可达:运行 `khy gateway status` 看实测状态,`/proxy` 配置代理,稍后重试。';
const _MODEL_NOT_FOUND_FIX =
  '  → 模型不存在或未领取:检查模型名是否正确(`/model` 查看),或在厂商控制台领取/开通该模型。';

/**
 * 汇总各通道失败,生成可操作指引。绝不抛;不适用(门关 / 无 attempts / 无匹配信号 /
 * 任何异常)→ null。
 *
 * @param {object} a
 * @param {Array<object>} [a.attempts]  累计失败 attempts(带 errorType/statusCode/error)
 * @param {object} [a.env]              注入 env(可测;默认 process.env)
 * @returns {{ reasons: Array<string>, message: string } | null}
 */
function buildChannelFailureAdvice(input) {
  try {
    const { attempts, env } = input && typeof input === 'object' ? input : {};
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!_enabled(e)) {
      return null;
    }
    const list = Array.isArray(attempts) ? attempts : [];
    if (!list.length) {
      return null;
    }

    const flags = {
      serverError: false,
      auth: false,
      rateLimited: false,
      network: false,
      modelNotFound: false,
    };
    for (const att of list) {
      if (!flags.serverError && _isServerError(att)) {
        flags.serverError = true;
      }
      if (!flags.auth && _isAuthFailure(att)) {
        flags.auth = true;
      }
      if (!flags.rateLimited && _isRateLimited(att)) {
        flags.rateLimited = true;
      }
      if (!flags.network && _isNetworkFailure(att)) {
        flags.network = true;
      }
      if (!flags.modelNotFound && _isModelNotFound(att)) {
        flags.modelNotFound = true;
      }
    }
    const present = Object.entries(flags)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (present.length === 0) {
      return null;
    }

    const lines = ['⚠ 通道失败原因与下一步:'];
    if (flags.serverError) {
      lines.push(_SERVER_ERROR_FIX);
    }
    if (flags.auth) {
      lines.push(_AUTH_FIX);
    }
    if (flags.rateLimited) {
      lines.push(_RATE_LIMITED_FIX);
    }
    if (flags.network) {
      lines.push(_NETWORK_FIX);
    }
    if (flags.modelNotFound) {
      lines.push(_MODEL_NOT_FOUND_FIX);
    }

    return { reasons: present, message: lines.join('\n') };
  } catch {
    return null;
  }
}

module.exports = {
  buildChannelFailureAdvice,
  _isServerError,
  _isAuthFailure,
  _isRateLimited,
  _isNetworkFailure,
  _isModelNotFound,
};
