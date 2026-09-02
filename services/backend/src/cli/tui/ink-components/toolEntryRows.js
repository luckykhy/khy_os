'use strict';

// toolEntryRows.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:给 live 时间线尾切预算(liveHeightClamp.tailTimelineToVisualRows)提供**单个工具条目的
// 真实渲染行数**。历史把每个 tool entry 记 1 行,而 ToolLines 的实际渲染是:头行 1 + 执行中叙述
// 行 1 + 失败详情(折叠 ≤10 行 + 页脚)/ shell stdout 折叠体 / Write±diff 行 —— 单条最多可到
// ~20 行。系统性低估使工具密集回合的 live 帧真实高度越过终端 rows → ink 走 fullscreen 分支
// (`clearTerminal + fullStaticOutput + output`)→ 每次都把帧头(整段已提交 transcript 前缀)
// 推入 scrollback,用户看到「同一段输出重复多份」(本次修复的 bug,见
// docs/04_IMPL_实现/[IMPL-RPT-044])。前馈修准后,尾切窗口在加入昂贵条目的**同一帧**收缩,
// 从根上不触发全屏重绘;测量反馈钳制(resolveExtraReserve)仍在,兜住长尾异常。
//
// 估算与渲染同源:行数全部来自 ToolLines 导出的 estimateLiteralRows / errorText /
// isShellResult 与 toolErrorFold / ccUserFacingToolError 同一批叶子(与渲染**共用 memo 缓存**,
// 每帧零重复计算),不另立第二份渲染模型。门控 KHY_TOOL_ROW_BUDGET 默认开;关 → 恒返 1
// (调用方相应不下传 toolCostOf,逐字节回退今日)。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 估算门控默认开;仅显式 falsy 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const v = String((env && env.KHY_TOOL_ROW_BUDGET) || '')
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 估算一个 live 时间线 tool entry 渲染后占的行数(与 ToolLines 的 live 分支逐分支同源)。
 * 绝不抛(异常 → 返 1,退化为历史记法)。tool 缺失/非对象 → 1。
 *
 * 分支镜像(与 ToolLines() 渲染体一一对应):
 *   - _agentTree 非空 → AgentTree 整体替换单行(历史即记 1,方差交给反馈钳制);
 *   - 头行恒 1;未完成且有 progress → +1(↳ 执行中叙述行);
 *   - 失败(与 ToolLines.isErr 同一判定)→ headline(权限被拒绝/失败,无详情行时)+ 折叠详情
 *     行数(ccUserFacingToolError 收敛 + toolErrorFold.planErrorFold)+「+N 行」页脚;
 *   - 完成 → ToolLines.estimateLiteralRows(±diff / shell 折叠体 / 展开透明体 / 摘要行)。
 *
 * @param {{name?:string,toolName?:string,tool?:string,progress?:*,result?:*}|null|undefined} tool
 * @param {{columns?:*,expanded?:boolean,live?:boolean,env?:object}} [opts]
 * @returns {number} ≥ 1
 */
function estimateToolEntryRows(tool, opts = {}) {
  try {
    const env = opts.env || process.env;
    if (!isEnabled(env)) {
      return 1;
    }
    if (!tool || typeof tool !== 'object') {
      return 1;
    }
    if (Array.isArray(tool._agentTree) && tool._agentTree.length > 0) {
      return 1;
    }
    const ToolLines = require('./ToolLines');
    let rows = 1; // header(◆/✓/✗ + 显示名 + 入参摘要)
    const result = tool.result;
    if (!result) {
      if (tool.progress) {
        rows += 1; // 执行中叙述行(live only,与渲染条件一致)
      }
      return rows;
    }
    const isErr = !!(
      result.isError ||
      result.is_error ||
      result.error ||
      result.success === false
    );
    if (isErr) {
      const denied = !!result.denied;
      const expanded = !!opts.expanded;
      const ccErr = require('../../ccUserFacingToolError');
      const fold = require('../../toolErrorFold');
      const rawReason = ToolLines.errorText(result, env);
      const reason = ccErr.collapseValidationErrorForDisplay(rawReason, { expanded }, env);
      const rawLines = reason ? String(reason).split('\n') : [];
      const { shown, hidden } = fold.planErrorFold(rawLines, expanded, env);
      if (denied || shown.length === 0) {
        rows += 1; // headline 行(权限被拒绝 / 失败)
      }
      rows += shown.length + (hidden > 0 ? 1 : 0);
      return rows;
    }
    const name = String(tool.name || tool.toolName || tool.tool || '');
    rows += ToolLines.estimateLiteralRows(result, {
      expanded: !!opts.expanded,
      live: opts.live !== false,
      shell: ToolLines.isShellResult(name),
      env,
    });
    return rows;
  } catch {
    return 1;
  }
}

module.exports = { isEnabled, estimateToolEntryRows, OFF_VALUES };
