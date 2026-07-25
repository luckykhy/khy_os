'use strict';

/**
 * diskAnalyzeReport.js — 纯叶子:把 DiskAnalyze 引擎的结构化结果渲染成 ASCII 报告框。
 *
 * 仿 diskCleanup/index.js 的 renderPlanReport 盒式风格,给弱模型/用户一份「一眼能读」的
 * 磁盘分析摘要(最大文件 Top-N、旧安装包、重复文件组、总量与是否被上限截断)。
 *
 * 契约:零 I/O(纯字符串拼装,不碰 fs/网络/子进程)、确定性(无时钟/随机;输入已定序则输出定序)、
 * 绝不抛(fail-soft 返回退化串)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_DISKANALYZE_REPORT  默认 on —— 关 ⇒ 返回最小单行 legacy 串(逐字节回退,不产盒式报告)。
 *
 * @module services/diskAnalyzeReport
 */

const WIDTH = 60;                       // 盒内文本可视宽度(不含左右边框)

const _isEnabled = require('../utils/isEnabledDefaultOn');

function isReportEnabled(env) {
  return _isEnabled('KHY_DISKANALYZE_REPORT', env);
}

// 字节 → 人类可读(带空格、到 TB)收敛到单一真源 byteFormat.humanBytes
// (与 upstreamStudyReport / diskCleanup/planner 同口径,逐字节等价)。
const { humanBytes: _humanBytes } = require('./byteFormat');

// 盒式行/分隔线基元收敛到单一真源 asciiBox(宽度参数化;本地 _row/_rule 传 WIDTH)。
const { boxRow: _boxRow, boxRule: _boxRule } = require('./asciiBox');

/** 截断过长字符串,尾部留 … 标记(用于超宽路径)。 */
function _ellipsize(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  if (max <= 1) return str.slice(0, max);
  return str.slice(0, max - 1) + '…';
}

/** 一条盒内行:左对齐填充/裁剪到 WIDTH,包上边框。委托单一真源 asciiBox。 */
function _row(text) {
  return _boxRow(text, WIDTH);
}

function _rule(label) {
  return _boxRule(label, WIDTH);
}

function _legacy(result) {
  try {
    const r = result || {};
    const large = Array.isArray(r.largeFiles) ? r.largeFiles.length : 0;
    const inst = Array.isArray(r.oldInstallers) ? r.oldInstallers.length : 0;
    const dup = Array.isArray(r.duplicateGroups) ? r.duplicateGroups.length : 0;
    return `磁盘分析: 大文件 ${large} · 旧安装包 ${inst} · 重复文件组 ${dup}`;
  } catch {
    return '磁盘分析: (无结果)';
  }
}

/**
 * 渲染磁盘分析报告。门控关/异常 → 最小 legacy 串。绝不抛。
 * @param {object} result analyze() 的返回:{ platform, roots, largeFiles, oldInstallers,
 *                        duplicateGroups, totals, truncated, notes }
 * @param {object} [env]
 * @returns {string}
 */
function renderAnalyzeReport(result, env) {
  try {
    if (!isReportEnabled(env)) return _legacy(result);
    const r = result || {};
    const large = Array.isArray(r.largeFiles) ? r.largeFiles : [];
    const installers = Array.isArray(r.oldInstallers) ? r.oldInstallers : [];
    const dupGroups = Array.isArray(r.duplicateGroups) ? r.duplicateGroups : [];
    const totals = r.totals || {};
    const roots = Array.isArray(r.roots) ? r.roots.join(' ') : String(r.roots || '');

    const lines = [];
    lines.push(`┌─ khyos 磁盘分析${'─'.repeat(WIDTH + 2 - '─ khyos 磁盘分析'.length)}┐`);
    lines.push(_row(`平台 ${String(r.platform || '?')}   根 ${_ellipsize(roots, WIDTH - 12)}`));
    lines.push(_row(`扫描 ${Number(totals.scanned || 0)} 项 · 累计 ${_humanBytes(totals.bytes || 0)}`
      + (r.truncated ? ' · 已达上限截断' : '')));

    // 最大文件 Top-N
    lines.push(_rule('最大文件'));
    if (large.length) {
      for (const f of large) {
        const size = _humanBytes(Number(f && f.size) || 0);
        const path = _ellipsize(String(f && f.path || ''), WIDTH - size.length - 3);
        lines.push(_row(`${path}  ${size}`));
      }
    } else {
      lines.push(_row('(未发现超过阈值的大文件)'));
    }

    // 旧安装包
    lines.push(_rule('旧安装包'));
    if (installers.length) {
      for (const f of installers) {
        const size = _humanBytes(Number(f && f.size) || 0);
        const age = Number.isFinite(Number(f && f.ageDays)) ? `${Math.round(f.ageDays)}天` : '';
        const tail = `${size}${age ? ' · ' + age : ''}`;
        const path = _ellipsize(String(f && f.path || ''), WIDTH - tail.length - 3);
        lines.push(_row(`${path}  ${tail}`));
      }
    } else {
      lines.push(_row('(未发现旧安装包)'));
    }

    // 重复文件组
    lines.push(_rule('重复文件'));
    if (dupGroups.length) {
      for (const g of dupGroups) {
        const files = Array.isArray(g && g.files) ? g.files : [];
        const size = _humanBytes(Number(g && g.sizeBytes) || 0);
        const wasted = _humanBytes((Number(g && g.sizeBytes) || 0) * Math.max(0, files.length - 1));
        lines.push(_row(`${files.length}× ${size} (可省 ${wasted})`));
        for (const p of files) {
          lines.push(_row(`   ${_ellipsize(String(p || ''), WIDTH - 4)}`));
        }
      }
    } else {
      lines.push(_row('(未发现内容重复的文件)'));
    }

    if (r.truncated) {
      lines.push(_rule('说明'));
      lines.push(_row('扫描在时间/条目上限内提前结束,结果为部分视图。'));
      lines.push(_row('可缩小 roots 或调 KHY_FS_WALK_BUDGET_MS 再扫。'));
    }

    lines.push(`└${'─'.repeat(WIDTH + 2)}┘`);
    return lines.join('\n');
  } catch {
    return _legacy(result);
  }
}

module.exports = {
  isReportEnabled,
  renderAnalyzeReport,
  _humanBytes,
};
