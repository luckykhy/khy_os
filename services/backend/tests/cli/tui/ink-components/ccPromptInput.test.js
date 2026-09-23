'use strict';

// CcPromptInput 源码契约测试 — P0-4 六修的接线锚定(IME Enter 守卫 / shift+return
// 死分支修复 / astral 字素步进 / dwidth CJK 回退 / 粘贴标记剥离)。组件本身依赖
// inkRuntime 惰性加载,无法在 node:test 里廉价实例化,故按 abortInterruptWiring
// 范式锚定源码结构;纯函数部分(_prevStep/_nextStep/visWidth)直接断言行为。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_ROOT = path.resolve(__dirname, '../../../../src');
const read = (rel) => fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');

const ccPrompt = read('cli/tui/ink-components/CcPromptInput.js');
const useTextInput = read('cli/tui/hooks/useTextInput.js');
const appJs = read('cli/tui/ink-components/App.js');

test('CcPromptInput: shift+return 块位于 key.return 块之前(死分支已修复)', () => {
  const shiftIdx = ccPrompt.indexOf('key.shift && key.return');
  const returnIdx = ccPrompt.indexOf('if (key.return)');
  assert.ok(shiftIdx > 0, 'shift+return 块应存在');
  assert.ok(returnIdx > 0, 'key.return 块应存在');
  assert.ok(shiftIdx < returnIdx, 'shift+return 必须先于 key.return 判定,否则永远是死分支');
});

test('CcPromptInput: key.return 块内接线 IME 守卫(裸 Enter 近因吞掉)', () => {
  const idx = ccPrompt.indexOf('if (key.return)');
  const block = ccPrompt.slice(idx, idx + 900);
  assert.ok(/imeCommitGuard\.shouldSwallowBareEnter\(\)/.test(block), 'return 块须咨询守卫叶子');
  assert.ok(/!key\.shift && !key\.ctrl && !key\.meta/.test(block), '守卫只对裸 Enter 生效(modifier 让位)');
  assert.ok(/require\('\.\.\/imeCommitGuard'\)/.test(ccPrompt), '须 require 共享叶子(单一真源)');
});

test('CcPromptInput: astral 字素步进(Backspace/箭头/Vim h/l/x 走 _prevStep/_nextStep)', () => {
  assert.ok(/require\('\.\.\/utils\/Cursor'\)/.test(ccPrompt), '须从 Cursor 取步进叶子');
  // Backspace 用 _prevStep
  const bsIdx = ccPrompt.indexOf('key.backspace || key.delete');
  assert.ok(bsIdx > 0 && /_prevStep\(value, offset\)/.test(ccPrompt.slice(bsIdx, bsIdx + 400)),
    'Backspace 须按字素步退(代理对按一个码点删)');
  // Vim x 前删用 _nextStep
  const xIdx = ccPrompt.indexOf("input === 'x'");
  assert.ok(xIdx > 0 && /_nextStep\(value, offset\)/.test(ccPrompt.slice(xIdx, xIdx + 400)),
    'Vim x 须按字素前删');
  // h/l 箭头不再用裸 ±1(抽样 leftArrow 与 Vim h)
  const leftIdx = ccPrompt.indexOf('key.leftArrow');
  assert.ok(leftIdx > 0 && !/o - 1\)\)/.test(ccPrompt.slice(leftIdx, leftIdx + 200)),
    'leftArrow 不得再用裸 -1 步进');
});

test('CcPromptInput: dwidth 回退链接到 textMeasure.visWidth(CJK 不再退 UTF-16 长度)', () => {
  const idx = ccPrompt.indexOf('function dwidth');
  const body = ccPrompt.slice(idx, idx + 800);
  assert.ok(/textMeasure.*visWidth/.test(body), '回退链尾须是 visWidth(CJK=2)');
});

test('CcPromptInput: 可打印输入前剥离粘贴标记(ESC[200~/201~ 不再入库)', () => {
  assert.ok(/\\x1b\\\[200~/.test(ccPrompt), '须剥离 bracketed-paste 标记');
});

test('useTextInput: 守卫位于 paste 守卫之前 + 两个打点(单字符/多字符 chunk)', () => {
  // key.return 块内:IME 守卫先于 PASTE_NEWLINE_GUARD_MS(组字 Enter 不得命中 paste 窗变杂散换行)
  const returnIdx = useTextInput.indexOf('if (key.return)');
  const block = useTextInput.slice(returnIdx, returnIdx + 1200);
  const imePos = block.indexOf('shouldSwallowBareEnter');
  const pastePos = block.indexOf('PASTE_NEWLINE_GUARD_MS');
  assert.ok(imePos > 0, 'return 块须咨询 IME 守卫');
  assert.ok(pastePos > imePos, 'IME 守卫必须位于 paste 守卫之前');
  // 打点:单字符分支 + 多字符粘贴分支
  const singlePos = useTextInput.indexOf('imeCommitGuard.noteImeCommit(input)');
  const multiPos = useTextInput.indexOf("imeCommitGuard.noteImeCommit(stripPasteMarkers(input))");
  assert.ok(singlePos > 0, '单字符分支须打点(逐键 CJK 上屏)');
  assert.ok(multiPos > 0, '多字符分支须打点(整词组字上屏)');
});

test('App.js: revSearch 与补全菜单的 Enter 守卫 + revSearch 可打印打点', () => {
  // revSearch: key.return||key.tab 分支内守卫
  const revIdx = appJs.indexOf('if (key.return || key.tab)');
  assert.ok(revIdx > 0, 'revSearch Enter/Tab 分支应存在');
  assert.ok(/imeCommitGuard\.shouldSwallowBareEnter\(\)/.test(appJs.slice(revIdx, revIdx + 600)),
    'revSearch Enter 须咨询守卫(IME 确认键不得误收匹配)');
  // revSearch 可打印分支打点(overlay 不落 textInput,须就地打点)
  const revPrintIdx = appJs.indexOf("imeCommitGuard.noteImeCommit(input)");
  assert.ok(revPrintIdx > revIdx, 'revSearch 可打印分支须就地打点');
  // 补全菜单:key.return 分支内守卫(slash 命令立即执行,破坏性最强)
  const menuIdx = appJs.indexOf("completion.kind === 'slash'");
  assert.ok(menuIdx > 0, '补全菜单 slash 分支应存在');
  const menuEnterIdx = appJs.lastIndexOf('if (key.return)', menuIdx);
  assert.ok(menuEnterIdx > 0 && /shouldSwallowBareEnter/.test(appJs.slice(menuEnterIdx, menuIdx)),
    '补全菜单 Enter 须先过守卫再执行命令');
});

// ── 行为层:步进叶子与宽度回退的真实语义(非源码锚定) ──────────────────────────
const { _prevStep, _nextStep } = require('../../../../src/cli/tui/utils/Cursor');
const { visWidth } = require('../../../../src/cli/tui/runtime/textMeasure');

test('行为: astral 步进语义(emoji 代理对按 2 步进,不撕裂)', () => {
  const s = 'a😀b'; // 😀 = U+1F600 (2 code units)
  assert.strictEqual(_prevStep(s, 3), 2, '从代理对后位置回退应跨 2 个 code unit');
  assert.strictEqual(_prevStep(s, 1), 1, '从 BMP 字符后回退为 1');
  assert.strictEqual(_prevStep(s, 0), 0, '0 处回退为 0');
  assert.strictEqual(_nextStep(s, 1), 2, '从代理对起点前进应跨 2');
  assert.strictEqual(_nextStep(s, 3), 1, '从 BMP 前进为 1');
  assert.strictEqual(_nextStep(s, 4), 0, '末尾前进为 0');
});

test('行为: visWidth CJK=2(dwidth 回退的语义保证)', () => {
  assert.strictEqual(visWidth('你好'), 4);
  assert.strictEqual(visWidth('a你'), 3);
  assert.strictEqual(visWidth(''), 0);
});

// ── BUG-99：CC 输入光标按真实列渲染（ink 真渲染，非源码锚定）─────────────────
// 组件此前把光标钉在其 segment 末尾（Text(segText) 再追加 Cursor），
// caretToWrapped 算出的 caret.col 被丢弃 → 行内编辑 / 恢复草稿（offset=0 有值）
// 时光标画在整行末尾而非编辑点。inkRuntime 可在本测试里廉价实例化，故直接渲染对拍。
test('BUG-99 行为: 行内光标落在真实列，非 segment 末尾（ink 真渲染）', async () => {
  const TUI_PATH = path.resolve(__dirname, '../../../../src/cli/tui');
  process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';
  const R = require(require.resolve('react', { paths: [TUI_PATH] }));
  const inkRuntime = require(path.join(TUI_PATH, 'inkRuntime'));
  await inkRuntime.loadInk();
  const ink = inkRuntime.get();
  const stripAnsi2 = require(path.resolve(__dirname, '../../../../src/utils/stripAnsi'));
  const Comp = require(path.join(TUI_PATH, 'ink-components/CcPromptInput')).CcPromptInput;
  // 内部 offset 起点为 0（恢复草稿态）；cols=12 令 value 折成多段。
  const frame = stripAnsi2(
    ink.renderToString(R.createElement(Comp, { value: 'hello there world', cols: 12, maxRows: 5 }),
      { columns: 12 }),
  ).replace(/\n$/, '').split('\n');
  const withCaret = frame.find((ln) => ln.includes('\u2502'));
  assert.ok(withCaret !== undefined, '帧内须有光标');
  // 修复前 = "> hello th│"（光标在段末，col 10）；修复后须 = "> │hello th"（编辑点 col 2）。
  assert.ok(withCaret.startsWith('> \u2502'), '光标须在提示符后、文本前（真实列），实测: ' + JSON.stringify(withCaret));
  assert.ok(!withCaret.endsWith('\u2502'), '光标不得再钉在 segment 末尾');
});
