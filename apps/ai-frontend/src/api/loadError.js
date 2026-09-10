import { ref } from 'vue';
import { deriveErrorMessage } from '@/api/notify';

// Empty-catch hygiene.
//
// The frontend had ~137 `catch {}` blocks that resolved to an empty default
// ({}, [], null), so a dead endpoint rendered as an empty table with no signal.
// This helper is the replacement: the failure is recorded on a ref the view can
// render, and the message follows the "problem / code / fix" contract instead
// of "加载失败".
//
// The composable still resolves (never throws) so the view can keep rendering
// the last good data; only the error state is new.

export function useLoadError() {
  return ref('');
}

function statusOf(err) {
  const status = Number(err?.response?.status || 0);
  return Number.isFinite(status) && status > 0 ? status : 0;
}

/**
 * 把一次加载失败变成一句可显示的话。
 * @param {*} err
 * @param {string} subject 被加载的东西（例：用量日志）
 * @param {string} [fix] 用户可以做的一个动作（例：运行 khy doctor）
 * @returns {string}
 */
export function describeLoadError(err, subject, fix = '请稍后重试') {
  const status = statusOf(err);
  const base = deriveErrorMessage(err, { fallback: '' });

  let reason;
  if (status === 401) {
    reason = '登录已失效，请重新登录';
  } else if (status === 403) {
    reason = '当前账号没有权限访问';
  } else if (status === 404) {
    reason = '后端没有这个接口（服务端与前端版本不匹配）';
  } else if (status === 429) {
    reason = '请求过于频繁，请稍后再试';
  } else if (status >= 500) {
    reason = `服务端错误 (${status})`;
  } else if (status >= 400) {
    reason = `请求被拒绝 (${status})`;
  } else if (base && /网络连接异常/.test(base)) {
    reason = '无法连接后端服务，请确认服务已启动';
  } else {
    reason = base ? base.slice(0, 90) : '请求失败';
  }

  return `${subject}加载失败：${reason}，${fix}`;
}

/**
 * 跑一次读取并把失败记到 `loadError` 上。成功时清空错误。
 * loader 返回 undefined/null 时不算错误——后端明确返回空集合是合法结果。
 */
export async function loadInto(subject, loadError, loader, fix) {
  loadError.value = '';
  try {
    return await loader();
  } catch (err) {
    loadError.value = describeLoadError(err, subject, fix);
    return undefined;
  }
}
