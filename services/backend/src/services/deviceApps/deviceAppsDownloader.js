'use strict';

/**
 * deviceAppsDownloader.js — 带**字节级进度**的下载器(设备应用下载/安装包获取)。
 *
 * 诉求「下载时要能看到进度条」的后端支撑:流式下载、按 on('data') 累计字节、读
 * content-length 得总量,回调 onProgress({downloaded,total,percent,known}) 供 CLI
 * 用 ProgressBar 回车重绘。
 *
 * 分层:
 *   - computeProgress(downloaded, total) —— 确定性纯函数(不做 IO、绝不抛),把已下/总量
 *     折算为 {downloaded,total,percent,known}。可 node:test 全量覆盖(沙盒无法真实网络下载)。
 *   - downloadWithProgress(...) —— 薄 IO 壳:SSRF 校验 → axios stream → 累计字节 → 落盘。
 *
 * 安全红线:
 *   - 下载前必过 ssrfGuard.validateUrl(DNS 解析后 fail-closed,私网/特殊用途地址一律拒)。
 *   - 重定向逐跳做同步主机名封锁检查(beforeRedirect);仅允许 http(s)。
 */

const MAX_REDIRECTS = 5;

/**
 * 把已下载/总字节折算为进度快照(纯函数)。
 * total<=0(服务器未给 content-length)→ known:false、percent:0(调用方显示为「未知总量」)。
 * @param {number} downloaded
 * @param {number} total
 * @returns {{downloaded:number,total:number,percent:number,known:boolean}}
 */
function computeProgress(downloaded, total) {
  const d = Number.isFinite(downloaded) && downloaded > 0 ? Math.floor(downloaded) : 0;
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (t <= 0) return { downloaded: d, total: 0, percent: 0, known: false };
  const capped = d > t ? t : d; // 防越界(chunk 可能因编码略超)
  const percent = Math.max(0, Math.min(100, Math.round((capped / t) * 100)));
  return { downloaded: capped, total: t, percent, known: true };
}

/**
 * 人类可读字节数(KB/MB/GB,纯函数)。用于 CLI 进度标签。
 * @param {number} n
 * @returns {string}
 */
function formatBytes(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${units[i]}`;
}

/**
 * 流式下载并按字节回调进度。SSRF 守卫、仅 http(s)、重定向逐跳查封锁主机名。
 *
 * @param {string} url 下载地址(http/https)
 * @param {string} destPath 目标文件路径
 * @param {(p:{downloaded:number,total:number,percent:number,known:boolean})=>void} [onProgress]
 * @param {object} [opts] 注入点:{ axios, fs, validateUrl, timeoutMs, ssrfPolicy, headers, throttleMs }
 * @returns {Promise<{bytes:number,total:number,path:string}>}
 */
async function downloadWithProgress(url, destPath, onProgress, opts = {}) {
  const axios = opts.axios || require('axios');
  const fs = opts.fs || require('fs');
  const validateUrl = opts.validateUrl || require('../ssrfGuard').validateUrl;
  const { isBlockedHostnameOrIp } = require('../ssrfGuard');
  const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 600000;
  const throttleMs = Number.isFinite(opts.throttleMs) ? opts.throttleMs : 120;
  const emit = typeof onProgress === 'function' ? onProgress : () => {};

  // 1) SSRF:DNS 解析后校验初始 URL(私网/特殊地址 fail-closed)。
  await validateUrl(url, opts.ssrfPolicy || {});

  // 2) 流式请求。beforeRedirect 对每个重定向目标做同步主机名封锁检查(字面私网/封锁名)。
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout,
    maxRedirects: MAX_REDIRECTS,
    headers: Object.assign({ 'User-Agent': 'khy-device-apps' }, opts.headers || {}),
    beforeRedirect: (options) => {
      const host = options && (options.hostname || options.host);
      if (host && isBlockedHostnameOrIp(String(host))) {
        throw new Error(`Blocked redirect target: ${host}`);
      }
    },
  });

  const total = Number(response.headers && response.headers['content-length']) || 0;
  let downloaded = 0;
  let lastEmit = 0;

  // 3) 落盘 + 字节累计。节流回调(throttleMs),但 100%/首帧必发。
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { ws.destroy(); } catch (_) { /* ignore */ }
      reject(err);
    };
    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = _now();
      if (now - lastEmit >= throttleMs) {
        lastEmit = now;
        try { emit(computeProgress(downloaded, total)); } catch (_) { /* onProgress 不得中断下载 */ }
      }
    });
    response.data.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      try { emit(computeProgress(downloaded, total)); } catch (_) { /* ignore */ }
      resolve();
    });
    response.data.pipe(ws);
  });

  return { bytes: downloaded, total, path: destPath };
}

// 隔离时间源,便于节流逻辑测试(且遵守叶子约束由 IO 壳承担)。
function _now() {
  return Date.now();
}

module.exports = {
  computeProgress,
  formatBytes,
  downloadWithProgress,
  MAX_REDIRECTS,
};
