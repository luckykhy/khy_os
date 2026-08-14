'use strict';

/**
 * Tests for gateway/webSearchInterceptor.js — Anthropic web_search server-tool
 * interception (kiro2cc-inspired).
 *
 * Covers: pure-web_search detection (positive + the multi-tool / wrong-name
 * negatives), query extraction with/without the "Perform a web search for the
 * query: " prefix, and the synthesized Anthropic SSE event sequence shape
 * (server_tool_use → web_search_tool_result → text). Pure functions only — no
 * network and no real search are exercised here.
 */

const interceptor = require('../../src/services/gateway/webSearchInterceptor');

describe('isPureWebSearchRequest', () => {
  test('matches a single web_search tool', () => {
    const body = { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }] };
    expect(interceptor.isPureWebSearchRequest(body)).toBe(true);
  });

  test('does not match a multi-tool request that merely includes web_search', () => {
    const body = { tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'Bash', input_schema: {} },
    ] };
    expect(interceptor.isPureWebSearchRequest(body)).toBe(false);
  });

  test('does not match a single non-web_search tool', () => {
    expect(interceptor.isPureWebSearchRequest({ tools: [{ name: 'Read', input_schema: {} }] })).toBe(false);
  });

  test('does not match when tools is absent', () => {
    expect(interceptor.isPureWebSearchRequest({ messages: [] })).toBe(false);
    expect(interceptor.isPureWebSearchRequest({})).toBe(false);
  });
});

describe('extractSearchQuery', () => {
  test('strips the "Perform a web search for the query: " prefix (array content)', () => {
    const body = { messages: [{ role: 'user', content: [
      { type: 'text', text: 'Perform a web search for the query: latest rust release 2026' },
    ] }] };
    expect(interceptor.extractSearchQuery(body)).toBe('latest rust release 2026');
  });

  test('returns plain string content unchanged (trimmed)', () => {
    const body = { messages: [{ role: 'user', content: '  what is the weather today  ' }] };
    expect(interceptor.extractSearchQuery(body)).toBe('what is the weather today');
  });

  test('returns null when no extractable text', () => {
    expect(interceptor.extractSearchQuery({ messages: [] })).toBeNull();
    expect(interceptor.extractSearchQuery({ messages: [{ role: 'user', content: [{ type: 'image' }] }] })).toBeNull();
    expect(interceptor.extractSearchQuery({})).toBeNull();
  });
});

describe('buildWebSearchEvents', () => {
  const results = [
    { title: 'Rust 1.99', url: 'https://rust-lang.org', snippet: 'Released today', publishedDate: '2026-06-01' },
  ];

  test('emits the full Anthropic SSE sequence with the right block types', () => {
    const events = interceptor.buildWebSearchEvents({
      model: 'kiro/claude-sonnet-4.5', query: 'rust', toolUseId: 'srvtoolu_abc', results, inputTokens: 3,
    });
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('message_start');
    expect(types[types.length - 1]).toBe('message_stop');

    // server_tool_use opens at index 0.
    const stuStart = events.find((e) => e.event === 'content_block_start'
      && e.data.content_block.type === 'server_tool_use');
    expect(stuStart).toBeTruthy();
    expect(stuStart.data.content_block.name).toBe('web_search');
    expect(stuStart.data.content_block.id).toBe('srvtoolu_abc');

    // web_search_tool_result carries the real result and references the tool id.
    const toolResult = events.find((e) => e.event === 'content_block_start'
      && e.data.content_block.type === 'web_search_tool_result');
    expect(toolResult).toBeTruthy();
    expect(toolResult.data.content_block.tool_use_id).toBe('srvtoolu_abc');
    expect(toolResult.data.content_block.content[0]).toMatchObject({
      type: 'web_search_result', title: 'Rust 1.99', url: 'https://rust-lang.org',
    });

    // A text block summarizes the results.
    const textStart = events.find((e) => e.event === 'content_block_start'
      && e.data.content_block.type === 'text');
    expect(textStart).toBeTruthy();
    const summary = events.filter((e) => e.event === 'content_block_delta'
      && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join('');
    expect(summary).toContain('Rust 1.99');

    // Terminates the turn cleanly so Claude Code stops looping.
    const delta = events.find((e) => e.event === 'message_delta');
    expect(delta.data.delta.stop_reason).toBe('end_turn');
  });

  test('handles an empty result set without throwing', () => {
    const events = interceptor.buildWebSearchEvents({
      model: 'm', query: 'q', toolUseId: 'srvtoolu_x', results: [], inputTokens: 1,
    });
    const toolResult = events.find((e) => e.event === 'content_block_start'
      && e.data.content_block.type === 'web_search_tool_result');
    expect(toolResult.data.content_block.content).toEqual([]);
    const summary = events.filter((e) => e.event === 'content_block_delta'
      && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join('');
    expect(summary).toContain('No results found');
  });
});

describe('buildWebSearchMessage (non-stream)', () => {
  test('produces a single assistant message with the three content blocks', () => {
    const msg = interceptor.buildWebSearchMessage({
      model: 'm', query: 'rust', toolUseId: 'srvtoolu_y',
      results: [{ title: 'T', url: 'https://u', snippet: 's' }], inputTokens: 2,
    });
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.content.map((b) => b.type)).toEqual([
      'server_tool_use', 'web_search_tool_result', 'text',
    ]);
  });
});
