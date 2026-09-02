// notify — 集中式错误通知层（结构化，薄封装，复用 Element Plus 的 ElMessage）。
//
// v2 改动（错误结构化）：
//   - 引入 KhyError 七件套模型，按 severity 选 toast 形态：
//       silent → 不弹
//       info   → ElMessage({ type: 'info' })
//       warn   → ElMessage({ type: 'warning' })
//       error  → ElMessage({ type: 'error' })  + 4s 自动关
//       fatal  → ElMessage({ type: 'error', duration: 0 }) 持久不关 + 跳转兜底页
//   - 不再依赖 Element Plus 内部 type 字段映射；调用方传 KhyError 实例即可，
//     旧调用方传 string 仍兼容（自动规整为 KhyError）。
//   - 保留去重逻辑：同 code 在 3s 窗口内只弹一次。
//   - 保留 fail-soft：ElMessage 不可用降级 console。
//
// 其它改动见：services/backend/src/cli/reportKhyError.js（CLI 同源）
//            platform/packages/shared/src/errorEnvelope.js（HTTP 序列化）
import { ElMessage } from 'element-plus';
import { classifyKhyError } from '../utils/classifyKhyError.mjs';

// 同一 code 的最近弹出时间戳。窗口内重复 code 被抑制。
const recent = new Map();
const DEDUPE_WINDOW_MS = 3000;

// severity → ElMessage.type 的映射。fatal 不在这里走 —— 它走单独的 modal 流。
const SEVERITY_TO_TOAST_TYPE = Object.freeze({
  silent: null,    // null = 不弹
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'error',  // fatal 仍走 ElMessage.error 但 duration:0 不自动关
});

function shouldSuppress(key) {
  const now = Date.now();
  const last = recent.get(key);
  // 顺带清理过期项，避免 Map 无限增长。
  for (const [k, t] of recent) {
    if (now - t > DEDUPE_WINDOW_MS) recent.delete(k);
  }
  if (last && now - last < DEDUPE_WINDOW_MS) return true;
  recent.set(key, now);
  return false;
}

/**
 * 弹出一条错误/警告/信息提示（去重、fail-soft、按 severity 分级）。
 * @param {string|Error|KhyErrorShape} input - 任意错误值
 * @param {{ dedupe?: boolean, duration?: number, action?: string, target?: string }} [opts]
 */
export function notifyError(input, opts = {}) {
  const env = _ensureKhy(input, opts);
  if (!env) return;
  // silent：连去重 map 都不写，避免污染。
  if (env.severity === 'silent') return;

  const toastType = SEVERITY_TO_TOAST_TYPE[env.severity];
  if (toastType == null) return;

  const dedupeKey = `${env.code}|${env.severity}`;
  const { dedupe = true, duration = env.severity === 'fatal' ? 0 : 4000 } = opts;
  if (dedupe && shouldSuppress(dedupeKey)) return;

  // fatal 走 modal 持久化（duration:0 + showClose），其它走普通 toast。
  // 文案格式：[分类] 错误码 · 摘要（提示：下一步）
  const text = _formatToast(env);
  try {
    ElMessage({ message: text, type: toastType, duration, showClose: true, grouping: true });
  } catch {
    // Element Plus 不可用时不至于让调用链崩溃。
    try {
      // eslint-disable-next-line no-console
      console.error('[notify]', text);
    } catch {
      /* noop */
    }
  }
}

/**
 * 把任意输入规整成 KhyErrorShape —— 后端 envelope / 原生 Error / 字符串皆可。
 * 没匹配上任何已知 shape 的就走兜底 UNKNOWN。
 */
function _ensureKhy(input, opts) {
  if (!input) return null;
  // 已是 KhyError
  if (input && input.isKhyError === true && typeof input.code === 'string') return input;
  // 后端 KhyErrorEnvelope（HTTP 响应里直接返回的）
  if (input && typeof input.code === 'string' && (input.category || input.severity)) return input;
  // 原生 Error / 字符串 / 任意 → 走分类器
  return classifyKhyError(input, { fallbackCode: 'UNKNOWN' });
}

/**
 * 把 KhyErrorShape 渲染成 toast 文案。
 * 形如：[warn] 上游服务 · RATE_LIMITED · 上游限流（提示：等几秒再试）
 */
function _formatToast(env) {
  const tag = env.severity === 'fatal' ? 'fatal' : (env.severity || 'error');
  const code = env.code || 'UNKNOWN';
  const msg = String(env.message || code).slice(0, 80);
  const hint = env.hint ? `（提示：${String(env.hint).slice(0, 60)}）` : '';
  return `[${tag}] ${code} · ${msg}${hint}`;
}

/**
 * 从任意 error/HTTP 响应里推导一句人话文案 —— 旧 API（向后兼容）。
 * 内部委托 notifyError，避免双实现。
 * @param {*} error
 * @param {{ fallback?: string }} [opts]
 * @returns {string}
 */
export function deriveErrorMessage(error, opts = {}) {
  const fallback = opts.fallback || '操作失败，请稍后重试。';
  if (!error) return fallback;
  // 拦截器已备好的文案优先。
  if (error.userMessage) return String(error.userMessage);
  const env = classifyKhyError(error, { fallbackCode: 'UNKNOWN' });
  // 从 KhyError 还原成老接口期望的纯文本。
  const hint = env.hint ? `（提示：${env.hint}）` : '';
  return `${env.message || env.code}${hint}`;
}