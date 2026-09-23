'use strict';

/**
 * ilinkSendPolicy.js — 微信 ilink 轮询/出站/审批的纯策略叶子(零 IO、确定性)。
 *
 * 覆盖:
 *   轮询退避:decideBackoffMs / isSessionExpired / createDedupe
 *   入站意图:parsePermissionReply / parseSlashCommand
 *   出站重试:isRetryableSendError / sendBackoffMs
 *   审批渲染:formatPermissionPrompt
 *
 * 协议常量从 ilinkProtocol 取(单向依赖,不回边宿主)。
 *
 * @module services/messaging/ilinkSendPolicy
 */

const { RET_SESSION_EXPIRED, SEND_BACKOFF_MAX_MS } = require('./ilinkProtocol');

/**
 * 轮询失败后的退避时长。
 * @param {number} consecutiveFailures
 * @param {object} cfg { shortMs, longMs, threshold }
 * @returns {number} 毫秒
 */
function decideBackoffMs(consecutiveFailures, cfg = {}) {
  const n = Number(consecutiveFailures) || 0;
  const threshold = Number(cfg.threshold) || 3;
  const shortMs = Number(cfg.shortMs) || 3000;
  const longMs = Number(cfg.longMs) || 30000;
  return n >= threshold ? longMs : shortMs;
}

/** getupdates 应答是否表示「会话已过期,需重新扫码」。 */
function isSessionExpired(resp) {
  return !!resp && resp.ret === RET_SESSION_EXPIRED;
}

/**
 * 入站去重器。只认 message_id;容量满时淘汰最旧的一半(Set 按插入序迭代)。
 * 有状态但零 IO,可单测。
 * @param {number} max
 */
function createDedupe(max) {
  const cap = Number(max) > 0 ? Number(max) : 1000;
  const seen = new Set();
  return {
    /**
     * @param {number|null} messageId
     * @returns {boolean} true = 是新消息(应处理);false = 重复(应跳过)
     */
    accept(messageId) {
      // 没有 message_id 的报文无法去重,一律放行(宁可重复也不丢)。
      if (messageId == null) {
        return true;
      }
      if (seen.has(messageId)) {
        return false;
      }
      seen.add(messageId);
      if (seen.size > cap) {
        const drop = [];
        const it = seen.values();
        for (let i = 0; i < Math.floor(cap / 2); i++) {
          const { value, done } = it.next();
          if (done) {
            break;
          }
          drop.push(value);
        }
        for (const v of drop) {
          seen.delete(v);
        }
      }
      return true;
    },
    size() {
      return seen.size;
    },
  };
}

/**
 * 判定一条文本是否是权限审批回复。
 * 兼容中英文与常见变体;不匹配返回 null。
 * @param {string} text
 * @returns {'allow'|'deny'|null}
 */
function parsePermissionReply(text) {
  const t = String(text == null ? '' : text)
    .trim()
    .toLowerCase()
    .replace(/[。．.!!]+$/, '');
  if (!t) {
    return null;
  }
  if (t === 'y' || t === 'yes' || t === '是' || t === '好' || t === '允许' || t === '同意') {
    return 'allow';
  }
  if (t === 'n' || t === 'no' || t === '否' || t === '不' || t === '拒绝' || t === '不允许') {
    return 'deny';
  }
  return null;
}

/**
 * 解析斜杠命令。整个剩余部分作为一个原始 args 串(不做分词/引号处理)。
 * @param {string} text
 * @returns {{cmd:string, args:string}|null}
 */
function parseSlashCommand(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t.startsWith('/')) {
    return null;
  }
  const sp = t.indexOf(' ');
  const cmd = (sp === -1 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
  if (!cmd) {
    return null;
  }
  const args = sp === -1 ? '' : t.slice(sp + 1).trim();
  return { cmd, args };
}

/**
 * 这次出站失败值不值得重试。
 *
 * 分类语义与 msgSender._isRetryable 一致(瞬时故障重试、永久错立即放弃),但判据取
 * **结构化字段**而非正则猜消息:ilinkApi 会在抛出的错误上带 `status` / `isTimeout`。
 *   可重试:传输层错(无 status)、超时、429、5xx
 *   不重试:4xx(除 429)—— 报文/鉴权问题,重发多少次都一样,只会拖慢并刷日志
 *
 * @param {{status?:number, isTimeout?:boolean}} err
 * @returns {boolean}
 */
function isRetryableSendError(err) {
  if (!err) {
    return false;
  }
  if (err.isTimeout) {
    return true;
  }
  const status = Number(err.status);
  if (!Number.isFinite(status)) {
    return true;
  } // 传输层错(网络断/DNS/连接重置)
  if (status === 429) {
    return true;
  }
  return status >= 500 && status <= 599;
}

/**
 * 第 attempt 次重试(从 1 起)的退避毫秒:base·2^(attempt-1),封顶 SEND_BACKOFF_MAX_MS。
 * @param {number} attempt
 * @param {number} baseMs
 * @returns {number}
 */
function sendBackoffMs(attempt, baseMs) {
  const b = Number(baseMs) > 0 ? Number(baseMs) : 800;
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(b * 2 ** (n - 1), SEND_BACKOFF_MAX_MS);
}

/**
 * 把权限审批请求渲染成一条微信看得懂的中文提示。
 *
 * 为什么要自己渲染:本地终端那套审批 UI 是 console.log 到 stdout 的,在守护进程里只会
 * 进日志文件、到不了微信。permissionPromptPort 给的是结构化的 (toolName, params, ...),
 * 所以这里负责把它变成一句人能判断的话。
 *
 * 参数值一律截断:params 里可能是整个文件内容,原样发出去既刷屏又可能泄漏敏感内容。
 *
 * @param {object} info { toolName, params, riskInfo, reasoning }
 * @param {number} [maxValueLen] 单个参数值的展示上限
 * @returns {string}
 */
function formatPermissionPrompt(info, maxValueLen = 200) {
  const i = info || {};
  const tool = String(i.toolName || '未知工具');
  const lines = [`🔐 需要你授权执行:${tool}`];

  const risk = i.riskInfo && (i.riskInfo.level || i.riskInfo.risk);
  if (risk) {
    lines.push(`风险等级:${risk}`);
  }

  const params = i.params && typeof i.params === 'object' ? i.params : {};
  // 优先展示最能说明「要动什么」的字段,其余按原序补上。
  const preferred = ['command', 'file_path', 'filePath', 'path', 'url', 'pattern'];
  const keys = Object.keys(params).filter(
    (k) => !k.startsWith('_') && k !== 'explanation' && k !== 'diffPreview'
  );
  keys.sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    if (ia === -1 && ib === -1) {
      return 0;
    }
    if (ia === -1) {
      return 1;
    }
    if (ib === -1) {
      return -1;
    }
    return ia - ib;
  });
  for (const k of keys.slice(0, 6)) {
    let v = params[k];
    if (v && typeof v === 'object') {
      try {
        v = JSON.stringify(v);
      } catch {
        v = '[对象]';
      }
    }
    v = String(v == null ? '' : v);
    if (v.length > maxValueLen) {
      v = `${v.slice(0, maxValueLen)}…(共 ${v.length} 字符)`;
    }
    lines.push(`· ${k}: ${v}`);
  }

  const reasoning = i.reasoning ? String(i.reasoning) : '';
  if (reasoning) {
    lines.push(
      `💭 ${reasoning.length > maxValueLen ? `${reasoning.slice(0, maxValueLen)}…` : reasoning}`
    );
  }

  lines.push('');
  lines.push('回复 y 允许,n 拒绝。超时会自动拒绝。');
  return lines.join('\n');
}

module.exports = {
  decideBackoffMs,
  isSessionExpired,
  createDedupe,
  parsePermissionReply,
  parseSlashCommand,
  isRetryableSendError,
  sendBackoffMs,
  formatPermissionPrompt,
};
