'use strict';

/**
 * cliErrorDescriptor.js — 「真实原因 + 解决方案」结构化错误描述器（service 层单一真源）。
 *
 * 本模块是纯描述逻辑：输入任意错误（Error / 字符串 / {error,exitCode,stderr}），
 * 输出 { title, reason, exitCode, kind, suggestions, stack } 结构对象，不做任何终端渲染。
 *
 * 分层契约（REQ-2026-001 / DESIGN-ARCH-057）：原先该逻辑位于 cli/cliErrorReporter，
 * 却同时 (a) 依赖 service 层（errorClassifier / failsafe.errorCodes）且 (b) 被 service 层
 * （daemonEntry / crashRecovery）反向 require，构成 service→cli 分层违例。因 describeCliError
 * 本质是消费 service、又服务 service 的纯逻辑，正确归属是 service 层。下沉到此后：
 *   - cli/cliErrorReporter 改为从本模块取 describeCliError 并保留终端渲染包装（cli→service，合法）；
 *   - daemonEntry / crashRecovery 直接 require 本模块，反向边消失。
 *
 * 红线（来自 /goal「错误不要只出现 exit -1」）：
 *   1. 任何错误出口都必须显示真实原因（不止退出码、不止"命令执行失败"）。
 *   2. 必须给出怎么解决（至少一条可操作建议）。
 *   3. suggestions 永不为空——未知错误也回落到通用排查指引。
 */

const {
  formatErrorMessage,
  detectErrorKindDeep,
  extractErrorCode, // eslint-disable-line no-unused-vars -- kept for parity with errorClassifier surface
  suggestRecoveryAction,
} = require('./errorClassifier');

let codes = null;
try {
  codes = require('./failsafe/errorCodes');
} catch { /* failsafe 字典缺失时降级，不影响主流程 */ }

// ── kind → 可操作中文修复指引（高于 suggestRecoveryAction 的动作令牌，给人看） ──
const KIND_REMEDIATION = {
  network: [
    '检查网络连通性（curl/ping 目标地址）。',
    '若处于受限网络，设置代理：export HTTPS_PROXY=http://127.0.0.1:7890。',
  ],
  timeout: [
    '目标响应过慢或不可达：稍后重试，或提高超时阈值。',
    '检查网络/代理是否稳定；必要时切换模型通道或镜像源。',
  ],
  rate_limit: [
    '触发限流：稍候重试，或切换到其他账号/通道。',
    '降低并发与请求频率。',
  ],
  context_length: [
    '上下文超长：运行 /compact 压缩，或 history clear 清理历史。',
    '改用更大上下文窗口的模型。',
  ],
  auth: [
    '凭证无效或过期：运行 khy login（或对应渠道的登录命令）重新认证。',
    '核对 settings.json / 环境变量中的 API Key 是否正确、未过期。',
  ],
  permission: [
    '权限不足：检查文件/目录所有权与读写位（ls -l），必要时调整权限。',
    '受沙箱/审批网关拦截时，按提示确认授权或降低操作影响面。',
  ],
  billing: [
    '账户额度不足或欠费：检查计费状态并充值，或切换可用账号。',
  ],
  model_not_found: [
    '模型不存在或不可用：运行 /model 查看可用模型并改选。',
    '核对模型 ID 拼写与该渠道是否支持该模型。',
  ],
  overloaded: [
    '上游服务过载：稍后重试；khyos 会自动降级到备用通道。',
  ],
  server_error: [
    '上游服务端错误（5xx）：稍后重试；若持续，切换模型通道。',
  ],
  refusal: [
    '内容被安全策略拦截：调整请求内容后重试。',
  ],
  cancelled: [
    '操作已被取消（Ctrl+C / 超时中断）：如非预期，请重新执行。',
  ],
  process: [
    '子进程异常退出或通道关闭：查看下方真实输出定位原因，修正后重跑。',
  ],
};

// ── errno / 系统码 → 具体修复（比 kind 更精确，优先采用） ──
const ERRNO_REMEDIATION = {
  ENOENT: (ctx) => [
    `找不到文件或命令${ctx ? `：${ctx}` : ''}。请确认路径拼写与该可执行文件是否已安装、在 PATH 中。`,
  ],
  EACCES: () => ['权限被拒绝：检查目标的读写/执行权限（chmod / chown），或换用有权限的目录。'],
  EPERM: () => ['操作不被允许：可能需要更高权限或受系统策略限制；核对所有权与运行身份。'],
  EADDRINUSE: (ctx) => [`端口已被占用${ctx ? `：${ctx}` : ''}。换一个端口（--port N），或结束占用该端口的进程（lsof -i:PORT）。`],
  ECONNREFUSED: () => ['目标服务未在监听：确认服务已启动且地址/端口正确（如先运行 khy server start）。'],
  ENOTFOUND: () => ['域名解析失败：检查网络/DNS 与目标地址拼写；受限网络下配置代理。'],
  ETIMEDOUT: () => ['连接超时：检查网络/代理与目标可达性，稍后重试。'],
  ENOSPC: () => ['磁盘空间不足：清理空间后重试（df -h 查看占用）。'],
  EMFILE: () => ['打开文件句柄过多：提高 ulimit -n，或排查句柄泄漏。'],
  MODULE_NOT_FOUND: (ctx) => [`缺少 Node 依赖${ctx ? `：${ctx}` : ''}。在 services/backend 下运行 npm install 后重试。`],
  ELOOP: () => ['符号链接成环：检查目标路径的软链接是否自引用。'],
};

const GENERIC_REMEDIATION = [
  '查看完整堆栈：以 KHY_VERBOSE=1 重新运行该命令。',
  '运行 khy os doctor 进行环境自检；问题可复现时附上上方真实原因反馈。',
];

/** 从错误对象/结果对象中尽力提取退出码（数字）。 */
function _extractExitCode(err) {
  if (err == null || typeof err !== 'object') return undefined;
  for (const key of ['exitCode', 'status', 'statusCode']) {
    const v = err[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  // err.code 可能是数字退出码，也可能是 errno 字符串；仅数字时当退出码
  if (typeof err.code === 'number' && Number.isFinite(err.code)) return err.code;
  return undefined;
}

/** 提取 errno 风格的字符串码（ENOENT / MODULE_NOT_FOUND…）。 */
function _extractErrno(err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) {
    return err.code;
  }
  return undefined;
}

/**
 * 把任意错误归一为「真实原因 + 解决方案」结构。
 *
 * @param {unknown} err  Error / 字符串 / {error|message, exitCode|status, stderr}
 * @param {object} [opts]
 * @param {string} [opts.title]    面板标题（默认按归类生成）
 * @param {string} [opts.context]  命令/操作上下文（如命令名、路径），用于丰富建议
 * @param {string} [opts.stderr]   子进程 stderr（作为真实原因补充）
 * @param {string} [opts.fallbackReason] 实在拿不到原因时的兜底文案
 * @returns {{ title:string, reason:string, exitCode:(number|undefined), kind:(string|undefined), suggestions:string[], stack:(string|undefined) }}
 */
function describeCliError(err, opts = {}) {
  const exitCode = _extractExitCode(err);
  const errno = _extractErrno(err);
  const kind = detectErrorKindDeep(err);

  // 真实原因：优先错误消息链（脱敏），并入显式 stderr。绝不止退出码。
  // 仅从「真正承载文案」的来源取原因，避免把 {exitCode,stderr} 这类结果对象
  // JSON.stringify 成噪音（也会污染退出码判断）。
  let reason = '';
  if (err instanceof Error || typeof err === 'string') {
    reason = formatErrorMessage(err);
  } else if (err && typeof err === 'object') {
    const msg = (typeof err.error === 'string' && err.error.trim())
      ? err.error
      : (typeof err.message === 'string' && err.message.trim() ? err.message : '');
    if (msg) reason = formatErrorMessage(msg);
  }
  const stderrText = (opts.stderr || (err && typeof err === 'object' ? err.stderr : '') || '').toString().trim();
  if (stderrText) {
    const cleaned = formatErrorMessage(stderrText);
    reason = reason && reason !== cleaned ? `${reason} | ${cleaned}` : cleaned;
  }
  reason = (reason || '').trim();
  // 只剩退出码、无任何文案时，至少说明"进程以非零码退出"，并附兜底原因
  if (!reason || reason === '-1' || reason === String(exitCode)) {
    reason = opts.fallbackReason
      || (exitCode != null
        ? `进程以退出码 ${exitCode} 结束，但未输出具体错误信息。`
        : '操作失败，但未捕获到具体错误信息。');
  }
  if (exitCode != null && !reason.includes(`退出码 ${exitCode}`) && !/exit\s*code/i.test(reason)) {
    reason = `${reason}（退出码 ${exitCode}）`;
  }

  // 解决方案：errno 最精确 > kind 映射 > 失败协议字典 > 通用兜底。永不为空。
  const suggestions = [];
  if (errno && ERRNO_REMEDIATION[errno]) {
    suggestions.push(...ERRNO_REMEDIATION[errno](opts.context));
  }
  if (!suggestions.length && kind && KIND_REMEDIATION[kind]) {
    suggestions.push(...KIND_REMEDIATION[kind]);
  }
  if (!suggestions.length && codes && kind) {
    // 失败协议字典按 action 间接给建议
    const action = suggestRecoveryAction(kind);
    const byAction = {
      compress: '上下文过长：先压缩历史再重试。',
      credential_rotate: '切换账号/通道或检查额度后重试。',
      fallback_model: '改用其他可用模型（/model）。',
      reauth: '重新登录认证（khy login）。',
      retry: '这是可重试错误：稍后重试。',
    };
    if (byAction[action]) suggestions.push(byAction[action]);
  }
  if (!suggestions.length) {
    suggestions.push(...GENERIC_REMEDIATION);
  } else {
    // 总是附一条"如何看更多"的兜底，确保用户有下一步
    suggestions.push(GENERIC_REMEDIATION[0]);
  }

  const title = opts.title
    || (kind ? `命令失败（${_kindLabel(kind)}）` : '命令失败');

  const stack = (err instanceof Error && err.stack) ? err.stack : undefined;

  return { title, reason, exitCode, kind, suggestions, stack };
}

function _kindLabel(kind) {
  const labels = {
    network: '网络', timeout: '超时', rate_limit: '限流', context_length: '上下文超限',
    auth: '认证', permission: '权限', billing: '计费', model_not_found: '模型不存在',
    overloaded: '服务过载', server_error: '服务端错误', refusal: '安全拦截',
    cancelled: '已取消', process: '子进程',
  };
  return labels[kind] || kind;
}

module.exports = {
  describeCliError,
  _kindLabel,
  KIND_REMEDIATION,
  ERRNO_REMEDIATION,
  GENERIC_REMEDIATION,
};
