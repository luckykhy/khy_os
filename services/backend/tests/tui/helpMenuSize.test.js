'use strict';

/**
 * helpMenuSize.test.js — `?` 帮助浮层的「帧高随内容槽收敛」守卫(BUG-58)。
 *
 * 同族于 BUG-54/55/56/57，但载体不同：`HelpMenu` 不是覆盖层，它**替换**主内容槽
 * (App.js 三元链里 Viewport 的位置)，槽高 = `_viewportHeight`（实测 80×24 下 = 18）。
 * 改前它一个尺寸参数都不接，每条 item 行 = `键列 + 一整句中文说明`，**行宽无上限**：
 * 说明列最宽 43 显示列，40 列终端上长项折成 2 视觉行 ⇒ 同一框 80 列 18 行、
 * 40 列 20 行、30 列 24 行、20 列 40 行(AM/repro-before-dump.txt)，而槽预算不随
 * 宽度缩小 —— 超出的行被 ink 整屏重画推走。
 *
 * 处方（两处都必须让用户看得出少了什么）：
 *   列：描述按显示列截到一视觉行（`clipCell` + `pickerRowBudget`，太窄则不裁）
 *   行：槽高不够就整条隐藏，并留一行 `… 另有 N 条 · /keybindings` 指针
 * 帧高一律用 `visualRows` 投影后再决定 `shown`，不假设「一条 = 一行」。
 *
 * 本文件钉四件事：正常终端**逐字节不变**（含不传 props 的负对照）、帧高与宽度无关、
 * 短槽里帧不超槽、「另有 N 条」的 N 与实际隐藏条数**相等**（指针撒谎比没有更糟）。
 *
 * 帧部分需 NODE_OPTIONS=--experimental-vm-modules，由 scripts/run-ink-tui-tests.js 带上。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const path = require('path');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const { displayWidth } = require('../../src/cli/formatters');
const { keybindingCatalog } = require('../../src/services/keybindings');

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

function sliceFrame(buf) {
  const from = buf.lastIndexOf('╭');
  const to = buf.indexOf('╰', from);
  const out = (from === -1 || to === -1 ? buf : buf.slice(from, to))
    .split('\n')
    .map((r) => r.replace(/\s+$/, ''));
  // slice 停在 ╰ 之前 → 末尾多一个空元素，只剔这一个（中间的纯空白行是真实产物）。
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** 挂真组件渲染真帧。props = undefined 时按「无尺寸参数」挂载（= 改前形态）。 */
async function mount(props, tty = {}) {
  const ink = await rt.loadInk();
  const Comp = require(path.join(
    '..', '..', 'src', 'cli', 'tui', 'ink-components', 'HelpMenu.js'
  ));
  const stdout = frameStdout(tty.cols || 80, tty.rows || 24);
  const instance = ink.render(React.createElement(Comp, props || {}), {
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
      if (polled.includes('╭') && polled.indexOf('╰', polled.lastIndexOf('╭')) !== -1) break;
      await wait(25);
    }
    rows = sliceFrame(polled);
  } finally {
    if (typeof instance.unmount === 'function') instance.unmount();
  }
  return rows;
}

// mount 的行切片不含下边框 ⇒ 整框高度 = rows.length + 1
const frameHeight = (rows) => rows.length + 1;
const widest = (rows) => rows.reduce((m, r) => Math.max(m, displayWidth(r)), 0);
const flattened = (rows) => rows.join('').replace(/[\s│╭╰─]+/g, '');

// 键位单一真源：与组件同一份 catalog，改键位不需要动本文件。
const KEYS = keybindingCatalog.getEssentialShortcuts().map(([k]) => k.replace(/\s*\+\s*/g, '+'));
const bare = (row) => row.replace(/^[│╭╰]\s?/, '');
// 一条 item 行 = 以某个键位标签开头。标题/边框/「另有 N 条」行都不匹配。
const visibleKeys = (rows) => rows.map(bare).filter((t) => KEYS.some((k) => t.startsWith(k)));
const hiddenCountInHint = (rows) => {
  const m = rows.join('\n').match(/另有 (\d+) 条/);
  return m ? Number(m[1]) : null;
};

describeOrSkip('HelpMenu · 帧高随内容槽收敛(BUG-58)', () => {
  it('80×24：传 props 与不传 props 逐字节相同 —— 正常终端零改动', async () => {
    const legacy = await mount(undefined, { cols: 80, rows: 24 });
    const sized = await mount({ cols: 80, rows: 24 }, { cols: 80, rows: 24 });
    expect(sized).toEqual(legacy);
    expect(frameHeight(sized)).toBe(18);
    expect(visibleKeys(sized)).toHaveLength(KEYS.length);
    expect(hiddenCountInHint(sized)).toBeNull();
    // 描述没有被截断：最长那条（Ctrl+O）仍在。
    expect(flattened(sized)).toContain('打开会话记录视图(滚动回看/展开)');
  }, 20000);

  it('帧高与宽度无关：80/60/40/30 列同为 18 行，每条 item 占一视觉行', async () => {
    const h = [];
    for (const cols of [80, 60, 40, 30]) {
      const rows = await mount({ cols, rows: 24 }, { cols, rows: 24 });
      h.push(frameHeight(rows));
      expect(widest(rows)).toBeLessThanOrEqual(cols);
      expect(visibleKeys(rows)).toHaveLength(KEYS.length);
    }
    // 改前：18 / 18 / 20 / 24 —— 宽度越窄框越高(AM/repro-before.txt)。
    expect(new Set(h).size).toBe(1);
  }, 30000);

  it('短槽（40×14）：不超槽高，隐藏条数与「另有 N 条」相等', async () => {
    const rows = await mount({ cols: 40, rows: 14 }, { cols: 40, rows: 14 });
    expect(frameHeight(rows)).toBeLessThanOrEqual(14);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    const n = visibleKeys(rows).length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThan(KEYS.length);
    expect(hiddenCountInHint(rows)).toBe(KEYS.length - n);
    expect(flattened(rows)).toContain('/keybindings');
  }, 20000);

  it('更短（40×10）：仍然收敛，且第一条键位与指针都在可见区', async () => {
    const rows = await mount({ cols: 40, rows: 10 }, { cols: 40, rows: 10 });
    expect(frameHeight(rows)).toBeLessThanOrEqual(10);
    expect(rows.slice(0, 9).some((r) => bare(r).startsWith('Enter'))).toBe(true);
    expect(rows.slice(0, 9).join('\n')).toContain('/keybindings');
    expect(hiddenCountInHint(rows)).toBe(KEYS.length - visibleKeys(rows).length);
  }, 20000);

  it('窄到 20 列：宁可不裁描述（预算 <8 列）也绝不把 /keybindings 截成半截', async () => {
    const rows = await mount({ cols: 20, rows: 10 }, { cols: 20, rows: 10 });
    expect(frameHeight(rows)).toBeLessThanOrEqual(10);
    expect(widest(rows)).toBeLessThanOrEqual(20);
    // 「/keybindings」必须完整出现在某一帧行里：整词不跨行断裂。
    expect(rows.some((r) => r.includes('/keybindings'))).toBe(true);
  }, 20000);

  it('只给宽度不给高度（ChatColumn 并列挂载点）：不收缩行数', async () => {
    const rows = await mount({ cols: 40 }, { cols: 40, rows: 24 });
    expect(frameHeight(rows)).toBe(18);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(visibleKeys(rows)).toHaveLength(KEYS.length);
    expect(hiddenCountInHint(rows)).toBeNull();
  }, 20000);
});
