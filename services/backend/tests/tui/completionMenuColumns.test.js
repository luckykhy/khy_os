'use strict';

/**
 * completionMenuColumns.test.js —— 补全下拉两列对齐的守卫(BUG-47)。
 *
 * 缺陷本体(实测自真实挂载帧，见 .khy/feedback/tui-ux-audit-20260919/AG/)：
 *   标签列的**宽度**与**填充**都按 UTF-16 码元数算（`.length` / `padEnd`），
 *   而描述列按显示列算（`displayWidth`/`truncateToWidth`）。CJK 标签一个字符
 *   占 2 列 ⇒ ① 各行描述起点错开（混合列表实测 15/20/21 三列）；② 描述预算
 *   `descMax` 同步虚高，临界长的描述照样换行，续行顶到盒左缘、并挤出一行幻影空行；
 *   ③ 超过 28 上限的标签根本没被裁剪，纯 ASCII 长路径照样错 32 列。
 *
 * 锁的是**不变量**而非文案：所有数据行的第二列起点同列、数据行数 = 条目数
 * (无幻影续行)、每行宽度 ≤ cols、标签格 ≤ 28 列；再用一条逐字节断言钉住
 * 「无 cols 的纯窄 ASCII」旧行为不许动。
 *
 * 跑法同 ccHelpMenuOverlay：需 --experimental-vm-modules
 * (node services/backend/scripts/run-ink-tui-tests.js completionMenuColumns)。
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
    '[completionMenuColumns] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const ESC = String.fromCharCode(27);
const COLS = 80;

const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(new RegExp(ESC + '\\][^' + ESC + ']*' + ESC + '\\\\', 'g'), '')
    .replace(new RegExp(ESC + '[=>78HM]', 'g'), '');

function dw(s) {
  const { displayWidth } = require('../../src/cli/formatters');
  return displayWidth(s);
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

function collectingStdout(columns) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = 30;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

/** 最后一整个圆角盒内的行（去掉左右边框之外的内容、去 ANSI）。 */
function lastBoxLines(buffer) {
  const start = buffer.lastIndexOf('╭');
  if (start === -1) throw new Error('帧里找不到盒框，挂载可能为空');
  const end = buffer.indexOf('╰', start);
  if (end === -1) throw new Error('盒未闭合（最后一帧不完整）');
  return buffer
    .slice(start, end)
    .split('\n')
    .map((l) => stripAnsi(l.replace(/^[\s\S]*╭/, '').replace(/╮[\s\S]*$/, '')));
}

/**
 * 一行里「描述列」起始所在的显示列：`│` + ≤4 空格 + 标签格 + ≥2 空格 + 描述。
 * 不读被测代码算出的 labelWidth，纯从画面行反推（否则等于用 bug 验 bug）。
 */
function descColumnOf(line) {
  const m = /^│\s{0,4}(\S(?:.*?\S)?)\s{2,}/.exec(line);
  return m ? dw(line.slice(0, m[0].length)) : null;
}

/** 数据行：去掉右竖线，丢掉顶边框、页脚与只剩竖线的残行。 */
function dataRows(lines) {
  return lines
    .map((l) => l.replace(/│$/, ''))
    .filter((l) => l.trim() && !/^│?\s*─+\s*$/.test(l) && !l.includes('Esc 取消'));
}

async function mount(items, opts) {
  const stdin = pressableStdin();
  const stdout = collectingStdout(COLS);
  const CompletionMenu = require('../../src/cli/tui/ink-components/CompletionMenu');
  const app = rt.get().render(
    React.createElement(CompletionMenu, {
      completion: { active: true, kind: 'file', items },
      selectedIndex: items[0].value,
      marginLeft: 0,
      page: 0,
      cols: COLS,
      ...opts,
    }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false }
  );
  await new Promise((r) => setTimeout(r, 140));
  const lines = lastBoxLines(stdout.getBuffer());
  app.unmount();
  return dataRows(lines);
}

const MIXED = [
  { label: '中文文件名.ts', value: 'a', desc: '第一个候选说明' },
  { label: 'abc.ts', value: 'b', desc: '第二个候选说明' },
  { label: '第三季度报告.md', value: 'c', desc: '第三个候选说明' },
];

describeOrSkip('CompletionMenu 两列按显示列对齐(BUG-47)', () => {
  let ink;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
  });

  test('挂载可用（ink 真实版本）', () => {
    expect(ink && typeof ink.render === 'function').toBe(true);
  });

  test('混合 CJK/ASCII 标签：所有行的描述列起点同一列', async () => {
    const rows = await mount(MIXED, {});
    expect(rows.length).toBe(MIXED.length);
    const starts = rows.map(descColumnOf);
    expect(starts.every((v) => v !== null)).toBe(true);
    expect(new Set(starts).size).toBe(1);
  });

  test('CJK 标签 + 临界长描述：不产生换行幻影行，行数 = 条目数', async () => {
    const rows = await mount(
      [
        { label: '中文文件名.ts', value: 'a', desc: '说'.repeat(30) }, // 60 列
        { label: 'abc.ts', value: 'b', desc: '短' },
      ],
      {}
    );
    expect(rows.length).toBe(2);
    expect(new Set(rows.map(descColumnOf)).size).toBe(1);
  });

  test('每条数据行的显示宽度 ≤ cols', async () => {
    const groups = [MIXED, [{ label: 'x.ts', value: 'x', desc: 'y'.repeat(200) }]];
    for (const items of groups) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await mount(items, {});
      // eslint-disable-next-line no-await-in-loop
      for (const r of rows) expect(dw(r)).toBeLessThanOrEqual(COLS);
    }
  });

  test('标签列不超过 28 列上限（长路径必须被裁剪而不是撑爆预算）', async () => {
    const rows = await mount(
      [
        { label: 'src/services/backend/src/services/gateway/adapters/openai.js', value: 'a', desc: '说明' },
        { label: 'a.js', value: 'b', desc: '说明' },
      ],
      {}
    );
    const starts = rows.map(descColumnOf);
    expect(new Set(starts).size).toBe(1);
    // 描述起点 = 竖线(1) + paddingX(1) + 标记(2) + 标签格 + 间隙(2)，
    // 反推标签格宽度 ⇒ 不得超过 28 列上限
    starts.forEach((s) => expect(s - 6).toBeLessThanOrEqual(28));
    expect(rows[0]).toContain('src/services/backend/src');
  });

  test('旧行为锁：无 cols 的纯窄 ASCII 列表逐字节不变', async () => {
    const rows = await mount(
      [
        { label: '/help', value: '/help', desc: 'show help' },
        { label: '/model', value: '/model', desc: 'switch model' },
      ],
      { cols: undefined }
    );
    expect(rows.map((r) => r.trimEnd())).toEqual([
      '│   /help   show help',
      '│   /model  switch model',
    ]);
  });
});
