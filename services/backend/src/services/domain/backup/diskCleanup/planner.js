'use strict';

/**
 * diskCleanup/planner.js — 把扫描结果组装成「可执行清理计划」（纯函数）。
 *
 * 计划把候选分成三档：
 *   - selected   本次会清（safe 且 eligible；或 review 且 includeReview）
 *   - review     可清但需用户显式 opt-in（safety=review，未 includeReview）
 *   - skipped    不可清（受保护/在用/含用户数据/不存在/已空）
 *
 * 总是只「选择」，从不删除。executor 拿 selected 执行，且执行前每项再过一次否决。
 */

const { humanBytes: _humanBytes } = require('../../../byteFormat');

const catalog = require('./junkCatalog');

// 字节 → 人类可读(带空格、到 TB)收敛到单一真源 byteFormat.humanBytes
// (与 diskAnalyzeReport / upstreamStudyReport 同口径,逐字节等价)。

/**
 * @param {object} scanResult - scanner.scan() 返回
 * @param {object} [opts] - {includeReview:boolean, categories?:string[], includeIds?:string[]}
 * @returns {object} plan
 */
function buildPlan(scanResult, opts = {}) {
  const includeReview = !!opts.includeReview;
  const categoryFilter =
    Array.isArray(opts.categories) && opts.categories.length ? new Set(opts.categories) : null;
  // includeIds：按稳定 id 精确点名若干 review 条目纳入本次计划。与 includeReview 的区别：
  // includeReview 是「全部 review 一起放行」（会把回收站这类不可逆项也带进来），
  // includeIds 让调用方只点名确实想要的条目（如 cleandisk 方法论的自动档：
  // Windows Temp + 更新下载缓存），回收站仍留在 review 列。白名单之外的 id 无效。
  const idFilter =
    Array.isArray(opts.includeIds) && opts.includeIds.length ? new Set(opts.includeIds) : null;

  const selected = [];
  const review = [];
  const skipped = [];

  for (const c of scanResult.candidates) {
    if (categoryFilter && !categoryFilter.has(c.category)) {
      continue;
    }

    if (!c.eligible) {
      // 不存在/已空 不值得展示为 skipped 噪音，但保留含数据/受保护/在用的，便于透明。
      if (c.skipReason && c.skipReason !== '不存在' && c.skipReason !== '已空') {
        skipped.push(c);
      }
      continue;
    }
    if (c.safety === catalog.REVIEW && !includeReview && !(idFilter && idFilter.has(c.id))) {
      review.push(c);
    } else {
      selected.push(c);
    }
  }

  const sumBytes = (arr) => arr.reduce((a, c) => a + (c.sizeBytes || 0), 0);
  const byCategory = {};
  for (const c of selected) {
    byCategory[c.category] = byCategory[c.category] || { count: 0, bytes: 0 };
    byCategory[c.category].count += 1;
    byCategory[c.category].bytes += c.sizeBytes || 0;
  }
  const byDrive = {};
  for (const c of selected) {
    byDrive[c.drive] = byDrive[c.drive] || { count: 0, bytes: 0 };
    byDrive[c.drive].count += 1;
    byDrive[c.drive].bytes += c.sizeBytes || 0;
  }

  const selectedBytes = sumBytes(selected);
  const reviewBytes = sumBytes(review);

  return {
    platform: scanResult.platform,
    driveRoots: scanResult.driveRoots,
    includeReview,
    selected,
    review,
    skipped,
    totals: {
      selectedCount: selected.length,
      selectedBytes,
      selectedHuman: _humanBytes(selectedBytes),
      reviewCount: review.length,
      reviewBytes,
      reviewHuman: _humanBytes(reviewBytes),
      skippedCount: skipped.length,
    },
    byCategory,
    byDrive,
  };
}

module.exports = { buildPlan, _humanBytes };
