'use strict';

/**
 * BUG-62 — 按键处理器不得读到落后一次提交的 state。
 *
 * 现象（活体 40×24）：敲 `/` 打开补全菜单后**立刻**按 ↑，菜单被「历史回溯」顶掉，
 * 输入框里刚敲的 `/` 变成了一条历史消息。6 次里 3 次。
 *
 * 病因：ink 的 useInput 在 passive effect 里按 `[isActive, stdin, exitOnCtrlC,
 * inputHandler]` 重新订阅，React 把这次 flush 推到下一次渲染开始才做 —— 于是按键
 * 可能由**上一次提交**的闭包接走。修法是把订阅身份固定成转发器（_keyDispatch），
 * 真正的处理器每次渲染换进 ref（见 App.js 的 BUG-62 注释块）。
 *
 * 这条守卫钉的是屏幕上的确定性标记，与本机历史内容无关：
 *   `/` 之后页脚是「1/N」，↑ 从第一页**回绕**到最后一页 → 必须是「N/N」。
 * 闭包落后时 ↑ 走 history:previous，菜单直接消失（屏上再无「Esc 取消」），
 * 所以两种失败形态都会被同一断言抓住。
 *
 * 需要 --experimental-vm-modules（ink 是 ESM-only），故与 inkRenderSmoke 一样自跳过。
 */

const { Writable } = require('stream');
const { EventEmitter } = require('events');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[keyHandlerFreshClosure] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const COLS = 40;
const ROWS = 24;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeStdout() {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = COLS;
  stream.rows = ROWS;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

/** ink 的 StdinContext 在 'readable' 上 read()，故按键 = 入队 + 触发 readable。 */
function pressableStdin() {
  const stream = new EventEmitter();
  const queue = [];
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => (queue.length ? queue.shift() : null);
  stream.push = (s) => {
    queue.push(Buffer.from(String(s)));
    stream.emit('readable');
  };
  return stream;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');

/** 最后一帧页脚那一行的文本（ink 逐帧重画，最后一次出现即当前帧）。 */
function lastLineWith(buffer, needle) {
  const i = buffer.lastIndexOf(needle);
  if (i < 0) return null;
  const start = buffer.lastIndexOf('\n', i) + 1;
  const end = buffer.indexOf('\n', i);
  return stripAnsi(buffer.slice(start, end < 0 ? buffer.length : end)).trim();
}

describeOrSkip('BUG-62/63/64 键处理器与高亮重置的时序（/ + ↑ 回绕到最后一页）', () => {
  let ink;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
  }, 60000);

  // App 的高度账本读的是 process.stdout.rows/columns，不是 ink 的 stdout（BUG-28 教训）。
  const desc = {
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
  };
  const stub = (name, value) => Object.defineProperty(process.stdout, name, {
    value, configurable: true, writable: true, enumerable: true,
  });

  beforeAll(() => {
    stub('columns', COLS);
    stub('rows', ROWS);
  });

  afterAll(() => {
    for (const name of ['columns', 'rows']) {
      if (desc[name]) Object.defineProperty(process.stdout, name, desc[name]);
      else delete process.stdout[name];
    }
  });

  // 改前是竞态（实测 3/6 命中），故循环数次；改后恒绿。
  const RUNS = 3;

  /**
   * 敲 `/` 打开补全菜单，随后按 ↑。断言全在**最后一帧**的页脚上：
   * 「1/N」= 导航没生效，「N/N」= 从首页回绕到了末页（N 由屏上的总数给出，
   * 与本机历史/命令表内容无关）。
   *
   * @param gapMs `/` 与 ↑ 之间的间隔。0 = 用户的最快手速，也正是 BUG-63 的复现条件。
   */
  async function openThenUp(gapMs) {
    const App = require('../../src/cli/tui/ink-components/App');
    const stdout = fakeStdout();
    const stdin = pressableStdin();
    const instance = ink.render(React.createElement(App, { options: {} }), {
      stdout, stdin, exitOnCtrlC: false, patchConsole: false,
    });
    try {
      await wait(400);
      stdin.push('/');
      if (gapMs) await wait(gapMs);
      stdin.push('\x1b[A'); // ↑
      await wait(300);

      const footer = lastLineWith(stdout.getBuffer(), 'Esc 取消');
      expect(footer).not.toBeNull(); // 菜单被顶掉 = BUG-62 的失败形态
      const m = /(\d+)\/(\d+)\s*·\s*Esc/.exec(footer);
      expect(m).not.toBeNull();
      expect(Number(m[2])).toBeGreaterThan(1); // 单页就没有回绕可测
      expect(m[1]).toBe(m[2]); // 停在 1/N = BUG-63
    } finally {
      instance.unmount();
    }
  }

  // BUG-62：处理器闭包落后一次提交 → ↑ 被当成「历史回溯」。竞态，故循环数次。
  for (let i = 1; i <= RUNS; i += 1) {
    test(`第 ${i}/${RUNS} 次：'/' 后慢按 ↑ 回绕到最后一页（BUG-62）`, () => openThenUp(200), 60000);
  }

  // BUG-63：两键落在同一次被动 effect 冲刷之前 → 迟到的重置顶掉刚做的高亮。
  test("'/' 后立即 ↑ 仍然回绕，不被迟到的重置顶回去（BUG-63）", () => openThenUp(0), 60000);
});
