'use strict';

/**
 * promptFrameBilling.test.js — 输入框「账本行数 == 实际画出行数」守卫(BUG-59)。
 *
 * `App.js` 的 `_viewportHeight` 账本此前写着 `const promptH = 3`，注释自带前提
 * 「单行输入时」。这个前提在本 TUI 几乎从不成立：
 *   · 空态占位文案按 BUG-12 裁决**整条折行、永不截断** —— 60/40/30/20 列实测 4/5/6/9 行；
 *   · 多行输入（Ctrl+J / 粘贴）每行各占一行 —— 80 列四行就是 6 行。
 * 更要命的是改前 `layoutPromptRows` **不把占位符折行**：整串塞进一行交给 ink 硬折，
 * 于是 `lineRowCount`（防溢出的那条「逻辑行 == 视觉行」不变量）漏算它，
 * 首行也没给内联 MIC 留 5 列（实测 30 列下 " MIC " 被 flex 挤成 " MI"）。
 * 账本恒扣 3 ⇒ 主内容槽多报 1~6 行 ⇒ ? 浮层 / 补全菜单 / 转录视口的顶边框先掉出屏幕。
 *
 * 处方是把两处收进同一个真源：占位符进自己的行模型、`firstAvail` 计入 MIC 与
 * 反白光标格、导出 `frameRowCount()` 供账本调用。本文件因此不测「看起来变矮了」，
 * 而是钉**账本 == paint**（逐列）、**不超宽**、**不超屏**三件事；宽终端 80 列
 * 那格还要求逐字节等于改前形态（负对照）。
 *
 * 帧部分需 NODE_OPTIONS=--experimental-vm-modules，由 scripts/run-ink-tui-tests.js 带上。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const path = require('path');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const { displayWidth } = require('../../src/cli/formatters');
const PromptFrame = require('../../src/cli/tui/ink-components/PromptFrame');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

const ESC = String.fromCharCode(27);
const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(new RegExp(ESC + '\\][^' + ESC + ']*' + ESC + '\\\\', 'g'), '')
    .replace(new RegExp(ESC + '[=>78HM]', 'g'), '');

function quietStdin() {
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
  stream.rows = rows || 24;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 App.js:5467 同一条空态占位（BUG-12：整条折行不截断）。 */
const PLACEHOLDER = '输入消息，/ 命令，@ 文件，! shell，# 记忆，? 快捷键，Alt+M 语音';
const TYPED = '第一行内容\n第二行内容\n第三行内容\n第四行内容';
// App 在 Windows 上默认挂载语音输入 ⇒ MIC 内联占 5 列（BUG-59 的一半成因）。
const MIC = { active: false, onClick: () => {} };

/**
 * 挂真组件渲染真帧，返回框内行（含上下边框）。
 * @param props PromptFrame 的入参
 * @param tty   伪终端尺寸；`props.width/rows` 刻意由调用方另给，方便做不一致负对照
 */
async function mountFrame(props, tty) {
  const ink = await rt.loadInk();
  const stdout = frameStdout(tty.cols, tty.rows);
  const instance = ink.render(React.createElement(PromptFrame, props), {
    stdin: quietStdin(),
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  let rows = [];
  try {
    let polled = '';
    for (let i = 0; i < 160; i += 1) {
      polled = stripAnsi(stdout.getBuffer());
      if (polled.includes('╭') && polled.lastIndexOf('╰') > polled.indexOf('╭')) break;
      await wait(25);
    }
    const from = polled.indexOf('╭');
    const lines = (from === -1 ? polled : polled.slice(from))
      .split('\n')
      .map((r) => r.replace(/\s+$/, ''));
    // 收在底边框那一**整行**：ink 的末行不带换行，按 ╰ 的位置切会把边框切成 1 列。
    const close = lines.findIndex((r) => r.startsWith('╰'));
    rows = close >= 0 ? lines.slice(0, close + 1) : lines;
  } finally {
    if (typeof instance.unmount === 'function') instance.unmount();
  }
  return rows;
}

const propsFor = (cols, rows, over = {}) => ({
  value: '',
  offset: 0,
  placeholder: PLACEHOLDER,
  width: cols,
  rows,
  mic: MIC,
  ...over,
});

// 账本真源：与 App.js 传给 PromptFrame 的入参同形。
const billed = (cols, termRows, over = {}) =>
  PromptFrame.frameRowCount({
    value: over.value || '',
    offset: over.offset || 0,
    cols,
    placeholder: over.placeholder === undefined ? PLACEHOLDER : over.placeholder,
    rows: termRows,
    mic: over.mic === undefined ? MIC : over.mic,
  });

const widest = (rows) => rows.reduce((m, r) => Math.max(m, displayWidth(r)), 0);

describeOrSkip('BUG-59 输入框账本与 paint 同源', () => {
  test('80 列空态：帧与改前逐字节一致（负对照，账本 = 3）', async () => {
    const legacy = [
      '╭' + '─'.repeat(78) + '╮',
      '>  MIC  输入消息，/ 命令，@ 文件，! shell，# 记忆，? 快捷键，Alt+M 语音',
      '╰' + '─'.repeat(78) + '╯',
    ];
    const rows = await mountFrame(propsFor(80, 24), { cols: 80, rows: 24 });
    expect(rows).toEqual(legacy);
    expect(billed(80, 24)).toBe(rows.length);
  });

  test('20/30/40/60 列空态：账本行数 == 画出行数，且没有一行超过终端宽', async () => {
    const cases = [];
    for (const cols of [60, 40, 30, 20]) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await mountFrame(propsFor(cols, 24), { cols, rows: 24 });
      cases.push({ cols, painted: rows.length, billed: billed(cols, 24), wide: widest(rows), rows });
    }
    for (const c of cases) {
      // 改前恒扣 3 行 ⇒ 每格都亏空；现在必须一格不差。
      expect(c.billed).toBe(c.painted);
      expect(c.painted).toBeGreaterThan(3);
      expect(c.wide).toBeLessThanOrEqual(c.cols);
    }
    // 「MIC 被挤成 MI」是改前首行超宽的直接后果
    for (const c of cases) {
      expect(c.rows.some((r) => r.includes('MIC'))).toBe(true);
      expect(c.rows.some((r) => /[^M]MI[^C]/.test(r))).toBe(false);
    }
  });

  test('四行已输入（80 列）：账本 == 画出 6 行，改前少扣 3 行', async () => {
    const props = propsFor(80, 24, { value: TYPED, offset: TYPED.length });
    const rows = await mountFrame(props, { cols: 80, rows: 24 });
    expect(rows.length).toBe(6);
    expect(billed(80, 24, { value: TYPED, offset: TYPED.length })).toBe(rows.length);
  });

  test('无 MIC / 无占位时按无内联格计（帧仍与账本相等）', async () => {
    const props = propsFor(40, 24, { value: '短', offset: 1, mic: null, placeholder: '' });
    const rows = await mountFrame(props, { cols: 40, rows: 24 });
    expect(rows.length).toBe(3);
    expect(billed(40, 24, { value: '短', offset: 1, mic: null, placeholder: '' })).toBe(rows.length);
  });

  test('矮屏（8 行）自带上限：框不得吃掉整屏，折叠提示行不超宽', () => {
    const n = billed(20, 8);
    expect(n).toBeLessThanOrEqual(8);
    // 折叠提示此前固定 21+ 显示列，20 列屏上必被 ink 再折一行
    expect(displayWidth(PromptFrame.ellipsisLabel('above', 12, 20))).toBeLessThanOrEqual(18);
    expect(PromptFrame.ellipsisLabel('above', 12, 80)).toBe(
      '  ⋯ 上方还有 12 行（输入已折叠，内容未丢失）'
    );
  });

  test('布局真源：首行预算扣除 MIC 5 列 + 反白光标格 1 列', () => {
    const withMic = PromptFrame.layoutPromptRows({
      cols: 40,
      placeholder: PLACEHOLDER,
      micCols: PromptFrame.MIC_COLS,
    });
    const noMic = PromptFrame.layoutPromptRows({ cols: 40, placeholder: PLACEHOLDER });
    expect(withMic.avail).toBe(36);
    // 首行文本列 = 40 - marker(2) - MIC(5) - 光标格(1) - 余量(2) = 30
    expect(displayWidth(withMic.rows[0].text)).toBeLessThanOrEqual(30);
    expect(noMic.rows.length).toBeLessThan(withMic.rows.length);
    for (const r of withMic.rows) expect(r.isPlaceholder).toBe(true);
    expect(withMic.rows.slice(1).every((r) => r.isFirstOfValue === false)).toBe(true);
  });
});
