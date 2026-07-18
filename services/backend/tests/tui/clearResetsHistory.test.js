'use strict';

/**
 * clearResetsHistory — 回归守卫:Ink TUI 的 /clear 必须真正清空后端模型上下文 +
 * 复位网关熔断 + 归零页脚上下文占用,而不只是清屏。
 *
 * 背景(goal 2026-07-03「/clear 完全失效」):此前 App.js 的 /clear 分支只做
 * setMessages([]) + app.clear() 就提前 return,从不调 ai().clearHistory() 也不复位熔断
 * → 屏幕清白但 AI 记得全部对话、熔断残留 = 用户眼中「完全失效」。本测锁定修复后的接线,
 * 防止再退回那条只清屏的早退路径。
 *
 * /clear 分支是 App.js 里的 React useCallback,无法脱离渲染单测;故这里用**源码接线断言**
 * 守住三处必调,并验证 sessionClear 共享叶子与 useQueryBridge.resetContext 出口存在。
 * 行为语义(熔断复位)已由 tests/services/breakerResetOnNew.test.js 覆盖。
 *
 * 可在 jest(describe/test/expect)与 `node --test` 双跑(下方 shim)。
 */

const fs = require('fs');
const path = require('path');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const nodeTest = require('node:test');
  const assert = require('node:assert');
  _describe = nodeTest.describe;
  _test = nodeTest.test;
  _expect = (actual) => ({
    toBe: (exp) => assert.strictEqual(actual, exp),
    toContain: (sub) => assert.ok(String(actual).includes(sub), `expected to contain: ${sub}`),
    toMatch: (re) => assert.match(String(actual), re),
    toBeTruthy: () => assert.ok(actual),
  });
}

const backendRoot = path.resolve(__dirname, '..', '..');
const appSrc = fs.readFileSync(
  path.join(backendRoot, 'src/cli/tui/ink-components/App.js'), 'utf8'
);
const bridgeSrc = fs.readFileSync(
  path.join(backendRoot, 'src/cli/tui/hooks/useQueryBridge.js'), 'utf8'
);

// 抠出 /clear 分支块(从 `parsed.command === 'clear'` 到其 `return;`),只在块内断言,
// 避免匹配到文件别处同名调用。
function clearBranch() {
  const start = appSrc.indexOf("parsed.command === 'clear'");
  _expect(start >= 0).toBe(true);
  const end = appSrc.indexOf('return;', start);
  _expect(end >= 0).toBe(true);
  return appSrc.slice(start, end + 'return;'.length);
}

_describe('TUI /clear 接线守卫', () => {
  _test('/clear 分支调 ai().clearHistory()(清后端模型上下文)', () => {
    _expect(clearBranch()).toMatch(/require\(['"]\.\.\/\.\.\/ai['"]\)\.clearHistory\(\)/);
  });

  _test('/clear 分支调 sessionClear.resetGatewayBreakerOnSessionClear(复位熔断)', () => {
    _expect(clearBranch()).toMatch(
      /require\(['"]\.\.\/\.\.\/sessionClear['"]\)\s*\.\s*resetGatewayBreakerOnSessionClear/
    );
  });

  _test('/clear 分支调 query.resetContext()(归零页脚上下文占用)', () => {
    _expect(clearBranch()).toContain('query.resetContext()');
  });

  _test('/clear 分支仍保留既有清屏/transcript 清空', () => {
    const b = clearBranch();
    _expect(b).toContain('query.setMessages([])');
    _expect(b).toContain('app0.clear()');
  });

  _test('分支条件同时覆盖 /new 与 /reset(对齐 REPL:三者同义清空会话)', () => {
    // 抠出 if 条件那一行(从块起点到首个 `{`),断言三命令都在。
    const b = clearBranch();
    const cond = b.slice(0, b.indexOf('{') + 1);
    _expect(cond).toContain("parsed.command === 'clear'");
    _expect(cond).toContain("parsed.command === 'new'");
    _expect(cond).toContain("parsed.command === 'reset'");
  });
});

_describe('共享叶子与 bridge 出口存在', () => {
  _test('sessionClear 导出 resetGatewayBreakerOnSessionClear', () => {
    const leaf = require('../../src/cli/sessionClear');
    _expect(typeof leaf.resetGatewayBreakerOnSessionClear).toBe('function');
  });

  _test('useQueryBridge 定义 resetContext 并纳入 return 出口', () => {
    _expect(bridgeSrc).toMatch(/const resetContext = useCallback\(/);
    _expect(bridgeSrc).toContain('setContextTokens(0)');
    // return 出口含 resetContext(与其它 return 字段并列)。
    _expect(bridgeSrc).toMatch(/\n\s*resetContext,\n/);
  });
});

_describe('TUI /rewind · /undo(无参)→ 原生 RewindPicker 接线守卫', () => {
  // 此前无参 /rewind 落到 route()→handleRollback 只在瞬态区打印纯文本回溯点列表(退化),
  // 而双 Esc 却给富交互原生选择器 = 同一功能两套体验。本测锁定:无参 /rewind·/undo 直接
  // openRewindPicker()(与双 Esc 共用管线),带参形式仍走 route() 保留原语义。
  function rewindBranch() {
    const start = appSrc.indexOf("parsed.command === 'rewind'");
    _expect(start >= 0).toBe(true);
    const end = appSrc.indexOf('return;', start);
    _expect(end >= 0).toBe(true);
    return appSrc.slice(start, end + 'return;'.length);
  }

  _test('无参 /rewind · /undo 分支调 openRewindPicker()', () => {
    _expect(rewindBranch()).toContain('openRewindPicker()');
  });

  _test('分支条件覆盖 rewind 与 undo,且限定无参无子命令', () => {
    const b = rewindBranch();
    const cond = b.slice(0, b.indexOf('{') + 1);
    _expect(cond).toContain("parsed.command === 'rewind'");
    _expect(cond).toContain("parsed.command === 'undo'");
    _expect(cond).toMatch(/!parsed\.args \|\| parsed\.args\.length === 0/);
    _expect(cond).toContain('!parsed.subCommand');
  });

  _test('openRewindPicker 调用被 try/catch 包裹(打不开则静默不误发 AI)', () => {
    _expect(rewindBranch()).toMatch(/try \{ openRewindPicker\(\); \} catch/);
  });
});

_describe('TUI /resume 重放可见 transcript 接线守卫', () => {
  // /resume(= history resume)恢复后端 ai._messages 但 route() 只返 true 无载荷 →
  // App.js 须复用 buildResumedTranscript(ai.getConversation()) 把对话重放进可见 transcript,
  // 否则用户看到空屏而 AI 却记得全部(与旧 /clear 缺口同类)。
  function resumeReplayBlock() {
    // 抠出 refreshGoalActive 之后、aiForward 分支之前的重放块。
    const anchor = appSrc.indexOf('try { refreshGoalActive();');
    _expect(anchor >= 0).toBe(true);
    const end = appSrc.indexOf('route() declined', anchor);
    _expect(end >= 0).toBe(true);
    return appSrc.slice(anchor, end);
  }

  _test('resume 分支用 buildResumedTranscript(ai.getConversation()) 重放', () => {
    const b = resumeReplayBlock();
    _expect(b).toContain('buildResumedTranscript(');
    _expect(b).toMatch(/require\(['"]\.\.\/\.\.\/ai['"]\)\.getConversation\(\)/);
    _expect(b).toContain('query.setMessages(');
  });

  _test('仅在 result===true(完整恢复)且命令是 resume/history resume 时重放', () => {
    const b = resumeReplayBlock();
    _expect(b).toContain('result === true');
    _expect(b).toContain("parsed.command === 'resume'");
    _expect(b).toMatch(/parsed\.command === 'history'\s*&&\s*parsed\.subCommand === 'resume'/);
  });

  _test('buildResumedTranscript 已在 App.js 模块作用域导入', () => {
    _expect(appSrc).toMatch(/const \{[^}]*buildResumedTranscript[^}]*\} = require\(['"]\.\.\/hooks\/useQueryBridge['"]\)/);
  });
});

