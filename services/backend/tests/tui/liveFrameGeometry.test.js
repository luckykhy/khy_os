'use strict';

/**
 * liveFrameGeometry — 把「live 帧在终端里的首行」这条几何律钉在 ink 的**真实字节流**上。
 *
 * 为什么需要它(BUG-26):选区/点击的行号换算要先减掉「live 帧的首行」。这件事只能
 * 从 ink 的账本(`fullStaticOutput` / `lastOutputHeight`)推算,而 ink 的两条写路径
 * 行尾约定**不同**(非全屏 `log.update(output + '\n')` 带尾换行;全屏
 * `clearTerminal + static + output` 不带)。差一个换行就差一行,纯推算极易得出现实中
 * 不存在的答案 —— 本仓第一次推导就写成了 `rows − frameRows`(实测应为 `− 1`)。
 *
 * 所以这里不推算:把真 App 在假 TTY 上渲染时 ink 实际写出的字节流喂给一个会滚动、
 * 会解析 CSI 的**最小 VT 屏幕模型**,直接读出帧顶落在第几行,再断言叶子给出的数字
 * 与实测一致。ink 升级改了行尾/滚动约定时,这条测试会第一时间变红。
 *
 * 跑法:node scripts/run-ink-tui-tests.js(需要 --experimental-vm-modules)
 */

const { EventEmitter } = require('events');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const mouse = require('../../src/cli/tui/mouseButtons');

process.env.KHY_TUI_PREWARM = '0';
const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[liveFrameGeometry] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const ANSI_RE = new RegExp(
  '[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]', 'g');

/**
 * 最小 VT 屏幕模型 —— 与 BUG-91 真帧守卫共用 ./vtScreen 一份实现
 * （抄两份就会漂移；该份还修了「无参 CSI（\x1b[G）被当正文漏进网格」的洞）。
 * @param {number} rows @param {number} cols
 */
const { createScreen } = require('./vtScreen');

function fakeStdout({ columns, rows, screen }) {
  const stream = new (require('stream').Writable)({
    write(chunk, _enc, cb) {
      screen.feed(chunk.toString());
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  return stream;
}

function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => s;
  s.setEncoding = () => s;
  s.resume = () => s;
  s.pause = () => s;
  s.ref = () => {};
  s.unref = () => {};
  s.read = () => null;
  return s;
}

/**
 * 真 App 在给定终端行高下的实测:ink 账本 + 从屏幕模型读出的帧顶行。
 *
 * ⚠ 必须同时改 `process.stdout.rows`:App 的行高来自 `process.stdout.rows`
 * (App.js `_resRows` ← `sidebarLayout.stickyDim`),**不是**注入的渲染流。早先
 * 只注入假 stdout 的版本里,三种 rows 下 App 都按同一个行高排版(帧高恒 22),
 * 于是「帧顶 == staticRows」和「帧高不随终端收缩(BUG-28)」两条结论都是探针假象。
 *
 * 帧顶用「帧最后一行的落点 − (帧高 − 1)」反推:最后一行是页脚,唯一且必然非空,
 * 而帧第一行可能是视口的空行(用文本搜索会命中屏幕顶部那行空行)。
 */
/**
 * 等启动节拍真的跑完：App 在 beats 全部终态之前渲染的是 BootScreen(恒 14 行)，
 * 用固定 300ms 去撞它 = 测到的是启动屏而不是主 UI(实测 rows=20/26/40 都给出
 * frameRows=14，「帧高随终端走」因此以错误的理由变红)。这里等真信号，并且
 * **有界 + 报进度**(规则 3)：超时抛错带上 beats.progress()，不静默放过。
 */
async function waitBootReady(timeoutMs = 15000) {
  const { beats } = require('../../src/cli/startupBeats');
  const deadline = Date.now() + timeoutMs;
  while (!beats.isReady()) {
    if (Date.now() > deadline) {
      throw new Error('启动节拍未在 ' + timeoutMs + 'ms 内就绪：' + JSON.stringify(beats.progress()));
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300)); // 让 App 把主 UI 重画出来
}

async function measureApp(rows, { columns = 118 } = {}) {
  const ink = await rt.loadInk();
  const App = require('../../src/cli/tui/ink-components/App');
  const screen = createScreen(rows, columns);
  const stdout = fakeStdout({ columns, rows, screen });
  rt.setRenderStdout(stdout);
  const saved = _describe(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  let instance;
  try {
    instance = ink.render(React.createElement(App, { options: {} }), {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await waitBootReady();
  } finally {
    if (saved) Object.defineProperty(process.stdout, 'rows', saved);
    else delete process.stdout.rows;
  }
  const m = _readFrame(screen, rows, columns);
  instance.unmount();
  return m;
}

/**
 * 只有横幅 + 一行 live 内容的最小 ink 应用:专门测「帧高很小、static 接得住」
 * 那一支 —— 真 App 的视口永远撑满终端,走不到这一支。
 */
async function measureTinyStatic(staticLineCount, rows, { columns = 80 } = {}) {
  const ink = await rt.loadInk();
  const { Box, Static, Text } = rt.get();
  const screen = createScreen(rows, columns);
  const stdout = fakeStdout({ columns, rows, screen });
  rt.setRenderStdout(stdout);
  const saved = _describe(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  let instance;
  try {
    const items = Array.from({ length: staticLineCount }, (_, i) => `static-line-${i}`);
    instance = ink.render(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Static, { items }, (it) => React.createElement(Text, null, it)),
        React.createElement(Text, null, 'live-row-0')
      ),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const m = _readFrame(screen, rows, columns);
    instance.unmount();
    return m;
  } finally {
    if (saved) Object.defineProperty(process.stdout, 'rows', saved);
    else delete process.stdout.rows;
  }
}

function _describe(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d || null;
}

function _readFrame(screen, rows, columns) {
  const inst = rt.getInkInstance();
  const staticRows = mouse.staticRowCount(inst && inst.fullStaticOutput);
  const frameRows = Number(inst && inst.lastOutputHeight) || 0;
  const frame = String((inst && inst.lastOutput) || '').replace(ANSI_RE, '').split('\n');
  const lastLine = [...frame].reverse().find((l) => l.trim() !== '') || '';
  const needle = lastLine.trim().slice(0, 10);
  const bottomRow = needle ? screen.findLast(needle) : -1;
  const measuredTop = bottomRow >= 0 ? bottomRow - (frameRows - 1) : -1;
  if (process.env.GEO_DUMP) {
    // eslint-disable-next-line no-console
    console.log('[geo]', JSON.stringify({ rows, columns, staticRows, frameRows, measuredTop, needle }));
  }
  return { rows, columns, staticRows, frameRows, measuredTop, needle };
}

describeOrSkip('live 帧首行的几何律(与 ink 真实字节流对账)', () => {
  test('真 App · 行高随终端走:帧高 + static 校正 == 实测帧顶(rows=40)', async () => {
    const m = await measureApp(40);
    // 帧高**必须**贴着终端行高(证伪 BUG-28:帧高恒 22 只是探针没改 process.stdout.rows)
    expect(m.frameRows).toBeGreaterThan(30);
    expect(m.frameRows + m.measuredTop + 1).toBeLessThanOrEqual(40);
    expect(mouse.liveFrameTop(m)).toBe(m.measuredTop);
  }, 20000);

  test('真 App · 短终端同一条律(rows=20)', async () => {
    const m = await measureApp(20);
    expect(m.frameRows).toBeGreaterThan(10);
    expect(mouse.liveFrameTop(m)).toBe(m.measuredTop);
  }, 20000);

  test('小帧 + 高终端 → 帧顶由 staticRows 决定(夹取的左支)', async () => {
    const m = await measureTinyStatic(6, 40);
    expect(m.staticRows).toBe(6);
    expect(m.measuredTop).toBe(6);
    expect(mouse.liveFrameTop(m)).toBe(6);
  }, 20000);

  test('static + 帧**放得下**时帧顶仍被 static 顶开(左支的另一组数)', async () => {
    const m = await measureTinyStatic(3, 24);
    expect(m.measuredTop).toBe(3);
    expect(mouse.liveFrameTop(m)).toBe(3);
  }, 20000);

  test('screenOffset 把同一个数交给命中测试', async () => {
    const m = await measureApp(26);
    const off = mouse.screenOffset(m.frameRows, {
      rows: m.rows,
      anchorBottom: false,
      screenTop: mouse.liveFrameTop(m),
    });
    expect(off).toBe(m.measuredTop);
  }, 20000);

  // 叶子对、接线漏 = 用户侧依旧是 0 偏移(单测全绿而真机照错,是这条 bug 的成因)。
  // 所以这里钉三个接线点,缺一即红。
  test('App 把帧顶接进了命中测试与选区两条路径', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../src/cli/tui/ink-components/App.js'), 'utf8'
    );
    expect(src).toMatch(/_mouse\.liveFrameTop\(/);
    expect(src).toMatch(/screenTop: _screenTop/);
    // 选区侧必须是**减**帧顶(`- offset` 那一版方向反过,别再写错)。
    expect(src).toMatch(/Math\.trunc\(Number\(ev\.row\)\) - _screenTop \+ offset/);
  });
});
