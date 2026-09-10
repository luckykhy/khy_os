'use strict';

/**
 * ccUndoStack.js —— 操作栈（撤销/重做）
 *
 * 管理 CC 模式下的操作历史，支持：
 * - z 撤销
 * - Z (Shift+Z) 重做
 * - 最大历史深度限制
 *
 * 参考：[DESIGN-ARCH-088] 快捷键系统、Redo/Fork
 */

const MAX_HISTORY = 50;

/**
 * 操作栈类
 */
class UndoStack {
  constructor(options = {}) {
    this._maxDepth = options.maxDepth || MAX_HISTORY;
    this._undoStack = [];
    this._redoStack = [];
    this._listeners = new Set();
  }

  /**
   * 订阅变化
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    const state = this.state();
    for (const listener of this._listeners) {
      try { listener(state); } catch { /* ignore */ }
    }
  }

  /**
   * 压入操作
   */
  push(action) {
    if (!action) return;

    this._undoStack.push({
      ...action,
      timestamp: Date.now(),
    });

    // 超出深度时丢弃最旧的操作
    if (this._undoStack.length > this._maxDepth) {
      this._undoStack.shift();
    }

    // 新操作清空重做栈
    this._redoStack = [];

    this._emit();
  }

  /**
   * 撤销
   */
  undo() {
    if (this._undoStack.length === 0) return null;

    const action = this._undoStack.pop();
    this._redoStack.push(action);

    this._emit();
    return action;
  }

  /**
   * 重做
   */
  redo() {
    if (this._redoStack.length === 0) return null;

    const action = this._redoStack.pop();
    this._undoStack.push(action);

    this._emit();
    return action;
  }

  /**
   * 清空
   */
  clear() {
    this._undoStack = [];
    this._redoStack = [];
    this._emit();
  }

  /**
   * 当前状态
   */
  state() {
    return {
      canUndo: this._undoStack.length > 0,
      canRedo: this._redoStack.length > 0,
      undoDepth: this._undoStack.length,
      redoDepth: this._redoStack.length,
    };
  }

  /**
   * 获取撤销栈顶（不弹出）
   */
  peek() {
    return this._undoStack.length > 0
      ? this._undoStack[this._undoStack.length - 1]
      : null;
  }
}

// 单例
let _instance = null;
function getUndoStack() {
  if (!_instance) {
    _instance = new UndoStack();
  }
  return _instance;
}

module.exports = { UndoStack, getUndoStack, MAX_HISTORY };
