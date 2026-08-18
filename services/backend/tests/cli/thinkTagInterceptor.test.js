// Regression tests for the prompt-injected CoT interceptor (_createThinkTagInterceptor).
//
// CoT here is prompt-injected (COT_INJECTION_PROMPT), so the reasoning block is
// plain text in the stream: the interceptor has to lift it out and re-emit it on
// the `thinking` channel. Two things make that fragile and are pinned here:
//   1. Models emit either the `<think>` form we ask for or the `<thinking>` form
//      they were trained on (QWEN), in arbitrary casing. Missing a variant leaks
//      raw tags + reasoning into the answer.
//   2. The closing tag is never guaranteed (model forgets it, or max_tokens
//      truncates mid-reasoning), so finalize() must fail OPEN rather than leave
//      the user with a blank turn.
//
// Pure + env-free: no gateway, no network.

const ai = require('../../src/cli/ai');
const { _createThinkTagInterceptor } = ai.__test__;

/** Collects emitted chunks and exposes the per-channel concatenated text. */
function makeSink() {
  const chunks = [];
  const sink = (chunk) => chunks.push(chunk);
  sink.chunks = chunks;
  sink.textOf = (type) =>
    chunks
      .filter((c) => c && c.type === type)
      .map((c) => c.text)
      .join('');
  return sink;
}

describe('_createThinkTagInterceptor — tag recognition', () => {
  test('short <think> form is lifted onto the thinking channel', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: '<think>weighing options</think>Final answer.' });
    onChunk.finalize();

    expect(sink.textOf('thinking')).toBe('weighing options');
    expect(sink.textOf('text')).toBe('Final answer.');
  });

  test('long <thinking> form (QWEN) is lifted too', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: '<thinking>step 1, step 2</thinking>42' });
    onChunk.finalize();

    expect(sink.textOf('thinking')).toBe('step 1, step 2');
    expect(sink.textOf('text')).toBe('42');
  });

  test('tag casing is not trusted — mixed/upper case still matches', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: '<THINK>hmm</Think>done' });
    onChunk({ type: 'text', text: '<Thinking>more</THINKING>ok' });
    onChunk.finalize();

    expect(sink.textOf('thinking')).toBe('hmmmore');
    expect(sink.textOf('text')).toBe('doneok');
  });

  test('no reasoning text ever reaches the text channel', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: '<think>secret chain of thought</think>visible' });
    onChunk.finalize();

    expect(sink.textOf('text')).not.toMatch(/secret/);
    expect(sink.textOf('text')).not.toMatch(/think/i);
  });
});

describe('_createThinkTagInterceptor — chunk boundaries', () => {
  test('tags split across chunks are still recognised', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    // Worst case: every tag is torn apart by the stream framing.
    for (const part of ['<thi', 'nk', '>rea', 'soning</thi', 'nk', '>ans', 'wer']) {
      onChunk({ type: 'text', text: part });
    }
    onChunk.finalize();

    expect(sink.textOf('thinking')).toBe('reasoning');
    expect(sink.textOf('text')).toBe('answer');
  });

  test('a partial tag never leaks while it is still ambiguous', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: '<thi' });

    // Nothing may be emitted yet — '<thi' could still become <think>/<thinking>.
    expect(sink.chunks).toHaveLength(0);
  });

  test('text that merely looks like a tag passes through verbatim', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: 'use <b>bold</b> and a < b comparison' });
    onChunk.finalize();

    expect(sink.textOf('text')).toBe('use <b>bold</b> and a < b comparison');
    expect(sink.textOf('thinking')).toBe('');
  });
});

describe('_createThinkTagInterceptor — passthrough', () => {
  test('non-text chunks are forwarded untouched', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    const toolChunk = { type: 'tool_use', name: 'read_file', input: { path: 'a.js' } };
    onChunk(toolChunk);
    onChunk({ type: 'thinking', text: 'native reasoning' });

    expect(sink.chunks[0]).toBe(toolChunk);
    expect(sink.chunks[1]).toEqual({ type: 'thinking', text: 'native reasoning' });
  });

  test('non-text sidecar fields survive onto deferred thinking chunks', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: '<think>why</think>ok', sessionId: 's-1', sequence: 7 });
    onChunk.finalize();

    const thinking = sink.chunks.find((c) => c.type === 'thinking');
    expect(thinking).toMatchObject({ type: 'thinking', text: 'why', sessionId: 's-1', sequence: 7 });
  });
});

describe('_createThinkTagInterceptor — finalize() fails open', () => {
  test('unclosed <think> with no answer releases the buffer as text', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    // Truncated mid-reasoning: closing tag never arrives.
    onChunk({ type: 'text', text: '<think>I was thinking about' });
    expect(sink.textOf('text')).toBe(''); // nothing yet — still buffered

    onChunk.finalize();

    // A blank turn is worse than raw reasoning, so the buffer is released.
    expect(sink.textOf('text')).toBe('I was thinking about');
  });

  test('unclosed <think> after real answer text keeps the reasoning hidden', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: 'The answer is 42. <think>but wait' });
    onChunk.finalize();

    expect(sink.textOf('text')).toBe('The answer is 42. ');
    expect(sink.textOf('text')).not.toMatch(/but wait/);
  });

  test('finalize() is a no-op on a well-formed stream and is safe to repeat', () => {
    const sink = makeSink();
    const onChunk = _createThinkTagInterceptor(sink);

    onChunk({ type: 'text', text: '<think>r</think>a' });
    const before = sink.chunks.length;

    onChunk.finalize();
    onChunk.finalize();

    expect(sink.chunks).toHaveLength(before);
    expect(sink.textOf('text')).toBe('a');
  });

  test('interceptor tolerates a missing downstream callback', () => {
    const onChunk = _createThinkTagInterceptor(null);

    expect(() => {
      onChunk({ type: 'text', text: '<think>r</think>a' });
      onChunk({ type: 'text', text: '<think>unclosed' });
      onChunk.finalize();
    }).not.toThrow();
  });
});
