'use strict';

// 验证 wordDiff.computeWordDiffSegments 纯叶子:把一对 remove/add 行的词级差异表达成
// 渲染器无关的「段(segment)」数组(每段 {text, changed}),供 ink TUI 用
// <Text backgroundColor> 高亮真正改动的子片段——对齐 CC StructuredDiffFallback
// 的词级高亮(changeRatio ≤ CHANGE_THRESHOLD 才词级,否则整行回退)。
const test = require('node:test');
const assert = require('node:assert');
const {
  computeWordDiffSegments,
  computeWordDiff,
  CHANGE_THRESHOLD,
  MAX_LCS_CELLS,
} = require('../../src/cli/wordDiff');

// 段拼回的完整文本必须与原行逐字节一致(不得吞字/重排)。
function joinSegs(segs) {
  return segs.map((s) => s.text).join('');
}

test('单词改动 → 词级:只把改动的那个词标 changed,其余 changed=false', () => {
  const r = computeWordDiffSegments('return oldName(p);', 'return newName(p);');
  assert.strictEqual(r.wordLevel, true);
  assert.strictEqual(joinSegs(r.old), 'return oldName(p);');
  assert.strictEqual(joinSegs(r.new), 'return newName(p);');
  const changedOld = r.old.filter((s) => s.changed).map((s) => s.text);
  const changedNew = r.new.filter((s) => s.changed).map((s) => s.text);
  assert.deepStrictEqual(changedOld, ['oldName']);
  assert.deepStrictEqual(changedNew, ['newName']);
});

test('相邻同状态 token 被合并成一个段(coalesce)', () => {
  // 改动横跨多个相邻 token 时应合并,而不是逐 token 一段。
  const r = computeWordDiffSegments('a = 1;', 'a = 2;');
  assert.strictEqual(r.wordLevel, true);
  // 未改动段与改动段交替,且没有两个相邻段同 changed。
  for (let i = 1; i < r.new.length; i++) {
    assert.notStrictEqual(r.new[i].changed, r.new[i - 1].changed, '相邻段不应同 changed 状态');
  }
  assert.strictEqual(joinSegs(r.new), 'a = 2;');
});

test('改动比例超过 CHANGE_THRESHOLD → 整行回退(wordLevel=false,单段)', () => {
  const r = computeWordDiffSegments('alpha beta gamma', 'one two three four five');
  assert.strictEqual(r.wordLevel, false);
  assert.deepStrictEqual(r.old, [{ text: 'alpha beta gamma', changed: false }]);
  assert.deepStrictEqual(r.new, [{ text: 'one two three four five', changed: false }]);
});

test('整行插入(old 空)→ 比例为 1 > 阈值 → 整行回退', () => {
  const r = computeWordDiffSegments('', 'brand new line');
  assert.strictEqual(r.wordLevel, false);
  assert.deepStrictEqual(r.old, []); // 空行无段
  assert.deepStrictEqual(r.new, [{ text: 'brand new line', changed: false }]);
});

test('仅缩进/空白改动 → 词级且原文逐字节保留(空白进段不丢)', () => {
  const r = computeWordDiffSegments('  return 1;', '    return 1;');
  // CC 字符长度口径下空白也计入分母/分子,但仅缩进改动占比 6/24=0.25 ≤ 0.4 → 仍词级。
  assert.strictEqual(r.wordLevel, true);
  assert.strictEqual(joinSegs(r.old), '  return 1;');
  assert.strictEqual(joinSegs(r.new), '    return 1;');
});

test('CJK 行逐字成 token,改动字被精确标出', () => {
  const r = computeWordDiffSegments('保存文件成功', '保存文件失败');
  assert.strictEqual(r.wordLevel, true);
  assert.strictEqual(joinSegs(r.old), '保存文件成功');
  assert.strictEqual(joinSegs(r.new), '保存文件失败');
  const changedNew = r.new.filter((s) => s.changed).map((s) => s.text).join('');
  assert.ok(changedNew.includes('失') || changedNew.includes('败'), '应标出改动的 CJK 字');
});

test('完全相同的两行 → 词级且无任何 changed 段', () => {
  const r = computeWordDiffSegments('same line', 'same line');
  assert.strictEqual(r.wordLevel, true);
  assert.ok(r.old.every((s) => !s.changed));
  assert.ok(r.new.every((s) => !s.changed));
});

test('非字符串入参 → 绝不抛,按空/字符串化处理', () => {
  assert.doesNotThrow(() => computeWordDiffSegments(null, undefined));
  const r = computeWordDiffSegments(null, undefined);
  assert.deepStrictEqual(r.old, []);
  assert.deepStrictEqual(r.new, []);
  // 数字被字符串化
  const r2 = computeWordDiffSegments(12, 13);
  assert.strictEqual(joinSegs(r2.old), '12');
  assert.strictEqual(joinSegs(r2.new), '13');
});

test('刀16 字符长度口径 vs token 计数口径在边界翻转(单个长标识符改名)', () => {
  // `a = reallyLongOldName + b + c + d` → 仅 reallyLongOldName(17 字)→ reallyLongNewName(17 字)。
  //   字符口径:changed=17+17=34·total=33+33=66 → 34/66≈0.515 > 0.4 → 整行回退(wordLevel=false)。
  //   token 口径(非空白):changed=1+1=2·total=9+9=18 → 2/18≈0.111 ≤ 0.4 → 词级(wordLevel=true)。
  const oldLine = 'a = reallyLongOldName + b + c + d';
  const newLine = 'a = reallyLongNewName + b + c + d';
  // 门控开(默认)= CC 字符口径 → 整行回退。
  const on = computeWordDiffSegments(oldLine, newLine);
  assert.strictEqual(on.wordLevel, false);
  // 门控关 = legacy token 口径 → 词级,且只标改名那一段。
  const off = computeWordDiffSegments(oldLine, newLine, { KHY_WORD_DIFF_CHAR_RATIO: '0' });
  assert.strictEqual(off.wordLevel, true);
  assert.strictEqual(joinSegs(off.old), oldLine);
  assert.strictEqual(joinSegs(off.new), newLine);
  const changedNew = off.new.filter((s) => s.changed).map((s) => s.text);
  assert.deepStrictEqual(changedNew, ['reallyLongNewName']);
});

test('刀16 门控关 → 字节回退 legacy token 计数口径(短词多改仍词级)', () => {
  // `return oldName(p);` → `return newName(p);`:两口径同判词级,验证门控关不破坏既有行为。
  const off = computeWordDiffSegments('return oldName(p);', 'return newName(p);', {
    KHY_WORD_DIFF_CHAR_RATIO: 'off',
  });
  assert.strictEqual(off.wordLevel, true);
  assert.strictEqual(joinSegs(off.old), 'return oldName(p);');
  assert.strictEqual(joinSegs(off.new), 'return newName(p);');
});

test('CHANGE_THRESHOLD 与 SSOT 同一常量(0.4)', () => {
  assert.strictEqual(CHANGE_THRESHOLD, 0.4);
});

// ── O(m·n) 溢出守卫(模糊测试发现:超长多 token 行会 OOM/挂死) ─────────────────
// 背景:computeWordDiff 的 LCS 在时间与内存上都是 O(m·n),会为 (m+1)·(n+1) 个 cell
// 分配 dp/dir 矩阵。一行极长文本(压缩过的 JS、超长日志行、粘贴的对抗输入)会把这个
// 乘积撑到 GB 级 → 进程 OOM 被杀;即便不 OOM,~8k token 的行也会冻结渲染数秒。守卫在
// token 乘积超过 MAX_LCS_CELLS 时回退整行着色(等价 CHANGE_THRESHOLD 分支),永不分配
// 矩阵、永不抛、永不挂。

test('溢出守卫:超长多 token 行不挂死,回退整行(wordLevel=false)且逐字节保留', () => {
  const words = 50000; // 远超守卫阈值;未加守卫时此规模会 OOM/挂死
  const oldLine = Array.from({ length: words }, (_, i) => 'w' + i).join(' ');
  const newLine = Array.from({ length: words }, (_, i) => 'q' + i).join(' ');
  const t0 = Date.now();
  const r = computeWordDiffSegments(oldLine, newLine);
  const dt = Date.now() - t0;
  assert.strictEqual(r.wordLevel, false, '超预算应整行回退');
  assert.ok(dt < 3000, `应在预算内返回(实测 ${dt}ms),而非 O(m·n) 挂死`);
  // 整行回退时段拼回必须仍逐字节等于原行(不吞字)。
  assert.strictEqual(joinSegs(r.old), oldLine);
  assert.strictEqual(joinSegs(r.new), newLine);
});

test('溢出守卫:computeWordDiff 超预算返回全改动 + changeRatio=1,不分配矩阵', () => {
  const m = 2000;
  const n = 2000; // (2001)^2 ≈ 4M > 1M 预算
  const oldTokens = Array.from({ length: m }, (_, i) => 'a' + i);
  const newTokens = Array.from({ length: n }, (_, i) => 'b' + i);
  const t0 = Date.now();
  const r = computeWordDiff(oldTokens, newTokens);
  assert.ok(Date.now() - t0 < 1000, '守卫路径应立即返回');
  assert.strictEqual(r.changeRatio, 1);
  assert.ok(r.oldRanges.every((v) => v === true), '超预算时旧 token 全标改动');
  assert.ok(r.newRanges.every((v) => v === true), '超预算时新 token 全标改动');
  assert.strictEqual(r.oldRanges.length, m);
  assert.strictEqual(r.newRanges.length, n);
});

test('溢出守卫:阈值之下仍走真实 LCS(小输入行为不变)', () => {
  // 恰在预算内的小规模仍精确词级 diff,证明守卫只拦病态输入、不误伤正常行。
  const r = computeWordDiffSegments('return oldName(p);', 'return newName(p);');
  assert.strictEqual(r.wordLevel, true);
  assert.deepStrictEqual(r.new.filter((s) => s.changed).map((s) => s.text), ['newName']);
  assert.ok(MAX_LCS_CELLS >= 1_000_000, 'MAX_LCS_CELLS 应为百万级预算');
});

test('溢出守卫门控关 → 小输入字节回退(不改变正常 diff 结果)', () => {
  // 守卫关闭时,小输入的结果必须与开启时逐字节一致(守卫只在超预算时才生效)。
  const on = computeWordDiffSegments('a = 1;', 'a = 2;');
  const off = computeWordDiffSegments('a = 1;', 'a = 2;', { KHY_WORD_DIFF_GUARD: 'off' });
  assert.strictEqual(on.wordLevel, off.wordLevel);
  assert.strictEqual(joinSegs(on.new), joinSegs(off.new));
  assert.deepStrictEqual(
    on.new.map((s) => [s.text, s.changed]),
    off.new.map((s) => [s.text, s.changed]),
  );
});
