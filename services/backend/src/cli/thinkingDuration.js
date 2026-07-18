'use strict';

/**
 * thinkingDuration — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 目标(承 Goal「khy 做事像 Claude Code 一样结构化」,用户「批量测试结果」素材里的
 * `Thought for 7s (ctrl+o to expand)`):给**已提交的折叠思考行**补上**真实思考时长**。
 *
 * 关键(reframe「绑定真实后端态,绝不编造」):时长来自 useQueryBridge 捕获的**真实
 * elapsed**(首个 thinking chunk → 首个非 thinking chunk 的墙钟差),落成 timeline
 * thinking 条目的 `durationMs` 结构化字段;本叶子只负责**判定门控 + 确定性格式化 +
 * 拼装单一真源的折叠摘要文本**,不读时钟、不算时长。
 *
 * 门控:KHY_THINKING_DURATION(默认开)。=0/false/off/no → 关 → 回退旧「💭 思考 · N 字」
 * 行,逐字节等价。无 durationMs / <1s 的可忽略思考 → 不显时长(诚实,不四舍五入夸大)。
 *
 * 时长**格式**(怎么把 ms 渲成串)对齐 CC 源 `src/utils/format.ts` 的 formatDuration——
 * 经共享纯叶子 [ccFormat] 移植(floor 取秒、"1m 30s" 空格分隔、分钟档保留 0 秒)。
 * 「是否显示时长」(亚秒思考诚实不显)是 Khy 刻意保留的产品决定,正交于「怎么显示」,
 * 因此放在本叶子;格式本身交给 ccFormat 这个单一真源。本文件复用其门控 KHY_CC_FORMAT
 *(默认开),关 → 逐字节回退本刀之前的 legacy 口径(round 取秒、"1m30s" 无空格)。
 */

const { ccFormatEnabled, ccFormatDuration } = require('./ccFormat');

function thinkingDurationEnabled(env = process.env) {
  const flag = String((env && env.KHY_THINKING_DURATION) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * 确定性 ms → 紧凑人读时长标签。<1s 的可忽略思考返 ''(不夸大)。
 *
 * KHY_CC_FORMAT 开(默认):≥1s 走 CC formatDuration("7s" / "1m 30s",floor + 空格)。
 * 关:逐字节回退 legacy("Ns" / "MmSs",round + 无空格)。
 * @param {number} ms
 * @param {object} [env]
 * @returns {string}
 */
function humanizeThinkingMs(ms, env = process.env) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (ccFormatEnabled(env)) {
    // 亚秒思考:诚实地不显时长(Khy 刻意保留;不夸大成 CC 的 "0s")。
    if (n < 1000) return '';
    return ccFormatDuration(n); // CC 口径:floor 取秒、"1m 30s" 空格分隔、"1m 0s"
  }
  // legacy 字节回退(本刀之前口径,逐字节等价)
  const totalSec = Math.round(n / 1000);
  if (totalSec < 1) return ''; // 亚秒思考:诚实地不显时长
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/**
 * 已提交折叠思考行的摘要文本——单一真源。
 * 门控开且有真实时长 → `💭 思考 7s · N 字（Ctrl+O 展开）`;
 * 否则(门控关 / 无时长)→ 旧 `💭 思考 · N 字（Ctrl+O 展开）` 字节回退。
 * @param {{chars:number,durationMs?:number,env?:object}} opts
 * @returns {string}
 */
function buildThinkingSummary({ chars, durationMs, env = process.env } = {}) {
  const dur = thinkingDurationEnabled(env) ? humanizeThinkingMs(durationMs, env) : '';
  const head = dur ? `💭 思考 ${dur}` : '💭 思考';
  return `${head} · ${chars} 字（Ctrl+O 展开）`;
}

/**
 * 展开态思考块头部装饰(`💭 思考` 或 `💭 思考 7s`)——与折叠态同一时长口径。
 * @param {{durationMs?:number,env?:object}} opts
 * @returns {string}
 */
function buildThinkingHeader({ durationMs, env = process.env } = {}) {
  const dur = thinkingDurationEnabled(env) ? humanizeThinkingMs(durationMs, env) : '';
  return dur ? `💭 思考 ${dur}` : '💭 思考';
}

module.exports = {
  thinkingDurationEnabled,
  humanizeThinkingMs,
  buildThinkingSummary,
  buildThinkingHeader,
};
