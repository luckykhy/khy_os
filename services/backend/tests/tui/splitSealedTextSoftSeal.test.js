'use strict';

/**
 * splitSealedTextSoftSeal.test —— J1 软封长增长段(node:test)。
 *
 * 病根:splitSealedText 只在空行处封存,一个持续增长、内部无空行的开放文本段(长段落 /
 * 长列表 / 无空行长内容)永远整段 live → 每帧全量重规范化 O(n²) → TUI 卡顿。
 * 修复(门 KHY_TUI_SOFT_SEAL 默认开):在「两纯散文行之间」的安全软边界回退封存以封顶 live 段。
 *
 * 本套件钉死的契约:
 *   - 恒等式 sealed + live === input(切片,永不丢字节)。
 *   - 门关(KHY_TUI_SOFT_SEAL=off)→ 与历史空行边界逻辑逐字节等价(不软封)。
 *   - 门开但未超阈值(< KHY_TUI_SOFT_SEAL_CHARS)→ 不软封。
 *   - 软边界绝不劈开 fence / 表格 / 列表 / 引用 / 缩进码。
 */
const test = require('node:test');
const assert = require('node:assert');

const { splitSealedText } = require('../../src/cli/tui/hooks/queryBridgeTimeline');

const ON = {};                               // 门开(默认)
const OFF = { KHY_TUI_SOFT_SEAL: 'off' };    // 门关

// 一段无空行、无结构标记的长散文(每行都是纯散文行),用于触发软封。
function longProse(nLines = 200) {
  return Array.from({ length: nLines }, (_, i) => `这是第${i}行足够长的纯散文内容用于制造无空行长段落`).join('\n');
}

test('恒等式 sealed + live === input(门开门关皆然)', () => {
  const p = longProse();
  for (const env of [ON, OFF]) {
    const { sealed, live } = splitSealedText(p, env);
    assert.strictEqual(sealed + live, p);
  }
});

test('门关:长散文无空行 → 整段 live(逐字节回退历史行为)', () => {
  const { sealed, live } = splitSealedText(longProse(), OFF);
  assert.strictEqual(sealed, '');
  assert.strictEqual(live, longProse());
});

test('门开:超阈值长散文 → 在软边界封存(sealed 非空且以 \\n 结尾)', () => {
  const p = longProse();
  const { sealed, live } = splitSealedText(p, ON);
  assert.ok(sealed.length > 0, 'sealed 应非空');
  assert.ok(sealed.endsWith('\n'), '软边界切在终止换行处');
  assert.strictEqual(sealed + live, p);
  assert.ok(live.length < p.length, 'live 段被封顶变短');
});

test('门开:短散文(< 阈值)不软封', () => {
  const short = 'line1\nline2\nline3';
  assert.deepStrictEqual(splitSealedText(short, ON), { sealed: '', live: short });
});

test('自定义 KHY_TUI_SOFT_SEAL_CHARS 生效', () => {
  const p = longProse(60);
  // 极小阈值 → 触发;极大阈值 → 不触发
  const small = splitSealedText(p, { KHY_TUI_SOFT_SEAL_CHARS: '50' });
  assert.ok(small.sealed.length > 0, '阈值 50 → 触发软封');
  const large = splitSealedText(p, { KHY_TUI_SOFT_SEAL_CHARS: '10000000' });
  assert.strictEqual(large.sealed, '', '阈值极大 → 不触发');
});

test('表格永不被软封劈开(表格行含 | 判非纯散文)', () => {
  const table = '| a | b |\n'.repeat(400);
  const { sealed, live } = splitSealedText(table, ON);
  assert.strictEqual(sealed, '', '表格整段保持 live,绝不切割');
  assert.strictEqual(sealed + live, table);
});

test('巨型代码围栏(内部无空行)不被软封劈开', () => {
  const fence = '```js\n' + Array.from({ length: 400 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
  const { sealed, live } = splitSealedText(fence, ON);
  // 围栏在开头 → 软边界只会落在围栏之前(此处无),故整段 live。
  assert.strictEqual(sealed, '');
  assert.strictEqual(sealed + live, fence);
});

test('列表永不被软封劈开(列表项判非纯散文)', () => {
  const list = Array.from({ length: 400 }, (_, i) => `- 列表项 ${i} 的内容足够长`).join('\n');
  const { sealed, live } = splitSealedText(list, ON);
  assert.strictEqual(sealed, '', '列表整段保持 live');
  assert.strictEqual(sealed + live, list);
});

test('引用块永不被软封劈开', () => {
  const quote = Array.from({ length: 400 }, (_, i) => `> 引用第 ${i} 行内容`).join('\n');
  const { sealed } = splitSealedText(quote, ON);
  assert.strictEqual(sealed, '', '引用整段保持 live');
});

test('空行边界仍优先;空行后尾部超阈值时软扩展至更靠后的软边界', () => {
  // 前面一个短段 + 空行,后面一大段无空行纯散文。
  const head = 'intro para\n\n';
  const tail = longProse(200);
  const input = head + tail;
  const { sealed, live } = splitSealedText(input, ON);
  assert.strictEqual(sealed + live, input);
  // 软扩展:sealed 应超过纯空行边界(head 长度),把长尾也封进去一部分。
  assert.ok(sealed.length > head.length, '空行后长尾触发软扩展');
  // 门关时应恰好停在空行边界(无软扩展)。
  const off = splitSealedText(input, OFF);
  assert.strictEqual(off.sealed, head);
  assert.strictEqual(off.live, tail);
});

test('混排:长散文段落之间的空行边界正常(未超阈值不软扩展)', () => {
  const input = 'a short\n\nb short\n\nc still typing';
  assert.deepStrictEqual(splitSealedText(input, ON), {
    sealed: 'a short\n\nb short\n\n', live: 'c still typing',
  });
});
