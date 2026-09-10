'use strict';

/**
 * useSidebarState.js —— 右侧看板状态管理 Hook
 *
 * 管理右侧看板的显示/隐藏、当前面板、面板数据。
 *
 * 参考：[DESIGN-ARCH-081] Phase 1: 右侧看板设计规范
 */

const React = require('react');
const { shouldShowSidebar } = require('../utils/ccLayout');

/**
 * 右侧看板状态管理
 * @param {object} options
 * @param {number} options.cols - 终端列数
 * @param {boolean} options.forceShow - 强制显示（覆盖自动判断）
 * @param {boolean} options.forceHide - 强制隐藏
 * @returns {{ visible: boolean, activePanel: string, setActivePanel, toggle, stats, setStats }}
 */
function useSidebarState({ cols = 80, forceShow = false, forceHide = false } = {}) {
  // 是否显示看板
  const defaultVisible = forceHide ? false : forceShow ? true : shouldShowSidebar(cols);
  const [visible, setVisible] = React.useState(defaultVisible);
  const [activePanel, setActivePanel] = React.useState('context');
  const [stats, setStats] = React.useState(null);

  // 终端尺寸变化时更新
  React.useEffect(() => {
    if (!forceShow && !forceHide) {
      setVisible(shouldShowSidebar(cols));
    }
  }, [cols, forceShow, forceHide]);

  // 切换显示/隐藏
  const toggle = React.useCallback(() => {
    setVisible(v => !v);
  }, []);

  return {
    visible,
    setVisible,
    activePanel,
    setActivePanel,
    toggle,
    stats,
    setStats,
  };
}

module.exports = { useSidebarState };
