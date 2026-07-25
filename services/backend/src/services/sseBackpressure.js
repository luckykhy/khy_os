'use strict';

/**
 * SSE Backpressure — 流式背压控制器
 *
 * 借鉴 DeepSeek-TUI 的 8MB 高水位 + Smooth/CatchUp 双速模式设计。
 * 包装 Node.js HTTP response 的 write() 为背压感知写入，当下游消费慢
 * （弱网/WebSocket 拥塞）时暂停上游产出，避免内存膨胀和 UI 卡顿。
 *
 * 用法:
 *   const bp = new SSEBackpressure(res, { highWaterMark: 8 * 1024 * 1024 });
 *   await bp.write(ssePayload);   // 超高水位时自动等待 drain
 *   bp.writeSync(ssePayload);     // 尽力写入，不等待（适合 keepalive）
 *
 * @module sseBackpressure
 */

// ── 常量 ─────────────────────────────────────────────────────────

/** 默认高水位: 8MB（与 DeepSeek-TUI SSE_BACKPRESSURE_HIGH_WATERMARK 对齐） */
const DEFAULT_HIGH_WATER_MARK = 8 * 1024 * 1024;

/** 低水位: 高水位的 25%，用于判断积压排空 */
const LOW_WATER_RATIO = 0.25;

/** drain 等待上限: 30 秒（防止无限挂起） */
const DRAIN_TIMEOUT_MS = 30_000;

/** Smooth 模式每次最大行数 */
const SMOOTH_MAX_LINES = 32;

/** CatchUp 模式每次最大行数 */
const CATCHUP_MAX_LINES = 256;

/** CatchUp 进入阈值: 队列中的行数 */
const CATCHUP_ENTER_LINES = 64;

/** CatchUp 退出阈值: 队列中的行数 */
const CATCHUP_EXIT_LINES = 16;

/** 帧率限制: 最小写入间隔 (ms)，约 120 FPS */
const MIN_WRITE_INTERVAL_MS = 8;

// ── BackpressureMode ─────────────────────────────────────────────

const BPMode = {
  SMOOTH: 'smooth',
  CATCHUP: 'catchup',
};

// ── SSEBackpressure 类 ───────────────────────────────────────────

class SSEBackpressure {
  /**
   * @param {import('http').ServerResponse} res
   * @param {object} [options]
   * @param {number} [options.highWaterMark] 高水位字节数
   */
  constructor(res, options = {}) {
    this._res = res;
    this._hwm = options.highWaterMark || DEFAULT_HIGH_WATER_MARK;
    this._lwm = Math.floor(this._hwm * LOW_WATER_RATIO);
    this._mode = BPMode.SMOOTH;
    this._queuedLines = [];
    this._lastWriteTs = 0;
    this._drainWaits = 0;
    this._totalWrites = 0;
    this._destroyed = false;

    // 监听连接关闭
    res.on('close', () => { this._destroyed = true; });
  }

  /**
   * 带背压的异步写入。当写缓冲区超高水位时等待 drain。
   * @param {string} payload — SSE 格式的完整消息
   * @returns {Promise<boolean>} 是否成功写入
   */
  async write(payload) {
    if (this._destroyed || this._res.writableEnded) return false;

    // 帧率限制
    const now = Date.now();
    if (now - this._lastWriteTs < MIN_WRITE_INTERVAL_MS) {
      this._queuedLines.push(payload);
      return true; // 入队成功，稍后 flush
    }

    // 检查背压
    const buffered = this._res.writableLength || 0;
    if (buffered > this._hwm) {
      this._drainWaits++;
      await this._waitForDrain();
      if (this._destroyed) return false;
    }

    // 先 flush 队列
    this._flushQueue();

    // 写入当前负载
    return this._doWrite(payload);
  }

  /**
   * 同步尽力写入（不等待 drain）。适用于 keepalive 心跳等低优先级写入。
   * @param {string} payload
   * @returns {boolean}
   */
  writeSync(payload) {
    if (this._destroyed || this._res.writableEnded) return false;

    // 背压过高时跳过非关键写入
    const buffered = this._res.writableLength || 0;
    if (buffered > this._hwm) return false;

    if (this._queuedLines.length > 0) {
      this._flushQueue();
    }

    return this._doWrite(payload);
  }

  /**
   * 批量 flush 已入队的行。按当前模式决定每次 flush 的行数。
   */
  _flushQueue() {
    if (this._queuedLines.length === 0) return;

    const maxLines = this._mode === BPMode.CATCHUP
      ? CATCHUP_MAX_LINES : SMOOTH_MAX_LINES;

    // 模式切换（滞环）
    if (this._mode === BPMode.SMOOTH && this._queuedLines.length >= CATCHUP_ENTER_LINES) {
      this._mode = BPMode.CATCHUP;
    } else if (this._mode === BPMode.CATCHUP && this._queuedLines.length < CATCHUP_EXIT_LINES) {
      this._mode = BPMode.SMOOTH;
    }

    const batch = this._queuedLines.splice(0, maxLines);
    if (batch.length > 0) {
      this._doWrite(batch.join(''));
    }
  }

  /**
   * 底层写入
   */
  _doWrite(payload) {
    try {
      this._res.write(payload);
      this._lastWriteTs = Date.now();
      this._totalWrites++;
      return true;
    } catch {
      this._destroyed = true;
      return false;
    }
  }

  /**
   * 等待 drain 事件，带超时保护
   */
  _waitForDrain() {
    return new Promise((resolve) => {
      if (this._destroyed || this._res.writableEnded) {
        resolve();
        return;
      }

      let timer;
      const onDrain = () => {
        clearTimeout(timer);
        resolve();
      };

      timer = setTimeout(() => {
        this._res.removeListener('drain', onDrain);
        resolve(); // 超时后放行，避免无限挂起
      }, DRAIN_TIMEOUT_MS);

      this._res.once('drain', onDrain);
    });
  }

  /**
   * 获取状态信息（供监控/调试）
   */
  getStats() {
    return {
      mode: this._mode,
      queuedLines: this._queuedLines.length,
      writableLength: this._res.writableLength || 0,
      drainWaits: this._drainWaits,
      totalWrites: this._totalWrites,
      destroyed: this._destroyed,
    };
  }

  /**
   * 强制 flush 所有队列内容
   */
  async flushAll() {
    while (this._queuedLines.length > 0 && !this._destroyed) {
      const batch = this._queuedLines.splice(0, CATCHUP_MAX_LINES);
      this._doWrite(batch.join(''));
      // 如果背压高，等一下
      const buffered = this._res.writableLength || 0;
      if (buffered > this._hwm) {
        await this._waitForDrain();
      }
    }
  }

  destroy() {
    this._destroyed = true;
    this._queuedLines.length = 0;
  }
}

module.exports = {
  SSEBackpressure,
  BPMode,
  DEFAULT_HIGH_WATER_MARK,
  SMOOTH_MAX_LINES,
  CATCHUP_MAX_LINES,
};
