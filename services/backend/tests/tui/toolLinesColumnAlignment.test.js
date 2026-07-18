'use strict';

/**
 * toolLinesColumnAlignment — 回归:命令 stdout 的列对齐(成串空格)必须原样进帧,
 * 不能被裁切阶段的 `\s+`→单空格折叠塌成 `p n s` 这类单字母 + 空行。
 *
 * 起因(真实现场):Windows 上 khyos 跑 PowerShell 全盘去重扫描,一次「成功」的命令
 * 输出被渲染成表头 `p n s`(单字母 + 大片空白 + 高亮空行)——因 renderLiteralOutput
 * 的行裁切用了会折叠空白的 `truncate(ln, w)`(`replace(/\s+/g,' ')`),把靠成串空格
 * 排版的 PowerShell 表(如 `Name`/`Size`/`Path` 列)压成不可读的单字符碎片。
 *
 * 修复:命令 stdout / stderr / 预览三处裁切统一改用**保留空格**的 `clip(ln, w)`
 * (与 diff 分支同口径)。本测走与 inkRenderSmoke / toolLinesErrorFaithful 同一个
 * VM-modules headless ink 渲染探针:渲染成帧串后断言列间空白仍在。
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
    '[toolLinesColumnAlignment] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

function fakeStdout(columns = 200) {
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

describeOrSkip('ToolLines 命令 stdout 列对齐(p n s 回归)', () => {
  let ink;
  let ToolLines;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
    ToolLines = require('../../src/cli/tui/ink-components/ToolLines');
  });

  async function frameFor(tools, { expanded = true, columns = 200 } = {}) {
    const stdout = fakeStdout(columns);
    const instance = ink.render(
      React.createElement(ToolLines, { tools, expanded }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  // PowerShell 风格表:列靠成串空格对齐。折叠 `\s+` 会把它塌成 `Name Size Path`
  // 连成一坨(现场极端下甚至 `p n s`);保留空格的 clip 则让 `Name` 与 `Size` 之间
  // 的多个空格原样进帧。
  const PS_TABLE = [
    'Name            Size      Path',
    '----            ----      ----',
    'a.txt           1024      C:\\a.txt',
    'b.txt           2048      D:\\b.txt',
  ].join('\n');

  const SHELL_TOOL = {
    name: 'Bash',
    input: { command: 'Get-ChildItem | Format-Table' },
    result: { text: PS_TABLE, exitCode: 0 },
  };

  test('命令 stdout:列间成串空格原样保留(不塌成单空格)', async () => {
    const frame = await frameFor([SHELL_TOOL], { expanded: true });
    // 表头必须在帧内。
    expect(frame).toContain('Name');
    expect(frame).toContain('Size');
    expect(frame).toContain('Path');
    // 关键不变量:`Name` 与 `Size` 之间保留 >1 个空格(列对齐)。
    // 若被 truncate 的 `\s+`→单空格折叠,这里只会有单个空格,断言失败。
    expect(frame).toMatch(/Name {2,}Size/);
    expect(frame).toMatch(/Size {2,}Path/);
    // 且绝不出现被折叠后每列只剩首字母那种坍缩形态。
    expect(frame).not.toMatch(/(^|\s)N S P(\s|$)/);
  });

  // 诚实边界:错误/stderr 行的**行内空白**早由上游 stripInternalControlText(刀18)逐行折叠 +
  // trim,故 stderr 分支的裁切改 truncate→clip **对空白逐字节等价**——alignment 在上游就已丢失,
  // 不在本次显示层修复范围内。此测只确认 stderr 分支仍正常渲染(clip 不崩、内容完整),而非
  // 断言 stderr 保留列对齐(那需改上游折叠,超出「p n s」显示层修复的加法式边界)。
  test('命令 stderr(红色错误行):clip 改动不破坏渲染(上游已折叠,逐字节等价)', async () => {
    const errTool = {
      name: 'Bash',
      input: { command: 'ps-scan' },
      result: {
        error: [
          'Col1            Col2      Col3',
          'x               y         z',
        ].join('\n'),
        exitCode: 1,
      },
    };
    const frame = await frameFor([errTool], { expanded: true });
    // 每列内容都在帧内(无丢字、无坍缩成单字母)。
    expect(frame).toContain('Col1');
    expect(frame).toContain('Col2');
    expect(frame).toContain('Col3');
    expect(frame).toContain('x');
    expect(frame).toContain('z');
  });
});
