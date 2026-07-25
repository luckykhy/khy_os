'use strict';

/**
 * turnStats — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 目标(承 Goal「khy 做事像 Claude Code 一样结构化」第六刀):在一个回合**真正结束**时,
 * 补一行 CC 风格的**回合统计**——`✓ 1m30s · 3 工具 · 1.2k tokens`——把这个回合实际
 * 花了多久、调了几个工具、用了多少 token **一眼交代清楚**(对标 CC 的回合收尾摘要)。
 *
 * 关键(reframe「绑定真实后端态,绝不编造」):三个量全部来自 useQueryBridge 在 finalize
 * 拿到的**真实结构化后端态**——
 *   - elapsed = `Date.now() - startTime`(用户真实等待的墙钟)
 *   - toolCount = `result.toolCallLog.length`(后端权威的本回合工具调用日志长度)
 *   - tokens = `result.tokenUsage`(后端上报的真实用量)
 * 本叶子只负责**判定门控 + 确定性格式化 + 拼装单一真源的统计行**,不读时钟、不数工具、
 * 不估 token。任一量缺失 → **诚实省略那一段**(绝不补零/编造)。
 *
 * 门控:KHY_TURN_STATS(默认开)。=0/false/off/no → 关 → 返 null(不追加统计行,逐字节
 * 回退到本刀之前的行为)。抑噪:无工具且耗时低于 KHY_TURN_STATS_MIN_MS(默认 2000ms)的
 * trivial 闲聊回合 → 返 null(不给每句短回复都堆一行噪声)。
 *
 * 时长 / token 的**格式**(怎么渲成串)经共享纯叶子 [ccFormat] 对齐 CC 源
 * `src/utils/format.ts` 的 formatDuration / formatTokens——与 thinkingDuration 同一单一真源。
 * 本文件复用其门控 KHY_CC_FORMAT(默认开),关 → 逐字节回退本刀之前的 legacy 口径。
 */

const { ccFormatEnabled, ccFormatDuration, ccFormatTokens } = require('./ccFormat');

function turnStatsEnabled(env = process.env) {
  const flag = String((env && env.KHY_TURN_STATS) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/** trivial 回合抑噪阈值(ms)。无效/负 → 回退 2000。 */
function turnStatsMinMs(env = process.env) {
  const n = parseInt(String((env && env.KHY_TURN_STATS_MIN_MS) || '2000'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 2000;
}

/**
 * 确定性 ms → 紧凑人读时长(与 thinkingDuration 同口径)。<1s → 空串(诚实省略,
 * 也与回合统计不为亚秒堆噪一致)。
 *
 * KHY_CC_FORMAT 开(默认):≥1s 走 CC formatDuration("7s" / "1m 30s")。
 * 关:逐字节回退 legacy("Ns" / "MmSs",round + 无空格)。
 */
function humanizeElapsed(ms, env = process.env) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (ccFormatEnabled(env)) {
    if (n < 1000) return ''; // 亚秒回合:省略时长段(与 thinking 同口径,不显 CC 的 "0s")
    return ccFormatDuration(n);
  }
  // legacy 字节回退(本刀之前口径)
  const totalSec = Math.round(n / 1000);
  if (totalSec < 1) return '';
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/**
 * 确定性 token 数 → 紧凑标签。<=0/无效 → 空串(诚实省略)。
 *
 * KHY_CC_FORMAT 开(默认):数字部分走 CC formatTokens(Intl 紧凑记数)+ " tokens" 标签
 *   → "42 tokens" / "1.2k tokens" / "123.5k tokens"。
 * 关:逐字节回退 legacy(<1000 → "N tokens";≥1000 → "N.Nk tokens",≥100k 取整)。
 */
function fmtTokens(n, env = process.env) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (ccFormatEnabled(env)) {
    return `${ccFormatTokens(v)} tokens`;
  }
  // legacy 字节回退
  if (v < 1000) return `${Math.round(v)} tokens`;
  const k = v / 1000;
  const s = k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `${s}k tokens`;
}

/**
 * 回合统计行——单一真源。门控关 / trivial 抑噪 / 无任何可显量 → null。
 * 只拼装传入的**真实**量,任一缺失则省略那段(绝不编造)。
 * @param {{elapsedMs?:number,tokens?:number,toolCount?:number,env?:object}} opts
 * @returns {string|null}
 */
function buildTurnStatsLine({ elapsedMs = 0, tokens = 0, toolCount = 0, env = process.env } = {}) {
  if (!turnStatsEnabled(env)) return null;
  const tc = Number(toolCount) > 0 ? Math.floor(Number(toolCount)) : 0;
  // 抑噪:无工具且耗时低于阈值的 trivial 回合不显(短闲聊保持干净)。
  if (tc < 1 && Number(elapsedMs) < turnStatsMinMs(env)) return null;
  const parts = [];
  const elapsed = humanizeElapsed(elapsedMs, env);
  if (elapsed) parts.push(elapsed);
  if (tc >= 1) parts.push(`${tc} 工具`);
  const tok = fmtTokens(tokens, env);
  if (tok) parts.push(tok);
  if (parts.length === 0) return null;
  return `✓ ${parts.join(' · ')}`;
}

module.exports = {
  turnStatsEnabled,
  turnStatsMinMs,
  humanizeElapsed,
  fmtTokens,
  buildTurnStatsLine,
};
