'use strict';

/**
 * ccExecutionMonitor.js —— 执行监控器
 *
 * 检测模型跑偏（循环检测 + 超时检测）。
 * 提供检查点和用户引导机制。
 *
 * 参考：[DESIGN-ARCH-088] 执行偏差处理
 */

const { TIMING } = require('./ccTimers');

/**
 * 执行状态
 */
const EXEC_STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  DEVIATING: 'deviating',  // 检测到跑偏
  TIMED_OUT: 'timed_out',
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
});

/**
 * 执行监控器类
 */
class ExecutionMonitor {
  constructor(options = {}) {
    this._timeoutMs = options.timeoutMs || 120_000; // 默认 2 分钟超时
    this._loopThreshold = options.loopThreshold || 3; // 循环检测阈值
    this._state = EXEC_STATE.IDLE;
    this._lastActivity = Date.now();
    this._actions = []; // 动作历史（用于循环检测）
    this._listeners = new Set();
    this._checkpoints = [];
  }

  /**
   * 订阅状态变化
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    const state = this.getState();
    for (const listener of this._listeners) {
      try { listener(state); } catch { /* ignore */ }
    }
  }

  /**
   * 开始监控
   */
  start() {
    this._state = EXEC_STATE.RUNNING;
    this._lastActivity = Date.now();
    this._actions = [];
    this._emit();
  }

  /**
   * 记录活动（重置空闲计时器）
   */
  recordActivity(type, detail) {
    this._lastActivity = Date.now();
    this._actions.push({ type, detail, timestamp: Date.now() });

    // 循环检测
    if (this._detectLoop()) {
      this._state = EXEC_STATE.DEVIATING;
      this._emit();
      return { deviating: true, reason: 'loop_detected' };
    }

    // 恢复运行状态
    if (this._state === EXEC_STATE.DEVIATING) {
      this._state = EXEC_STATE.RUNNING;
      this._emit();
    }

    return { deviating: false };
  }

  /**
   * 检测循环（同一动作重复 N 次）
   */
  _detectLoop() {
    if (this._actions.length < this._loopThreshold) return false;

    const recent = this._actions.slice(-this._loopThreshold);
    const types = recent.map(a => a.type);

    // 检查是否全部相同
    return types.every(t => t === types[0]);
  }

  /**
   * 检查是否超时
   */
  checkTimeout() {
    if (this._state !== EXEC_STATE.RUNNING && this._state !== EXEC_STATE.DEVIATING) {
      return { timedOut: false };
    }

    const idle = Date.now() - this._lastActivity;
    if (idle > this._timeoutMs) {
      this._state = EXEC_STATE.TIMED_OUT;
      this._emit();
      return {
        timedOut: true,
        idleMs: idle,
        suggestion: '执行超时：尝试拆分任务或提供更多上下文',
      };
    }

    return { timedOut: false, idleMs: idle };
  }

  /**
   * 创建检查点
   */
  checkpoint(label) {
    this._checkpoints.push({
      label,
      actionCount: this._actions.length,
      timestamp: Date.now(),
    });
  }

  /**
   * 回滚到最近检查点
   */
  rollback() {
    if (this._checkpoints.length === 0) return null;

    const cp = this._checkpoints.pop();
    this._actions = this._actions.slice(0, cp.actionCount);
    this._state = EXEC_STATE.RUNNING;
    this._lastActivity = Date.now();
    this._emit();
    return cp;
  }

  /**
   * 中断执行
   */
  interrupt() {
    this._state = EXEC_STATE.INTERRUPTED;
    this._emit();
  }

  /**
   * 完成执行
   */
  complete() {
    this._state = EXEC_STATE.COMPLETED;
    this._emit();
  }

  /**
   * 重置
   */
  reset() {
    this._state = EXEC_STATE.IDLE;
    this._lastActivity = Date.now();
    this._actions = [];
    this._checkpoints = [];
    this._emit();
  }

  /**
   * 获取当前状态
   */
  getState() {
    return {
      state: this._state,
      isRunning: this._state === EXEC_STATE.RUNNING,
      isDeviating: this._state === EXEC_STATE.DEVIATING,
      isTimedOut: this._state === EXEC_STATE.TIMED_OUT,
      actionCount: this._actions.length,
      idleMs: Date.now() - this._lastActivity,
      checkpointCount: this._checkpoints.length,
    };
  }
}

// 单例
let _instance = null;
function getExecutionMonitor() {
  if (!_instance) {
    _instance = new ExecutionMonitor();
  }
  return _instance;
}

module.exports = {
  EXEC_STATE,
  ExecutionMonitor,
  getExecutionMonitor,
};
