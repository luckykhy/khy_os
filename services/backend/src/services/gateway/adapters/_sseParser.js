/**
 * @pattern Iterator
 */
'use strict';

/**
 * _sseParser.js — OpenAI 兼容 SSE 流解析
 *
 * 从 traeAdapter.consumeSseText 和 windsurfAdapter.consumeSseText 中提取，
 * 两者逻辑完全一致。
 */

/**
 * 解析 OpenAI 兼容的 SSE 文本，提取 delta content 并通过 onChunk 回调发出。
 *
 * @param {string} text - SSE 原始文本（可包含多行 "data: {...}" ）
 * @param {function|null} onChunk - 流式回调 ({ type: 'text', text: string }) => void
 * @returns {string} 拼接后的完整文本
 */
function consumeSseText(text = '', onChunk = null) {
  const chunks = String(text || '').split(/\r?\n/);
  let full = '';

  for (const lineRaw of chunks) {
    const line = String(lineRaw || '').trim();
    if (!line || !line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const obj = JSON.parse(data);
      const delta = obj?.choices?.[0]?.delta?.content;
      const textPart = typeof delta === 'string'
        ? delta
        : (typeof obj?.choices?.[0]?.message?.content === 'string' ? obj.choices[0].message.content : '');
      if (!textPart) continue;
      full += textPart;
      if (typeof onChunk === 'function') onChunk({ type: 'text', text: textPart });
    } catch {
      // 容忍非 JSON 的 SSE 行
    }
  }

  return full;
}

/**
 * 增量 SSE 解析 — 处理跨 chunk 边界的 SSE 数据。
 * 使用双换行边界检测（\n\n 或 \r\n\r\n），匹配 SSE 规范。
 *
 * @param {{ buffer: string }} state - 持久状态对象，保存跨 chunk 未处理的文本
 * @param {string} incomingText - 新到达的文本片段
 * @param {function|null} onChunk - 流式回调
 * @returns {string} 本次调用中提取的文本（不含累计）
 */
function consumeSseIncremental(state, incomingText = '', onChunk = null) {
  if (!state) return '';
  state.buffer = (state.buffer || '') + String(incomingText || '');
  let out = '';

  while (true) {
    const lf = state.buffer.indexOf('\n\n');
    const crlf = state.buffer.indexOf('\r\n\r\n');
    let idx = -1;
    let sepLen = 0;
    if (lf >= 0 && crlf >= 0) {
      idx = Math.min(lf, crlf);
      sepLen = (idx === crlf) ? 4 : 2;
    } else if (lf >= 0) {
      idx = lf;
      sepLen = 2;
    } else if (crlf >= 0) {
      idx = crlf;
      sepLen = 4;
    }
    if (idx < 0) break;

    const block = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + sepLen);
    out += consumeSseText(block, onChunk);
  }

  return out;
}

/**
 * 刷出增量解析器缓冲区中剩余的 SSE 数据。
 * 在流结束时调用，确保最后一个不完整的 SSE block 也被处理。
 *
 * @param {{ buffer: string }} state
 * @param {function|null} onChunk
 * @returns {string}
 */
function flushSseIncremental(state, onChunk = null) {
  if (!state) return '';
  const out = consumeSseText(state.buffer, onChunk);
  state.buffer = '';
  return out;
}

module.exports = {
  consumeSseText,
  consumeSseIncremental,
  flushSseIncremental,
};
