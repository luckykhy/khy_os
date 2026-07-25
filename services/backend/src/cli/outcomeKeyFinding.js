'use strict';

/**
 * outcomeKeyFinding.js — 纯叶子:从**失败**的工具结果里确定式提取「最有信息量的一句根因」,
 * 供 toolOutcomeNarration 的失败分支汇报,让过程旁白说出「为什么没通」而非死板的「我先看下报错」。
 *
 * 真实缺口(2026-07-05 目标):khy 中间过程说明太死板——失败步的参考旁白恒为
 * 「这一步没走通,我先看下报错信息再调整方案」/「命令返回了非零退出码(N),我先看下输出里的报错」。
 * 而失败结果里 `result.error`(shellCommand 的 _composeShellError 产物,已含根因)、`result.output`
 * (stdout+stderr)、`result.stderr` 就摆着根因文本,旁白却完全不读 → 模型转述时也没有根因可说,
 * 用户看到的永远是「看下报错再调整」这类空话,不随实际错误实时调整。
 *
 * 本叶子把结构化结果里的根因**提取成一行**:优先命名异常(XxxError/XxxException,Python traceback
 * 取最后一条=真正抛出的那个)、其次高频环境/姿势错签名(命令找不到/缺模块/权限/路径不存在/端口占用
 * /git fatal/npm ERR!),再兜底短单行 error。提取不到 → null,调用方逐字节回退旧 canned 行。
 *
 * 只**转述解释器/工具自己给出的错误**,不臆测业务逻辑:提取的是报错文本里已有的签名行,不推断
 * 「你的数据有问题」这类猜测。与 shellErrorClassify/pythonInvocationHint(它们产「怎么改」的 hint,
 * 接 composeShellError)分工不同:本叶子只回答**旁白该说的「根因是什么」那一句**,不出修复建议。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_TOOL_OUTCOME_ROOT_CAUSE(默认开,仅显式
 * 0/false/off/no 关);关 / 无根因 / 异常 → null。门控经 flagRegistry 集中判定(CANON),
 * fail-soft 回退本地 CANON。
 *
 * @module cli/outcomeKeyFinding
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定:flagRegistry 优先,回退本地 CANON。默认开。 */
function rootCauseEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_TOOL_OUTCOME_ROOT_CAUSE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_TOOL_OUTCOME_ROOT_CAUSE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 根因提取上限(字符):一行足以点出问题,过长的编译长文由错误 UI 全量呈现。
const _MAX_REASON = 140;

// 命名异常:Python/JS 的 XxxError / XxxException / XxxWarning + 冒号后的消息。
// traceback 末行才是真正抛出的异常,故全文匹配取**最后一条**。
const _NAMED_ERR_RE = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception|Warning))\b\s*:?[ \t]*([^\n]*)/g;

// 高频环境/姿势错签名(命中即返回该行):顺序≈从最专指到较泛。中英各覆盖。
const _SIGN_RES = [
  /ModuleNotFoundError[^\n]*|Cannot find module[^\n]*|No module named[^\n]*/i,
  /(?:command )?not found[^\n]*|is not recognized as[^\n]*|不是内部或外部命令[^\n]*/i,
  /No such file or directory[^\n]*|系统找不到指定的[^\n]*|No such file[^\n]*/i,
  /Permission denied[^\n]*|EACCES[^\n]*|拒绝访问[^\n]*|Access is denied[^\n]*/i,
  /address already in use[^\n]*|EADDRINUSE[^\n]*|端口[^\n]*被占用[^\n]*/i,
  /ENOSPC[^\n]*|No space left on device[^\n]*|磁盘空间[^\n]*/i,
  /fatal:[ \t][^\n]*/i,
  /npm ERR![ \t][^\n]*/i,
  /SyntaxError[^\n]*|invalid syntax[^\n]*/i,
  /error[:：][ \t]?[^\n]*/i,
  /错误[:：][^\n]*/,
];

/** 收紧一行:折叠内部空白、去首尾空白、超长截断带省略号。 */
function _clip(line) {
  const s = String(line || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > _MAX_REASON ? s.slice(0, _MAX_REASON - 1) + '…' : s;
}

/** 从一段文本里取最有信息量的一行根因;取不到返回 ''。 */
function _extractFromText(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';

  // ① 命名异常:取最后一条(traceback 末行=真正抛出的异常)。
  let lastNamed = null;
  _NAMED_ERR_RE.lastIndex = 0;
  let m;
  while ((m = _NAMED_ERR_RE.exec(raw)) !== null) {
    lastNamed = m;
    if (m.index === _NAMED_ERR_RE.lastIndex) _NAMED_ERR_RE.lastIndex++; // 防零宽死循环
  }
  if (lastNamed) {
    const name = lastNamed[1];
    const msg = (lastNamed[2] || '').trim();
    return _clip(msg ? `${name}: ${msg}` : name);
  }

  // ② 高频签名:逐行扫,命中第一条即返回该整行。
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const re of _SIGN_RES) {
    for (const line of lines) {
      if (re.test(line)) return _clip(line);
    }
  }
  return '';
}

/**
 * 从失败结果里提取一句根因。
 * @param {object} result   工具结果(失败态);读 error/output/content/text/stderr
 * @param {object} [env]
 * @returns {string|null}   根因一行,或 null(门控关/无根因/异常)
 */
function salientErrorReason(result, env) {
  try {
    if (!rootCauseEnabled(env)) return null;
    if (!result || typeof result !== 'object') return null;

    // error 优先(shellCommand 已把根因组进 error);其次 stderr/output/content/text。
    const errField = result.error;
    const errText = typeof errField === 'string'
      ? errField
      : (errField && typeof errField.message === 'string' ? errField.message : '');
    const bodyText = [result.stderr, result.output, result.content, result.text]
      .find((x) => typeof x === 'string' && x) || '';

    // 先在 error 里找签名(它更精炼),再退到输出正文。
    let reason = _extractFromText(errText) || _extractFromText(bodyText);

    // 兜底:error 是一句短单行(非多行长文)时,直接用它。
    if (!reason && errText && !errText.includes('\n') && errText.trim().length <= _MAX_REASON) {
      reason = _clip(errText);
    }
    return reason || null;
  } catch {
    return null; // 绝不抛:任何意外 → null,调用方走旧 canned 行
  }
}

module.exports = {
  salientErrorReason,
  rootCauseEnabled,
  // 供测试
  _extractFromText,
};
