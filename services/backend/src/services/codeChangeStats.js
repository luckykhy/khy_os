'use strict';

/**
 * codeChangeStats — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让显示背后的**后端逻辑**对齐。」
 * CC 的 `/cost` 报表(cost-tracker.ts::formatTotalCost)默认带一行
 *   "Total code changes:  N lines added, M lines removed"
 * —— 整个会话里 khy 实际写入/编辑了多少行代码。khy 每轮 `_buildDeliverySummary`
 * (services/toolUseLoop.js)**早已**为每个 Edit 算出净增/净删行、为每个 Write 算出
 * 行数(fileEdited/fileCreated),并以 `+X/-Y` 逐文件显示 —— 但这些数字**从不跨会话
 * 汇总**,`formatCostReport` 里没有「代码改动」这一项(half-wired:每轮计算侧已 live,
 * 会话呈现侧从未接线)。
 *
 * 本叶子只做纯决策/格式化:
 *   • countEditChurn        —— khy 编辑行 churn 的单一公式(净增/净删,行语义)
 *   • collectUncountedChurn —— 从一轮工具日志里**幂等**采集未计过的成功 Edit/Write 增删
 *   • buildCodeChangesValue —— /cost「代码改动」值文本(壳负责加标签/颜色)
 * 会话累计(有状态)与渲染(chalk / 中文)留给壳(services/tokenUsageService)。
 *
 * 幂等契约(collectUncountedChurn):只统计尚未打上 `_khyChurnCounted` 标记的条目,并把
 * 处理过的条目原样回传给壳去打标。故无论调用方在工具循环内每轮跑几次、也无论 toolCallLog
 * 是否跨迭代累积,每条改动只会被计入一次(壳负责打标这一副作用,叶子保持零副作用)。
 *
 * 诚实边界:
 *   • 只统计**成功**的改动(result.success===false / 被去重 / 循环拦截的条目不计;失败的
 *     编辑没真正改到代码。每轮摘要另以 ❌ 标注尝试,与本账本各司其职)。
 *   • 编辑用净增/净删近似(与每轮摘要 `+X/-Y` 同公式,单一真源),不做逐行 LCS diff。
 *   • Write/新建按写入行数计入「新增」,不对整文件覆盖做逐行 diff(以免把未变行误计为增删),
 *     故覆盖写只增不减。
 *   • 账本在交付汇总点采集;极少数经异常/预算早退路径退出的改动可能未计入(fail-soft 取舍)。
 * 门控 KHY_CODE_CHANGES 默认开;关 → 壳短路不采集、不呈现(逐字节回退今日 /cost 报表)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_CODE_CHANGES 默认开;{0,false,off,no} 关。 */
function codeChangesEnabled(env = process.env) {
  const raw = env && env.KHY_CODE_CHANGES;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** 非负整数化;非法/负值 → 0。 */
function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 字符串行数(空串 → 0)。 */
function _lineCount(s) {
  if (typeof s !== 'string' || s === '') return 0;
  return s.split('\n').length;
}

/**
 * khy 编辑行 churn 的单一公式:净增/净删(行语义)。
 * added = max(0, newLines - oldLines);removed = max(0, oldLines - newLines)。
 * 与 toolUseLoop `_buildDeliverySummary` 每轮 `+X/-Y` 逐文件显示同源(单一真源)。
 * @param {string} oldString
 * @param {string} newString
 * @returns {{added:number, removed:number}}
 */
function countEditChurn(oldString, newString) {
  try {
    const oldLen = _lineCount(oldString);
    const newLen = _lineCount(newString);
    return { added: Math.max(0, newLen - oldLen), removed: Math.max(0, oldLen - newLen) };
  } catch {
    return { added: 0, removed: 0 };
  }
}

/** 归一工具名:小写并去空白/下划线/连字符(与 _buildDeliverySummary 同口径)。 */
function _normTool(tool) {
  return String(tool || '').toLowerCase().replace(/[\s_-]/g, '');
}

/** 该日志条目是否算「成功且真实」的一次工具调用(去重/循环拦截/显式失败 → 否)。 */
function _isSuccessfulReal(entry) {
  const r = entry && entry.result;
  if (r && (r._deduped || r._loopDetected)) return false;
  // success 缺省视为成功(与 _buildDeliverySummary `success !== false` 同口径)。
  if (r && r.success === false) return false;
  if (entry && entry.success === false) return false;
  return true;
}

/**
 * 从一轮工具日志里**幂等**采集未计过的成功 Edit/Write 增删行。
 *
 * 只看尚未打 `_khyChurnCounted` 标记的条目;把处理过的条目放进返回的 counted 数组,交由
 * 壳去打标(叶子不改输入,保持零副作用)。Edit 用净增/净删公式;Write/新建按写入行数计入
 * 「新增」(优先 result._khyWriteDiff.afterContent 的行数,退回 params.content 的行数)。
 *
 * @param {Array<object>} toolCallLog 形如 { tool, params, result, _khyChurnCounted? }
 * @returns {{added:number, removed:number, counted:object[]}}
 *   added/removed:本次新采集的增删行合计;counted:本次处理、待壳打标的条目(含 churn 为 0 者)。
 */
function collectUncountedChurn(toolCallLog) {
  const counted = [];
  let added = 0;
  let removed = 0;
  try {
    if (!Array.isArray(toolCallLog)) return { added: 0, removed: 0, counted };
    for (const entry of toolCallLog) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry._khyChurnCounted) continue;
      const tool = _normTool(entry.tool);
      const isEdit = /^(edit|editfile|fileedit)$/.test(tool);
      const isWrite = /^(write|writefile|createfile)$/.test(tool);
      if (!isEdit && !isWrite) continue;      // 非改动工具:不打标、不计,留待后续判断
      if (!_isSuccessfulReal(entry)) { counted.push(entry); continue; } // 失败:打标消费但不计
      const params = entry.params || {};
      if (isEdit) {
        const churn = countEditChurn(
          params.old_string || params.oldString || '',
          params.new_string || params.newString || '',
        );
        added += churn.added;
        removed += churn.removed;
      } else {
        const diff = entry.result && entry.result._khyWriteDiff;
        const after = diff && typeof diff.afterContent === 'string'
          ? diff.afterContent
          : (typeof params.content === 'string' ? params.content : '');
        added += _lineCount(after);
        // 覆盖写只增不减(见文件头诚实边界)。
      }
      counted.push(entry);
    }
  } catch {
    // fail-soft:采集异常绝不影响调用方;已累计部分照常返回。
  }
  return { added: Math.max(0, added), removed: Math.max(0, removed), counted };
}

/**
 * /cost「代码改动」值文本。壳负责加「改动:」标签与颜色。
 * @param {number} added
 * @param {number} removed
 * @returns {string} 例:"128 行新增 · 34 行删除";无改动(两者皆 <=0)→ ''。
 */
function buildCodeChangesValue(added, removed) {
  const a = _num(added);
  const r = _num(removed);
  if (a <= 0 && r <= 0) return '';
  return `${a.toLocaleString('en-US')} 行新增 · ${r.toLocaleString('en-US')} 行删除`;
}

module.exports = {
  codeChangesEnabled,
  countEditChurn,
  collectUncountedChurn,
  buildCodeChangesValue,
};
