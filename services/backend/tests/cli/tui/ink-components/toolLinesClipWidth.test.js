'use strict';

// toolLinesClipWidth — clip() 必须按「显示列宽」而非「字符数」裁切。
//
// 背景(为什么这个文件必须存在):
//   clip(s, n) 的 n 是**列预算**(litClipW = cols - 10),但历史实现用 `s.length > n`
//   判是否超宽。CJK 每字占 2 列:一条 48 字符 / 76 列的中文行,`48 > 70` 恒假 →
//   clip 认为「放得下」原样返回 → 实际 76 列 > 70 预算 → ink 二次软换行 → 撑破
//   foldOutput 的行预算(正是本文件注释反复防护的 live 区顶穿 / fullscreen 清屏)。
//   现在:宽字符走 displayWidth 感知的 truncateToWidth(且**不折叠空格**,保留缩进);
//   纯窄字符走逐字节等价的旧路径(锁死的 ASCII 输出/测试不受影响)。
//
//   `node --test`。

const test = require('node:test');
const assert = require('node:assert');

const { displayWidth } = require('../../../../src/cli/formatters');
const clip = require('../../../../src/cli/tui/ink-components/ToolLines.js').clip;

test('clip: CJK 行按列预算裁切,不再溢出', () => {
  const budget = 70;
  const line = '    const 消息 = "这是一段很长的中文内容用来模拟命令输出或diff行的缩进保留";';
  assert.ok(displayWidth(line) > budget, '前提:输入确实超预算');
  const out = clip(line, budget);
  assert.ok(displayWidth(out) <= budget, `裁切后应 ≤ 预算, 实际 ${displayWidth(out)}`);
});

test('clip: 保留前导缩进(不折叠空格)', () => {
  const line = '        缩进很深的中文行内容用于验证裁切不会把前导空格塌掉啊啊啊啊啊啊啊啊';
  const out = clip(line, 30);
  assert.match(out, /^ {8}/, '前导 8 空格必须原样保留');
});

test('clip: 纯窄字符输出与旧逐字节路径完全一致', () => {
  const legacy = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  for (const s of ['short ascii', 'x'.repeat(100), '']) {
    assert.equal(clip(s, 70), legacy(s, 70));
  }
});

test('clip: n=Infinity 时整行透传(Ctrl+O 展开全貌)', () => {
  const line = '一整行非常长的中文内容在展开态不应该被任何数据层裁切交给 ink 自然换行即可';
  assert.equal(clip(line, Infinity), line);
});

test('clip: 内容未超预算时原样返回(含宽字符)', () => {
  const line = '短的中文';
  assert.equal(clip(line, 70), line);
});

// ── astral(代理对)回归 BUG-113 ──
// 宽字符判定门 `displayWidth(s) !== s.length` 对 astral 失效:一个 emoji 既是
// 2 显示列也是 2 个 UTF-16 码元 → 门判「等高」→ 走旧逐字节路径 → `s.slice` 从
// 代理对中间切开 → 屏上留下孤立代理项(乱码)。现用 _SURROGATE_RE 兜住此类串,
// 改走按码点步进的 truncateToWidth。下列测试锁死:裁切结果无孤立代理 + 不超预算。
const EMOJI = '\u{1F600}'; // 😀 — 增补平面,UTF-16 占 2 码元
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = s.charCodeAt(i - 1);
      if (!(p >= 0xd800 && p <= 0xdbff)) return true;
    }
  }
  return false;
}

test('clip: astral emoji 行裁切不产生孤立代理项(不拆半对)', () => {
  const budget = 7;
  const out = clip('hello' + EMOJI + 'world', budget);
  assert.ok(!hasLoneSurrogate(out), `结果不得含孤立代理项: ${JSON.stringify(out)}`);
  assert.ok(displayWidth(out) <= budget, `裁切后应 ≤ 预算, 实际 ${displayWidth(out)}`);
});

test('clip: 纯 astral 行(displayWidth==length 的假象)仍走宽度感知路径', () => {
  // 整行只有 emoji:displayWidth == .length,旧门会误判为「窄」→ 逐字节 slice 拆对。
  const line = EMOJI.repeat(10); // 20 码元 / 20 列
  const out = clip(line, 9);
  assert.ok(!hasLoneSurrogate(out), `结果不得含孤立代理项: ${JSON.stringify(out)}`);
  assert.ok(displayWidth(out) <= 9, `裁切后应 ≤ 9 列, 实际 ${displayWidth(out)}`);
});

test('clip: 未超预算的 astral 行原样透传', () => {
  const line = '短' + EMOJI + '行';
  assert.equal(clip(line, 70), line);
});

// summarizeArgs 内部走 shorten(24 码点预算)+ truncate(端裁)。当 astral emoji 正好
// 压在 shorten 的第 23/24 码元边界上时,旧的 `s.slice(0,23)` 会把代理对切成一半 →
// 工具头行乱码。锁死:边界情形下 summarizeArgs 输出无孤立代理项。
test('summarizeArgs: shorten 边界上的 astral emoji 不被拆半', () => {
  const { summarizeArgs } = require('../../../../src/cli/tui/ink-components/ToolLines.js');
  const v = 'x'.repeat(22) + EMOJI + '尾部内容更多'; // emoji 跨 22/23 码元
  const out = summarizeArgs({ input: { customKeyA: v } });
  assert.ok(!hasLoneSurrogate(out), `工具头行不得含孤立代理项: ${JSON.stringify(out)}`);
});


