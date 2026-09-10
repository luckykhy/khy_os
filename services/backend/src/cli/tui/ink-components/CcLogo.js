'use strict';

/**
 * CcLogo.js —— CC 风格动画 Logo（Khy 品牌版）
 *
 * 设计：
 * - ✳ 动画星号 + "Khy" 品牌名
 * - 星号颜色为橙色品牌色
 * - 支持动画闪烁效果
 *
 * 参考：[DESIGN-ARCH-081] Phase 6: 动画与微交互
 */

const React = require('react');
const { Text, Box } = require('../inkRuntime').get();
const { CC_COLORS } = require('../theme/ccTheme');
const { BRAND } = require('../utils/ccBrand');

/**
 * CC 风格 Logo（静态）
 */
function CcLogo({ subtitle = true }) {
  return (
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center', marginY: 1 },
      React.createElement(Text, { color: CC_COLORS.brand, bold: true },
        BRAND.logo + ' ' + BRAND.name
      ),
      subtitle
        ? React.createElement(Text, { color: CC_COLORS.dimColor }, BRAND.tagline)
        : null,
    )
  );
}

/**
 * CC 风格 Logo（带动画闪烁）
 */
function CcAnimatedLogo({ subtitle = true }) {
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setVisible(v => !v);
    }, 800);
    return () => clearInterval(timer);
  }, []);

  return (
    React.createElement(Box, { flexDirection: 'column', alignItems: 'center', marginY: 1 },
      React.createElement(Text, { color: CC_COLORS.brand, bold: true, dimColor: !visible },
        BRAND.logo + ' ' + BRAND.name
      ),
      subtitle
        ? React.createElement(Text, { color: CC_COLORS.dimColor }, BRAND.tagline)
        : null,
    )
  );
}

module.exports = {
  CcLogo: React.memo(CcLogo),
  CcAnimatedLogo: React.memo(CcAnimatedLogo),
};
