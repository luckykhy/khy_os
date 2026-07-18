'use strict';

// 纯叶子 / pure-leaf —— 零 IO、绝不抛。
//
// OPS-MAN-099 空产出成功检测（第八发·「收结果」维度·空成功诚实）。
//
// 断桥：一个子任务结果 `success !== false`（producer agenticHarnessService.js:1016
// 把任何非显式 false 都算成功）却**零产出**——无 body（text/output 皆空）、无
// filesModified、无 toolCalls——会被 mergeResults(taskDecomposer.js) 计进
// successCount 并渲成「完成」，与真干了活的子任务无法区分。离机无人值守多智能体
// 最阴险的假绿：报告显示「完成 3/3」，其中一个 agent 实际空响应/被截断/no-op。
//
// 本叶把「空成功」判出来，供 mergeResults 渲成醒目的「⚠️ 完成（无产出）」+ footer
// 计数。只如实告知、不改 successCount 总数（它确实没失败），让人有机会复查。
//
// 与 092(skip≠fail 状态诚实) / 098(并行写冲突诚实) 正交：那两个追「状态」「文件重叠」，
// 本叶追「一个子任务有没有真产出」——同一渲染出口(mergeResults)的第三个正交诚实维度。

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// 门 KHY_MERGE_EMPTY_SUCCESS：default-on，仅 0/false/off/no 关闭。函数式每调用读 env
// （不缓存、不进 flagRegistry——同 KHY_MERGE_FILE_CONFLICT 等八个 sibling 门先例，
// 各自独立）。门关 → isEmptySuccess 恒返 false = 今日所有成功项都渲「完成」。
function _emptySuccessEnabled() {
  const v = process.env.KHY_MERGE_EMPTY_SUCCESS;
  if (v === undefined || v === null) return true;
  return !_FALSY.has(String(v).trim().toLowerCase());
}

// body 是否为空（text/output trim 后皆空）。
function _hasNoBody(result) {
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  if (text) return false;
  const output = typeof result.output === 'string' ? result.output.trim() : '';
  return !output;
}

/**
 * 判定一个子任务结果是否「成功但零产出」。
 *
 * 返回 true 当且仅当：门开 且 result 是对象 且 success 非 false 且 非 skipped 且
 * 无有效 body 且 无 filesModified 且 无 toolCalls。
 *
 * 保守：非对象/畸形 → false（宁可漏标不误报——空成功是提示不是拦截）。
 * skipped(092)/failed 另有归属，不在此重复标。
 */
function isEmptySuccess(result) {
  if (!_emptySuccessEnabled()) return false;
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return false; // 失败另有归属
  if (result.skipped === true) return false;  // 跳过项(092)另有归属
  if (!_hasNoBody(result)) return false;       // 有 body = 有产出
  if (Array.isArray(result.filesModified) && result.filesModified.length > 0) return false; // 改了文件
  if (result.toolCalls) return false;          // 跑了工具（0/缺失才算无）
  return true;
}

/**
 * 把空成功计数渲成一行 footer 告警字符串。count<1 → ''。纯函数。
 */
function formatEmptySuccessWarning(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 1) return '';
  return `⚠️ 完成但无产出: ${n} 项（可能空响应/被截断/no-op，请复查）`;
}

module.exports = { isEmptySuccess, formatEmptySuccessWarning };
