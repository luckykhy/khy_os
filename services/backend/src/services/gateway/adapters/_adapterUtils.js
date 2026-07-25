/**
 * @pattern Facade
 */
'use strict';

/**
 * _adapterUtils.js — 适配器间共享的小工具函数
 *
 * 从 6+ 个适配器中提取的重复工具函数。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 将逗号/换行分隔的字符串（或数组）解析为去空白的字符串数组。
 * 合并了简单版（cursorAdapter 等）和增强版（kiroAdapter, _proxyTunnel 等）。
 *
 * @param {string|string[]} raw
 * @returns {string[]}
 */
function parseList(raw) {
  if (Array.isArray(raw)) {
    return raw.map(v => String(v || '').trim()).filter(Boolean);
  }
  return String(raw || '')
    .split(/[\n,]/g)
    .map(v => String(v || '').trim())
    .filter(Boolean);
}

/**
 * 对字符串数组去重（大小写敏感）。
 * 合并了 traeAdapter.dedupe, windsurfAdapter.dedupeValues, _proxyTunnel.dedupe。
 *
 * @param {string[]} values
 * @returns {string[]}
 */
function dedupe(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 对路径数组去重（通过 path.normalize 标准化后去重）。
 * 合并了 cursorAdapter.dedupePaths 和 vscodeAdapter.dedupePaths。
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
function dedupePaths(paths = []) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    const key = String(p || '').trim();
    if (!key) continue;
    const normalized = path.normalize(key);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * 安全解析正整数，带范围约束。
 * 来自 relayApiAdapter._parsePositiveInt。
 *
 * @param {*} raw - 输入值
 * @param {number} fallback - 解析失败时的回退值
 * @param {number} [min=1] - 最小值
 * @param {number} [max=Infinity] - 最大值
 * @returns {number}
 */
function parsePositiveInt(raw, fallback, min = 1, max = Infinity) {
  const parsed = parseInt(String(raw ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

/**
 * 压缩文本：合并连续空白，截断至 maxLen。
 * 来自 codexAdapter.compactText。
 *
 * @param {*} value - 输入值
 * @param {number} [maxLen=200] - 最大长度
 * @returns {string}
 */
function compactText(value, maxLen = 200) {
  const t = String(value || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/**
 * 解析用户主目录列表，包括 WSL 挂载的 Windows 用户目录。
 * 合并了 cursorAdapter.resolveUserHomeRoots 和 vscodeAdapter.resolveUserHomeRoots。
 *
 * @returns {string[]}
 */
function resolveUserHomeRoots() {
  const roots = [
    os.homedir(),
    process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
      : '',
  ];

  const isWsl = process.platform === 'linux'
    && (
      !!process.env.WSL_DISTRO_NAME
      || !!process.env.WSL_INTEROP
      || fs.existsSync('/mnt/c/Windows')
    );
  if (isWsl) {
    const userHints = dedupePaths([
      process.env.USERNAME ? `/mnt/c/Users/${process.env.USERNAME}` : '',
      process.env.USER ? `/mnt/c/Users/${process.env.USER}` : '',
    ]);
    roots.push(...userHints);
    for (const drive of ['c', 'd', 'e']) {
      const usersDir = `/mnt/${drive}/Users`;
      try {
        if (!fs.existsSync(usersDir)) continue;
        const entries = fs.readdirSync(usersDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          roots.push(path.join(usersDir, entry.name));
        }
      } catch {
        // ignore unreadable mounts
      }
    }
  }

  return dedupePaths(roots);
}

module.exports = {
  parseList,
  dedupe,
  dedupePaths,
  parsePositiveInt,
  compactText,
  resolveUserHomeRoots,
};
