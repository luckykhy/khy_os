'use strict';

/**
 * ccRenderStrategy.js —— CC 模式渲染策略配置
 *
 * 核心原则：
 * 1. 静态内容使用 <Static> 组件（不重新渲染）
 * 2. 流式内容使用增量更新（仅更新变化部分）
 * 3. 批量更新（合并多次状态更新为一次渲染）
 * 4. 虚拟化（仅渲染可见区域）
 *
 * 参考：[DESIGN-ARCH-081] 渲染速度优化
 */

const RENDER_STRATEGY = Object.freeze({
  // 静态内容（已提交的消息）
  static: Object.freeze({
    component: 'Static',
    memoize: true,
    shouldUpdate: (prev, next) => prev.id !== next.id,
  }),

  // 流式内容（正在输出的消息）
  streaming: Object.freeze({
    component: 'StreamingBlock',
    batchInterval: 16,    // 60fps 批量更新
    maxChunkSize: 1024,
    useDiff: true,
  }),

  // 工具调用卡片
  toolCard: Object.freeze({
    component: 'CcToolCard',
    memoize: true,
    shouldUpdate: (prev, next) =>
      prev.status !== next.status || prev.result !== next.result,
  }),

  // 状态栏
  statusBar: Object.freeze({
    component: 'CcStatusLine',
    updateInterval: 1000, // 每秒更新
    memoize: true,
  }),

  // 输入框
  input: Object.freeze({
    component: 'CcPromptInput',
    debounce: 16,
    useCaret: true,
  }),

  // 右侧看板
  sidebar: Object.freeze({
    component: 'CcSidebarPanel',
    renderOnDemand: true, // 按需渲染，面板切换时更新
  }),
});

/**
 * 内容类型到渲染策略的映射
 */
const CONTENT_TYPE_MAP = Object.freeze({
  committedMessage: 'static',
  streamingOutput: 'streaming',
  toolCard: 'toolCard',
  statusBar: 'statusBar',
  input: 'input',
  sidebar: 'sidebar',
});

/**
 * 获取内容类型对应的渲染策略
 */
function getStrategy(contentType) {
  const key = CONTENT_TYPE_MAP[contentType];
  return key ? RENDER_STRATEGY[key] : null;
}

module.exports = { RENDER_STRATEGY, CONTENT_TYPE_MAP, getStrategy };
