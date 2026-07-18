'use strict';

/**
 * grepWindowsDriveKey.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 smartTruncation._filterSearchOutput 的「Windows 盘符冒号被当成 file:line 分隔符」缺陷:
 * 该过滤器把 grep 风格输出按**第一个冒号**切出「文件名」用于按文件折叠重复匹配
 * (每文件保留前 3 条)。但 Windows ripgrep/grep 输出形如 `C:\proj\file.js:1:content`,
 * 第一个冒号是**盘符冒号** → 每一行的「文件名」都被切成 `"C"` → 所有不同文件塌进同一
 * 个 `"C"` 桶 → 只有前 3 行存活,其余(可能几百个不同文件的匹配)被静默丢弃。
 * (Linux 路径无盘符冒号,不受影响。)
 *
 * 本叶子给出**修正后**的分隔冒号下标:行首匹配 `^[A-Za-z]:[\\/]`(盘符 + 分隔符)时,
 * 取盘符冒号**之后**的第一个冒号(真正的 file:line 分隔);否则退化为第一个冒号(与
 * legacy `line.indexOf(':')` 完全一致)。门控 KHY_GREP_WIN_DRIVE_DEDUP(默认开):
 * 关(0/false/off/no)/异常 → 返回 null,调用方逐字节回退到原 `line.indexOf(':')`,
 * 从而门关时 Windows/Linux 均与历史行为逐字节相同。flagRegistry 优先,失败回退本地
 * CANON 解析;绝不抛。
 *
 * 严格超集:仅当门开**且**行首是 `盘符:[\\/]` 形态时改变切分点;其余所有行
 * (含全部 Linux 路径)返回值等于 `line.indexOf(':')`,逐字节等价。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 行首盘符:单个字母 + 冒号 + 反斜杠或正斜杠(`C:\` / `c:/`)。
const _WIN_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/**
 * 门控 KHY_GREP_WIN_DRIVE_DEDUP:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function grepWinDriveDedupEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_GREP_WIN_DRIVE_DEDUP', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_GREP_WIN_DRIVE_DEDUP;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 返回该 grep 行用于切出「文件名」的分隔冒号下标(供 _filterSearchOutput 按文件折叠):
 *   - 门关 / 非字符串 / 异常 → null(调用方回退 `line.indexOf(':')`);
 *   - 门开且行首 `盘符:[\\/]` → 盘符冒号之后的第一个冒号(`line.indexOf(':', 2)`),
 *     使 Windows 盘符路径按真文件名分桶;
 *   - 门开且非盘符行 → `line.indexOf(':')`(与 legacy 逐字节一致)。
 * @param {string} line
 * @param {Record<string,string>} [env]
 * @returns {number|null}
 */
function resolveGrepSeparatorIndex(line, env = process.env) {
  try {
    if (!grepWinDriveDedupEnabled(env)) return null;
    if (typeof line !== 'string') return null;
    if (_WIN_DRIVE_PREFIX.test(line)) {
      return line.indexOf(':', 2); // 跳过盘符冒号(下标 1),取其后第一个
    }
    return line.indexOf(':');
  } catch {
    return null;
  }
}

module.exports = {
  grepWinDriveDedupEnabled,
  resolveGrepSeparatorIndex,
};
