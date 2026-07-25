'use strict';

/**
 * cliErrorReporter.js — CLI 错误面板的终端渲染层（cli 表现层）。
 *
 * 「真实原因 + 解决方案」的纯描述逻辑已下沉到 service 层单一真源
 * src/services/cliErrorDescriptor.js（DESIGN-ARCH-057）：原先它既依赖 service
 * 又被 service（daemonEntry / crashRecovery）反向 require，构成 service→cli 分层违例。
 * 本模块现仅负责把描述结果渲染到终端（cli→service，合法方向），并为向后兼容
 * 再导出下沉后的纯符号，保持既有 import 面不变。
 *
 * 红线（来自 /goal「错误不要只出现 exit -1」）见 cliErrorDescriptor.js。
 */

const {
  describeCliError,
  KIND_REMEDIATION,
  ERRNO_REMEDIATION,
  GENERIC_REMEDIATION,
} = require('../services/cliErrorDescriptor');

/**
 * 渲染错误面板（真实原因 + 解决方案）。优先用 printErrorPanel，缺失则逐行降级。
 * @param {unknown} err
 * @param {object} [opts] 同 describeCliError，另支持 opts.formatters 注入（测试用）
 */
function reportCliError(err, opts = {}) {
  const desc = describeCliError(err, opts);
  let fmt = opts.formatters;
  if (!fmt) {
    try { fmt = require('./formatters'); } catch { fmt = null; }
  }
  if (fmt && typeof fmt.printErrorPanel === 'function') {
    fmt.printErrorPanel({
      title: desc.title,
      message: desc.reason,
      suggestions: desc.suggestions,
      stack: opts.showStack === false ? undefined : desc.stack,
    });
  } else if (fmt && typeof fmt.printError === 'function') {
    fmt.printError(desc.reason);
    desc.suggestions.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
  } else {
    console.error(`✗ ${desc.reason}`);
    desc.suggestions.forEach((s, i) => console.error(`    ${i + 1}. ${s}`));
  }
  return desc;
}

/**
 * 单行形态：「真实原因 ｜ 解决: 第一条建议」。
 * 用于 TUI 消息内容、远程执行等不便渲染整块面板的场景——仍带原因与解决方向。
 */
function formatCliErrorLine(err, opts = {}) {
  const desc = describeCliError(err, opts);
  const fix = desc.suggestions[0] ? ` ｜ 解决: ${desc.suggestions[0]}` : '';
  return `${desc.reason}${fix}`;
}

module.exports = {
  // 纯描述逻辑下沉到 service 层，这里再导出以保持向后兼容的 import 面
  describeCliError,
  reportCliError,
  formatCliErrorLine,
  // 导出供测试/扩展
  KIND_REMEDIATION,
  ERRNO_REMEDIATION,
  GENERIC_REMEDIATION,
};
