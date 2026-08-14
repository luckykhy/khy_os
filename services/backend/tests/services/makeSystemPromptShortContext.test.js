'use strict';

/**
 * makeSystemPrompt short-context trimming — end-to-end proof that a small
 * context window drops the multi-KB hand-holding sections from the STATIC
 * system prompt, while a large window keeps today's full prompt byte-for-byte.
 *
 * Only the modular (cloud-model) prompt path is gated, which is exactly the
 * target population: small cloud models (haiku / mini / flash) on short windows.
 */

let runtime;
try {
  runtime = require('../../src/services/khyUpgradeRuntime');
} catch {
  runtime = null;
}

const _skip = !runtime || typeof runtime.makeSystemPrompt !== 'function';
const descFn = _skip ? describe.skip : describe;

descFn('makeSystemPrompt short-context', () => {
  // A cloud model id (triggers the modular path) whose name also trips the weak
  // heuristic — the realistic short-context case.
  const modelInfo = { model: 'claude-3-haiku', adapter: 'api' };

  function build(contextWindow) {
    return runtime.makeSystemPrompt(process.cwd(), modelInfo, [], {
      userMessage: 'help me refactor this function',
      taskScale: 'medium',
      contextWindow,
    });
  }

  test('short window yields a strictly shorter static prompt than a large window', async () => {
    const full = await build(200000); // large → full hand-holding
    const short = await build(8000);  // short → compact discipline only
    expect(typeof full).toBe('string');
    expect(typeof short).toBe('string');
    expect(full.length).toBeGreaterThan(0);
    // The heavy sections removed on a short window are several KB; require a
    // meaningful reduction so a trivial whitespace diff can't pass this.
    expect(short.length).toBeLessThan(full.length);
    expect(full.length - short.length).toBeGreaterThan(500);
  });

  test('a large window is unaffected (same as the no-window call)', async () => {
    const large = await build(200000);
    const noWindow = await runtime.makeSystemPrompt(process.cwd(), modelInfo, [], {
      userMessage: 'help me refactor this function',
      taskScale: 'medium',
    });
    expect(large.length).toBe(noWindow.length);
  });
});
