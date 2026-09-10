'use strict';

/**
 * ccFeedback.js —— 反馈管理器
 *
 * 管理复制反馈、粘贴反馈、滚动指示等瞬态消息。
 * 所有反馈都有自动消失机制。
 *
 * 参考：[DESIGN-ARCH-087] 微交互与反馈设计
 */

const { TIMING } = require('./ccTimers');
const { formatCopyFeedback, formatPasteFeedback } = require('./ccFormatters');

/**
 * 反馈类型
 */
const FEEDBACK_TYPE = Object.freeze({
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});

/**
 * 反馈管理器（用于非 React 上下文）
 */
class FeedbackManager {
  constructor() {
    this._listeners = new Set();
    this._current = null;
    this._timer = null;
  }

  /**
   * 订阅反馈变化
   * @param {Function} listener
   * @returns {Function} 取消订阅函数
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * 发布反馈
   */
  _emit(feedback) {
    this._current = feedback;
    for (const listener of this._listeners) {
      try { listener(feedback); } catch { /* ignore */ }
    }
  }

  /**
   * 显示反馈（带自动消失）
   */
  show(message, type = FEEDBACK_TYPE.INFO, duration) {
    const autoDuration = duration || TIMING.toast[type] || TIMING.toast.info;

    // 清除之前的定时器
    if (this._timer) clearTimeout(this._timer);

    this._emit({ message, type, timestamp: Date.now() });

    this._timer = setTimeout(() => {
      this._emit(null);
      this._timer = null;
    }, autoDuration);

    return autoDuration;
  }

  /**
   * 复制反馈
   */
  copy(text) {
    const message = formatCopyFeedback(text);
    return this.show(message, FEEDBACK_TYPE.SUCCESS);
  }

  /**
   * 粘贴反馈
   */
  paste(text) {
    const message = formatPasteFeedback(text);
    return this.show(message, FEEDBACK_TYPE.INFO);
  }

  /**
   * 清除当前反馈
   */
  clear() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._emit(null);
  }

  /**
   * 销毁管理器
   */
  destroy() {
    this.clear();
    this._listeners.clear();
  }
}

// 单例
let _instance = null;
function getFeedbackManager() {
  if (!_instance) {
    _instance = new FeedbackManager();
  }
  return _instance;
}

module.exports = {
  FEEDBACK_TYPE,
  FeedbackManager,
  getFeedbackManager,
};
