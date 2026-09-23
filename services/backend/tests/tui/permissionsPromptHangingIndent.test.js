'use strict';

/**
 * permissionsPromptHangingIndent.test.js — 授权框字段续行缩进的**真实帧**守卫(BUG-48)。
 *
 * 与 permissionFieldRows.test.js 的分工:叶子测试锁纯函数契约,这里锁「上屏后确实如此」——
 * 即 ink 收到预折好的行之后,没有再自行折行、没有多出空白行、一个字都没丢。
 *
 * 为什么这三件事都要锁:上一版处方(行内 Box + flexGrow 让 ink 自己折)量出来是
 * 「同一命令 12 行 → 13 行,多出的那行是纯空白」——wrap-ansi(trim:false)在文本恰好填满
 * 列宽时会吐一条全空格行,固定帧高里那就是白占一整行。预折行方案若哪天被改回去,
 * 下面第 3 条用例就是那道闸。
 *
 * 跑法同 permissionsPromptDigitFooter:需 NODE_OPTIONS=--experimental-vm-modules。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');
const { displayWidth } = require('../../src/cli/formatters');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

const ESC = String.fromCharCode(27);
const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(new RegExp(ESC + '\\][^' + ESC + ']*' + ESC + '\\\\', 'g'), '')
    .replace(new RegExp(ESC + '[=>78HM]', 'g'), '');

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
  stream.press = (b) => {
    queue += b;
    stream.emit('readable');
  };
  return stream;
}

function frameStdout(columns) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = 40;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 挂一次真实组件,返回盒子里的行(去掉右边界与行尾留白)。 */
async function mount(request, cols) {
  const ink = await rt.loadInk();
  const Comp = require('../../src/cli/tui/ink-components/PermissionsPrompt');
  const stdout = frameStdout(cols || 80);
  const instance = ink.render(
    React.createElement(Comp, { request, onResolve: () => {}, cols }),
    { stdin: pressableStdin(), stdout, exitOnCtrlC: false, patchConsole: false }
  );
  // 等到盒子真正闭合再取帧：整套 38 个 suite 同进程串行跑时，固定的 200ms
  // 会让偶尔没画完的帧退化成「整块 buffer」，断言随负载抖动。
  let buf = '';
  for (let i = 0; i < 120; i += 1) {
    buf = stripAnsi(stdout.getBuffer());
    if (buf.includes('╭') && buf.indexOf('╰', buf.lastIndexOf('╭')) !== -1) break;
    await wait(25);
  }
  const from = buf.lastIndexOf('╭');
  const to = buf.indexOf('╰', from);
  const rows = (from === -1 || to === -1 ? buf : buf.slice(from, to))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  instance.unmount();
  return rows;
}

/** 行内第一个非空格所在的显示列(1 基):`│ x` → 3。续行这个数就是悬挂缩进的落点。 */
function contentStart(row) {
  const body = row.replace(/^│/, '');
  const lead = (body.match(/^\s*/) || [''])[0].length;
  return displayWidth(body.slice(0, lead)) + 2;
}

const LONG_RES =
  'D:/Portable/khy-os/docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md';
const LONG_CMD =
  'for f in $(find . -name "*.md" -not -path "./node_modules/*"); do grep -c "TODO" "$f"; done | sort -rn | head -20';

const RES_REQ = {
  tool_name: 'write_file',
  input: { level: 'L1', action: '写入', scope: '项目内', resource: LONG_RES },
};
const CMD_REQ = { tool: 'bash', input: { command: LONG_CMD } };

const resRowsOf = (rows) => rows.filter((r) => /资源：|治理|规则\.md/.test(r));
const cmdRowsOf = (rows) => rows.filter((r) => /for f in|"TODO"|head -20/.test(r));

describeOrSkip('PermissionsPrompt 字段续行挂在标签之下(BUG-48)', () => {
  test('给了 cols:资源续行从第 9 列起(= 内容左界 3 + 「资源：」6 列)', async () => {
    const rows = await mount(RES_REQ, 80);
    const target = resRowsOf(rows);
    expect(target.length).toBeGreaterThan(1);
    expect(contentStart(target[0])).toBe(3);
    for (const r of target.slice(1)) {
      expect(contentStart(r)).toBe(9);
      expect(r.replace(/^│/, '').trim().length).toBeGreaterThan(0); // 缩进行必须有内容
    }
  });

  test('给了 cols:命令续行从第 5 列起(= 3 + 「$ 」2 列)', async () => {
    const rows = await mount(CMD_REQ, 80);
    const target = cmdRowsOf(rows);
    expect(target.length).toBeGreaterThan(1);
    for (const r of target.slice(1)) expect(contentStart(r)).toBe(5);
  });

  test('折行不吞字:命令各行拼回去(去空白)与「$ 」+ 原命令一致', async () => {
    const rows = await mount(CMD_REQ, 80);
    const rebuilt = cmdRowsOf(rows)
      .map((r) => r.replace(/^│/, '').replace(/│\s*$/, '').trim())
      .join('')
      .replace(/\s+/g, '');
    expect(rebuilt).toBe(('$ ' + LONG_CMD).replace(/\s+/g, ''));
  });

  test('不新增纯空白行(拒绝 flexGrow 自折的旧处方)', async () => {
    const before = await mount(CMD_REQ, undefined);
    const after = await mount(CMD_REQ, 80);
    const blanks = (rows) => rows.filter((r) => /^│\s*│$/.test(r) || /^\s*$/.test(r)).length;
    expect(blanks(after)).toBe(blanks(before));
    // 命令本身占的行数允许变多(悬挂缩进让值列变窄),但每行都必须真的画了东西
    for (const r of cmdRowsOf(after)) {
      expect(r.replace(/^│/, '').trim().length).toBeGreaterThan(2);
    }
  });

  test('没有 cols 时逐字节回退今日渲染:续行仍贴内容区最左列(= 缺陷原样)', async () => {
    const rows = await mount(RES_REQ, undefined);
    const target = resRowsOf(rows);
    expect(target.length).toBeGreaterThan(1); // ink 自己折 ⇒ 缺陷可见
    expect(target[0]).toContain('资源：D:/Portable/khy-os');
    for (const r of target.slice(1)) expect(contentStart(r)).toBe(3);
    for (const r of rows) if (r.trim()) expect(displayWidth(r)).toBeLessThanOrEqual(80);
  });
});
