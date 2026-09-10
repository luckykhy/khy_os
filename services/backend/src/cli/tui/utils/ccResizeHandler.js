'use strict';

/**
 * ccResizeHandler.js —— 终端 resize 无残影处理
 *
 * 策略：
 * 1. 监听 resize 事件（防抖 50ms）
 * 2. 重新计算布局
 * 3. 增量更新（仅重绘变化区域）
 *
 * 关键规则：
 * - 使用 ED0 而非 ED2（\x1B[0J 清除光标到末尾，保留滚动历史）
 * - 避免 \x1B[2J（全屏清除会擦除滚动历史）
 * - 防抖 50ms 避免频繁 resize 导致闪烁
 *
 * 参考：[DESIGN-ARCH-081] 调整大小无残影
 */

const { EventEmitter } = require('events');
const { TIMING } = require('./ccTimers');

class ResizeHandler extends EventEmitter {
  constructor(options = {}) {
    super();
    this._debounceMs = options.debounceMs || TIMING.resize.debounce;
    this._pending = null;
    this._lastCols = process.stdout.columns;
    this._lastRows = process.stdout.rows;
    this._onResize = this._onResize.bind(this);
  }

  start() {
    process.stdout.on('resize', this._onResize);
  }

  stop() {
    process.stdout.removeListener('resize', this._onResize);
    if (this._pending) {
      clearTimeout(this._pending);
      this._pending = null;
    }
  }

  _onResize() {
    if (this._pending) clearTimeout(this._pending);
    this._pending = setTimeout(() => {
      this._pending = null;
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (cols !== this._lastCols || rows !== this._lastRows) {
        this._lastCols = cols;
        this._lastRows = rows;
        this.emit('resize', { cols, rows });
      }
    }, this._debounceMs);
  }
}

module.exports = { ResizeHandler };
