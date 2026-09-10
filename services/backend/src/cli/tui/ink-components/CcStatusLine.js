'use strict';

/**
 * CcStatusLine.js —— CC 风格单行状态栏
 *
 * 格式：Model │ Context │ Cost │ Mode │ MCP
 *
 * 权限模式指示器：将 6 个后端 profile 映射为 4 级简单视图（ZCode 对齐）
 *   strict/normal → build（需确认编辑）
 *   acceptEdits  → edit（自动接受编辑）
 *   auto         → yolo（自动模式）
 *   dontAsk      → plan（只读计划）
 *   yolo         → yolo（完全自动）
 *
 * 窄终端 (< 60 列)：省略 token 计数，仅保留百分比
 * 宽终端 (>= 120 列)：显示 MCP 状态
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

/**
 * 6 个后端 profile → 4 级简单模式映射（ZCode 对齐）
 * 单一真源：所有前端模式显示必须调用此函数
 */
const PROFILE_TO_SIMPLE_MODE = Object.freeze({
  dontAsk: 'plan',
  strict: 'build',
  normal: 'build',
  acceptEdits: 'edit',
  auto: 'yolo',
  yolo: 'yolo',
});

/**
 * 简单模式 → 显示配置（标签 + 颜色 + 图标）
 */
const SIMPLE_MODE_DISPLAY = Object.freeze({
  plan: { label: 'plan', icon: '◈', color: CC_COLORS.info },
  build: { label: 'build', icon: '◉', color: CC_COLORS.warning },
  edit: { label: 'edit', icon: '◉', color: CC_COLORS.toolName },
  yolo: { label: 'yolo', icon: '⚡', color: CC_COLORS.error },
});

/**
 * 将后端 profile 转换为简单模式显示配置
 */
function getSimpleModeDisplay(profile) {
  const simpleMode = PROFILE_TO_SIMPLE_MODE[profile] || 'build';
  return SIMPLE_MODE_DISPLAY[simpleMode];
}

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
  const modelName = formatModelName(modelId);
  const contextTotal = getContextWindow(modelId);
  const contextStr = formatContext(contextUsed, contextTotal);
  const contextStatus = getContextStatus(contextUsed, contextTotal);
  const costStr = formatCost(cost);

  // 上下文颜色：根据用量变色
  const contextColor = contextStatus === 'critical'
    ? CC_COLORS.error
    : contextStatus === 'warning'
      ? CC_COLORS.warning
      : undefined; // 默认色

  // 构建片段
  const segments = [];

  // 模型名
  segments.push({ text: modelName, color: undefined });

  // 上下文
  segments.push({ text: contextStr, color: contextColor });

  // 费用
  if (cost > 0) {
    segments.push({ text: costStr, color: undefined });
  }

  // Vim 模式指示器（Claude Code 对齐）
  if (vimMode) {
    const vimDisplay = vimMode === 'normal'
      ? { text: '● NORM', color: CC_COLORS.success }
      : vimMode === 'visual'
        ? { text: '◒ VISU', color: CC_COLORS.warning }
        : { text: '│ INST', color: CC_COLORS.toolName };
    segments.push(vimDisplay);
  }

  // 任务时间预估（ZCode 对齐：2m/9h/1d）
  if (taskEstimate) {
    segments.push({ text: `⏱ ${taskEstimate}`, color: CC_COLORS.info });
  }

  // 权限模式指示器（ZCode 对齐）— 中等宽度即显示
  if (cols >= 50 && permissionProfile) {
    const modeDisplay = getSimpleModeDisplay(permissionProfile);
    segments.push({
      text: `${modeDisplay.icon} ${modeDisplay.label}`,
      color: modeDisplay.color,
    });
  }

  // 缓存命中率（宽终端，ZCode 对齐）
  if (cols >= 90 && cacheHitRate != null && cacheHitRate > 0) {
    const hitColor = cacheHitRate >= 70
      ? CC_COLORS.success
      : cacheHitRate >= 40
        ? CC_COLORS.warning
        : CC_COLORS.error;
    segments.push({
      text: `⚡ ${Math.round(cacheHitRate)}%`,
      color: hitColor,
    });
  }

  // MCP 状态（宽终端）
  if (cols >= 80 && mcpStatus && mcpStatus.servers && mcpStatus.servers.length > 0) {
    const connected = mcpStatus.servers.filter(s => s.state === 'connected').length;
    const total = mcpStatus.servers.length;
    const allConnected = connected === total;
    segments.push({
      text: `MCP •${connected}/${total}`,
      color: allConnected ? CC_COLORS.success : CC_COLORS.warning,
    });
  }

  // 窄终端简化
  if (cols < 60) {
    // 仅保留模型名 + 上下文百分比 + 模式
    const minimal = [segments[0]];
    if (segments[1]) {
      const pct = segments[1].text.match(/\d+%/);
      minimal.push({ text: pct ? pct[0] : segments[1].text, color: segments[1].color });
    }
    // 窄终端也保留模式指示器
    const modeSeg = segments.find(s => s.text && /^(◈|◉|⚡)/.test(s.text));
    if (modeSeg) {
      minimal.push(modeSeg);
    }
    return renderSegments(minimal);
  }

  return renderSegments(segments);
}

/**
 * 渲染片段（带分隔符）
 */
function renderSegments(segments) {
  const children = [];
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      children.push(
        React.createElement(Text, { key: `sep-${i}`, color: CC_COLORS.dimColor }, STATUS_SEPARATOR)
      );
    }
    const seg = segments[i];
    children.push(
      React.createElement(Text, { key: `seg-${i}`, color: seg.color }, seg.text)
    );
  }

  return (
    React.createElement(Box, null,
      React.createElement(Text, { color: CC_COLORS.dimColor }, ' '),
      ...children,
    )
  );
}

module.exports = {
  CcStatusLine: React.memo(CcStatusLine),
  getSimpleModeDisplay,
  PROFILE_TO_SIMPLE_MODE,
  SIMPLE_MODE_DISPLAY,
};
