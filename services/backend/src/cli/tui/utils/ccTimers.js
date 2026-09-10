'use strict';

/**
 * ccTimers.js —— CC 模式计时器常量管理
 *
 * 唯一合法的计时器常量来源。禁止在代码中硬编码计时器间隔。
 *
 * 参考：[DESIGN-ARCH-081] 计时与实时画面
 */

const TIMING = Object.freeze({
  // 流式输出
  streaming: Object.freeze({
    batchInterval: 16,      // 60fps 批量更新
    chunkSize: 512,         // 每批处理的字符数
    flushThreshold: 1024,   // 超过此值立即刷新
  }),

  // 状态栏更新
  statusBar: Object.freeze({
    interval: 1000,         // 每秒更新一次
    priority: 'low',
  }),

  // Spinner 动画
  spinner: Object.freeze({
    interval: 80,           // 12.5fps
    frames: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
  }),

  // MCP 状态轮询
  mcp: Object.freeze({
    interval: 5000,         // 每 5 秒轮询
    timeout: 2000,
  }),

  // 输入防抖
  input: Object.freeze({
    debounce: 16,
  }),

  // Resize 防抖
  resize: Object.freeze({
    debounce: 50,
  }),

  // 思考块折叠/展开
  thinking: Object.freeze({
    animationDuration: 200,
  }),

  // Toast 自动消失
  toast: Object.freeze({
    success: 3000,
    error: 5000,
    warning: 4000,
    info: 3000,
  }),

  // 双击退出检测
  doubleTapExit: Object.freeze({
    windowMs: 3000,
  }),
});

module.exports = { TIMING };
