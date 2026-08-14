'use strict';

/**
 * turnEventStandardizer.js — Y-code 风格 Turn 事件标准化器。
 *
 * 基于 Y-code core/turn_renderer.py 的 TurnRenderer，
 * 将原始工具执行结果转换为结构化 Turn 事件类型，
 * 支持渐进式流式渲染。
 *
 * 事件类型：
 *  - thinking_delta   → 内部推理增量（消费但不渲染）
 *  - thinking_finished → 推理完成，刷新 thinking buffer
 *  - tool_started     → 工具开始执行
 *  - tool_requested   → 工具请求已生成（尚未执行）
 *  - tool_finished    → 工具执行完成
 *  - diff_ready       → diff 渲染就绪（含 +行/-行 统计）
 *  - plan_updated     → 计划状态更新
 *  - error            → 执行错误
 *  - assistant_text   → 普通文本增量
 *
 * 使用方式：
 *  const renderer = new TurnEventRenderer();
 *  renderer.consume('tool_finished', { name, arguments, result, ok });
 *  const lines = renderer.getOutput();
 */

const toolResultSanitizer = require('../utils/toolResultSanitizer');

// ─── Constants ─────────────────────────────────────────────────────────────

const OPEN_TAGS = ['<thinking>', '<think>'];
const CLOSE_TAGS = ['</thinking>', '</think>'];
const CODE_FENCES = ['```', '~~~'];

// ─── Class ─────────────────────────────────────────────────────────────────

class TurnEventRenderer {
  constructor() {
    this._records = [];
    this._pendingText = '';
    this._inThinking = false;
    this._inCodeBlock = false;
    this._codeFence = '';
    this._finished = false;
    this._sawToolEvent = false;
    this._hasMeaningfulAssistantText = false;
    this._emitted = [];
    this._errors = new Set();
    this._assistantTextParts = [];
    this._suppressAssistantEmit = false;
  }

  /**
   * Process a structured turn event and return formatted output lines.
   *
   * @param {string} kind - Event type
   * @param {object} [payload={}] - Event data
   * @returns {string[]} Emitted lines since last call
   */
  consume(kind, payload) {
    payload = payload || {};
    if (this._finished) {
      return [];
    }

    this._emitted = [];

    switch (kind) {
      case 'thinking_delta':
        this._consumeThinkingDelta(String(payload.text || ''));
        break;

      case 'thinking_started':
        this._flushPendingToolLines();
        break;

      case 'thinking_finished':
        this._flushThinking();
        break;

      case 'assistant_text':
        this._flushPendingToolLines();
        this._consumeText(String(payload.text || ''));
        break;

      case 'tool_started':
      case 'tool_requested':
        this._sawToolEvent = true;
        this._trackToolStart(payload);
        break;

      case 'tool_finished':
        this._sawToolEvent = true;
        this._appendToolLines(this._formatToolFinished(payload));
        break;

      case 'diff_ready':
        this._sawToolEvent = true;
        this._appendToolLines(this._formatDiffReady(payload));
        break;

      case 'plan_updated':
        this._formatPlanUpdated(payload);
        break;

      case 'error':
        this._handleError(String(payload.message || 'Unknown error'));
        break;

      default:
        // Unknown event: silently ignore
        break;
    }

    return [...this._emitted];
  }

  /**
   * Get the complete assistant reply after removing thinking tags.
   *
   * @returns {string}
   */
  getAssistantText() {
    if (!this._hasMeaningfulAssistantText) {
      return '';
    }
    return this._assistantTextParts.join('');
  }

  /**
   * Flush all pending content and mark renderer as finished.
   *
   * @returns {string} All accumulated output
   */
  finish() {
    if (!this._finished) {
      this._flushPending();
      this._finished = true;
    }
    return this._records.join('').replace(/\n+$/, '');
  }

  /**
   * Incremental flush for streaming: only emit content that was waiting
   * for a complete stream boundary.
   *
   * @param {boolean} [includeAssistantText=true]
   * @returns {string[]}
   */
  flushIncremental(includeAssistantText) {
    if (this._finished) {
      return [];
    }
    this._emitted = [];
    const prevSuppress = this._suppressAssistantEmit;
    this._suppressAssistantEmit = !includeAssistantText;
    try {
      this._flushPending();
    } finally {
      this._suppressAssistantEmit = prevSuppress;
    }
    return [...this._emitted];
  }

  // ─── Private: text processing ─────────────────────────────────────────────

  _consumeText(chunk) {
    this._pendingText += chunk;
    while (this._pendingText) {
      if (this._inThinking) {
        const closing = _findTag(this._pendingText, CLOSE_TAGS);
        if (closing === null) {
          const safeLen = _safePrefixLength(this._pendingText, CLOSE_TAGS);
          this._pendingText = this._pendingText.slice(safeLen);
          return;
        }
        const [index, tag] = closing;
        this._pendingText = this._pendingText.slice(index + tag.length);
        this._inThinking = false;
        continue;
      }

      if (this._inCodeBlock) {
        const fence = this._codeFence;
        const closing = this._pendingText.indexOf(fence);
        if (closing === -1) {
          const safeLen = _safePrefixLength(this._pendingText, [fence]);
          if (safeLen > 0) {
            this._appendText(this._pendingText.slice(0, safeLen));
            this._pendingText = this._pendingText.slice(safeLen);
          }
          return;
        }
        this._appendText(this._pendingText.slice(0, closing + fence.length));
        this._pendingText = this._pendingText.slice(closing + fence.length);
        this._inCodeBlock = false;
        this._codeFence = '';
        continue;
      }

      const thinkOpen = _findTag(this._pendingText, OPEN_TAGS);
      const codeOpen = _findTag(this._pendingText, CODE_FENCES);

      if (codeOpen !== null && (thinkOpen === null || codeOpen[0] < thinkOpen[0])) {
        const [codeIndex, fence] = codeOpen;
        if (codeIndex > 0) {
          const suffix = this._pendingText.slice(codeIndex);
          this._pendingText = this._pendingText.slice(0, codeIndex);
          this._consumeText('');
          if (this._pendingText) {
            this._pendingText += suffix;
            return;
          }
          this._pendingText = suffix;
        }
        this._appendText(this._pendingText.slice(0, fence.length));
        this._pendingText = this._pendingText.slice(fence.length);
        this._inCodeBlock = true;
        this._codeFence = fence;
        continue;
      }

      if (thinkOpen === null) {
        let safeLen = _safePrefixLength(this._pendingText, OPEN_TAGS);
        while (
          (safeLen > 0 && this._pendingText[safeLen - 1] === '`') ||
          this._pendingText[safeLen - 1] === '~'
        ) {
          safeLen--;
        }
        if (safeLen > 0) {
          this._appendText(this._pendingText.slice(0, safeLen));
          this._pendingText = this._pendingText.slice(safeLen);
        }
        return;
      }

      const [thinkIndex, thinkTag] = thinkOpen;
      if (thinkIndex > 0) {
        this._appendText(this._pendingText.slice(0, thinkIndex));
      }
      this._pendingText = this._pendingText.slice(thinkIndex + thinkTag.length);
      this._inThinking = true;
    }
  }

  _consumeThinkingDelta(text) {
    // Internal reasoning content: consumed but not rendered.
    // Y-code pattern: thinking is consumed (to maintain state), not displayed.
    // Khyos: no-op — thinking is either hidden or streamed directly.
    if (typeof text === 'string') {
      /* intentionally unused — thinking delta consumed for state tracking only */
    }
  }

  _appendText(text) {
    const clean = _sanitizeProtocolText(text);
    if (!clean) {
      return;
    }
    this._assistantTextParts.push(clean);

    if (!this._suppressAssistantEmit && clean) {
      this._emitted.push(clean);
    }

    if (!_isMeaningfulText(clean)) {
      return;
    }
    this._hasMeaningfulAssistantText = true;

    if (this._records.length > 0 && !this._records[this._records.length - 1].endsWith('\n')) {
      this._records[this._records.length - 1] += clean;
    } else {
      this._records.push(clean);
    }
  }

  _appendLine(text) {
    this._finishCurrentLine();
    const line = text.replace(/\n$/, '') + '\n';
    this._records.push(line);
    this._emitted.push(line);
  }

  _finishCurrentLine() {
    if (this._records.length > 0 && !this._records[this._records.length - 1].endsWith('\n')) {
      this._records.push('\n');
      this._emitted.push('\n');
    }
  }

  _appendToolLines(lines) {
    for (const line of lines) {
      this._appendLine(line);
    }
  }

  _flushPendingToolLines() {
    // Placeholder: in Y-code this flushes tool progress aggregator state
    // Khyos version: no-op (tool lines are flushed at finish time)
  }

  _flushThinking() {
    // Thinking content consumed, nothing to display
  }

  _flushPending() {
    this._appendToolLines([]);
    this._flushThinking();

    if (!this._inThinking && this._pendingText) {
      this._appendText(this._pendingText);
    }
    this._pendingText = '';

    if (!this._hasMeaningfulAssistantText && !this._sawToolEvent) {
      this._appendLine('本轮暂未返回内容。');
    }
  }

  // ─── Private: event handlers ──────────────────────────────────────────────

  _trackToolStart(payload) {
    // In Y-code this feeds ToolProgressAggregator.
    // Khyos version: just track that a tool event occurred.
    // The actual display formatting happens at finish time.
  }

  _formatToolFinished(payload) {
    const id = String(payload.id || '');
    if (!id) {
      return [];
    }
    const name = String(payload.name || payload.toolName || 'tool');
    const result = payload.result || {};
    const ok =
      typeof payload.ok === 'boolean' ? payload.ok : !String(result.content || '').startsWith('🚨');
    const sanitized = toolResultSanitizer.fullSanitize(String(result.content || ''));

    if (ok) {
      const target = toolResultSanitizer.toolTarget(name, payload.arguments || {});
      const lineCount = typeof result.content === 'string' ? result.content.split('\n').length : 0;
      if (lineCount > 0 && target) {
        return [`✓ 已查看文件：${target}（${lineCount} 行）\n`];
      }
      const displayName = toolResultSanitizer.toolActionLabel(name);
      if (target) {
        return [`✓ 已${displayName}：${target}\n`];
      }
      return [`✓ ${displayName}完成\n`];
    }

    const errorSummary = toolResultSanitizer.sanitizeToolDisplayText(sanitized, 160);
    const action = toolResultSanitizer.toolActionLabel(name);
    const target = toolResultSanitizer.toolTarget(name, payload.arguments || {});

    if (target && target !== errorSummary) {
      return [`✗ ${action}失败：${target} — ${errorSummary}\n`];
    }
    return [`✗ ${action}失败：${errorSummary}\n`];
  }

  _formatDiffReady(payload) {
    const diff = String(payload.text || payload.diff || '');
    if (!diff) {
      return [];
    }

    const { added, removed } = _countDiffChanges(diff);
    const filePath = String(payload.file_path || '').trim();
    const target = toolResultSanitizer.toolTarget('', { file_path: filePath });

    return [`✓ 已修改 ${target} · +${added} / -${removed} 行\n`];
  }

  _formatPlanUpdated(payload) {
    if (payload.live_only) {
      return;
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      const status = String(item.status || 'pending');
      const subject = String(item.subject || '').trim();
      if (!subject) {
        continue;
      }
      const mark = _planMark(status);
      this._appendLine('  ' + mark + ' ' + subject);
    }
  }

  _handleError(message) {
    if (!message || this._errors.has(message)) {
      return;
    }
    this._errors.add(message);
    this._appendLine(`! 操作暂未完成：${message}`);
  }
}

// ─── Static helpers (shared across instances) ───────────────────────────────

function _findTag(text, tags) {
  const found = [];
  for (const tag of tags) {
    const index = text.indexOf(tag);
    if (index >= 0) {
      found.push([index, tag]);
    }
  }
  if (found.length === 0) {
    return null;
  }
  return found.sort((a, b) => a[0] - b[0] || b[1].length - a[1].length)[0];
}

function _safePrefixLength(text, tags) {
  const tagList = Array.isArray(tags) ? tags : [tags];
  const maxLen = Math.max(...tagList.map((t) => t.length), 0);
  const start = Math.max(0, text.length - maxLen + 1);

  for (let index = text.length; index >= start; index--) {
    const suffix = text.slice(index);
    if (suffix && tagList.some((tag) => tag.startsWith(suffix))) {
      return index;
    }
  }
  return text.length;
}

function _sanitizeProtocolText(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }
  let result = text;
  result = result.replace(/<tool_call[^>]*>[\s\S]*?<\/tool_call>/g, '');
  result = result.replace(/<\/?tool_call[^>]*>/g, '');
  result = result.replace(/\[Advisor consultation[^\]]*\]/g, '');
  result = result.replace(/\[Advisor review\]/g, '');
  result = result.replace(/\[End of advisor consultation[^\]]*\]/g, '');
  result = result.replace(/\(\s*advisor[^)]*\)/gi, '');
  return result;
}

function _isMeaningfulText(text) {
  if (!text) {
    return false;
  }
  const stripped = text.replace(/[\s`*_#>~\-\[\](){}|.,!?，。！？:：;；\/\\]+/g, '');
  return stripped.length > 0;
}

function _countDiffChanges(diffText) {
  const ansiRe = /\x1b\[[0-9;]*m/g;
  const markerRe = /^[\d\s]*([+\-])/;
  let added = 0;
  let removed = 0;

  for (const rawLine of diffText.split('\n')) {
    const line = rawLine.replace(ansiRe, '').trim().replace('│', '').trim();
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    const match = markerRe.exec(line);
    if (!match) {
      continue;
    }
    if (match[1] === '+') {
      added++;
    } else {
      removed++;
    }
  }
  return { added, removed };
}

function _planMark(status) {
  const map = {
    done: '✓',
    completed: '✓',
    failed: '✗',
    blocked: '⏸',
    in_progress: '→',
    pending: '○',
  };
  return map[status] || '○';
}

function _planColor(status) {
  const map = {
    done: '\x1b[32m',
    completed: '\x1b[32m',
    failed: '\x1b[31m',
    blocked: '\x1b[33m',
    in_progress: '\x1b[36m',
    pending: '\x1b[37m',
  };
  return map[status] || '\x1b[37m';
}

// Dummy thinking buffer (Y-code has ThinkingStreamBuffer; Khyos version skips)
const thinkingBuffer = {
  feed() {
    return [];
  },
  finish() {
    return [];
  },
};

// ─── Module exports ────────────────────────────────────────────────────────

module.exports = TurnEventRenderer;
