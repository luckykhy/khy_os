'use strict';

/**
 * G1 — 流式换行门控 (Line Buffer)
 *
 * 从 DeepSeek-TUI line_buffer.rs 学习，实现流式文本的行级缓冲：
 * - 只输出完整行（以 \n 结尾），不完整的尾部保留到下一次 push
 * - 对代码围栏、表格块等多行结构进行保护，不在中间拆分
 * - flushAll() 用于流结束时强制输出剩余内容
 *
 * G2 — 自适应分块 (Adaptive Chunker)
 *
 * 从 DeepSeek-TUI chunking.rs 学习，使用迟滞控制器避免状态震荡：
 * - Smooth 模式：逐行输出，低延迟
 * - CatchUp 模式：积压过多时批量输出，防止卡顿
 * - Severe 模式：严重积压时丢弃中间内容，只保留首尾
 */

// ─── G1: LineBuffer ────────────────────────────────────────────────

class LineBuffer {
  constructor() {
    this._pending = '';
    this._fenceOpen = false; // 当前是否在代码围栏内
    this._tableRun = false;  // 当前是否在表格块内
  }

  /**
   * 追加增量文本
   */
  push(delta) {
    if (!delta) return;
    this._pending += delta;
  }

  /**
   * 返回可安全输出的完整行（到最后一个 \n 为止），
   * 但不会在以下结构中间拆分：
   *   - 未闭合的代码围栏 (```)
   *   - 连续的 markdown 表格行
   *
   * 返回空字符串表示当前没有可输出的内容。
   */
  takeCommittable() {
    const buf = this._pending;
    if (!buf) return '';

    // 找到最后一个换行符——这是候选拆分点
    const lastNl = buf.lastIndexOf('\n');
    if (lastNl < 0) return ''; // 没有完整行

    const candidate = buf.slice(0, lastNl + 1);
    const tail = buf.slice(lastNl + 1);

    // 围栏保护：统计候选区域内的围栏数量（基于全局跟踪状态）
    const fences = candidate.match(/^```/gm);
    const fenceCount = fences ? fences.length : 0;
    const netOpen = (this._fenceOpen ? 1 : 0) + fenceCount;
    if (netOpen % 2 !== 0) {
      // 围栏未闭合，不输出
      return '';
    }

    // 表格保护：如果候选最后一行和尾部第一行都是表格行，不拆分
    if (tail.length > 0) {
      const lastLine = _lastNonEmptyLine(candidate);
      const nextLine = (tail.split('\n')[0] || '').trim();
      if (_isTableLine(lastLine) && _isTableLine(nextLine)) {
        return '';
      }
    }

    // 可安全输出
    this._pending = tail;
    // 更新围栏状态
    this._fenceOpen = netOpen % 2 !== 0;
    return candidate;
  }

  /**
   * 当没有完整行但缓冲区已积压 minChars 以上内容时，
   * 在最近的单词/CJK 字符/标点边界处切割输出。
   * 保证文本不会因为缺少换行而无限期卡在缓冲区。
   *
   * @param {number} minChars — 最小积压长度才触发
   * @returns {string} 可输出的文本（可能为空）
   */
  takePartial(minChars = 80) {
    const buf = this._pending;
    if (!buf || buf.length < minChars) return '';

    // 围栏内不拆分
    const fences = buf.match(/^```/gm);
    const fenceCount = fences ? fences.length : 0;
    const netOpen = (this._fenceOpen ? 1 : 0) + fenceCount;
    if (netOpen % 2 !== 0) return '';

    // 找最佳切割点：最后一个空格、CJK 字符后、或标点后
    // 搜索范围：[minChars * 0.5, buf.length]
    const searchStart = Math.floor(minChars * 0.5);
    let cutAt = -1;

    for (let i = buf.length - 1; i >= searchStart; i--) {
      const ch = buf[i];
      // 空格边界
      if (ch === ' ' || ch === '\t') { cutAt = i + 1; break; }
      // CJK 字符后（中日韩可以在任意字符后断开）
      if (ch.charCodeAt(0) >= 0x3000) { cutAt = i + 1; break; }
      // 标点后
      if (/[，。、；：！？,.;:!?）】」』"'…—]/.test(ch)) { cutAt = i + 1; break; }
    }

    if (cutAt <= 0) {
      // 没找到好的切割点，在 minChars 处硬切
      cutAt = minChars;
    }

    const out = buf.slice(0, cutAt);
    this._pending = buf.slice(cutAt);
    return out;
  }

  /**
   * 流结束时强制输出所有剩余内容
   */
  flushAll() {
    const r = this._pending;
    this._pending = '';
    this._fenceOpen = false;
    this._tableRun = false;
    return r;
  }

  /**
   * 当前缓冲区字节长度
   */
  get pendingLength() {
    return this._pending.length;
  }

  /**
   * 当前缓冲区行数
   */
  get pendingLines() {
    if (!this._pending) return 0;
    const m = this._pending.match(/\n/g);
    return m ? m.length : 0;
  }
}

// ─── G2: AdaptiveChunker ──────────────────────────────────────────

/**
 * 迟滞阈值常量（参照 DeepSeek-TUI chunking.rs 的设计）
 *
 * - ENTER_*: 从 Smooth → CatchUp 的进入阈值（较高）
 * - EXIT_*:  从 CatchUp → Smooth 的退出阈值（较低） + 保持时间
 * - SEVERE_*: 进入 Severe（丢弃）模式的极端阈值
 */
const CHUNKING = {
  // Smooth → CatchUp 进入条件
  ENTER_LINES: 160,
  ENTER_AGE_MS: 1200,

  // CatchUp → Smooth 退出条件
  EXIT_LINES: 32,
  EXIT_AGE_MS: 300,
  EXIT_HOLD_MS: 250,

  // 防止快速重入 CatchUp
  REENTER_HOLD_MS: 250,

  // Severe 模式阈值
  SEVERE_LINES: 640,
  SEVERE_AGE_MS: 4000,

  // CatchUp 批量大小
  CATCHUP_BATCH: 40,
};

/**
 * 分块状态枚举
 */
const ChunkMode = {
  SMOOTH: 'smooth',
  CATCHUP: 'catchup',
  SEVERE: 'severe',
};

class AdaptiveChunker {
  /**
   * @param {LineBuffer} lineBuffer — 上游 LineBuffer 实例
   * @param {function(string):void} renderFn — 输出回调
   */
  constructor(lineBuffer, renderFn) {
    this._lb = lineBuffer;
    this._render = renderFn;
    this._mode = ChunkMode.SMOOTH;
    this._firstChunkTs = 0;       // 当前积压的起始时间
    this._lastModeChange = 0;     // 上次模式切换的时间戳
    this._catchupExitTs = 0;      // CatchUp 退出条件首次满足的时间
  }

  /**
   * 每次从 SSE 收到新 delta 后调用
   */
  tick() {
    const now = Date.now();
    const lines = this._lb.pendingLines;
    const len = this._lb.pendingLength;

    if (lines === 0 && len === 0) return;

    // 记录积压起始时间
    if (this._firstChunkTs === 0) {
      this._firstChunkTs = now;
    }
    const age = now - this._firstChunkTs;

    // ── 状态转换 ──
    if (this._mode === ChunkMode.SMOOTH) {
      if (lines >= CHUNKING.SEVERE_LINES || age >= CHUNKING.SEVERE_AGE_MS) {
        this._mode = ChunkMode.SEVERE;
        this._lastModeChange = now;
      } else if (
        (lines >= CHUNKING.ENTER_LINES || age >= CHUNKING.ENTER_AGE_MS) &&
        (now - this._lastModeChange >= CHUNKING.REENTER_HOLD_MS)
      ) {
        this._mode = ChunkMode.CATCHUP;
        this._lastModeChange = now;
        this._catchupExitTs = 0;
      }
    } else if (this._mode === ChunkMode.CATCHUP) {
      if (lines >= CHUNKING.SEVERE_LINES || age >= CHUNKING.SEVERE_AGE_MS) {
        this._mode = ChunkMode.SEVERE;
        this._lastModeChange = now;
      } else if (lines < CHUNKING.EXIT_LINES && age < CHUNKING.EXIT_AGE_MS) {
        if (this._catchupExitTs === 0) {
          this._catchupExitTs = now;
        } else if (now - this._catchupExitTs >= CHUNKING.EXIT_HOLD_MS) {
          this._mode = ChunkMode.SMOOTH;
          this._lastModeChange = now;
          this._catchupExitTs = 0;
        }
      } else {
        this._catchupExitTs = 0;
      }
    }
    // SEVERE 不自动退出，靠 flushAll 结束

    // ── 按模式输出 ──
    switch (this._mode) {
      case ChunkMode.SMOOTH:
        this._emitSmooth();
        break;
      case ChunkMode.CATCHUP:
        this._emitCatchUp();
        break;
      case ChunkMode.SEVERE:
        // severe 模式下暂不输出，等 flushAll 一次性处理
        break;
    }
  }

  /**
   * 流结束时调用
   */
  flushAll() {
    const remaining = this._lb.flushAll();
    if (remaining) {
      this._render(remaining);
    }
    this._reset();
  }

  /**
   * Smooth 模式：逐次取可提交的完整行输出。
   * 当没有完整行但缓冲区积压超过 80 字符时，使用 takePartial 避免卡住。
   */
  _emitSmooth() {
    let text = this._lb.takeCommittable();
    if (!text && this._lb.pendingLength >= 80) {
      // 没有完整行但缓冲区已积压——部分输出避免进入 SEVERE
      text = this._lb.takePartial(80);
    }
    if (text) {
      this._render(text);
      this._firstChunkTs = this._lb.pendingLength > 0 ? this._firstChunkTs : 0;
    }
  }

  /**
   * CatchUp 模式：批量取出多次可提交行
   */
  _emitCatchUp() {
    let batch = '';
    let rounds = 0;
    while (rounds < CHUNKING.CATCHUP_BATCH) {
      const chunk = this._lb.takeCommittable();
      if (!chunk) break;
      batch += chunk;
      rounds++;
    }
    if (batch) {
      this._render(batch);
      this._firstChunkTs = this._lb.pendingLength > 0 ? Date.now() : 0;
    }
  }

  _reset() {
    this._mode = ChunkMode.SMOOTH;
    this._firstChunkTs = 0;
    this._lastModeChange = 0;
    this._catchupExitTs = 0;
  }

  /**
   * 当前模式（供调试/监控）
   */
  get mode() {
    return this._mode;
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────

function _lastNonEmptyLine(text) {
  const lines = text.trimEnd().split('\n');
  return (lines[lines.length - 1] || '').trim();
}

function _isTableLine(line) {
  return /^\s*\|.*\|/.test(line);
}

// ─── 导出 ────────────────────────────────────────────────────────

module.exports = {
  LineBuffer,
  AdaptiveChunker,
  ChunkMode,
  CHUNKING,
};
