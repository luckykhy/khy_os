'use strict';
/**
 * toolUseLoop.chatErrorGuard.test.js �?主循环模型调用防御纵深接�?goal 2026-07-11「包括错误的处理�?�?
 *
 * 网关契约�?generate() 返回 success:false 而非�?�?意外*异常会从 `await chat(...)` 穿透并
 * 杀掉整个多�?run。门 KHY_TOOL_LOOP_CHAT_GUARD(默认开)开启时:意外异常被归一成「诚实的本轮
 * 结束」返回结果——本轮优雅收尾、会话继�?不掉线。门�?�?逐字节回退:重新抛出�?
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-chatguard-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
const toolUseLoop = require('../src/services/toolUseLoop');
function throwingChat() {
  return async () => {
    throw new TypeError('adapter bug: cannot read properties of undefined (reading \'choices\')');
  };
}
describe('main loop chat() defense-in-depth (KHY_TOOL_LOOP_CHAT_GUARD)', () => {
  afterEach(() => {
    delete process.env.KHY_TOOL_LOOP_CHAT_GUARD;
  });
  test('gate on explicit "1": same honest turn-end', async () => {
    process.env.KHY_TOOL_LOOP_CHAT_GUARD = '1';
    const result = await toolUseLoop.runToolUseLoop('Do the multi-day work', {
      chat: throwingChat(),
      maxIterations: 3,
      sessionId: 'sess-cg-b',
      requestId: 'req-cg-b',
    });
    expect(result.unexpectedChatError).toBe(true);
    expect(result.finalResponse).toMatch(/意外异常/);
  });
});

describe('Tool Use Loop chat Error Guard', () => {
  test('gate on (default): an unexpected throw ends the turn honestly, never crashes the loop', async () => {
        delete process.env.KHY_TOOL_LOOP_CHAT_GUARD; // default ON
        const result = await toolUseLoop.runToolUseLoop('Do the multi-day work', {
          chat: throwingChat(),
          maxIterations: 3,
          sessionId: 'sess-cg-a',
          requestId: 'req-cg-a',
        });
        expect(result).toBeTruthy();
        expect(result.unexpectedChatError).toBe(true);
        expect(result.provider).toBe('none');
        expect(result.error_code).toBe('E01');
        expect(result.finalResponse).toMatch(/意外异常/);
        expect(result.finalResponse).toMatch(/choices/); // concrete cause surfaced, not hidden
        expect(result.resumable).toBe(true);
  });

  test('gate off (explicit falsy): re-throws �?byte-identical legacy behavior', async () => {
        process.env.KHY_TOOL_LOOP_CHAT_GUARD = 'off';
        await assert.rejects(
          () => toolUseLoop.runToolUseLoop('Do the multi-day work', {
            chat: throwingChat(),
            maxIterations: 3,
            sessionId: 'sess-cg-c',
            requestId: 'req-cg-c',
          }),
          /adapter bug/,
        );
  });

});

