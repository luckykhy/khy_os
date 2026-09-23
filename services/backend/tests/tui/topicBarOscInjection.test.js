'use strict';

/**
 * topicBarOscInjection.test.js — 窗口标题写入边界不得被控制字符越权(BUG-33)。
 *
 * 病根:`topicBar._paint` 与 `cli/repl/terminalTitle.setTerminalTitle` 都把主题串
 * 直接插进 `\x1b]0;${title}\x07`。主题是「模型回包」或「用户输入原文」,而 BEL(\x07)
 * 与 ESC(\x1b) 正是 OSC 串的**定界符** —— 载荷里带一个,终端就多解析出一条独立 OSC
 * (实测可注入 OSC 52 剪贴板写入)。见 .khy/feedback/tui-ux-audit-20260919/Y/。
 *
 * 手法与 topicBarWorking.test.js 一致:假 TTY stdout 捕获字节,零真实终端。
 * 断言两件事:① 越权不存在(永远只有一条 OSC 0);② 正常标题**逐字节不变**
 * (清洗不是「把所有标题都改一遍」)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO_SRC = path.join(__dirname, '../../src');
const BAR = path.join(REPO_SRC, 'cli/tui/runtime/topicBar');
const REPL_TITLE = path.join(REPO_SRC, 'cli/repl/terminalTitle');

function freshModule(p) {
  delete require.cache[require.resolve(p)];
  return require(p);
}

function fakeStdout() {
  const writes = [];
  return {
    isTTY: true,
    write(s) { writes.push(String(s)); return true; },
    joined() { return writes.join(''); },
    clear() { writes.length = 0; },
  };
}

// What a terminal would parse out of the byte stream: OSC command payloads.
function oscCommands(bytes) {
  return (bytes.match(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g) || []);
}

// The topic inside the last OSC 0 write (prefix glyph included).
function paintedTitle(bytes) {
  let title = '';
  const re = /\x1b\]0;([\s\S]*?)\x07/g;
  let m;
  while ((m = re.exec(bytes)) !== null) title = m[1];
  return title;
}

// Write the topic through the real TUI path and return the raw bytes emitted.
function paintTopicBar(topic) {
  const bar = freshModule(BAR);
  const out = fakeStdout();
  assert.strictEqual(bar.enable(out), true, 'fake TTY stdout should enable the bar');
  out.clear(); // enable() repaints whatever title the singleton still holds
  bar.setTitle(topic);
  return out.joined();
}

const { visWidth } = require(path.join(REPO_SRC, 'cli/tui/wrapCell'));

// ── 1. 越权注入被堵住 ────────────────────────────────────────────────────────

test('topicBar: 主题里的 BEL 不能再开出第二条 OSC(实测曾是 OSC 52 剪贴板写入)', () => {
  const evil = '标题\x07\x1b]52;c;ZXhmaWx0cmF0ZWQ=\x07pwned';
  const bytes = paintTopicBar(evil);
  assert.strictEqual(oscCommands(bytes).length, 1, `只该有一条 OSC,实得:${JSON.stringify(bytes)}`);
  assert.ok(!/\x1b\]52;/.test(bytes), '不得出现 OSC 52 剪贴板写入');
  assert.strictEqual(paintedTitle(bytes), '🍀 标题pwned');
});

test('topicBar: 主题里的 ST(ESC \\)同样不能提前终结 OSC 串', () => {
  const bytes = paintTopicBar('A\x1b\\B\x1b]1;假标题');
  assert.strictEqual(oscCommands(bytes).length, 1, 'ST 不得终结出第二条 OSC');
  const title = paintedTitle(bytes);
  // 未闭合的 OSC 载荷按「两字节 ESC 派发」吃掉 ESC+]，剩下的参数文本 `1;假标题`
  // 作为**可见但惰性**的普通文本留在标题里 —— 定界符已不存在，终端不会再当命令。
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(title), '标题载荷不得残留任何控制字符');
  assert.ok(!/\x1b\]1;/.test(title), '不得残留可被解析的 OSC 引入序列');
});

test('terminalTitle(REPL 路径): 同一载荷只产生一条 OSC', () => {
  const evil = '标题\x07\x1b]52;c;ZXhmaWx0cmF0ZWQ=\x07pwned';
  const realWrite = process.stdout.write;
  const realIsTTY = process.stdout.isTTY;
  const chunks = [];
  process.stdout.isTTY = true;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try {
    freshModule(REPL_TITLE).setTerminalTitle(evil);
  } finally {
    process.stdout.write = realWrite;
    process.stdout.isTTY = realIsTTY;
  }
  const bytes = chunks.join('');
  assert.strictEqual(oscCommands(bytes).length, 1);
  assert.strictEqual(paintedTitle(bytes), '标题pwned');
});

// ── 2. 正常标题不得被「顺手改坏」 ────────────────────────────────────────────

test('正常标题逐字节不变(清洗只砍控制字符,不动可读文本)', () => {
  for (const topic of ['修复登录 bug', 'AST parser', '🍀 混合 emoji 标题', 'a/b? c=d']) {
    const bytes = paintTopicBar(topic);
    assert.strictEqual(oscCommands(bytes).length, 1);
    assert.ok(bytes.endsWith(`\x1b]0;🍀 ${topic}\x07`), `标题被改写:${JSON.stringify(topic)}`);
  }
});

test('braille 空白装饰 U+2800 是刻意的 anti-trim,不得当成乱码清掉', () => {
  const bytes = paintTopicBar('标题\u2800续');
  assert.ok(paintedTitle(bytes).includes('\u2800'));
});

// ── 3. 宽度预算按显示列而不是字符数 ─────────────────────────────────────────

test('标题显示列宽不超过预算(CJK/emoji/ASCII 三类各扫一遍)', () => {
  const { titlePrefix } = require(path.join(REPO_SRC, 'cli/tui/runtime/topicBarWorkingIndicator'));
  const prefixCols = visWidth(titlePrefix({ working: false, tick: 0 }, {}));
  const CAP = 120; // topicBar.TITLE_MAX_COLS
  const cases = [];
  for (let n = 1; n <= 130; n++) cases.push('中'.repeat(n));
  for (let n = 1; n <= 130; n++) cases.push('🍀'.repeat(n));
  for (let n = 1; n <= 260; n++) cases.push('a'.repeat(n));
  for (const topic of cases) {
    const body = visWidth(paintedTitle(paintTopicBar(topic))) - prefixCols;
    assert.ok(body <= CAP, `超出预算:${topic.slice(0, 2)}… 输入 ${topic.length} 字符 → ${body} 列`);
  }
});

test('未超预算的 CJK 标题不被裁短(旧的按字符数判定会误伤)', () => {
  const topic = '中'.repeat(50); // 100 列,在预算内
  assert.strictEqual(paintedTitle(paintTopicBar(topic)), `🍀 ${topic}`);
});
