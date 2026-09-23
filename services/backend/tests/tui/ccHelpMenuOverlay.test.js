'use strict';

/**
 * ccHelpMenuOverlay.test.js —— CC 表面 `?` 浮层（CcHelpMenu）的「画得下 + 说得真」守卫(BUG-40)。
 *
 * 缺陷本体(全部实测自真实挂载帧，见 .khy/feedback/tui-ux-audit-20260919/AC/)：
 *   D1 标签栏四条标签黏成 `HelpGeneralCommandsCustom commands`——marginRight 挂在
 *      `Text` 上不生效(ink 的 Text 是行内节点)，只有 `Box` 吃 margin。
 *   D2/D3 General 页是「固定 `Box width:20` + 不限长 `Text` 描述」，两列最长描述
 *      28 列时总宽 81 > 内宽 76，yoga 逐行 shrink ⇒ 键列忽 20 忽 18、描述被**无省略号**
 *      裁掉(`Copy last reply to clipboar`)、被裁字符另起一行空行。
 *   D4 告知与能力不符：CC 表面(CcApp/CcPromptInput)根本不处理 `Tab Complete`、
 *      `Shift+Tab Cycle mode`、`↑/↓ History nav`(↑/↓ 实测只逐字符移动光标)，footer 还写
 *      `Enter select`(本浮层 useInput 无 Enter 分支)；同时漏报真存在的 Ctrl+P/E/V。
 *
 * 这里挂**真实 ink + 线上同一组件**，按 ink 的 stdin 契约喂真字节切标签，锁四件事：
 *   1) 帧内每一行的显示宽度 ≤ 浮层宽度(溢出是所有裁切/错列的根因，钉这一条最省)；
 *   2) 标签栏四条标签之间有可见间隙；
 *   3) 两列网格各行的列起点在**所有行上同一列**，且无 `...`、无中途空行；
 *   4) 谎报的键位不得再出现，真处理的键位不得再漏。
 *
 * 跑法同 permissionsPromptDigitFooter：需 --experimental-vm-modules
 * (npm run --workspace backend test:tui)。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[ccHelpMenuOverlay] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const ESC = String.fromCharCode(27);
const OVERLAY_WIDTH = 80; // = ccLayout.helpMenuWidth 的上限(min(80, cols*0.8))，线上真实宽度
const RIGHT_ARROW = `${ESC}[C`;

const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(/[\u2502\u2500\u250c\u2510\u2514\u2518]/g, '');

/** 帧内每一行的显示宽度（CJK 记 2 列）——用渲染层同一套度量。 */
function widthsOf(lines) {
  const { displayWidth } = require('../../src/cli/formatters');
  return lines.map((l) => displayWidth(l));
}

function pressableStdin() {
  const stream = new EventEmitter();
  let queue = '';
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => {
    if (!queue) return null;
    const out = queue;
    queue = '';
    return out;
  };
  stream.press = (bytes) => {
    queue += bytes;
    stream.emit('readable');
  };
  return stream;
}

function collectingStdout(rows = 30, columns = 100) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

/**
 * 取「最后一整个盒子」——从最后一个 ╭ 到其后的第一个 ╰。
 * ink 对 stdin 桩写的是增量帧，桩又不认光标寻址，所以 buffer 里会叠着历史帧；
 * 换标签时内容整块变化，ink 会全量重绘一整个框，最后那一块即当前画面。
 */
function lastBoxLines(buffer) {
  const start = buffer.lastIndexOf('╭');
  if (start === -1) throw new Error('帧里找不到盒框，挂载可能为空');
  const end = buffer.indexOf('╰', start);
  if (end === -1) throw new Error('盒未闭合（最后一帧不完整）');
  return buffer.slice(start, end).split('\n').map((l) => l.replace(/^.*╭/, '').replace(/╮.*$/, ''));
}

async function openAtTab(tab) {
  const { lines } = await openSized({ tab });
  return { lines };
}

/**
 * 挂载并切到第 tab 个页签，终端尺寸可控。
 * `rows` 同时喂给组件(props)与 ink 的 stdout(全屏判据)——两者必须同尺，
 * 否则「组件按 24 行预算画、ink 按 12 行判全屏」会得到一个既测不到病灶
 * 也测不到修复的假绿帧(BUG-74 的复现正是在这里)。
 */
async function openSized({ tab = 0, rows = 30, cols = 80 } = {}) {
  const stdin = pressableStdin();
  const stdout = collectingStdout(rows, cols);
  const { CcHelpMenu } = require('../../src/cli/tui/ink-components/CcHelpMenu');
  const app = rt.get().render(
    React.createElement(CcHelpMenu, {
      version: '9.9.9', onClose: () => {}, width: Math.min(cols, 80), rows,
    }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false }
  );
  await new Promise((r) => setTimeout(r, 120));
  for (let i = 0; i < tab; i += 1) {
    stdin.press(RIGHT_ARROW);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 120));
  }
  const raw = stdout.getBuffer();
  const lines = lastBoxLines(raw).map((l) => stripAnsi(l));
  app.unmount();
  return { lines, raw, height: lines.length };
}

/** ink 的全屏分支(残影之源)：一帧里出现一次 \x1b[2J 就算失败。 */
const clearCount = (raw) => raw.split('\x1b[2J').length - 1;

/** 网格区行：General 页里以 2+ 空格分列、且首列像键位的那几行。 */
function gridRows(lines) {
  return lines.filter((l) => /(Ctrl\+|↑\/↓|^\s*\?\s)/.test(l) && /\S {2,}\S/.test(l));
}

/** 一行内各**词组**（键位 / 描述）起始所在的显示列。
 *  用显示宽度而非字符下标：`↑/↓` 这类行内字符数≠列数，按下标比会把对齐良好的行
 *  误判成错列（BUG-11 同一条教训）。空格段长度随文字变化，所以量的是词组起点，
 *  不是空白起点——后者在错列时反而可能一致。 */
function tokenColumns(line) {
  const { displayWidth } = require('../../src/cli/formatters');
  return [...line.matchAll(/\S+(?: \S+)*/g)].map((m) => displayWidth(line.slice(0, m.index)));
}

describeOrSkip('CcHelpMenu 浮层渲染与告知一致(BUG-40)', () => {
  let ink;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
    expect(typeof ink.render).toBe('function');
  });

  test('钉死前提：组件确实用线上同一份 ink 画出非空帧', async () => {
    const { lines } = await openAtTab(0);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join('\n')).toContain('Welcome to Khy');
  });

  test('每一行的显示宽度都不超过浮层宽度(溢出=裁切与错列的根因)', async () => {
    for (const tab of [0, 1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const { lines } = await openAtTab(tab);
      const bad = lines
        .map((l, i) => ({ i, w: widthsOf([l])[0], l }))
        .filter((r) => r.w > OVERLAY_WIDTH);
      expect(bad).toEqual([]);
    }
  });

  test('D1 标签栏四条标签之间有间隙（不再黏成一坨）', async () => {
    const { lines } = await openAtTab(0);
    const bar = lines.find((l) => l.includes('Custom commands'));
    expect(bar).toBeTruthy();
    expect(bar).toMatch(/Help {2,}General {2,}Commands {2,}Custom commands/);
  });

  test('D2/D3 两列网格：列起点逐行一致、无省略号截断、中途无空行', async () => {
    const { lines } = await openAtTab(1);
    const rows = gridRows(lines);
    expect(rows.length).toBe(6); // 12 条快捷键 / 两列，多一行空行即打破

    // 四列（左键 / 左述 / 右键 / 右述）的起始显示列必须逐行一致。
    const cols = rows.map((r) => tokenColumns(r));
    for (const c of cols) expect(c.length).toBeGreaterThanOrEqual(3);
    for (const col of [0, 1, 2]) {
      const seen = new Set(cols.map((c) => c[col]));
      expect(seen.size).toBe(1);
    }

    const box = lines.join('\n');
    expect(box).not.toMatch(/\.\.\./); // 静默裁切的痕迹
    expect(box).toContain('Toggle agent tree');
    expect(box).toContain('Copy last reply');
    // 网格中途不得出现整行空白（缺陷态被裁字符会顶出一行空行）
    const mid = lines.slice(lines.indexOf(rows[0]), lines.indexOf(rows[rows.length - 1]) + 1);
    expect(mid.every((l) => l.trim().length > 0)).toBe(true);
  });

  test('D4 谎报的键位不得再出现，真处理的键位不得再漏', async () => {
    const { lines } = await openAtTab(1);
    const box = lines.join('\n');
    // CC 表面无处理：Tab 补全 / Shift+Tab 换模式 / ↑↓ 历史导航 / 浮层内 Enter 选择
    expect(box).not.toContain('Cycle mode');
    expect(box).not.toContain('History nav');
    expect(box).not.toContain('Enter select');
    // CcApp.js:550/580/586 确实处理，浮层必须告知
    expect(box).toContain('Ctrl+P');
    expect(box).toContain('Ctrl+E');
    expect(box).toContain('Ctrl+V');
  });

  test('告知与「浮层自己的按键」一致：footer 只说真存在的操作', async () => {
    const { lines } = await openAtTab(0);
    const footer = lines.find((l) => l.includes('Esc close'));
    expect(footer).toBeTruthy();
    expect(footer).toContain('Tab'); // 本组件 useInput 有 key.tab 分支(换标签)
    expect(footer).not.toMatch(/Enter/);
  });
});

/**
 * BUG-74：浮层把「页签里有几条」当高度，chrome 9 行 + General/Commands 各 6/12 条
 * → 一帧 15-21 行；在默认的 80×24 之外，任何 rows ≤ 帧高的终端里 ink 都走全屏分支
 * 写 \x1b[2J（win32 把旧帧滚进回滚缓冲 = 整屏残影，且顶框被滚出屏幕）。
 * 这里按「同一把尺子」挂四种终端高度 × 四个页签，锁三件事：
 *   1) 帧高 ≤ rows-1（ink 全屏判据是 >=，留 1 行余量）；
 *   2) 整段字节流里 \x1b[2J 计数为 0；
 *   3) 少画的行要有一行「… 另有 N 条」说清楚，而不是静默消失。
 */
describeOrSkip('CcHelpMenu 帧高收敛到终端行数(BUG-74)', () => {
  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
  });

  test.each([12, 16, 20, 24])('80×%i：四个页签都不触发全屏擦除', async (rows) => {
    const heights = {};
    for (const tab of [0, 1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      const { raw, height } = await openSized({ tab, rows });
      heights[`tab${tab}`] = height;
      expect(clearCount(raw)).toBe(0);
    }
    // 溢出时把四个页签各自的行数一起报出来，不必重跑才知道是哪一页超了。
    const overflow = Object.entries(heights).filter(([, h]) => h > rows - 1);
    expect(overflow).toEqual([]);
  });

  test('装不下时明说少看了什么，且提示行不额外撑高帧', async () => {
    const { lines, height } = await openSized({ tab: 2, rows: 12 });
    const box = lines.join('\n');
    expect(box).toMatch(/另有 \d+ 条/);
    expect(height).toBeLessThanOrEqual(11);
    // 提示里指的键位必须真存在（本浮层 useInput 有 left/right/tab 分支）
    expect(box).toMatch(/←\/→/);
  });

  test('放得下时不多嘴：宽终端下无「另有 N 条」', async () => {
    const { lines } = await openSized({ tab: 2, rows: 30 });
    expect(lines.join('\n')).not.toMatch(/另有 \d+ 条/);
  });
});

/**
 * BUG-88（由 AU/probe-ccapp-fuzz.cjs 的随机按键普查撞出）：BUG-74 收口后仍留两处
 * 「按条目数当高度」的余病 ——
 *   ① chrome 恒 9 行没有降级档，`rows ≤ 10` 时 `listRows()` 兜到地板 1 行，
 *      「账本 10 行」正好等于 rows → ink 走全屏分支（判据是 `>=`）；
 *   ② 「… 另有 N 条」这一行画在预算**之外**（实画 = 账本 + 1）。
 * 修法是把两件事都交给 ccOverlayLayout 的新叶子（chromePlan 让位梯 / listWithHint），
 * 因此守卫钉的就是「账本 = 画面」这条等式本身 —— 探针另抄算式测出来的绿是假的。
 */
describeOrSkip('CcHelpMenu 装饰让位与提示行入账(BUG-88)', () => {
  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
  });

  const OVERLAY_W = 80; // openSized 传的是 `Math.min(cols, 80)`，本块一律 cols=80
  /** 账本与 paint 同源：算账用的就是组件里那一份函数，不在测试里另抄算式。 */
  const help = () => require('../../src/cli/tui/ink-components/CcHelpMenu');
  const fit = () => require('../../src/cli/tui/ink-components/ccOverlayLayout');
  /** 叶子的账本：这一几何下这一页「chrome + 条目 + 提示」共几行。 */
  function ledgerOf(tab, rows) {
    const total = help().ccHelpTabRows[tab](OVERLAY_W).length;
    const plan = help().helpChromePlan(rows, total);
    const { shown, hint } = fit().listWithHint(plan.budget, total);
    return { plan, total, rows: plan.chrome + shown + (hint ? 1 : 0) };
  }

  test.each([6, 8, 10, 11, 14, 24])('%i 行 · 四个页签：帧高严格小于 rows 且不擦屏', async (rows) => {
    for (const tab of [0, 1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      const { raw, height } = await openSized({ tab, rows, cols: 80 });
      expect(height).toBeLessThanOrEqual(rows - 1);
      expect(clearCount(raw)).toBe(0);
    }
  });

  test.each([6, 9, 11, 13, 16, 24, 30])('%i 行 · 账本 = 画面：叶子给的行数与实画帧高相等', async (rows) => {
    for (const tab of [0, 1, 2, 3]) {
      const { plan, total, rows: ledger } = ledgerOf(tab, rows);
      // eslint-disable-next-line no-await-in-loop
      const { height } = await openSized({ tab, rows, cols: 80 });
      // 报错时要能看出是「账本变了」还是「画面变了」。
      expect({ rows, tab, total, chrome: plan.chrome, ledger, height })
        .toEqual({ rows, tab, total, chrome: plan.chrome, ledger, height: ledger });
    }
  });

  test('越砍越省：同一页签在更矮的终端上装饰只会更少，条目不会更多', async () => {
    let prevChrome = Infinity;
    let prevShown = Infinity;
    for (const rows of [24, 16, 12, 10, 8, 6]) {
      const { plan, total } = ledgerOf(1, rows);
      const { shown } = fit().listWithHint(plan.budget, total);
      expect(plan.chrome).toBeLessThanOrEqual(prevChrome);
      expect(shown).toBeLessThanOrEqual(prevShown);
      prevChrome = plan.chrome;
      prevShown = shown;
    }
  });

  test('地板：装饰砍光仍放不下时宁可少一行提示，也不越屏（实测 4 行为设计边界）', async () => {
    // rows=5 是**通过宿主的路径**量到的下限：真实 CcApp + 屏幕模型的同几何读数见
    // AU/repro-after-bug88.txt（chrome 3 + 内容 1 = 4 行、2J 0、差额 0）。
    // 本文件挂载的是组件自己（浮层是 early-return 的整棵树，宿主只是决定 cols/rows），
    // 故 4 行以下在这里同样是越屏的 —— 那是 BUG-88b 的结构地板，不是回归。
    const { height, lines } = await openSized({ tab: 1, rows: 5, cols: 80 });
    expect(height).toBe(4);
    expect(lines.join('\n')).not.toMatch(/另有 \d+ 条/);
    // 再矮一行就付不起了：边框 2 + 标签栏 1 + 内容 1 = 4 = rows → ink 走全屏分支。
    const { height: h4, raw: raw4 } = await openSized({ tab: 1, rows: 4, cols: 80 });
    expect(h4).toBe(4);
    expect(clearCount(raw4)).toBeGreaterThan(0);
  });
});
