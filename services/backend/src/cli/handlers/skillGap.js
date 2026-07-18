'use strict';

/**
 * Skill-Gap Command Handler — `khy skill-gap …`.
 *
 * Surfaces recorded capability gaps so users can inspect which domains
 * the system is weak in, mark individual gaps as resolved, or clear
 * the entire history.
 *
 *   skill-gap list            — list all unresolved gaps (sorted by count desc)
 *   skill-gap stats           — aggregate statistics by domain
 *   skill-gap resolve <id>    — mark a specific gap as resolved
 *   skill-gap clear           — clear all gap records (requires --force)
 *
 * @module handlers/skillGap
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printError, printTable, printSuccess, printWarn } = require('../formatters');
const { listGaps, markResolved, getStats } = require('../../services/skillGapRecorder');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format an ISO timestamp to a short, human-friendly string.
 * @param {string} iso
 * @returns {string}
 */
function _fmtDate(iso) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

// ── Sub-command handlers ─────────────────────────────────────────────────────

/**
 * List all unresolved skill gaps, sorted by occurrence count descending.
 */
function _handleList() {
  const gaps = listGaps().filter((g) => !g.resolved);
  if (gaps.length === 0) {
    printSuccess('✓ 当前没有未解决的能力缺口。');
    return true;
  }
  printInfo(`📋 未解决的能力缺口 ${gaps.length} 条（按出现次数降序）：`);
  const rows = gaps.map((g) => [
    chalk.cyan(g.id),
    g.domain || '-',
    g.taskType || '-',
    String(g.count),
    _fmtDate(g.lastSeen),
  ]);
  printTable(['ID', '领域', '任务类型', '次数', '最近出现'], rows);
  printInfo('标记已修复：khy skill-gap resolve <ID>');
  return true;
}

/**
 * Show aggregated statistics per domain.
 */
function _handleStats() {
  const stats = getStats();
  if (stats.length === 0) {
    printInfo('📊 能力缺口统计：暂无记录。');
    return true;
  }
  const totalAll = stats.reduce((s, r) => s + r.totalGaps, 0);
  const unresolvedAll = stats.reduce((s, r) => s + r.unresolvedGaps, 0);
  printInfo(`📊 能力缺口统计 (共 ${stats.length} 个域，总计 ${totalAll} 条，未解决 ${unresolvedAll} 条)：`);
  const rows = stats.map((r) => [
    chalk.bold(r.domain),
    String(r.totalGaps),
    r.unresolvedGaps > 0 ? chalk.yellow(String(r.unresolvedGaps)) : chalk.green('0'),
  ]);
  printTable(['领域', '总缺口数', '未解决数'], rows);
  return true;
}

/**
 * Mark a single gap as resolved by its ID.
 * @param {string} gapId
 */
function _handleResolve(gapId) {
  if (!gapId) {
    printError('用法: skill-gap resolve <缺口ID>');
    printInfo('用 `khy skill-gap list` 查看缺口列表及 ID。');
    return true;
  }
  const ok = markResolved(gapId);
  if (ok) {
    printSuccess(`✓ 已标记缺口 ${chalk.cyan(gapId)} 为已修复。`);
  } else {
    printError(`✗ 未找到缺口 ID：${gapId}`);
    printInfo('用 `khy skill-gap list` 确认缺口 ID 是否正确。');
  }
  return true;
}

/**
 * Clear all gap records. Requires --force flag to skip confirmation.
 * @param {object} options
 */
function _handleClear(options) {
  const force = options && (options.force === true || options['--force'] === true);
  if (!force) {
    printWarn('⚠ 此操作将清空所有能力缺口记录，且不可恢复。');
    printInfo('确认执行请加 --force：khy skill-gap clear --force');
    return true;
  }
  // Re-import recorder internals to wipe the file
  const fs = require('fs');
  const path = require('path');
  // Locate the data file via the recorder's own DATA_DIR logic
  let dataFile = null;
  try {
    // Reuse the same resolve logic as the recorder module
    const bundledRoot = process.env.KHY_BUNDLED_ROOT;
    const khyRoot = bundledRoot
      ? path.join(bundledRoot, '.khy')
      : path.join(path.resolve(__dirname, '..', '..', '..', '..'), '.khy');
    dataFile = path.join(khyRoot, 'growth', 'skill_gaps.json');
  } catch {
    printError('无法定位缺口数据文件。');
    return true;
  }
  try {
    fs.writeFileSync(dataFile, '[]', 'utf-8');
    printSuccess('✓ 已清空所有能力缺口记录。');
  } catch (err) {
    printError(`清空失败：${err.message}`);
  }
  return true;
}

// ── Public entry ─────────────────────────────────────────────────────────────

/**
 * Handle the `skill-gap` CLI command.
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 * @returns {boolean}
 */
function handleSkillGapCommand(subCommand, args = [], options = {}) {
  const sub = String(subCommand || '').toLowerCase().trim();

  if (!sub || sub === 'list') return _handleList();
  if (sub === 'stats') return _handleStats();
  if (sub === 'resolve') return _handleResolve(args[0]);
  if (sub === 'clear') return _handleClear(options);

  printError(`未知子命令：${sub}`);
  printInfo('用法: skill-gap list | stats | resolve <ID> | clear [--force]');
  return true;
}

module.exports = { handleSkillGapCommand };
