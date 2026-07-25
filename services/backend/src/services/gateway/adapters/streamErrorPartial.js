'use strict';

// streamErrorPartial.js — pure leaf (zero IO, deterministic, never throws, unit-testable).
//
// 目的:当 API 流式响应在「已吐出半句之后」因连接抖动硬断(ECONNRESET / socket hang up /
// premature close …)时,把已累积的 partial 文本保全下来,对齐同文件已有的
// premature-close 处理(resolve 成 finishReason:'length'),喂给既有的 maxTokensRecovery
// 续写路径,而不是 `reject(err)` 把已产出文本整段丢弃。
//
// 背景(诊断):_openaiSseStream.js 的 stream.on('error') 早已这样做(非中止 + 已有进度 →
// resolve 成 length + interrupted),但 _anthropicSseStream.js 仍 `reject(err)`,闭包里已累积
// 的 content 随之丢弃;buildFailure 又强制 content:''。本叶子把这条"已被验证、已在 OpenAI
// 路径生效"的策略收敛成单源,供 Anthropic 路径接上,达成两 adapter 一致。
//
// 策略(= OpenAI 路径既有逻辑,单源化):
//   • 已有进度(hasContent)且非用户/stall 主动中止 → 保全 partial 续写(true)。
//   • 用户/stall 主动中止(AbortError / signal.aborted)→ false(意图优先,绝不当截断)。
//   • 零进度错误 → false(无可保全;交回 reject 让上游分类真错误)。
// 诚实边界:transport 层在已 200+吐内容之后才触发的 error 绝大多数是通道抖动;鉴权/4xx/
// 配额一般在出字节之前就以非 200 报错(零进度),因此 hasContent 这道闸已把"需要被分类的
// 真错误"挡在保全之外。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 用户/stall 主动中止 —— 意图优先,绝不当截断续写。错误对象的 name/code/message 任一命中即视为中止。
const ABORT_RE = /AbortError|ABORT_ERR|aborted by (?:the )?user|operation was aborted/i;

// 典型瞬时传输错误码 —— 仅作可观测/诊断参考(策略主判据是"非中止 + 有进度",不依赖此表)。
const TRANSIENT_RE = new RegExp(
  '(?:ECONNRESET|socket hang ?up|ETIMEDOUT|ECONNABORTED|ECONNREFUSED|EPIPE'
  + '|ENETUNREACH|ENETRESET|EHOSTUNREACH|EAI_AGAIN|premature close|read ECONN'
  + '|stream (?:closed|ended) unexpectedly)',
  'i',
);

/**
 * partial 保全默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_STREAM_ERROR_PRESERVE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 从 error 对象抽取分类签名(code + name + message)。
 * @param {*} error
 * @returns {string}
 */
function _errorSignature(error) {
  if (!error) return '';
  const code = error.code == null ? '' : String(error.code);
  const name = error.name == null ? '' : String(error.name);
  const message = error.message == null ? '' : String(error.message);
  return `${code} ${name} ${message}`.trim();
}

/**
 * 该 error 是否为用户/stall 主动中止。
 * @param {{ error?: *, aborted?: boolean }} [opts]
 * @returns {boolean}
 */
function isUserAbort(opts = {}) {
  const o = opts || {};
  if (o.aborted) return true;
  const err = o.error;
  if (err && err.name === 'AbortError') return true;
  return ABORT_RE.test(_errorSignature(err));
}

/**
 * 是否应在 socket error 时保全已累积 partial(转 length 续写路径)而非 reject。
 *   • 门控关 → false(逐字节回退 reject)
 *   • 无已累积内容 → false(无可保全,维持 reject 让上游分类)
 *   • 用户/stall 主动中止 → false(意图优先)
 *   • 其余(非中止 + 有进度)→ true
 *
 * @param {{ error?: *, hasContent?: boolean, aborted?: boolean }} [opts]
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldPreservePartial(opts = {}, env = process.env) {
  if (!isEnabled(env)) return false;
  const o = opts || {};
  if (!o.hasContent) return false;
  if (isUserAbort(o)) return false;
  return true;
}

module.exports = {
  isEnabled,
  shouldPreservePartial,
  isUserAbort,
  OFF_VALUES,
  ABORT_RE,
  TRANSIENT_RE,
};
