'use strict';

/**
 * CcScrollIndicators.js —— 滚动指示器
 *
 * 设计：
 * - 上方有内容：⋯ (N above)
 * - 下方有内容：⋯ (N below)
 * - 到达顶部/底部：无指示器
 *
 * 参考：[DESIGN-ARCH-087] 微交互与反馈设计
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');

const ELLIPSIS = '⋯';

/**
 * 滚动指示器
 */
function CcScrollIndicators({
  above = 0,    // 上方隐藏行数
  below = 0,    // 下方隐藏行数
}) {
  if (above <= 0 && below <= 0) return null;

  return (
    React.createElement(Box, { flexDirection: 'column' },
      above > 0
        ? React.createElement(Text, { color: CC_COLORS.dimColor }, ELLIPSIS + ' (' + above + ' above)')
        : null,
      below > 0
        ? React.createElement(Text, { color: CC_COLORS.dimColor }, ELLIPSIS + ' (' + below + ' below)')
        : null,
    )
  );
}

/**
 * 简化的滚动指示器（仅显示一侧）
 */
function CcScrollHint({ direction, count }) {
  if (count <= 0) return null;

  const label = direction === 'up' ? `${count} above` : `${count} below`;

  return React.createElement(Text, { color: CC_COLORS.dimColor },
    ELLIPSIS + ' (' + label + ')',
  );
}

module.exports = {
  CcScrollIndicators: React.memo(CcScrollIndicators),
  CcScrollHint: React.memo(CcScrollHint),
};
