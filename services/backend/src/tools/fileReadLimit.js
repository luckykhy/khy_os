'use strict';

/**
 * fileReadLimit.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 文件读取上限的单一真源。复现痛点:用户在 Windows 上「文件(如 html)读不出来」。
 * 两个读取工具(tools/readFile.js、tools/FileReadTool/index.js)历史上把单次读取
 * 上限硬编码为 500KB,**超限即硬报错**并把模型导向 `Bash type`——既偏小(正常 html
 * 常超 500KB),又用「报错 + 改用 shell」的措辞把弱模型带偏,放大 root-cause-2。
 *
 * 本叶子提供:
 *   1) isEnabled(env)                       —— 门控 KHY_FILE_READ_LIMIT(默认开)
 *   2) resolveMaxBytes(env, legacyBytes)    —— 单次读取字节上限(开:更高/env 覆盖;关:legacy)
 *   3) resolveMaxLines(env, legacyLines)    —— 单次返回行数上限(开:更高/env 覆盖;关:legacy)
 *   4) partialOnOversizeEnabled(env)        —— 超限是否走「有界窗口 + 分页提示」(开)而非硬报错(关)
 *   5) buildOversizeNotice({...})           —— 诚实截断提示(纯字符串)
 *
 * 门控关 → 全部逐字节回退历史:resolveMax* 返回各 call-site 传入的 legacy 常量,
 * partialOnOversizeEnabled 返回 false → 调用方维持「超限硬报错」原样。
 * IO(stat / fd 分段读 / 解码)全部留在薄壳,本叶子只算术与拼串。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB —— 正常 html/源码单次读得下
const DEFAULT_MAX_LINES = 5000;
const LEGACY_MAX_BYTES = 500 * 1024;
const LEGACY_MAX_LINES = 2000;

function _isOff(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return OFF_VALUES.includes(v);
}

function _posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 门控 KHY_FILE_READ_LIMIT(默认开)。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  return !_isOff(env && env.KHY_FILE_READ_LIMIT);
}

/**
 * 单次读取字节上限。门控开 → env 覆盖 KHY_FILE_READ_MAX_BYTES,否则 2MB;
 * 门控关 → 返回 call-site 的 legacy 常量(字节回退)。
 * @param {object} env
 * @param {number} [legacyBytes]
 * @returns {number}
 */
function resolveMaxBytes(env = process.env, legacyBytes) {
  const legacy = _posInt(legacyBytes) || LEGACY_MAX_BYTES;
  if (!isEnabled(env)) return legacy;
  const override = _posInt(env && env.KHY_FILE_READ_MAX_BYTES);
  return override || DEFAULT_MAX_BYTES;
}

/**
 * 单次返回行数上限。门控开 → env 覆盖 KHY_FILE_READ_MAX_LINES,否则 5000;
 * 门控关 → 返回 call-site 的 legacy 常量(字节回退)。
 * @param {object} env
 * @param {number} [legacyLines]
 * @returns {number}
 */
function resolveMaxLines(env = process.env, legacyLines) {
  const legacy = _posInt(legacyLines) || LEGACY_MAX_LINES;
  if (!isEnabled(env)) return legacy;
  const override = _posInt(env && env.KHY_FILE_READ_MAX_LINES);
  return override || DEFAULT_MAX_LINES;
}

/**
 * 超限是否走「有界窗口 + 诚实分页提示」而非硬报错。门控开 → true;关 → false。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function partialOnOversizeEnabled(env = process.env) {
  return isEnabled(env);
}

/**
 * 诚实截断提示(纯字符串)。绝不假装读全:明示已读字节/上限与可执行的续读路径。
 * @param {object} opts
 * @param {number} opts.totalBytes  文件总字节
 * @param {number} opts.maxBytes    单次上限
 * @returns {string}
 */
function buildOversizeNotice({ totalBytes, maxBytes } = {}) {
  const tb = _posInt(totalBytes);
  const mb = _posInt(maxBytes) || DEFAULT_MAX_BYTES;
  const tbStr = tb > 0 ? `${tb} 字节` : '较大';
  return `\n\n---\n[文件${tbStr},超过单次读取上限 ${mb} 字节,以上仅为前 ${mb} 字节按行返回的内容。`
    + `如需后续内容:用 offset/limit 在已读窗口内翻页,或提高 KHY_FILE_READ_MAX_BYTES 后重读,或用 shell 分段读取。]`;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  LEGACY_MAX_BYTES,
  LEGACY_MAX_LINES,
  isEnabled,
  resolveMaxBytes,
  resolveMaxLines,
  partialOnOversizeEnabled,
  buildOversizeNotice,
};
