'use strict';

/**
 * webSearchInterceptor.js — Anthropic 服务端 web_search 工具的代理侧拦截与合成。
 *
 * 背景：Claude Code 的 WebSearch 是 Anthropic 的「服务端工具」（type:
 * web_search_20250305），正常由 Anthropic API 在服务端执行。Claude Code 触发
 * 搜索时，会发出一个「专用子请求」——其 tools 数组只含一个 web_search 工具，
 * 且首条用户消息以 "Perform a web search for the query: " 前缀携带查询词，并期望
 * 上游返回 server_tool_use → web_search_tool_result → text 的 SSE 序列。
 *
 * 当 KHY 把该子请求路由到非 Anthropic 后端（kiro/deepseek/sensenova 等）时，
 * 后端无法执行服务端工具，返回空结果，Claude Code 显示 "Did 0 searches" 并让
 * 模型反复重发，造成死循环。
 *
 * 解决：在代理入口探测该子请求，直接用 KHY 自带的多引擎搜索（webSearchService，
 * Baidu→Bing→Kiro→DuckDuckGo）真正执行，并按 Anthropic 协议合成响应。子请求
 * 不再下发到任何模型后端，因此对所有适配器一致生效，且能返回真实搜索结果。
 *
 * 参考实现：kiro2cc-proxy 的 src/anthropic/websearch.rs（MIT）。
 * 依赖：webSearchService（真实搜索）、crypto（id 生成）。
 */

const crypto = require('crypto');

// Claude Code 在 WebSearch 子请求中给用户消息加的固定前缀。
const SEARCH_QUERY_PREFIX = 'Perform a web search for the query: ';

// 懒加载，避免循环依赖与启动期副作用。
let _webSearchService = null;
function _getWebSearchService() {
  if (!_webSearchService) {
    _webSearchService = require('../webSearchService');
  }
  return _webSearchService;
}

/**
 * 探测请求是否为「纯 web_search 子请求」。
 *
 * 条件（对齐 kiro2cc）：tools 有且仅有一个，且其 name === 'web_search'。
 * 普通编码请求会携带完整工具集（含 web_search），不应命中——那种情况下模型
 * 并未在执行搜索，须照常路由。
 *
 * @param {object} body 原始 Anthropic 请求体
 * @returns {boolean}
 */
function isPureWebSearchRequest(body) {
  const tools = body && body.tools;
  if (!Array.isArray(tools) || tools.length !== 1) return false;
  const t = tools[0];
  return !!t && t.name === 'web_search';
}

/**
 * 从请求中提取搜索查询词。
 *
 * 读取首条消息的文本内容（字符串或首个 text 块），并剥离
 * "Perform a web search for the query: " 前缀。
 *
 * @param {object} body 原始 Anthropic 请求体
 * @returns {string|null} 查询词，无法提取时返回 null
 */
function extractSearchQuery(body) {
  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const first = messages[0];
  if (!first) return null;

  let text = '';
  if (typeof first.content === 'string') {
    text = first.content;
  } else if (Array.isArray(first.content)) {
    const firstBlock = first.content[0];
    if (firstBlock && firstBlock.type === 'text' && typeof firstBlock.text === 'string') {
      text = firstBlock.text;
    } else {
      return null;
    }
  } else {
    return null;
  }

  const query = text.startsWith(SEARCH_QUERY_PREFIX)
    ? text.slice(SEARCH_QUERY_PREFIX.length)
    : text;

  const trimmed = query.trim();
  return trimmed ? trimmed : null;
}

// 生成 Anthropic 风格的服务端工具调用 id：srvtoolu_<32 hex>。
function _serverToolUseId() {
  return `srvtoolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;
}

// 生成消息 id：msg_<24 hex>。
function _messageId() {
  return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/**
 * 把 KHY 搜索结果转为 Anthropic 的 web_search_result 内容块数组。
 * snippet 放入 encrypted_content（对齐 Anthropic/ kiro2cc 的字段语义）。
 */
function _toWebSearchResultBlocks(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    type: 'web_search_result',
    title: r.title || 'Untitled',
    url: r.url || '',
    encrypted_content: r.snippet || '',
    page_age: r.publishedDate || null,
  }));
}

/**
 * 生成给模型/用户阅读的搜索结果摘要文本。
 */
function _buildSummary(query, results) {
  let summary = `Here are the search results for "${query}":\n\n`;
  if (Array.isArray(results) && results.length > 0) {
    results.forEach((r, i) => {
      summary += `${i + 1}. **${r.title || 'Untitled'}**\n`;
      if (r.snippet) {
        const s = String(r.snippet);
        const truncated = s.length > 200 ? `${s.slice(0, 200)}...` : s;
        summary += `   ${truncated}\n`;
      }
      if (r.url) summary += `   Source: ${r.url}\n`;
      summary += '\n';
    });
  } else {
    summary += 'No results found.\n';
  }
  summary += '\nPlease note that these are web search results and may not be fully accurate or up-to-date.';
  return summary;
}

/**
 * 构造完整的 Anthropic SSE 事件序列（与 kiro2cc 对齐的 11 段）。
 *
 * @returns {Array<{event:string,data:object}>}
 */
function buildWebSearchEvents({ model, query, toolUseId, results, inputTokens }) {
  const events = [];
  const messageId = _messageId();
  const resultBlocks = _toWebSearchResultBlocks(results);
  const summary = _buildSummary(query, results);

  // 1. message_start
  events.push({ event: 'message_start', data: {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: model || 'default',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens || 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } });

  // 2. content_block_start — server_tool_use（index 0）
  events.push({ event: 'content_block_start', data: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: {} },
  } });

  // 3. content_block_delta — input_json_delta（回填 query）
  events.push({ event: 'content_block_delta', data: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
  } });

  // 4. content_block_stop（server_tool_use）
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });

  // 5. content_block_start — web_search_tool_result（index 1）
  events.push({ event: 'content_block_start', data: {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'web_search_tool_result', tool_use_id: toolUseId, content: resultBlocks },
  } });

  // 6. content_block_stop（web_search_tool_result）
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } });

  // 7. content_block_start — text（index 2）
  events.push({ event: 'content_block_start', data: {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'text', text: '' },
  } });

  // 8. content_block_delta — text_delta（分块发送摘要）
  const CHUNK = 100;
  for (let i = 0; i < summary.length; i += CHUNK) {
    events.push({ event: 'content_block_delta', data: {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: summary.slice(i, i + CHUNK) },
    } });
  }

  // 9. content_block_stop（text）
  events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } });

  // 10. message_delta（end_turn + output 估算）
  const outputTokens = Math.ceil((summary.length + 3) / 4);
  events.push({ event: 'message_delta', data: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } });

  // 11. message_stop
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });

  return events;
}

/**
 * 构造非流式（stream:false）的等价 Anthropic 消息体。
 */
function buildWebSearchMessage({ model, query, toolUseId, results, inputTokens }) {
  const summary = _buildSummary(query, results);
  return {
    id: _messageId(),
    type: 'message',
    role: 'assistant',
    model: model || 'default',
    content: [
      { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: { query } },
      { type: 'web_search_tool_result', tool_use_id: toolUseId, content: _toWebSearchResultBlocks(results) },
      { type: 'text', text: summary },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens || 0,
      output_tokens: Math.ceil((summary.length + 3) / 4),
    },
  };
}

/**
 * 处理被拦截的 web_search 子请求：真正执行搜索并按协议写回响应。
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} body 原始 Anthropic 请求体
 * @returns {Promise<boolean>} 是否已处理（已写回响应）
 */
async function handleWebSearchRequest(req, res, body) {
  const query = extractSearchQuery(body);
  if (!query) return false; // 提不出查询词则交还给正常路由

  const model = body.model || 'default';
  const stream = body.stream !== false; // Claude Code 默认 stream
  const toolUseId = _serverToolUseId();
  const inputTokens = Math.ceil((query.length + 3) / 4);

  if (String(process.env.PROXY_TOOL_DEBUG || '').toLowerCase() === 'true') {
    console.log(`[proxy:websearch] intercept query="${query}" stream=${stream}`);
  }

  // 执行真实搜索（失败时 results 为空，仍合成合法响应以打破死循环）。
  let results = [];
  try {
    const svc = _getWebSearchService();
    const r = await svc.search(query);
    if (r && r.success && Array.isArray(r.results)) results = r.results;
  } catch (err) {
    if (String(process.env.PROXY_TOOL_DEBUG || '').toLowerCase() === 'true') {
      console.log(`[proxy:websearch] search error: ${err && err.message}`);
    }
  }

  if (!stream) {
    const message = buildWebSearchMessage({ model, query, toolUseId, results, inputTokens });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    });
    res.end(JSON.stringify(message));
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
  });
  const events = buildWebSearchEvents({ model, query, toolUseId, results, inputTokens });
  for (const e of events) {
    try { res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`); } catch { /* client gone */ }
  }
  res.end();
  return true;
}

module.exports = {
  isPureWebSearchRequest,
  extractSearchQuery,
  buildWebSearchEvents,
  buildWebSearchMessage,
  handleWebSearchRequest,
  SEARCH_QUERY_PREFIX,
};
