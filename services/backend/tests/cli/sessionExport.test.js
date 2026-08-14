'use strict';

/**
 * sessionExport — coverage for the `session export` Markdown builder.
 *
 * `formatSessionMarkdown` is the PURE document renderer behind `session export
 * <id> --format md` and the in-REPL `/export` Markdown sibling. It must:
 *   - emit a title + metadata header (id, model, message count, project, time),
 *   - render each message under a role heading,
 *   - keep plain string content verbatim,
 *   - fence structured tool_use / tool_result blocks so they survive export,
 *   - degrade safely on empty / missing input (never throw).
 *
 * Runnable under both jest and `node --test` via the shim (no jest binary here).
 */

const { formatSessionMarkdown } = require('../../src/cli/handlers/session');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    toMatch: (re) => assert.ok(re.test(String(actual)), `expected to match ${re}`),
  });
}

/* ── tests ──────────────────────────────────────────────────────────────── */
_describe('formatSessionMarkdown', () => {
  _test('renders title, metadata header and role-tagged messages', () => {
    const md = formatSessionMarkdown({
      sessionId: 'abc123',
      title: '量化策略回测',
      model: 'claude-opus-4-8',
      messages: [
        { role: 'user', content: '帮我写一个回测' },
        { role: 'assistant', content: '好的，这是实现' },
      ],
      metadata: { cwd: '/home/u/proj' },
      updatedAt: 0,
    });
    _expect(md).toMatch(/^# 量化策略回测/);
    _expect(md).toContain('- Session ID: abc123');
    _expect(md).toContain('- Model: claude-opus-4-8');
    _expect(md).toContain('- Messages: 2');
    _expect(md).toContain('- Project: /home/u/proj');
    _expect(md).toContain('## 🧑 User');
    _expect(md).toContain('帮我写一个回测');
    _expect(md).toContain('## 🤖 Assistant');
    _expect(md).toContain('好的，这是实现');
  });

  _test('fences structured tool_use and tool_result content', () => {
    const md = formatSessionMarkdown({
      sessionId: 's1',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'running a command' },
            { type: 'tool_use', name: 'shell', input: { command: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'file-a\nfile-b' }],
        },
      ],
    });
    _expect(md).toContain('running a command');
    _expect(md).toContain('"tool": "shell"');
    _expect(md).toContain('"command": "ls"');
    _expect(md).toContain('tool_result');
    _expect(md).toContain('file-a\nfile-b');
  });

  _test('empty / missing input degrades safely without throwing', () => {
    _expect(formatSessionMarkdown({})).toContain('# (untitled session)');
    _expect(formatSessionMarkdown({})).toContain('- Messages: 0');
    _expect(formatSessionMarkdown(null)).toContain('- Messages: 0');
  });
});
