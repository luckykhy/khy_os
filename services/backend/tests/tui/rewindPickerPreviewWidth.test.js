'use strict';

/**
 * rewindPickerPreviewWidth.test.js — 回溯选择器的预览「一行一视觉行」守卫(BUG-54)。
 *
 * 两层各管一件事，两层都要锁：
 *   叶子层 `clipCell` / `listUserTargets`：单位从**码元**换成**显示列**，
 *     且截断点绝不落在代理对里（探针量到 `preview` 104/114/158 列、孤立代理 1）。
 *   帧层 `RewindPicker`：拿到 `cols` 后每行必须只占一视觉行 ⇒ 12 条一页的帧高
 *     恒定（28 行 → 16 行，之前顶穿 24 行终端，Enter/Esc 提示被挤出屏幕）。
 *
 * 没 `cols` 时必须与改前逐字节相同（组件不参与裁剪）。
 *
 * 跑法同 permissionsPromptHangingIndent：帧部分需 NODE_OPTIONS=--experimental-vm-modules
 * （由 scripts/run-ink-tui-tests.js 带上）。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const path = require('path');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const { displayWidth } = require('../../src/cli/formatters');
const { clipCell } = require('../../src/cli/tui/wrapCell');
const rewindControl = require('../../src/cli/tui/rewindControl');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

const ESC = String.fromCharCode(27);
const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(new RegExp(ESC + '\\][^' + ESC + ']*' + ESC + '\\\\', 'g'), '')
    .replace(new RegExp(ESC + '[=>78HM]', 'g'), '');

const ROCKET = String.fromCodePoint(0x1f680);
const CN80 = '把回溯选择器的预览限制成终端宽度内的一行然后验证中文不再溢出'
  + '，这条消息正好八十个汉字上下，用来量单位口径';

function pressableStdin() {
  const stream = new EventEmitter();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => null;
  return stream;
}

function frameStdout(columns, rows) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = rows || 40;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function targetsOf(contents) {
  return rewindControl.listUserTargets(contents.map((c) => ({ role: 'user', content: c })));
}

/**
 * 挂真组件，返回框内各行（去掉行尾留白、不含下边框那一行）。
 * `cols`/`rows` 传 undefined 即改前形态：组件拿不到终端尺寸。
 */
async function mount(targets, cols, termRows) {
  const ink = await rt.loadInk();
  const Comp = require(path.join('..', '..', 'src', 'cli', 'tui', 'ink-components', 'RewindPicker.js'));
  const stdout = frameStdout(cols || 80, termRows);
  const instance = ink.render(
    React.createElement(Comp, { targets, onResolve: () => {}, cols, rows: termRows }),
    { stdin: pressableStdin(), stdout, exitOnCtrlC: false, patchConsole: false }
  );
  let buf = '';
  for (let i = 0; i < 160; i += 1) {
    buf = stripAnsi(stdout.getBuffer());
    if (buf.includes('╭') && buf.indexOf('╰', buf.lastIndexOf('╭')) !== -1) break;
    await wait(25);
  }
  const from = buf.lastIndexOf('╭');
  const to = buf.indexOf('╰', from);
  const rows = (from === -1 || to === -1 ? buf : buf.slice(from, to))
    .split('\n')
    .map((r) => r.replace(/\s+$/, ''));
  // slice 停在 ╰ 之前，末尾必然带一个换行 → split 多出一个空元素。只剔这最后一个：
  // 中间的纯空白行是真实渲染产物（BUG-48 那类守卫靠它计数），不能一律滤掉。
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  if (typeof instance.unmount === 'function') instance.unmount();
  return rows;
}

function loneSurrogates(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const nx = s.charCodeAt(i + 1);
      if (!(nx >= 0xdc00 && nx <= 0xdfff)) n += 1;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 1;
  }
  return n;
}

describe('clipCell · 一视觉行的显示列裁剪', () => {
  test('不超时逐字节原样返回（含省略号都不加）', () => {
    expect(clipCell('fix typo', 80)).toBe('fix typo');
    expect(clipCell('中文', 4)).toBe('中文');
  });
  test('按显示列计，中文一字两列 ⇒ 80 列预算只放得下 39 个汉字加省略号', () => {
    const s = clipCell('中'.repeat(60), 80);
    expect(s.endsWith('…')).toBe(true);
    expect(displayWidth(s)).toBeLessThanOrEqual(80);
    expect(displayWidth(s)).toBeGreaterThanOrEqual(78);
  });
  test('截断点落在代理对里时，绝不留下半个字符', () => {
    const src = '中'.repeat(78) + ROCKET + '后面的中文内容';
    for (let w = 70; w <= 90; w += 1) {
      const s = clipCell(src, w);
      expect(loneSurrogates(s)).toBe(0);
      expect(displayWidth(s)).toBeLessThanOrEqual(w);
    }
  });
  test('SGR 序列整条消费（零宽）：不占预算，也不把宽度算错', () => {
    const whole = `a${ESC}[32m中${ESC}[0mb`;
    expect(clipCell(whole, 4)).toBe(whole); // 总宽 1+2+1=4，未超预算 ⇒ 原样
    const s = clipCell(whole, 3);
    expect(stripAnsi(s)).toBe('a…');
    expect(displayWidth(stripAnsi(s))).toBeLessThanOrEqual(3);
  });
  test('换行折成空格（预览只允许一视觉行）', () => {
    expect(clipCell('a\nb', 80)).toBe('a b');
  });
  test('宽度非法 / 太窄时不抛错、不吐半字符', () => {
    expect(clipCell('中文', 0)).toBe('');
    expect(clipCell('中文', NaN)).toBe('');
    expect(clipCell('中文', 1)).toBe('');
    expect(clipCell(null, 10)).toBe('');
  });
});

describe('listUserTargets · 预览单位是显示列(BUG-54)', () => {
  test('中文长消息：预览不超过 80 显示列（改前是 104 列）', () => {
    const [t] = targetsOf([CN80]);
    expect(displayWidth(t.preview)).toBeLessThanOrEqual(80);
    expect(t.preview.endsWith('…')).toBe(true);
    expect(t.content).toBe(CN80); // 全文仍在 content 里，截的是预览不是数据
  });
  test('代理对正好落在截断点上：不留孤立代理（改前实测 1 个）', () => {
    const [t] = targetsOf(['中'.repeat(78) + ROCKET + '后面的中文内容']);
    expect(loneSurrogates(t.preview)).toBe(0);
  });
  test('第二参从「字符数」变成「显示列」，短消息一律不截', () => {
    const [t] = targetsOf(['短消息']);
    expect(t.preview).toBe('短消息');
    const [n] = rewindControl.listUserTargets([{ role: 'user', content: CN80 }], 40);
    expect(displayWidth(n.preview)).toBeLessThanOrEqual(40);
  });
  test('纯 ASCII 与改前逐字节一致（守卫不改变未超预算的行）', () => {
    const [t] = targetsOf(['line one\n  line  two   with    spaces ' + 'x'.repeat(200)]);
    expect(t.preview.length).toBeLessThanOrEqual(80);
    expect(t.preview.endsWith('…')).toBe(true);
  });
});

describeOrSkip('RewindPicker · 真实帧里的行宽与帧高(BUG-54)', () => {
  test('传 cols：每行都不超过终端宽，帧高恒定', async () => {
    const targets = targetsOf(
      Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 条：` + CN80)
    );
    const rows = await mount(targets, 80);
    for (const r of rows) {
      expect(displayWidth(r)).toBeLessThanOrEqual(80);
      expect(loneSurrogates(r)).toBe(0);
    }
    // 整框 = 上下边框 + 标题 + 12 条 + 页脚 = 16 行；改前同一批消息实测 28 行，
    // 在 24 行终端上直接把 Enter/Esc 提示顶出屏幕（AJ/repro-b55-before-on-head.txt T6）
    expect(rows.length + 1).toBeLessThanOrEqual(16);
  });

  test('不传 cols：与改前形态一致（预览原样上屏，由 ink 自行折行）', async () => {
    const targets = targetsOf([CN80]);
    const clipped = await mount(targets, 80);
    const raw = await mount(targets, undefined);
    expect(raw.length).toBeGreaterThan(clipped.length);
    expect(raw.join('\n')).toContain(CN80.slice(0, 20));
  });
});

describeOrSkip('RewindPicker · 帧高随终端行数收敛(BUG-55)', () => {
  const TWELVE = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 条：` + CN80);
  // mount 返回的行切片不含下边框那一行，所以整框高度要 +1。
  const frameHeight = (rows) => rows.length + 1;

  test('rows 未知时不改形态：仍是 12 条一页、整框 16 行', async () => {
    const rows = await mount(targetsOf(TWELVE), 80, undefined);
    expect(frameHeight(rows)).toBe(16);
  });

  test('80×12 矮终端：整框不超过屏幕，Esc 提示就在最后一行', async () => {
    const rows = await mount(targetsOf(TWELVE), 80, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
    // 收缩后必须告诉用户还有更多：分页从 12 降到屏幕装得下的条数
    expect(rows.join('\n')).toContain('更多');
  });

  test('40×12 又窄又矮：标题/页脚各折两行也仍在屏内，且没有一行超出 40 列', async () => {
    const rows = await mount(targetsOf(TWELVE), 40, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(40);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
  });

  test('24 行正常终端不因本修复缩水：仍排满 12 条', async () => {
    const rows = await mount(targetsOf(TWELVE), 80, 24);
    const items = rows.filter((r) => /第 \d+ 条/.test(r));
    expect(items.length).toBe(12);
  });
});
