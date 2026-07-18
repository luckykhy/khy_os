'use strict';

/**
 * diskCleanup/index.js — 安全磁盘清理引擎门面（scan → plan → clean）。
 *
 * 教 khyos「怎么清理 C 盘/D 盘又不破坏用户所需要的数据」的对外单一入口。设计承诺：
 *   · 只从 junkCatalog 白名单选删除目标（名单外一律当用户数据，不碰）。
 *   · 两道否决（catalog 白名单 + protectedGuard 受保护根/用户数据信号），fail-closed。
 *   · dry-run 默认：scan/plan 纯只读；clean 不传 apply 也只演练。
 *   · 回收站/更新缓存等「涉及可恢复数据」归 review，必须显式 includeReview 才动。
 *   · 真正执行删除时由 DiskCleanupTool 声明 isDestructive→经 riskGate 不可绕人闸确认。
 *
 * 用法：
 *   const dc = require('services/diskCleanup');
 *   const plan = dc.plan({ roots: ['C:'], includeReview: false });   // 看会清什么
 *   const report = await dc.clean({ roots: ['C:'], apply: true });    // 真清（经人闸）
 */

const scanner = require('./scanner');
const planner = require('./planner');
const executor = require('./executor');
const catalog = require('./junkCatalog');
const guard = require('./protectedGuard');

/** 只读扫描：返回全部候选（含被跳过/否决的，便于透明）。 */
function scan(opts = {}) {
  return scanner.scan(opts);
}

/** 组装计划（只读）。 */
function plan(opts = {}) {
  const scanResult = scanner.scan(opts);
  return planner.buildPlan(scanResult, opts);
}

/**
 * 执行清理。apply 缺省 false → 仅演练。
 * @param {object} [opts] - {roots, includeReview, keepRecentHours, categories, apply, deps}
 * @returns {Promise<{plan, report}>}
 */
async function clean(opts = {}) {
  const p = plan(opts);
  const report = await executor.execute(p, opts);
  return { plan: p, report };
}

/** ASCII 报告（纯字符串，终端/Web 通用）。 */
function renderPlanReport(plan) {
  const lines = [];
  const t = plan.totals;
  lines.push('┌─ khyos 安全磁盘清理 · 计划 ────────────────────────┐');
  lines.push(`│ 平台: ${_pad(plan.platform, 10)} 盘符: ${_pad(plan.driveRoots.join(' '), 16)}        `.slice(0, 53) + '│');
  lines.push('├────────────────────────────────────────────────────┤');
  lines.push(`│ 本次将清理: ${_pad(t.selectedCount + ' 项', 8)} 可回收 ${_pad(t.selectedHuman, 10)}            `.slice(0, 53) + '│');
  if (Object.keys(plan.byCategory).length) {
    for (const [cat, v] of Object.entries(plan.byCategory)) {
      lines.push(`│   · ${_pad(cat, 16)} ${_pad(String(v.count) + ' 项', 7)} ${planner._humanBytes(v.bytes)}`.padEnd(53).slice(0, 53) + '│');
    }
  } else {
    lines.push('│   (无可清理项，磁盘已很干净)                          '.slice(0, 53) + '│');
  }
  if (t.reviewCount) {
    lines.push('├─ 需确认 (review，默认不清) ─────────────────────────┤');
    lines.push(`│ ${_pad(t.reviewCount + ' 项', 8)} 约 ${_pad(t.reviewHuman, 10)}  含回收站/更新缓存等           `.slice(0, 53) + '│');
    lines.push('│ 想清这些请显式开启 includeReview                     '.slice(0, 53) + '│');
  }
  if (t.skippedCount) {
    lines.push('├─ 已保护跳过 ────────────────────────────────────────┤');
    for (const s of plan.skipped.slice(0, 6)) {
      lines.push(`│ ⚠ ${_pad(s.label, 22)} ${s.skipReason}`.padEnd(53).slice(0, 53) + '│');
    }
  }
  lines.push('└────────────────────────────────────────────────────┘');
  return lines.join('\n');
}

function _pad(v, width) {
  const s = String(v == null ? '' : v);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

module.exports = {
  scan,
  plan,
  clean,
  renderPlanReport,
  // 透传子模块，便于直接单测/复用
  scanner,
  planner,
  executor,
  catalog,
  guard,
};
