'use strict';

/**
 * completionMenuSize.test.js — 补全下拉「账本行数 == 画出行数」守卫(BUG-60)。
 *
 * 与 BUG-59 同一处账本、同一族病：`App.js` 的 `_viewportHeight` 里写着
 * `completionH = Math.min(4, items + 1)`（注释「有补全时占 1-4 行」），
 * 而 `CompletionMenu` 的页大小是 `ITEMS_PER_PAGE = 10`，一帧最多画
 * 边框 2 + 10 条 + 页脚 1 = **13 行**。用户敲一个 `/` 就是 260 条候选，
 * 于是账本恒扣 4、画面恒画 13 ⇒ 主内容槽多报 **9 行**（`AO/repro-b59…/AO/repro-b60-before.txt`）。
 * 附带第二条：页脚整句 43 显示列，在 40 列槽里被 ink 折成 2 行 ⇒ 14 行，
 * 连「账本 = 13」都追不上（BUG-58 里「另有 N 条」那句就是这么把 14 撑成 15 的）。
 *
 * 处方与 BUG-58/59 一致：页脚走退档阶梯（整句 → 去种类前缀 → 只留 `Esc 取消` → 截断），
 * 行数由组件导出的 `menuRowCount()` 报给账本，**账本与 paint 同源**。
 * 80 列宽屏必须逐字节保持今日文案（负对照）。
 *
 * 高度是同一条账本的另一半：账本给框算出 `maxRows` 预算 → 组件据此定一页画几条；
 * 预算连最低一框（边框 2 + 1 条 + 页脚 1）都放不下时**整框让位**（0 行、不挂载），
 * 因为补全看不见还能重敲，而 13 行的框压过 `live < rows` 会让 ink 清掉整个转录。
 *
 * 帧部分需 NODE_OPTIONS=--experimental-vm-modules，由 scripts/run-ink-tui-tests.js 带上。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const path = require('path');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const { displayWidth } = require('../../src/cli/formatters');
const CompletionMenu = require('../../src/cli/tui/ink-components/CompletionMenu');

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

/** 与真实 slash 菜单同形：label 是命令名，desc 是一整句中文。 */
function mkCompletion(n, kind = 'slash') {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      value: `/cmd${i}`,
      label: `/cmd${i}`,
      desc: '配置 AI 服务商/端点(对齐 Claude Code gateway config 的常用通道)',
    });
  }
  return { active: true, kind, items, start: 0, end: 0 };
}

/**
 * 挂真组件渲染真帧。返回 {rows, billed}：rows = 框内所有行（含上下边框），
 * billed = 账本将扣的行数（组件导出的帧高真源）。
 */
async function mount(props, tty, expectFrame = true) {
  const ink = await rt.loadInk();
  const stdout = frameStdout(tty.cols, tty.rows);
  const instance = ink.render(React.createElement(CompletionMenu, props), {
    stdin: quietStdin(),
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  let rows = [];
  try {
    let polled = '';
    // 预期「整框让位」时不必等满 4 s：给几帧时间确认它确实什么都没画。
    const tries = expectFrame ? 160 : 8;
    for (let i = 0; i < tries; i += 1) {
      polled = stripAnsi(stdout.getBuffer());
      const ls = polled.split('\n');
      if (ls.some((r) => r.startsWith('╭')) && ls.some((r) => r.startsWith('╰'))) break;
      await wait(25);
    }
    const lines = polled.split('\n').map((r) => r.replace(/\s+$/, ''));
    const from = lines.findIndex((r) => r.startsWith('╭'));
    const to = lines.findIndex((r) => r.startsWith('╰'));
    rows = from === -1 || to < from ? lines : lines.slice(from, to + 1);
  } finally {
    if (typeof instance.unmount === 'function') instance.unmount();
  }
  const billed = CompletionMenu.menuRowCount(props);
  return { rows, billed, cols: tty.cols };
}

const widest = (rows) => rows.reduce((m, r) => Math.max(m, displayWidth(r)), 0);

describeOrSkip('BUG-60 补全下拉账本与 paint 同源', () => {
  test('80 列：页脚与帧形逐字节保持今日形态（负对照）', async () => {
    const completion = mkCompletion(26);
    const props = { completion, selectedIndex: 0, marginLeft: 0, page: 0, cols: 80 };
    const { rows, billed } = await mount(props, { cols: 80, rows: 24 });
    expect(rows[0]).toBe('╭' + '─'.repeat(78) + '╮');
    expect(rows[rows.length - 1]).toBe('╰' + '─'.repeat(78) + '╯');
    expect(rows[rows.length - 2]).toContain('斜杠命令 · 1/3 · Tab/Enter 选择 · Esc 取消');
    expect(displayWidth(rows[rows.length - 2])).toBe(80);
    // 边框 2 + 一页 10 条 + 页脚 1
    expect(rows.length).toBe(13);
    expect(billed).toBe(rows.length);
  });

  test('20/30/40/60/80 列：账本行数 == 画出行数，且无一行超过槽宽', async () => {
    const completion = mkCompletion(260);
    for (const cols of [80, 60, 40, 30, 20]) {
      const props = { completion, selectedIndex: 0, marginLeft: 0, page: 0, cols };
      // eslint-disable-next-line no-await-in-loop
      const { rows, billed } = await mount(props, { cols, rows: 24 });
      expect(billed).toBe(rows.length);
      expect(widest(rows)).toBeLessThanOrEqual(cols);
    }
  });

  test('窄槽里页脚退档但绝不丢「Esc 取消」，帧高不随宽度长高', async () => {
    const completion = mkCompletion(260);
    const heights = [];
    for (const cols of [80, 60, 40, 30, 20]) {
      const props = { completion, selectedIndex: 0, marginLeft: 0, page: 0, cols };
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await mount(props, { cols, rows: 24 });
      heights.push(rows.length);
      const footer = rows[rows.length - 2];
      // 退档顺序：先丢种类前缀，再丢选择键，页码只在 20 列（内宽 16）才让位给退出键。
      expect(footer).toContain('Esc 取消');
      if (cols >= 30) expect(footer).toContain('1/26');
      expect(displayWidth(footer)).toBeLessThanOrEqual(cols);
    }
    // 改前：40/30 列各多一行（页脚被折）、20 列 23 行（条目被折），帧高是宽度的函数
    expect(new Set(heights).size).toBe(1);
  });

  test('极窄槽里条目折栏消失而不是长高：20 列下 label 钳进内宽、desc 整栏让位', () => {
    const completion = mkCompletion(260);
    const g = CompletionMenu.menuGeom({ completion, page: 0, cols: 20, marginLeft: 0 });
    // 内宽 = 20 − 边框 2 − paddingX 2 = 16；marker(2) + label 必须装得下
    expect(g.inner).toBe(16);
    expect(g.labelWidth + 2).toBeLessThanOrEqual(g.inner);
    // 剩余不足 8 列 ⇒ 整栏不画（descMax === 0），绝不折出第二视觉行
    expect(g.descMax).toBe(0);
    expect(CompletionMenu.menuRowCount({ completion, page: 0, cols: 20 })).toBe(13);
    // 40 列还留得下一栏 desc
    expect(CompletionMenu.menuGeom({ completion, page: 0, cols: 40 }).descMax).toBeGreaterThan(0);
  });

  test('光标跟随（marginLeft>0）时按收窄后的内宽记账', () => {
    const completion = mkCompletion(260);
    const inner = (cols) =>
      CompletionMenu.footerLabel('slash', 0, 26, cols - 4 - 20);
    // margin 20 把 60 列压成 36 内宽 ⇒ 页脚退档，但仍是 1 视觉行
    expect(CompletionMenu.menuRowCount({ completion, page: 0, cols: 60, marginLeft: 20 })).toBe(13);
    expect(displayWidth(inner(60))).toBeLessThanOrEqual(36);
    // 极窄：退到只剩退出键，仍不许折行
    expect(displayWidth(CompletionMenu.footerLabel('slash', 0, 26, 10))).toBeLessThanOrEqual(10);
  });

  test('空/未激活一律 0 行；不足一页按实际条数计', () => {
    expect(CompletionMenu.menuRowCount({ completion: null })).toBe(0);
    expect(CompletionMenu.menuRowCount({ completion: { active: false, items: [] } })).toBe(0);
    expect(
      CompletionMenu.menuRowCount({ completion: { active: true, kind: 'file', items: [] } })
    ).toBe(0);
    const three = { active: true, kind: 'file', items: [{ value: 'a', label: 'a', desc: '文件' }] };
    expect(CompletionMenu.menuRowCount({ completion: three, cols: 80 })).toBe(4);
  });

  test('高度预算：一页条数按预算收缩；画不下一框就整框让位（账本 == 画出）', async () => {
    const completion = mkCompletion(260);
    // 预算 0 = 不受高度约束（今日形态）；13 → 一页 10 条；7 → 4 条；4 → 1 条；
    // < 4（边框 2 + 1 条 + 页脚 1 的最低框高）→ 画不下，组件不挂载、账本归零。
    for (const [maxRows, want] of [[0, 13], [13, 13], [7, 7], [4, 4], [3, 0], [1, 0]]) {
      const props = { completion, selectedIndex: 0, marginLeft: 0, page: 0, cols: 80, maxRows };
      // eslint-disable-next-line no-await-in-loop
      const { rows, billed } = await mount(props, { cols: 80, rows: 24 }, want > 0);
      expect(billed).toBe(want);
      const painted = rows.some((r) => r.startsWith('╭'));
      expect(painted).toBe(want > 0);
      if (want > 0) expect(rows.length).toBe(want);
    }
  });

  test('页大小真源 perPageFor：预算换页条数，翻页与 paint 同一个数', () => {
    expect(CompletionMenu.perPageFor(0)).toBe(10);
    expect(CompletionMenu.perPageFor(100)).toBe(10);
    expect(CompletionMenu.perPageFor(13)).toBe(10);
    expect(CompletionMenu.perPageFor(7)).toBe(4);
    expect(CompletionMenu.perPageFor(4)).toBe(1);
    // 预算低于最低框高：frameFits 关 → 账本与 paint 一起归零
    expect(CompletionMenu.frameFits(3)).toBe(false);
    expect(CompletionMenu.frameFits(4)).toBe(true);
    expect(CompletionMenu.frameFits(0)).toBe(true);
  });
});
