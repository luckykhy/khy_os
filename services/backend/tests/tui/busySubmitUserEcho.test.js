'use strict';

/**
 * busySubmitUserEcho — 回归守卫:忙时提交(steer/urgent 路由)的用户消息必须以
 * user 角色行出现在 transcript 中,不能只留一条 40 字截断的 dim notice。
 *
 * 背景(2026-07-28「发送后用户消息从历史消失」):回合运行中用户提交的输入若被
 * routeBusyInput 分类为 'steer'/'urgent',此前只推入 steerQueueRef + 一条 notice,
 * 从不提交 user 行。经典 REPL 的 readline 会天然把输入行留在终端滚动区,而 Ink
 * 输入框提交即清空 —— 于是 TUI 里这条消息「消失」:AI 在思考中逐条回应它,历史里
 * 却看不到回显。次生缺陷:回合内无后续工具边界时 steer 遗留永不消费(静默丢失或
 * 泄漏进下一个不相关回合)。
 *
 * 忙时路由是 useQueryBridge 里的 React useCallback,无法脱离渲染单测;故用**源码
 * 接线断言**锁定修复(与 clearResetsHistory.test.js 同风格)。
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
const bridgeSrc = fs.readFileSync(
  path.join(backendRoot, 'src/cli/tui/hooks/useQueryBridge.js'), 'utf8'
);

// 抠出忙时路由某分支块:从分支条件起到该分支的 `return Promise.resolve(null);`。
function busyBranch(marker) {
  const start = bridgeSrc.indexOf(marker);
  _expect(start >= 0).toBe(true);
  const end = bridgeSrc.indexOf('return Promise.resolve(null);', start);
  _expect(end >= 0).toBe(true);
  return bridgeSrc.slice(start, end);
}

_describe('TUI 忙时提交 user 行回显守卫', () => {
  _test('steer 分支把用户原文以 user 角色提交到 transcript', () => {
    // 抠出整个 'steer' 路由分支(到 'interrupt' 分支前),断言注入段提交 user 行。
    const start = bridgeSrc.indexOf("if (route.action === 'steer')");
    _expect(start >= 0).toBe(true);
    const end = bridgeSrc.indexOf("if (route.action === 'interrupt')", start);
    _expect(end >= 0).toBe(true);
    const seg = bridgeSrc.slice(start, end);
    _expect(seg).toMatch(/setMessages\(\(m\) => \[\.\.\.m, \{ role: 'user', content: route\.text/);
  });

  _test('urgent 分支把用户原文以 user 角色提交到 transcript', () => {
    const seg = busyBranch("if (route.action === 'urgent')");
    _expect(seg).toMatch(/setMessages\(\(m\) => \[\.\.\.m, \{ role: 'user', content: route\.text/);
  });

  _test('重复提交去抖同时覆盖 steer 队尾(防同文本双份回显)', () => {
    _expect(bridgeSrc).toContain('const _lastSteer = steerQueueRef.current[steerQueueRef.current.length - 1];');
    _expect(bridgeSrc).toMatch(/_lastSteer === 'string' && _lastSteer\.trim\(\) === _trimmed/);
  });
});

_describe('steer 遗留安全网(不静默丢失、不泄漏跨回合)', () => {
  _test('_runSubmit 收尾把未消费 steer 转入 FIFO 队列续跑', () => {
    _expect(bridgeSrc).toContain('const leftovers = steerQueueRef.current.splice(0);');
    _expect(bridgeSrc).toMatch(/queueRef\.current\.push\(\{ text: t, options: \{ _echoed: true \} \}\)/);
  });

  _test('_runSubmit 乐观回显被 _echoed 守卫(续跑回合不二次回显)', () => {
    _expect(bridgeSrc).toContain('if (!options._echoed) {');
    _expect(bridgeSrc).toMatch(/if \(!options\._echoed\) \{\s*\n\s*setMessages\(\(m\) => \[\.\.\.m, \{ role: 'user', content: text, imageCount/);
  });
});
