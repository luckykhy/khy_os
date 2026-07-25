/**
 * @pattern Iterator
 */
'use strict';

/**
 * _streamProcessor.js — Claude stream-json 事件处理器
 *
 * 从 claudeAdapter.processStreamEvent 和 cliToolAdapter.processStreamEvent 中提取。
 * 两份代码结构相同（~250行），差异通过 options 参数化：
 *   - parseJsonMaybe 回退策略（safeJsonParse vs null）
 *   - genai 遥测追踪（仅 claude）
 *   - content_block_stop 发出的事件类型（tool_use vs tool_result）
 *   - content_block_start 是否记录 _startTs
 *   - 顶层 tool_use/tool_call/tool_result 事件（仅 cliTool）
 */

/**
 * @param {object} event - stream-json 事件对象
 * @param {function} onChunk - 流式回调
 * @param {function} appendContent - 追加文本内容的回调
 * @param {object} state - 持久状态 { blocks: Map, sawStreamEvent, sawAssistantText, _traceId?, _model? }
 * @param {object} [options]
 * @param {boolean} [options.repairJson=false] - 是否使用 safeJsonParse 修复截断 JSON
 * @param {boolean} [options.trackGenai=false] - 是否记录 genai 遥测
 * @param {function|null} [options.getGenai=null] - 获取 genai 实例的函数
 * @param {string} [options.toolStopEventType='tool_use'] - content_block_stop 中工具事件类型
 * @param {boolean} [options.handleTopLevelToolEvents=false] - 是否处理顶层 tool_use/tool_call/tool_result
 */
function processStreamEvent(event, onChunk, appendContent, state, options = {}) {
  if (!state) state = { blocks: new Map(), sawStreamEvent: false, sawAssistantText: false };
  if (!state.blocks) state.blocks = new Map();

  const {
    repairJson = false,
    trackGenai = false,
    getGenai = null,
    toolStopEventType = 'tool_use',
    handleTopLevelToolEvents = false,
  } = options;

  // ── 内部辅助函数 ──────────────────────────────────────────────────

  const summarizeInput = (input) => {
    if (!input) return '';
    if (typeof input === 'string') return input.slice(0, 120);
    try {
      return Object.entries(input)
        .map(([k, v]) => `${k}=${String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 40)}`)
        .join(', ')
        .slice(0, 120);
    } catch { return ''; }
  };

  const parseJsonMaybe = (str) => {
    if (!str || typeof str !== 'string') return null;
    try { return JSON.parse(str); } catch {
      if (repairJson) {
        try {
          const { safeJsonParse } = require('../safeJsonParse');
          return safeJsonParse(str, null);
        } catch { return null; }
      }
      return null;
    }
  };

  const summarizeText = (value, maxLen = 220) => {
    const text = typeof value === 'string' ? value : summarizeInput(value);
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
  };

  const genai = () => {
    if (!trackGenai || typeof getGenai !== 'function') return null;
    try { return getGenai(); } catch { return null; }
  };

  // ── 顶层工具事件（cliTool 特有） ──────────────────────────────────

  if (handleTopLevelToolEvents) {
    if (event.type === 'tool_use' || event.type === 'tool_call') {
      const toolName = event.name || event.tool || event.tool_name || 'unknown';
      const inputSummary = summarizeInput(event.input || event.arguments || event.params || {});
      onChunk({
        type: 'tool_use',
        tool: toolName,
        input: inputSummary,
        rawInput: event.input || event.arguments || event.params || {},
        id: event.id || '',
      });
      return;
    }
    if (event.type === 'tool_result') {
      const content = typeof event.content === 'string'
        ? event.content
        : JSON.stringify(event.content || event.result || '');
      onChunk({ type: 'tool_result', id: event.tool_use_id || event.id || '', content: content.slice(0, 200), isError: event.is_error });
      return;
    }
  }

  // ── tool_progress 事件 ────────────────────────────────────────────

  if (event.type === 'tool_progress') {
    onChunk({
      type: 'tool_progress',
      id: event.tool_use_id || event.id || '',
      tool: event.tool_name || event.tool || 'tool',
      status: event.status || event.status_category || '',
      detail: summarizeText(event.status_detail || event.message || event.detail || ''),
      parentId: event.parent_tool_use_id || null,
    });
    return;
  }

  // ── auth_status 事件 ──────────────────────────────────────────────

  if (event.type === 'auth_status') {
    onChunk({
      type: 'auth_status',
      isAuthenticating: !!event.isAuthenticating,
      output: summarizeText(event.output || ''),
      error: summarizeText(event.error || ''),
    });
    return;
  }

  // ── system 任务生命周期事件 ────────────────────────────────────────

  if (event.type === 'system' && event.subtype &&
      (event.subtype === 'task_started' || event.subtype === 'task_progress' || event.subtype === 'task_notification')) {
    onChunk({
      type: event.subtype,
      taskId: event.task_id || '',
      toolUseId: event.tool_use_id || '',
      status: event.status || '',
      summary: summarizeText(event.summary || event.message || ''),
      outputFile: event.output_file || '',
      usage: event.usage || null,
    });
    return;
  }

  // ── stream_event 包装格式 ─────────────────────────────────────────

  if (event.type === 'stream_event' && event.event) {
    state.sawStreamEvent = true;
    const ev = event.event;

    if (ev.type === 'tool_progress') {
      onChunk({
        type: 'tool_progress',
        id: ev.tool_use_id || ev.id || '',
        tool: ev.tool_name || ev.tool || 'tool',
        status: ev.status || ev.status_category || '',
        detail: summarizeText(ev.status_detail || ev.message || ev.detail || ''),
        parentId: ev.parent_tool_use_id || null,
      });
      return;
    }

    if (ev.type === 'auth_status') {
      onChunk({
        type: 'auth_status',
        isAuthenticating: !!ev.isAuthenticating,
        output: summarizeText(ev.output || ''),
        error: summarizeText(ev.error || ''),
      });
      return;
    }

    if (ev.type === 'system' && ev.subtype &&
        (ev.subtype === 'task_started' || ev.subtype === 'task_progress' || ev.subtype === 'task_notification')) {
      onChunk({
        type: ev.subtype,
        taskId: ev.task_id || '',
        toolUseId: ev.tool_use_id || '',
        status: ev.status || '',
        summary: summarizeText(ev.summary || ev.message || ''),
        outputFile: ev.output_file || '',
        usage: ev.usage || null,
      });
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'session_state_changed') {
      const stateText = ev.state || ev.session_state || '';
      if (stateText) onChunk({ type: 'status', text: `Session state: ${stateText}` });
      return;
    }

    if (ev.type === 'content_block_start') {
      const idx = Number(ev.index);
      const block = ev.content_block || {};
      const blockState = {
        type: block.type || '',
        name: block.name || '',
        id: block.id || '',
        inputRaw: '',
      };
      if (trackGenai) blockState._startTs = Date.now();
      state.blocks.set(idx, blockState);

      if (block.type === 'thinking' && block.thinking) {
        onChunk({ type: 'thinking', text: block.thinking });
      } else if (block.type === 'text' && block.text) {
        onChunk({ type: 'text', text: block.text });
        appendContent(block.text);
        state.sawAssistantText = true;
      } else if (block.type === 'tool_use') {
        onChunk({ type: 'tool_use', tool: block.name || 'unknown', input: summarizeInput(block.input), rawInput: block.input || {}, id: block.id });
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        onChunk({ type: 'tool_result', id: block.tool_use_id || '', content: content.slice(0, 200) });
      }
      return;
    }

    if (ev.type === 'content_block_delta') {
      const idx = Number(ev.index);
      const delta = ev.delta || {};
      if (delta.type === 'thinking_delta' && delta.thinking) {
        onChunk({ type: 'thinking', text: delta.thinking });
      } else if (delta.type === 'text_delta' && delta.text) {
        onChunk({ type: 'text', text: delta.text });
        appendContent(delta.text);
        state.sawAssistantText = true;
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const blk = state.blocks.get(idx);
        if (blk) blk.inputRaw += delta.partial_json;
      }
      return;
    }

    if (ev.type === 'content_block_stop') {
      const idx = Number(ev.index);
      const blk = state.blocks.get(idx);
      if (blk && blk.type === 'tool_use' && blk.inputRaw) {
        const parsed = parseJsonMaybe(blk.inputRaw);
        const summary = summarizeInput(parsed) || summarizeInput(blk.inputRaw);
        if (summary) {
          if (toolStopEventType === 'tool_result') {
            onChunk({ type: 'tool_result', id: blk.id || '', content: `参数: ${summary}` });
          } else {
            onChunk({ type: 'tool_use', tool: blk.name || 'unknown', input: summary, rawInput: parsed || {}, id: blk.id });
          }
        }
        // genai 遥测追踪
        const g = genai();
        if (g) {
          try {
            g.recordToolUse({
              toolName: blk.name || 'unknown',
              input: summary || blk.inputRaw.slice(0, 500),
              durationMs: blk._startTs ? Date.now() - blk._startTs : 0,
              success: true,
              traceId: state._traceId || null,
            });
          } catch { /* best effort */ }
        }
      }
      state.blocks.delete(idx);
      return;
    }

    if (ev.type === 'message_delta' && ev.usage && typeof ev.usage.output_tokens === 'number') {
      onChunk({ type: 'cost', cost: ev.usage.output_tokens });
      const g = genai();
      if (g) {
        try {
          g.recordLLMCall({
            model: state._model || 'claude',
            provider: 'anthropic',
            outputTokens: ev.usage.output_tokens,
            inputTokens: ev.usage.input_tokens || 0,
            traceId: state._traceId || null,
          });
        } catch { /* best effort */ }
      }
      return;
    }
  }

  // 已消费 stream_event 时跳过 legacy 消息
  if (state.sawStreamEvent && (event.type === 'assistant' || event.type === 'user')) {
    return;
  }

  // ── system 子类型 ─────────────────────────────────────────────────

  if (event.type === 'system' && event.subtype) {
    if (event.subtype === 'api_retry') {
      const attempt = event.attempt || '?';
      const max = event.max_retries || '?';
      const reason = event.error || 'unknown';
      onChunk({ type: 'status', text: `Claude API retry ${attempt}/${max} (${reason})` });
      return;
    }
    if (event.subtype === 'error') {
      onChunk({ type: 'status', text: `Claude system error: ${event.error || 'unknown'}` });
      return;
    }
    if (event.subtype === 'session_state_changed') {
      const stateText = event.state || event.session_state || '';
      if (stateText) onChunk({ type: 'status', text: `Session state: ${stateText}` });
      return;
    }
  }

  // ── Legacy 消息格式 ───────────────────────────────────────────────

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        onChunk({ type: 'thinking', text: block.thinking });
      } else if (block.type === 'text' && block.text) {
        onChunk({ type: 'text', text: block.text });
        appendContent(block.text);
        state.sawAssistantText = true;
      } else if (block.type === 'tool_use') {
        onChunk({ type: 'tool_use', tool: block.name || 'unknown', input: summarizeInput(block.input), rawInput: block.input || {}, id: block.id });
      }
    }
  } else if (event.type === 'user' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        onChunk({ type: 'tool_result', id: block.tool_use_id, content: content.slice(0, 200), isError: block.is_error });
      }
    }
  } else if (event.type === 'result') {
    if (event.total_cost_usd) {
      onChunk({ type: 'cost', cost: event.total_cost_usd });
    }
    if (!state.sawAssistantText && typeof event.result === 'string' && event.result.trim()) {
      onChunk({ type: 'text', text: event.result });
      appendContent(event.result);
      state.sawAssistantText = true;
    }
  }
}

/**
 * 创建新的流处理状态对象。
 * @param {object} [extra] - 额外状态字段
 * @returns {object}
 */
function createStreamState(extra = {}) {
  return {
    blocks: new Map(),
    sawStreamEvent: false,
    sawAssistantText: false,
    ...extra,
  };
}

module.exports = {
  processStreamEvent,
  createStreamState,
};
