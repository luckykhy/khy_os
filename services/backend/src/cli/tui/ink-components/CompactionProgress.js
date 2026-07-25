'use strict';

/**
 * CompactionProgress — Claude-Code-style "Compacting conversation…" indicator.
 *
 * Renders a hatched progress bar tied to the real compression stages emitted by
 * buildSlidingWindow (prune → guard → AI summary → done). The backend reports
 * milestone floors (pct) per stage; this component eases the displayed
 * percentage upward between floors so the bar keeps moving during the long
 * AI-summary pole, then snaps to 100% on the `done` stage. Honours
 * KHY_REDUCED_MOTION by rendering a static frame at the latest milestone floor.
 *
 * Props:
 *   compaction: { pct, stage, tokensBefore, startedAt }
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

const REDUCED_MOTION = process.env.KHY_REDUCED_MOTION === '1';
const BAR_WIDTH = 24;

const STAGE_LABELS = {
  starting: '准备中',
  pruning: '清理冗余',
  guarding: '窗口守护',
  summarizing: '生成摘要',
  done: '完成',
};

// CC 后端口径对齐:压缩进度条左侧的「已耗时」走与 spinner/turn-stats 同一个时长格式 SSOT
// (ccFormatDuration,CC `src/utils/format.ts formatDuration` 的忠实移植)。原本地实现
// **逐秒 floor**(`Math.floor(ms/1000)` 再拆分),与 CC 在两处分叉:
//   ① ≥60s 时 CC 对**分内秒**用 `Math.round((ms%60000)/1000)`(60500ms→"1m 1s"),
//      本地 floor 给 "1m 0s"——压缩耗时正好过整分钟时差 1 秒;
//   ② CC 进位到**小时/天**("1h 1m 1s"),本地只到分钟("61m 1s")。
// 这正是 ccFormat.js 头部点名的「另写一套近似口径」反模式。改为委托 ccFormatDuration。
//   门控 KHY_COMPACTION_CC_FORMAT(默认开)→ ccFormatDuration;关 → 逐字节回退旧 floor 实现。
//   ccFormat require 包在 try 里,任何异常静默回退旧实现,绝不让进度条渲染抛错。
function formatElapsed(ms, env = process.env) {
  const v = String((env && env.KHY_COMPACTION_CC_FORMAT) || '').trim().toLowerCase();
  const ccMode = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (ccMode) {
    try {
      const fmt = require('../../ccFormat').ccFormatDuration;
      if (typeof fmt === 'function') {
        const out = fmt(Math.max(0, Number(ms) || 0));
        if (out) return out;
      }
    } catch { /* fall through to the legacy floor implementation below */ }
  }
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// CC 后端口径对齐:压缩进度条的「↑ N tokens」走与页脚/spinner 同一个紧凑 token 格式 SSOT
// (ccFormatTokens,CC formatTokens 的忠实移植——紧凑记数且**去掉尾随 ".0"**:24000→"24k"、
// 1000→"1k",而非旧本地实现的 "24.0k"/"1.0k";非整千值如 1500→"1.5k"/12345→"12.3k" 两者本就一致)。
// 保留「tokensBefore<=0 → 空串隐藏该段」的旧行为(ccFormatTokens(0) 会返 "0",故 0 守卫在最前)。
//   门控 KHY_COMPACTION_CC_TOKENS(默认开)→ ccFormatTokens;关 → 逐字节回退旧的 toFixed(1)+"k"。
//   ccFormat require 包在 try 里,任何异常静默回退旧实现,绝不让进度条渲染抛错。
function formatTokens(n, env = process.env) {
  if (!n || n <= 0) return '';
  const v = String((env && env.KHY_COMPACTION_CC_TOKENS) || '').trim().toLowerCase();
  const ccMode = !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  if (ccMode) {
    try {
      const fmt = require('../../ccFormat').ccFormatTokens;
      if (typeof fmt === 'function') return fmt(n);
    } catch { /* fall through to the legacy form below */ }
  }
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function CompactionProgress({ compaction }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  const floor = Math.max(0, Math.min(100, Number(compaction && compaction.pct) || 0));
  const stage = (compaction && compaction.stage) || 'starting';
  const tokensBefore = Number(compaction && compaction.tokensBefore) || 0;
  const startedAt = Number(compaction && compaction.startedAt) || Date.now();
  const done = stage === 'done';

  const [pct, setPct] = React.useState(floor);
  const [now, setNow] = React.useState(Date.now());

  // Never display below the latest milestone floor reported by the backend.
  React.useEffect(() => {
    setPct((p) => (floor > p ? floor : p));
  }, [floor]);

  React.useEffect(() => {
    if (REDUCED_MOTION) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
      setPct((p) => {
        if (done) return Math.min(100, p + (100 - p) * 0.4 + 1);
        const ceiling = 95; // asymptote toward 95% until the backend reports done
        if (p >= ceiling) return ceiling;
        return p + (ceiling - p) * 0.04;
      });
    }, 120);
    return () => clearInterval(id);
  }, [done]);

  const shown = done ? 100 : Math.max(floor, Math.round(pct));
  const filled = Math.round((shown / 100) * BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, BAR_WIDTH - filled));
  const elapsed = formatElapsed(now - startedAt);
  const tokenStr = formatTokens(tokensBefore);
  const stageLabel = STAGE_LABELS[stage] || '压缩中';

  return h(Box, { flexDirection: 'column', marginTop: 1 },
    h(Text, null,
      h(Text, { color: 'magenta' }, '✻ '),
      h(Text, { color: 'magenta' }, '正在压缩对话… '),
      h(Text, { dimColor: true }, `(${elapsed}${tokenStr ? ` · ↑ ${tokenStr} tokens` : ''})`)
    ),
    h(Text, null,
      h(Text, { color: 'magenta' }, bar),
      h(Text, { dimColor: true }, ` ${shown}%  ${stageLabel}`)
    )
  );
}

module.exports = CompactionProgress;
module.exports.formatTokens = formatTokens;
module.exports.formatElapsed = formatElapsed;
