'use strict';

/**
 * humanBytes.js — 字节数 → 人类可读串的单一真源
 *
 * 收敛以下 10+ 处独立实现：
 *   - services/byteFormat.js humanBytes
 *   - services/cleanupService.js humanSize
 *   - services/aiUploadStore.js humanSize
 *   - services/imageMetadataProbe.js _humanSize
 *   - services/localBrainEnvOptimize.js _humanBytes
 *   - services/multimodalInputService.js _formatBytes
 *   - services/repoDisciplineRisk.js _humanSize
 *   - services/toolDataSummary.js _humanSize
 *   - cli/ccFormat.js ccFormatFileSize
 *   - memdir/memdir.js _formatBytes
 *
 * 契约:零 I/O、确定性、绝不抛。
 *   - 非有限 / <=0 → '0 B'
 *   - 单位从 1024 起进位
 *   - >=100 的值或 B 档取整，否则保 1 位小数
 *
 * @param {number} bytes 字节数
 * @returns {string} 如 '512 B' / '1.5 KB' / '340 MB' / '2 GB'
 */
function humanBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

module.exports = { humanBytes };
