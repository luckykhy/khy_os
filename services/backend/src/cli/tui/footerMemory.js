'use strict';

/**
 * footerMemory.js — 纯叶子:页脚「进程内存(RSS)· pid」段的文案与严重度判定单一真源。
 *
 * Goal(对齐 Claude Code):CC 在 prompt 页脚左侧常驻一段
 *   `{humanizedRSS} · pid:{process.pid}`
 * (src/components/PromptInput/PromptInputFooterLeftSide.tsx:62-76 `useRssDisplay` +
 *  :432-444 常驻 spread 进 parts),每 5s 刷新一次,并按阈值上色:
 *   mb = rss/1MB;level = mb>=1024 ? 'error' : mb>=512 ? 'warning' : 'normal'。
 * 让用户随时看到当前会话进程占了多少内存、进程号是多少(排查卡顿/内存膨胀/找 pid 杀进程)。
 * Khy 页脚此前只有 model/effort/权限模式/上下文,**无任何内存/pid 段**(FooterBar.js 全表)。
 *
 * 关键 LOGIC(即用户所谓「更要注重显示背后的逻辑」):阈值→严重度→颜色的三段带。
 *   本叶子只做「给定 rss 字节 + pid → 产文案 + 判严重度 level」的纯判定;真正读
 *   `process.memoryUsage().rss` / `process.pid`(IO/非确定)与 level→ink 颜色 props 的映射
 *   留在 FooterBar 组件壳里。字节→人读复用既有 SSOT `ccFormat.ccFormatFileSize`
 *   (刀38,142MB/1.3GB 口径,忠实移植 CC formatFileSize)。
 *
 * 设计同 interruptHint.js / retryCountdown.js:纯叶子、env 门控(默认开)、零副作用、
 * 任何异常 fail-soft 返回 null(不渲该段=逐字节回退今日「无内存段」行为)。
 */

const FLAG = 'KHY_FOOTER_MEMORY'; // 主闸:页脚显示进程内存·pid 段,默认开

// 阈值(字节)——与 CC 完全一致:512MB 转 warning,1024MB(=1GB)转 error。
const WARNING_BYTES = 512 * 1024 * 1024;
const ERROR_BYTES = 1024 * 1024 * 1024;

/** env 门控惯例(同 interruptHint.isInterruptHintEnabled):默认开,仅显式 0/false/off/no 关。 */
function isFooterMemoryEnabled(env = process.env) {
  const raw = env && env[FLAG];
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 按 RSS 字节判严重度(对齐 CC `mb>=1024?'error':mb>=512?'warning':'normal'`)。
 * @param {number} rssBytes
 * @returns {'normal'|'warning'|'error'}
 */
function resolveMemoryLevel(rssBytes) {
  const b = Number(rssBytes);
  if (!Number.isFinite(b)) return 'normal';
  if (b >= ERROR_BYTES) return 'error';
  if (b >= WARNING_BYTES) return 'warning';
  return 'normal';
}

/**
 * 构造页脚内存段。
 * @param {object} p
 * @param {number} p.rssBytes  process.memoryUsage().rss(字节)
 * @param {number} p.pid       process.pid
 * @param {object} [env]
 * @returns {{text:string, level:'normal'|'warning'|'error'}|null} 门控关/坏输入→null(不渲)
 */
function buildFooterMemory(p = {}, env = process.env) {
  try {
    if (!isFooterMemoryEnabled(env)) return null;
    const rssBytes = Number(p && p.rssBytes);
    if (!Number.isFinite(rssBytes) || rssBytes <= 0) return null;
    let humanize = null;
    try { humanize = require('../ccFormat').ccFormatFileSize; } catch { humanize = null; }
    if (typeof humanize !== 'function') return null;
    const sizeText = humanize(rssBytes);
    if (!sizeText) return null;
    const pid = Number(p && p.pid);
    const pidText = Number.isFinite(pid) && pid > 0 ? `pid:${pid}` : null;
    const text = pidText ? `${sizeText} · ${pidText}` : String(sizeText);
    return { text, level: resolveMemoryLevel(rssBytes) };
  } catch {
    return null;
  }
}

module.exports = {
  isFooterMemoryEnabled,
  resolveMemoryLevel,
  buildFooterMemory,
  WARNING_BYTES,
  ERROR_BYTES,
};
