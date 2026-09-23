'use strict';

/**
 * viewportIndicatorRowBudget — 回归:滚动指示器不得吃掉任何一行**内容**。
 *
 * 起因(真实现场,BUG-25):用户在 khy TUI 里拖选复制「第 11 行」——文本能进剪贴板,
 * 但屏幕上**永远看不见**这一行。复现探针(同一套 headless ink 渲染器)显示:模型里
 * 60 行、视口高 13 时,帧里只出现 12 行,而且缺的是切片**中间**那一行,不是最后一行。
 *
 * 根因不是切片,而是盒子装多了:`Viewport` 把 `height` 行内容 + 1 行指示器放进一个
 * `height` 高、`overflow:'hidden'` 的 Box ⇒ 子节点数 = `height + 1` ⇒ yoga 按
 * flexShrink 把总高摊回 `height`,**中间**那一行高度取整成 0。
 * 结果:内容行被静默丢弃,而行号→屏幕行的换算(选区、拖选复制)仍按模型下标走,
 * 于是「能复制却看不见」。
 *
 * 修复:渲染侧改为只切 `viewportContentRows()` 行(有指示器时为 `height - 1`),
 * 把那一行**显式**让给指示器。本测走真渲染器,断言「切片区间的每一行都在帧里」——
 * 这是唯一能守住 yoga 行为的层次(纯函数单测守的是换算,守不住谁被吃掉)。
 *
 * 需 NODE_OPTIONS=--experimental-vm-modules(经 `npm run --workspace backend test:tui`)。
 */

const { Writable } = require('stream');
const { EventEmitter } = require('events');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[viewportIndicatorRowBudget] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

function fakeStdout(columns = 80) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buffer += chunk.toString(); cb(); },
  });
  stream.columns = columns;
  stream.rows = 40;
  stream.isTTY = false;
  stream.getBuffer = () => buffer;
  return stream;
}

function fakeStdin() {
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

describeOrSkip('Viewport 指示器行预算(内容行被吃掉回归)', () => {
  let ink;
  let Viewport;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
    Viewport = require('../../src/cli/tui/ink-components/Viewport');
  });

  const LINES = Array.from({ length: 60 }, (_, i) => `R${String(i).padStart(2, '0')} 内容行`);

  async function frameFor(opts) {
    const stdout = fakeStdout(80);
    const instance = ink.render(
      React.createElement(Viewport, opts),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  // 渲染侧的切片区间必须与帧逐行对齐:区间内每一行都出现,区间外一行都不出现。
  async function assertSliceFaithful({ height, scroll }) {
    const vp = require('../../src/cli/tui/ink-components/Viewport');
    const contentRows = vp.viewportContentRows(height, LINES.length, true);
    const maxScroll = Math.max(0, LINES.length - contentRows);
    const start = Math.max(0, Math.min(scroll, maxScroll));
    const end = Math.min(LINES.length, start + contentRows);
    const frame = await frameFor({
      height,
      lines: LINES,
      scroll: start,
      showIndicator: true,
      autoScroll: false,
    });
    for (let i = start; i < end; i++) {
      expect(frame).toContain(`R${String(i).padStart(2, '0')}`);
    }
    // 帧里的内容行总数不得超过盒子高(含指示器)
    const drawn = LINES.filter((l) => frame.includes(l)).length;
    expect(drawn).toBeLessThanOrEqual(height);
    expect(drawn).toBe(end - start);
  }

  test('贴底:最后一行在帧内,且切片区间的每一行都没被 yoga 吃掉', () => {
    return assertSliceFaithful({ height: 13, scroll: 47 }).then(() => {});
  });

  test('视口中段:曾经被吃掉的那一行(切片下标 start+11)必须出现', async () => {
    // 旧实现在 height=13 / scroll=1 时,帧里缺 `R12`(切片中间行)。
    await assertSliceFaithful({ height: 13, scroll: 1 });
    const frame = await frameFor({
      height: 13,
      lines: LINES,
      scroll: 1,
      showIndicator: true,
      autoScroll: false,
    });
    expect(frame).toContain('R12 内容行');
  });

  test('视口顶部:offset=0 时前 contentRows 行全部可见', () => {
    return assertSliceFaithful({ height: 13, scroll: 0 }).then(() => {});
  });

  test('不同盒子高 × 不同偏移均无内容行丢失', async () => {
    for (const height of [5, 8, 13, 20]) {
      // eslint-disable-next-line no-await-in-loop
      await assertSliceFaithful({ height, scroll: 0 });
      // eslint-disable-next-line no-await-in-loop
      await assertSliceFaithful({ height, scroll: 30 });
    }
  });

  test('关指示器时盒子高全额给内容(最后一行可见)', async () => {
    const height = 13;
    const vp = require('../../src/cli/tui/ink-components/Viewport');
    const contentRows = vp.viewportContentRows(height, LINES.length, false);
    expect(contentRows).toBe(height);
    const start = LINES.length - contentRows;
    const frame = await frameFor({
      height,
      lines: LINES,
      scroll: start,
      showIndicator: false,
      autoScroll: false,
    });
    expect(frame).toContain('R59 内容行');
    expect(frame).not.toMatch(/↑|↓/);
  });
});
