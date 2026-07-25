'use strict';

/**
 * openaiSseStream.partial.test.js — regression for the "未返回有效回复 / 半截话"
 * cluster reported from the live deepseek-v4 channel.
 *
 * Three root causes covered:
 *   #1 reasoning-only turn: the parser must ACCUMULATE and RETURN reasoning_content
 *      (previously emitted as a chunk then dropped → empty reply → "未返回有效回复").
 *   #1b premature close with text: stream ends with no explicit finish_reason but
 *      content was produced → must be reported as `length` so the loop continues.
 *   #2 transient channel interruption: stream errors mid-answer with content already
 *      accumulated → must RESOLVE the partial (interrupted+length) instead of
 *      rejecting and discarding the work. A genuine abort still rejects.
 */

const { EventEmitter } = require('events');
const { parseOpenAISseStream } = require('../src/services/gateway/adapters/_openaiSseStream');

/**
 * Minimal duplex-ish fake: parseOpenAISseStream only uses .on('data'|'error'|'end')
 * and .destroy(). We emit the scripted events on the next tick so the parser's
 * listeners are already attached.
 */
function fakeStream(script) {
  const ee = new EventEmitter();
  ee.destroy = () => { ee.emit('close'); };
  setImmediate(() => {
    for (const step of script) {
      if (step.data !== undefined) ee.emit('data', Buffer.from(step.data));
      else if (step.error !== undefined) ee.emit('error', step.error);
      else if (step.end) ee.emit('end');
    }
  });
  return ee;
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('parseOpenAISseStream — reasoning + interruption salvage', () => {
  test('#1 accumulates reasoning_content and returns it (empty content does not lose the reasoning)', async () => {
    const chunks = [];
    const stream = fakeStream([
      { data: sse({ choices: [{ delta: { reasoning_content: 'let me think ' } }] }) },
      { data: sse({ choices: [{ delta: { reasoning_content: 'about it.' } }] }) },
      { data: 'data: [DONE]\n\n' },
      { end: true },
    ]);

    const result = await parseOpenAISseStream(stream, (c) => chunks.push(c));

    expect(result.content).toBe('');
    expect(result.thinking).toBe('let me think about it.');
    // thinking chunks were still streamed to the UI
    expect(chunks.filter((c) => c.type === 'thinking')).toHaveLength(2);
  });

  test('#1b stream ends with text but no finish_reason → reported as length (truncated)', async () => {
    const stream = fakeStream([
      { data: sse({ choices: [{ delta: { content: 'partial answer' } }] }) },
      { end: true },
    ]);

    const result = await parseOpenAISseStream(stream, () => {});

    expect(result.content).toBe('partial answer');
    expect(result.finishReason).toBe('length');
  });

  test('#1b explicit finish_reason is preserved (no false length override)', async () => {
    const stream = fakeStream([
      { data: sse({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) },
      { data: 'data: [DONE]\n\n' },
      { end: true },
    ]);

    const result = await parseOpenAISseStream(stream, () => {});

    expect(result.content).toBe('done');
    expect(result.finishReason).toBe('stop');
  });

  test('#2 mid-stream error with accumulated content resolves a salvaged partial (not reject)', async () => {
    const stream = fakeStream([
      { data: sse({ choices: [{ delta: { content: 'half of the ' } }] }) },
      { data: sse({ choices: [{ delta: { content: 'answer' } }] }) },
      { error: new Error('socket hang up') },
    ]);

    const result = await parseOpenAISseStream(stream, () => {});

    expect(result.content).toBe('half of the answer');
    expect(result.interrupted).toBe(true);
    expect(result.finishReason).toBe('length');
    expect(result.interruptError).toMatch(/socket hang up/);
  });

  test('#2 error with zero progress still rejects (nothing to salvage)', async () => {
    const stream = fakeStream([
      { error: new Error('connection refused') },
    ]);

    await expect(parseOpenAISseStream(stream, () => {})).rejects.toThrow(/connection refused/);
  });

  test('#2 explicit abort rejects even if content was streamed', async () => {
    const controller = new AbortController();
    const stream = fakeStream([
      { data: sse({ choices: [{ delta: { content: 'streamed text' } }] }) },
      { error: Object.assign(new Error('Aborted'), { name: 'AbortError' }) },
    ]);

    await expect(
      parseOpenAISseStream(stream, () => {}, { signal: controller.signal })
    ).rejects.toThrow();
  });
});
