'use strict';

/**
 * userFeedback.js — 统一用户反馈工具
 *
 * 解决"用户以为卡死"问题
 * 特性：
 *   - 分级超时（首 token 快速失败）
 *   - 进度心跳输出
 *   - 已用时间显示
 *   - 预计剩余时间
 *
 * 使用方式：
 *   const feedback = require('./userFeedback');
 *   feedback.startProgress('正在生成', { timeout: 30000 });
 *   feedback.updateProgress({ elapsed: 5000, message: '已处理 3/10' });
 *   feedback.endProgress({ success: true, message: '完成' });
 */

const { performance } = require('perf_hooks');

class ProgressFeedback {
  constructor(options = {}) {
    this.options = {
      timeout: options.timeout || 30000,
      heartbeatInterval: options.heartbeatInterval || 10000,
      showElapsed: options.showElapsed !== false,
      showETA: options.showETA !== false,
      onTimeout: options.onTimeout || (() => {}),
      onHeartbeat: options.onHeartbeat || (() => {}),
      ...options,
    };
    
    this.startTime = 0;
    this.lastHeartbeat = 0;
    this.heartbeatTimer = null;
    this.timeoutTimer = null;
    this.isRunning = false;
    this.lastProgress = null;
  }

  start(message, options = {}) {
    if (this.isRunning) {
      this.stop();
    }
    
    this.startTime = performance.now();
    this.lastHeartbeat = this.startTime;
    this.isRunning = true;
    this.lastProgress = null;
    
    // 输出开始消息
    if (this.options.onStart) {
      this.options.onStart(message, this);
    }
    
    // 设置超时定时器
    const timeout = options.timeout || this.options.timeout;
    this.timeoutTimer = setTimeout(() => {
      if (this.isRunning) {
        this._handleTimeout();
      }
    }, timeout);
    this.timeoutTimer.unref?.();
    
    // 设置心跳定时器
    const interval = options.heartbeatInterval || this.options.heartbeatInterval;
    this.heartbeatTimer = setInterval(() => {
      if (this.isRunning) {
        this._handleHeartbeat();
      }
    }, interval);
    this.heartbeatTimer.unref?.();
    
    return this;
  }

  update(progress = {}) {
    if (!this.isRunning) return this;
    
    this.lastProgress = {
      ...progress,
      elapsed: performance.now() - this.startTime,
    };
    
    if (this.options.onUpdate) {
      this.options.onUpdate(this.lastProgress, this);
    }
    
    return this;
  }

  end(result = {}) {
    if (!this.isRunning) return this;
    
    this._cleanup();
    
    const elapsed = performance.now() - this.startTime;
    
    if (this.options.onEnd) {
      this.options.onEnd({ ...result, elapsed }, this);
    }
    
    return this;
  }

  stop() {
    this._cleanup();
    return this;
  }

  _handleTimeout() {
    if (this.options.onTimeout) {
      this.options.onTimeout(this);
    }
  }

  _handleHeartbeat() {
    if (this.options.onHeartbeat) {
      this.options.onHeartbeat(this);
    }
  }

  _cleanup() {
    this.isRunning = false;
    
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  getElapsed() {
    if (!this.isRunning) return 0;
    return performance.now() - this.startTime;
  }

  getElapsedSeconds() {
    return Math.round(this.getElapsed() / 1000);
  }
}

/**
 * 创建带超时的 Promise
 */
function withTimeout(promise, options = {}) {
  const { timeout = 30000, onTimeout, onProgress } = options;
  
  return new Promise((resolve, reject) => {
    let isSettled = false;
    let progressInterval = null;
    
  const timeoutId = setTimeout(() => {
    if (!isSettled) {
      isSettled = true;
      if (progressInterval) clearInterval(progressInterval);
      const err = new Error(`操作超时（${Math.round(timeout / 1000)}s）`);
      if (onTimeout) onTimeout(err);
      reject(err);
    }
  }, timeout);
  
  // 进度心跳
  if (onProgress && options.heartbeatInterval) {
    let elapsed = 0;
    progressInterval = setInterval(() => {
      elapsed += options.heartbeatInterval;
      onProgress({ elapsed, timeout });
    }, options.heartbeatInterval);
    progressInterval.unref?.();
  }
  
  promise.then(
    (result) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timeoutId);
        if (progressInterval) clearInterval(progressInterval);
        resolve(result);
      }
    },
    (err) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timeoutId);
        if (progressInterval) clearInterval(progressInterval);
        reject(err);
      }
    }
  );
  });
}

/**
 * 创建带心跳的异步生成器
 */
async function* withHeartbeat(asyncGenerator, options = {}) {
  const { heartbeatInterval = 10000, onHeartbeat } = options;
  
  let lastYield = performance.now();
  let heartbeatTimer = null;
  
  if (onHeartbeat && heartbeatInterval) {
    heartbeatTimer = setInterval(() => {
      const idle = performance.now() - lastYield;
      onHeartbeat({ idle, elapsed: idle });
    }, heartbeatInterval);
    heartbeatTimer.unref?.();
  }
  
  try {
    for await (const value of asyncGenerator) {
      lastYield = performance.now();
      yield value;
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

/**
 * 格式化已用时间
 */
  function formatElapsed(ms) {
  if (ms < 1000) return '< 1s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

/**
 * 格式化预计剩余时间
 */
function formatETA(elapsed, progress) {
  if (!progress || progress <= 0) return '计算中...';
  const total = elapsed / progress;
  const remaining = total - elapsed;
  if (remaining < 0) return '即将完成';
  return `约 ${formatElapsed(remaining)}`;
}

module.exports = {
  ProgressFeedback,
  withTimeout,
  withHeartbeat,
  formatElapsed,
  formatETA,
};
