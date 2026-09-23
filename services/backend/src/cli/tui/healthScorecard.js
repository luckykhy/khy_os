'use strict';

/**
 * healthScorecard.js — a single READ-ONLY "TUI health" view for the ink TUI.
 *
 * Pure leaf: zero writes to the managed stdout (the TUI owns it, per
 * bubbletea's stdout-ownership rule), zero network. Aggregates the safety
 * nets that live across the tui/ directory into one object / table so an
 * operator (or a CI `--leak-check` job) can answer "is the terminal healthy?"
 * without reading five source files:
 *
 *   - chrome ledger      — current frame-height vs the live-region budget
 *                          (chromeBudget.liveBudget), the H1 invariant
 *                          (frame <= rows-1) that keeps ink's fullscreen clear
 *                          from wiping the transcript.
 *   - frame budget       — rolling p50/p95/p99/max render-time (frameBudget),
 *                          over/under the 16ms floor.
 *   - instance lookup    — whether inkRuntime's internal WeakMap lookup has
 *                          degraded (the "残线" residual-line risk).
 *   - safety nets        — which stdout guards are active (alt-screen on/off,
 *                          scrollback-rescue active-or-not, mouse takeover).
 *   - memory             — process heapUsed snapshot (for trend, not a floor).
 *
 * Output: `renderTable()` (human, stderr-ready strings) and `toJSON()`
 * (machine). The caller decides the sink; this module NEVER writes itself.
 *
 * All inputs are passed in as plain values so the function stays testable
 * without mounting a real TUI.
 */

const chromeBudget = require('./chromeBudget');
const perfTunables = require('./perfTunables');

/**
 * Compute the scorecard from the live pieces.
 * @param {object} p
 * @param {{rows?: number, cols?: number}} p.geometry - stdout rows/cols
 * @param {object} [p.chromeShares] - chrome ledger shares for this session
 * @param {object} [p.frameGuard] - a createGuard() instance (or null)
 * @param {object} [p.inkRuntime] - inkRuntime module (for isInstanceLookupDegraded)
 * @param {object} [p.env] - env snapshot (defaults to process.env)
 * @returns {object}
 */
function build(p = {}) {
  const env = p.env || process.env;
  const rows = Number.isFinite(p.geometry && p.geometry.rows) ? p.geometry.rows : 0;
  const cols = Number.isFinite(p.geometry && p.geometry.cols) ? p.geometry.cols : 0;
  const shares = p.chromeShares || {};

  // ── chrome ledger (H1 invariant) ─────────────────────────────────────────
  // liveBudget returns the max allowed live-region rows; chromeRows is the
  // fixed-chrome sum the ledger is actually budgeting.
  const chromeRows = chromeBudget.chromeRows(shares);
  const liveAllowed = chromeBudget.liveBudget(rows, shares);
  // H1 holds when the live region fits under the last screen row.
  const h1Holds = rows > 0 && liveAllowed <= rows - 1;

  // ── frame budget window ────────────────────────────────────────────────────
  let frame = { p50: 0, p95: 0, p99: 0, max: 0, count: 0, overBudget: false, budgetMs: 16 };
  if (p.frameGuard && typeof p.frameGuard.stats === 'function') {
    try {
      frame = p.frameGuard.stats();
    } catch { /* guard optional */ }
  }

  // ── ink internal instance lookup ─────────────────────────────────────────
  let instanceDegraded = false;
  if (p.inkRuntime && typeof p.inkRuntime.isInstanceLookupDegraded === 'function') {
    instanceDegraded = p.inkRuntime.isInstanceLookupDegraded() === true;
  }

  // ── safety-net activation flags (read-only env mirrors) ───────────────────
  const safetyNets = {
    altScreen: envFlagOn(env, 'KHY_ALT_SCREEN'),
    scrollbackPreserve: envFlagOn(env, 'KHY_PRESERVE_SCROLLBACK'),
    suppressStaticReprint: envFlagOn(env, 'KHY_SUPPRESS_STATIC_REPRINT'),
    fullscreenTailCut: envFlagOn(env, 'KHY_FULLSCREEN_TAILCUT'),
    mouseWheelTakeover: envFlagOn(env, 'KHY_MOUSE_WHEEL'),
    inlineTranscript: envFlagOn(env, 'KHY_INLINE_TRANSCRIPT'),
  };

  // ── memory snapshot ────────────────────────────────────────────────────────
  let heap = null;
  try {
    const m = process.memoryUsage();
    heap = {
      heapUsedKB: Math.round(m.heapUsed / 1024),
      heapTotalKB: Math.round(m.heapTotal / 1024),
      rssKB: Math.round(m.rss / 1024),
    };
  } catch { /* memoryUsage unavailable in some embeds */ }

  return {
    generatedAt: new Date().toISOString(),
    geometry: { rows, cols },
    chrome: { chromeRows, liveAllowed, h1Holds, shares },
    frame,
    instance: { degraded: instanceDegraded },
    safetyNets,
    heap,
  };
}

/**
 * A gate is "on" unless explicitly set to a known off token. Mirrors the
 * repo's OFF_VALUES convention (0/false/off/no) so the scorecard matches what
 * the actual code paths will do.
 * @returns {boolean}
 */
function envFlagOn(env, key) {
  const v = String((env && env[key]) || '').trim().toLowerCase();
  if (v === '') return true; // unset -> the documented default (on for these nets)
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * Render a human-readable table (the caller writes it to stderr; this module
 * does not). One section per safety concern, each line a single truth.
 * @returns {string}
 */
function renderTable(s) {
  const lines = [];
  lines.push('=== TUI 健康记分卡（只读） ===');
  lines.push(`时间 ${s.generatedAt}`);
  lines.push('');
  lines.push(`── 几何 ── rows=${s.geometry.rows || '?'} cols=${s.geometry.cols || '?'}`);
  lines.push(`  chrome 账本 ${s.chrome.chromeRows} 行 | live 允许 ≤ ${s.chrome.liveAllowed} 行 | H1(帧高≤rows-1) ${s.chrome.h1Holds ? '成立' : '不成立(需 KHY_TUI_DIAG_H=1 查账本)'}`);
  lines.push('');
  lines.push('── 帧预算（16ms 地板） ──');
  if (s.frame.count > 0) {
    lines.push(`  p50=${fmt(s.frame.p50)} p95=${fmt(s.frame.p95)} p99=${fmt(s.frame.p99)} max=${fmt(s.frame.max)} (窗口 ${s.frame.count} 帧, 预算 ${s.frame.budgetMs}ms)`);
    lines.push(`  判定: ${s.frame.overBudget ? '超预算(已触发一次性告警)' : '在预算内'}`);
  } else {
    lines.push('  尚无采样（TUI 未渲染过帧或帧守卫未启用）');
  }
  lines.push('');
  lines.push('── ink 内部实例解析 ── ' + (s.instance.degraded ? '已降级（resize 全重绘修复可能失效，留意残线）' : '正常'));
  lines.push('');
  lines.push('── 安全网激活 ──');
  for (const [k, v] of Object.entries(s.safetyNets)) {
    lines.push(`  ${k.padEnd(22)} ${v ? 'on' : 'off'}`);
  }
  lines.push('');
  if (s.heap) {
    lines.push(`── 内存 ── heapUsed=${s.heap.heapUsedKB}KB rss=${s.heap.rssKB}KB`);
  }
  return lines.join('\n');
}

function fmt(v) {
  return (Number.isFinite(v) ? v : 0).toFixed(1) + 'ms';
}

function toJSON(s) {
  return s; // already a plain object
}

/** Test-only: reset any module-level state (none today; kept for symmetry). */
function _resetForTest() {}

module.exports = { build, renderTable, toJSON, envFlagOn, _resetForTest };
