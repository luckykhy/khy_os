'use strict';

/**
 * Viewport — 有界视口,在页面内滚动内容,不带动输入框。
 *
 * Ink 没有原生"区域内滚动"概念,本组件通过以下方式模拟:
 *   1. 测量视口可用行数(terminal 高度 - 其他 chrome)
 *   2. 维护 scrollOffset,只渲染可见窗口内的内容
 *   3. 提供键盘滚动(↑/↓/PageUp/PageDown/g/G)
 *
 * 两种使用方式:
 *
 *   A) children 模式(原有,适合少量动态子元素):
 *      <Viewport height={h} scroll={s} onScroll={setS}>
 *        {items.map((it, i) => <Text key={i}>{it}</Text>)}
 *      </Viewport>
 *
 *   B) lines 模式(新增,适合大量预渲染行 —— O(visible) 渲染,不重建子树):
 *      <Viewport height={h} scroll={s} onScroll={setS}
 *        lines={['line1', 'line2', ...]}
 *        autoScroll />
 *
 * lines 模式优势:
 *   - 父组件一次性算好全部视觉行(含软换行),Viewport 只做切片
 *   - 不创建 React 子元素 → 数千行时内存/重渲开销显著降低
 *   - autoScroll: lines 数组变长且当前在底部 → 自动追随底部
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');

function Viewport({
  height = 10,
  scroll = 0,
  onScroll,
  children,
  lines = null,
  autoScroll = false,
  showIndicator = true,
  emptyText = '',
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;

  // ── lines 模式:直接切片字符串数组 ──────────────────────────────────────────
  if (lines !== null && lines !== undefined) {
    const totalLines = lines.length;
    const maxScroll = Math.max(0, totalLines - height);
    let clampedScroll = Math.max(0, Math.min(scroll, maxScroll));

    // autoScroll: 如果之前在底部,内容变长后保持底部
    if (autoScroll && scroll >= maxScroll) {
      clampedScroll = maxScroll;
    }

    // 可见窗口
    const start = clampedScroll;
    const end = Math.min(totalLines, clampedScroll + height);
    const visible = lines.slice(start, end);

    // 空内容
    if (totalLines === 0 && emptyText) {
      return h(
        Box,
        { flexDirection: 'column', height },
        h(Text, { dimColor: true }, `  ${emptyText}`)
      );
    }

    const rows = [];
    for (let i = 0; i < visible.length; i++) {
      const line = visible[i];
      rows.push(
        h(
          Box,
          { key: `vl-${start + i}` },
          h(Text, null, line || ' ')
        )
      );
    }

    // 滚动指示器
    if (showIndicator && maxScroll > 0) {
      const above = clampedScroll;
      const below = maxScroll - clampedScroll;
      const indicatorParts = [];
      if (above > 0) indicatorParts.push(`↑${above}`);
      if (below > 0) indicatorParts.push(`↓${below}`);
      if (indicatorParts.length > 0) {
        rows.push(
          h(
            Text,
            { key: 'vp-indicator', dimColor: true, color: '#484f58' },
            `  ${indicatorParts.join(' ')}`
          )
        );
      }
    }

    return h(Box, { flexDirection: 'column', flexGrow: 1, height }, ...rows);
  }

  // ── children 模式(原有逻辑,兼容 PreviewLayout 等) ───────────────────────────
  const childArray = React.Children.toArray(children).filter(Boolean);
  const totalLines = childArray.length;

  // 滚动上界:内容不足视口时不可滚。
  const maxScroll = Math.max(0, totalLines - height);
  const clampedScroll = Math.max(0, Math.min(scroll, maxScroll));

  // 可见窗口
  const visible = childArray.slice(clampedScroll, clampedScroll + height);

  // 暴露滚动方法给父组件(通过 ref 回调)
  if (Viewport._registerScroll && onScroll) {
    Viewport._registerScroll(clampedScroll, maxScroll, onScroll);
  }

  return h(
    Box,
    { flexDirection: 'column' },
    visible,
    // 滚动指示器(可选)
    showIndicator && maxScroll > 0
      ? h(
          Text,
          { dimColor: true, color: '#484f58' },
          clampedScroll > 0 ? `  ↑ ${clampedScroll} 行` : '',
          clampedScroll < maxScroll ? `  ↓ ${maxScroll - clampedScroll} 行` : ''
        )
      : null
  );
}

// 滚动命令接口(供键盘处理器调用)
Viewport._registerScroll = null;

/**
 * 纯叶子:应用滚动动作,返回新偏移(已 clamp)。
 * 与 scrollActions 同一范式,但针对视口内偏移。
 */
function applyViewportScroll(action, { offset = 0, viewport = 10, total = 0 } = {}) {
  const maxScroll = Math.max(0, total - viewport);
  const cur = Math.max(0, Math.min(Number(offset) || 0, maxScroll));
  const half = Math.max(1, Math.floor(viewport / 2));
  const full = Math.max(1, viewport);
  let next = cur;
  switch (action) {
    case 'lineUp':
      next = cur - 1;
      break;
    case 'lineDown':
      next = cur + 1;
      break;
    case 'halfPageUp':
      next = cur - half;
      break;
    case 'halfPageDown':
      next = cur + half;
      break;
    case 'fullPageUp':
      next = cur - full;
      break;
    case 'fullPageDown':
      next = cur + full;
      break;
    case 'top':
      next = 0;
      break;
    case 'bottom':
      next = maxScroll;
      break;
    default:
      next = cur;
  }
  return Math.max(0, Math.min(next, maxScroll));
}

module.exports = Viewport;
module.exports.applyViewportScroll = applyViewportScroll;
