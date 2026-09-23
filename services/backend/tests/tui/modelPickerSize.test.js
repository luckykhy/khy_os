'use strict';

/**
 * modelPickerSize.test.js — /model 选择器的「一行一视觉行 + 帧高随屏幕收敛」守卫(BUG-56)。
 *
 * 与 BUG-54/55 同族：`ModelPicker` 此前既不接 cols 也不接 rows，`PAGE_SIZE` 是写死的 12。
 * 网关返回的模型 ID 是外部字符串(40+ 字符很常见)，未封顶的行在窄终端上折成两行，
 * 整框从 16 行涨到 22 行；矮终端(12 行)上框高 16 行 > 屏幕，掉出去的那一行正是
 * 「Enter 选择 · ↑/↓ 导航 · 打字搜索 · Esc 取消」——用户看不见退出键。
 * 实测见 .khy/feedback/tui-ux-audit-20260919/AK/repro-before.txt。
 *
 * 处方与回溯选择器一致：行内容过 `clipCell`(显示列口径)，分页过 `pickerPageRows`
 * 按真实帧高计费；本组件额外把「搜索: xxx」这一行回声行也计入(它只有自己知道)。
 *
 * 不传 cols/rows 时必须与改前形态一致(组件不参与裁剪/收缩)。
 *
 * 帧部分需 NODE_OPTIONS=--experimental-vm-modules，由 scripts/run-ink-tui-tests.js 带上。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const path = require('path');
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

/**
 * ink v6 的输入管线是 `stdin.on('readable')` + `while (chunk = stdin.read())`
 * （node_modules/ink/build/components/App.js:104），不是 'data'。所以这个假 stdin
 * 必须自带一个可读队列，`push()` 才把按键喂进 useInput。
 */
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


function frameStdout(columns, rows) {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = rows || 40;
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
  // slice 停在 ╰ 之前，末尾必然带一个换行 → split 多出一个空元素。只剔这一个。
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * 挂真组件渲染真帧，返回 { rows, raw }。
 * `rows` = 去色后的框内各行（不含下边框）；`raw` = 同一帧未去色的字节，用来看 SGR。
 * `keys` 是渲染后逐条写入 stdin 的按键（用来触发「搜索:」回声行）。
 * `ttyCols` 只在「终端宽但组件不知道」的负对照里用：它让 ink 按该宽度排版，
 * 而组件仍拿不到 cols，于是复现改前的撑行。
 */
async function renderFrame(choices, cols, termRows, keys, ttyCols) {
  const ink = await rt.loadInk();
  const Comp = require(path.join('..', '..', 'src', 'cli', 'tui', 'ink-components', 'ModelPicker.js'));
  const stdout = frameStdout(ttyCols || cols || 80, termRows);
  const stdin = pressableStdin();
  const instance = ink.render(
    React.createElement(Comp, {
      choices,
      defaultValue: null,
      recent: [],
      onResolve: () => {},
      cols,
      rows: termRows,
    }),
    { stdin, stdout, exitOnCtrlC: false, patchConsole: false }
  );
  let out = { rows: [], raw: '' };
  try {
    let polled = '';
    for (let i = 0; i < 160; i += 1) {
      polled = stdout.getBuffer();
      const plain = stripAnsi(polled);
      if (plain.includes('╭') && plain.indexOf('╰', plain.lastIndexOf('╭')) !== -1) break;
      await wait(25);
    }
    if (keys && keys.length) {
      for (const k of keys) {
        stdin.push(k);
        await wait(40);
      }
      for (let i = 0; i < 60; i += 1) {
        await wait(25);
        polled = stdout.getBuffer();
        if (stripAnsi(polled).includes('搜索:')) break;
      }
    }
    const raw = polled.slice(polled.lastIndexOf('╭'));
    out = { rows: sliceFrame(stripAnsi(polled)), raw };
  } finally {
    if (typeof instance.unmount === 'function') instance.unmount();
  }
  return out;
}

async function mount(choices, cols, termRows, keys, ttyCols) {
  return (await renderFrame(choices, cols, termRows, keys, ttyCols)).rows;
}


// mount 返回的行切片不含下边框那一行，所以整框高度要 +1。
const frameHeight = (rows) => rows.length + 1;
const widest = (rows) => rows.reduce((m, r) => Math.max(m, displayWidth(r)), 0);

/** 一行里还开着、但到行末没关的 SGR 组数（0 = 颜色不会漏到下一行）。 */
function sgrOffKey(c) {
  if (c === 39 || (c >= 30 && c <= 37) || c === 38 || (c >= 90 && c <= 97)) return c === 39 ? null : 39;
  if (c === 49 || (c >= 40 && c <= 47) || c === 48 || (c >= 100 && c <= 107)) return c === 49 ? null : 49;
  if (c === 1 || c === 2) return 22;
  if (c === 3) return 23;
  if (c === 4) return 24;
  if (c === 7) return 27;
  if (c === 9) return 29;
  return null;
}

function unclosedSgr(line) {
  const re = new RegExp(ESC + '\\[([0-9;]*)m', 'g');
  const open = new Set();
  let m;
  while ((m = re.exec(line)) !== null) {
    const codes = m[1] === '' ? [0] : m[1].split(';').map((p) => Number(p) || 0);
    for (const c of codes) {
      if (c === 0) { open.clear(); continue; }
      const off = sgrOffKey(c);
      if (off === null) open.delete(c);
      else { open.delete(off); open.add(off); }
    }
  }
  return open.size;
}

// 真实网关列表里的长 ID：长度由供应商决定，不由我们决定。
const LONG_IDS = [
  'claude-3-5-sonnet-20241022',
  'gemini-1.5-pro-exp-0827',
  'gpt-4o-mini-2024-07-18',
  'deepseek-chat-v3-20250324-preview',
  'qwen2.5-72b-instruct-128k',
  'kimi-k2-turbo-preview',
  'glm-4-plus-0111',
  'doubao-pro-128k-241211',
  'yi-lightning-latest',
  'minimax-abab6.5s-chat',
  'moonshot-v1-128k-vision-preview',
  'spark-large-3.5-plus',
];

function choicesOf(ids, everyFourthDisabled) {
  return ids.map((n, i) => ({
    name: n,
    value: { adapter: 'gateway', model: n },
    disabled: !!everyFourthDisabled && i % 4 === 3,
  }));
}

const LONG = choicesOf(LONG_IDS, true);

// 行号标签只对窗口内前 9 行存在（`windowPos < 9`），所以数条目不能靠 `\d+.`。
const STEMS = LONG_IDS.map((id) => id.slice(0, 6));
const isItemRow = (r) => STEMS.some((s) => r.includes(s));

describeOrSkip('ModelPicker · 真实帧的行宽(BUG-56)', () => {
  test('传 cols：长模型 ID 每条只占一视觉行，40 列窄终端也不折行', async () => {
    const rows = await mount(LONG, 40, 24);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    // 改前同一批 ID 在 40 列下有 5 行折成两行，整框 22 行（AK/repro-before.txt M2）
    expect(frameHeight(rows)).toBeLessThanOrEqual(17);
    // 12 条一页没有被宽度收缩悄悄改掉
    expect(rows.filter(isItemRow).length).toBe(12);
  });

  test('带 SGR 的彩色长 ID：宽度按可见列计，且颜色不跨行', async () => {
    // 真实网关列表的 name 是 chalk 预着色过的字符串。这里手拼 SGR 而不是调 chalk：
    // 测试环境无色彩支持时 chalk 退化成原样字符串，那样这条守卫什么也没测到。
    const green = (s) => ESC + '[32m' + s + ESC + '[39m';
    const colored = choicesOf(LONG_IDS.map(green), false);
    const { rows, raw } = await renderFrame(colored, 40, 24);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(rows.filter(isItemRow).length).toBe(12);
    // 计量口径若按码元/字节算，带色行会被截得过短或仍被 ink 折行撑高：
    // 12 条一页 + 4 行框 chrome = 17，必须与无色时同高。
    expect(frameHeight(rows)).toBeLessThanOrEqual(17);
    // 实测证伪了一条假设（见 AK/differential.md）：截断处「不补 reset 就会把颜色漏到
    // 下一行」在 ink 路径上不成立 —— ink 6 会给每个 Text 节点末尾自动补 ESC[39m。
    // 所以 clipCell 不再追加 reset，这里改锁真正需要成立的不变量：每一行的 SGR 闭合。
    for (const l of raw.split('\n')) expect(unclosedSgr(l)).toBe(0);
  });

  test('不传 cols：与改前形态一致（ID 原样上屏，由 ink 自行折行撑高）', async () => {
    const capped = await mount(LONG, 40, 24);
    // 同一个 40 列屏幕，只是组件没被告知宽度 —— 即改前的真实处境
    const raw = await mount(LONG, undefined, undefined, null, 40);
    expect(widest(raw)).toBeLessThanOrEqual(40); // ink 会折，不会超宽
    expect(frameHeight(raw)).toBeGreaterThan(frameHeight(capped));
    expect(raw.join('\n')).toContain('deepseek-chat-v3-20250324-preview');
  });
});

describeOrSkip('ModelPicker · 帧高随终端行数收敛(BUG-56)', () => {
  test('rows 未知时不改形态：仍是 12 条一页、整框 16 行', async () => {
    const rows = await mount(LONG, 80, undefined);
    expect(frameHeight(rows)).toBe(16);
  });

  test('80×12 矮终端：整框不超过屏幕，Esc 提示就在最后一行', async () => {
    const rows = await mount(LONG, 80, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
    expect(rows.join('\n')).toContain('更多');
  });

  test('40×12 又窄又矮：标题/页脚折行后仍在屏内，且没有一行超出 40 列', async () => {
    const rows = await mount(LONG, 40, 12);
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(widest(rows)).toBeLessThanOrEqual(40);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
  });

  test('24 行正常终端不因本修复缩水：仍排满 12 条', async () => {
    const rows = await mount(LONG, 80, 24);
    expect(rows.filter(isItemRow).length).toBe(12);
  });

  test('打字出「搜索:」回声行时，那一行也算进帧高', async () => {
    const rows = await mount(LONG, 80, 12, ['g', 'p', 't']);
    expect(rows.join('\n')).toContain('搜索:');
    expect(frameHeight(rows)).toBeLessThanOrEqual(12);
    expect(rows[rows.length - 1]).toContain('Esc 取消');
  });
});
