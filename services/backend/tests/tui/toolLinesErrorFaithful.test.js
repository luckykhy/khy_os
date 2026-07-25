'use strict';

/**
 * toolLinesErrorFaithful — 刀40 回归:TUI 工具失败**详情每行的裁切宽度**须走 diffClipWidth SSOT
 * (终端感知 + Ctrl+O 展开→Infinity 整行),与姊妹 literal stdout 分支(刀17)同口径,而非历史
 * 固定 `truncate(ln,120)`——后者无视终端宽,且**展开后仍裁 120**,令超长错误行尾部 Ctrl+O 永看
 * 不到(违 toolErrorFold「诚实展开」本意)。
 *
 * 诚实边界:错误行**行内空白**早由 stripInternalControlText(preserveNewlines)逐行折叠 + trim
 * (刀18 刻意:保留行间结构、归一行内空白),属上游既定设计**非本刀范围**——故本刀只验「宽度/
 * 展开」一面,绝不断言行内缩进保留(那是上游折叠后的既定形态)。
 *
 * 走与 inkRenderSmoke 同一个 VM-modules ink 渲染探针(headless 渲染成帧串再断言)。
 * 需 NODE_OPTIONS=--experimental-vm-modules(经 `npm run --workspace backend test:tui`)。
 *
 * 门控复用 KHY_TOOL_ERROR_FOLD(整个「多行错误忠实渲染」特性同一开关):
 *   - 开 → diffClipWidth(展开→Infinity 整行 / 折叠→终端感知宽);
 *   - 关 → truncate(ln,120)(固定 120 字截断 `…`,无视展开/终端)逐字节回退。
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
    '[toolLinesErrorFaithful] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

function fakeStdout(columns = 80) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) { buffer += chunk.toString(); cb(); },
  });
  stream.columns = columns;
  stream.rows = 24;
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

describeOrSkip('ToolLines tool-error faithful render (刀40)', () => {
  let ink;
  let ToolLines;
  let prevFold;
  let prevWidth;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
    ToolLines = require('../../src/cli/tui/ink-components/ToolLines');
  });

  beforeEach(() => {
    prevFold = process.env.KHY_TOOL_ERROR_FOLD;
    prevWidth = process.env.KHY_DIFF_CONTENT_WIDTH;
  });

  afterEach(() => {
    if (prevFold == null) delete process.env.KHY_TOOL_ERROR_FOLD;
    else process.env.KHY_TOOL_ERROR_FOLD = prevFold;
    if (prevWidth == null) delete process.env.KHY_DIFF_CONTENT_WIDTH;
    else process.env.KHY_DIFF_CONTENT_WIDTH = prevWidth;
  });

  async function frameFor(tools, { expanded = false, columns = 80 } = {}) {
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

  // 超长单行错误:130 个 x + 尾标记。固定 120 字裁切会丢尾标记并缀 `…`;
  // 展开态 diffClipWidth→Infinity 则整行交 ink 自然换行(全字符在帧内、无 `…`)。
  const LONG_TAIL = 'TAIL_MARKER_END_OF_VERY_LONG_ERROR_LINE';
  const LONG_ERR = {
    name: 'Bash',
    input: { command: 'build' },
    result: { error: `Error: ${'x'.repeat(130)}${LONG_TAIL}`, exitCode: 1 },
  };

  test('gate ON + expanded: 超长错误行整行可见(无固定 120 截断,Ctrl+O 真全貌)', async () => {
    process.env.KHY_TOOL_ERROR_FOLD = 'on';
    process.env.KHY_DIFF_CONTENT_WIDTH = 'on';
    const frame = await frameFor([LONG_ERR], { expanded: true });
    // ink 在 80 列会把整行自然换行(可能把尾标记拆到换行处),故剥除所有空白再比对:
    // 全部字符在帧内即证明无固定 120 截断(整行交 ink,Ctrl+O 真全貌)。
    const flat = frame.replace(/\s+/g, '');
    expect(flat).toContain(LONG_TAIL);
    expect(frame).not.toContain('…');
  });

  test('gate ON + collapsed: 终端感知裁切(超长行截尾 + `…`,与展开态对照)', async () => {
    process.env.KHY_TOOL_ERROR_FOLD = 'on';
    process.env.KHY_DIFF_CONTENT_WIDTH = 'on';
    const frame = await frameFor([LONG_ERR], { expanded: false });
    // 折叠态:diffClipWidth 返回终端感知宽(80 列下远 < 137)→ 截尾 + `…`,尾标记丢失。
    // 与「gate ON + expanded 全貌」形成对照,实证展开→Infinity 的差异是真实可见的(非 no-op)。
    const flat = frame.replace(/\s+/g, '');
    expect(flat).not.toContain(LONG_TAIL);
    expect(frame).toContain('…');
  });

  test('gate OFF + expanded: 逐字节回退固定 truncate(120)(展开也截尾 + `…`)', async () => {
    process.env.KHY_TOOL_ERROR_FOLD = 'off';
    const frame = await frameFor([LONG_ERR], { expanded: true });
    // 关门:无视展开,固定裁 120 → 尾标记丢失 + `…`(与 gate ON + expanded 的全貌形成对照)。
    const flat = frame.replace(/\s+/g, '');
    expect(flat).not.toContain(LONG_TAIL);
    expect(frame).toContain('…');
  });
});
