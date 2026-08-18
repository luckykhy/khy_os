import { describe, expect, it } from 'vitest';
import { parseSseBlock } from '../src/api/sse';

describe('SSE event parsing', () => {
  it('parses named JSON events and IDs', () => {
    expect(parseSseBlock('id: 42\nevent: task_event\ndata: {"status":"running"}')).toEqual({
      id: '42',
      event: 'task_event',
      data: { status: 'running' },
    });
  });

  it('joins multiline data and preserves plain text', () => {
    expect(parseSseBlock('data: first\ndata: second')).toEqual({
      id: null,
      event: 'message',
      data: 'first\nsecond',
    });
  });

  it('ignores heartbeat blocks without data', () => {
    expect(parseSseBlock(': keepalive')).toBeNull();
  });
});
