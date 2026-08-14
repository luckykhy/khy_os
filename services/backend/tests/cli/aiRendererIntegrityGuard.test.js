'use strict';

// 输出层软 bug 监听 — REPL 收口 seam(goal 2026-06-25)。
// 守护 renderAiResponse 在 markdown/diff/wrap 之前对原始模型文本跑 outputIntegrityMonitor:
//   1. 零星 U+FFFD 乱码被 strip,不进入最终渲染输出。
//   2. 监听器在 render 路径永不抛(整段乱码也只落日志 + 最佳努力渲染,不让回答整段弄没)。
//   3. 健康文本零改动(零误报)。
// 与 TUI 的 Transcript.normalizeCommitted 对称;此处只断言 REPL 这一条收口。

const { renderAiResponse } = require('../../src/cli/aiRenderer');

function stripAnsi(text = '') {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderAiResponse — 输出软 bug 收口', () => {
  test('零星 U+FFFD 乱码被 strip,不出现在渲染输出', () => {
    const out = stripAnsi(renderAiResponse('正常回答' + '�' + '继续'));
    expect(out.includes('�')).toBe(false);
    expect(out).toContain('正常回答');
    expect(out).toContain('继续');
  });

  test('整段乱码:render 路径永不抛,仍返回字符串(最佳努力)', () => {
    let out;
    expect(() => { out = renderAiResponse('�'.repeat(40)); }).not.toThrow();
    expect(typeof out).toBe('string');
  });

  test('健康文本零误报(逐字保留可见内容)', () => {
    const src = '这是一段正常的中文 with English, code `x`, and emoji 🎉。';
    const out = stripAnsi(renderAiResponse(src));
    expect(out).toContain('正常的中文');
    expect(out).toContain('English');
    expect(out).toContain('🎉');
  });
});
