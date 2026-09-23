'use strict';

/**
 * CcStatusLine.js —— CC 风格单行状态栏
 *
 * 格式：Model │ Context │ Cost │ Mode │ MCP
 *
 * 本组件只负责**画**。「显示哪几段」的决策在 ../utils/ccStatusBar.js，因为
 * 拖选投影（ccMessageProjection）必须对同一行记账 —— 两边此前各写一份
 * （投影层逐字抄过模式映射），现在共用一个纯函数。
 *
 * 关键不变式：**这一条永远只占 1 行**。账本（ccLayout.js:138「CcStatusLine
 * = 1 row」）据此扣减消息区预算；一旦这里画出 2 行，整帧就比终端高 1 行
 * ⇒ ink 走全屏分支写 \x1b[2J ⇒ win32 上把旧帧滚进 scrollback = 重影残帧。
 * 旧实现只用 `cols >= 50 / 80 / 90` 这类**列数阈值**决定「这一段要不要显示」，
 * 行宽本身从不参与，所以段数一多必然折行（实测 90 列 8 段折成 2 行，
 * 且各 Text 被 flex 等比压窄，模型名从中间断词）。
 *
 * 参考：[DESIGN-ARCH-081] Phase 2: 布局结构迁移
 * 灵感来源：ZCode 4 级模式系统（plan/build/edit/yolo）
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');
const { STATUS_SEPARATOR } = require('../utils/ccLayout');
const {
  formatModelName,
  formatContext,
  formatCost,
  getContextStatus,
} = require('../utils/ccFormatters');
const { getContextWindow } = require('../utils/ccContextWindows');
const { buildStatusSegments } = require('../utils/ccStatusBar');

// STATUS_SEPARATOR 自带两侧空格（' │ '），与 ccStatusBar 的宽度测算同一把尺子。
const SEP = STATUS_SEPARATOR;

/**
 * CC 风格单行状态栏
 */
function CcStatusLine({
  modelId,
  contextUsed = 0,
  cost = 0,
  cols = 80,
  mcpStatus = null, // { servers: [{ name, state }] }
  permissionProfile = null, // 当前权限 profile（6 个之一）
  cacheHitRate = null, // 缓存命中率（0-100），null 表示不可用
  vimMode = null, // Vim 模式：'normal' | 'insert' | 'visual' | null
  taskEstimate = null, // 任务时间预估（如 '2m', '9h', '1d'）
}) {
  const contextTotal = getContextWindow(modelId);
  const contextStatus = getContextStatus(contextUsed, contextTotal);
  const segments = buildStatusSegments({
    cols,
    modelName: formatModelName(modelId),
    contextStr: formatContext(contextUsed, contextTotal),
    contextColor: contextStatus === 'critical'
      ? CC_COLORS.error
      : contextStatus === 'warning' ? CC_COLORS.warning : undefined,
    cost,
    costStr: formatCost(cost),
    vimMode,
    taskEstimate,
    permissionProfile,
    cacheHitRate,
    mcpStatus,
  });

  return renderSegments(segments);
}

/**
 * 渲染片段。
 *
 * `flexShrink: 0` 是**必须**的，不是装饰：ink 的 flex 行默认允许子节点收缩，
 * 于是即便总宽 ≤ cols，多个 Text 也会被等比压窄并在**各自内部**换行
 * （实测 80 列下模型名断成 `anthropic:claude-sonnet-4` / `5`）。关掉收缩后，
 * 是否折行就完全由 ccStatusBar 的宽度决策决定 ⇒ 恒 1 行。
 */
function renderSegments(segments) {
  const children = [];
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      children.push(
        React.createElement(Text, {
          key: `sep-${i}`, color: CC_COLORS.dimColor, flexShrink: 0,
        }, SEP)
      );
    }
    const seg = segments[i];
    children.push(
      React.createElement(Text, {
        key: `seg-${i}`, color: seg.color, flexShrink: 0,
      }, seg.text)
    );
  }

  return (
    React.createElement(Box, { flexShrink: 0 },
      React.createElement(Text, { color: CC_COLORS.dimColor, flexShrink: 0 }, ' '),
      ...children,
    )
  );
}

module.exports = {
  CcStatusLine: React.memo(CcStatusLine),
};
