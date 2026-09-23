'use strict';

/**
 * BUG-67/68/69/70/71/72 —— CC 表面三个浮层（Ctrl+P 命令面板 / Ctrl+R 历史搜索 /
 * Ctrl+O 转录视图）的「接得上 + 画得下 + 选得中」守卫。
 * 同族续装（末两个 describe）：BUG-77/78/81 —— CcApp **主表面**的尾窗计费、
 * 假 Agent 树与输入框的高度上限。
 *
 * 缺陷本体（全部实测自真实挂载帧，存证见 .khy/feedback/tui-ux-audit-20260919/{AT,AU}/）：
 *   • 接线：`const { CcViewStack } = require('./CcViewStack')` 解构了不存在的名字 →
 *     Ctrl+P/Ctrl+R 一按整屏 `ERROR Cannot read properties of undefined`；
 *     `getCcTranscriptView()` 返回模块对象当元素类型 → Ctrl+O 报 Element type is invalid。
 *   • 数据源：历史面板读 `utils/ccHistory` 的 ~/.khyquant/.khy_history —— 全仓无人写 →
 *     面板恒空（BUG-67）。
 *   • 高度：palette 帧高恒 25 行 > 24 行终端 → ink 在 `outputHeight >= rows` 时走
 *     全屏分支写 \x1b[2J，win32 的 2J 把旧帧**滚进回滚缓冲**：实测按 10 次 ↓ 留 10 份
 *     整屏残影，且框的顶边被滚出屏幕。
 *   • 窗口：history `slice(0, 10)` / fuzzy `slice(0, maxHeight)` 钉死在列表开头，
 *     ↓ 过第 10 条后高亮「▸」根本不在屏上，Enter 选中的是看不见的那条。
 *   • 尺寸来源：浮层自己读裸 `process.stdout.columns`。conpty/管道下它是 undefined →
 *     `undefined - 8` = NaN → 裁切宽度塌到地板 → 整列条目画成「h...」（本轮修 70~72
 *     时实测到的新病灶，改走全仓唯一入口 ../effectiveDims + 宿主传入的 cols/rows）。
 *
 * 需要 --experimental-vm-modules（ink 是 ESM-only），故与 keyHandlerFreshClosure 一样自跳过。
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
    '[ccOverlayFit] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

// Pinned history so the panel's watermark is deterministic — and so the suite
// never touches the real ~/.khyquant_history (BUG-65's lesson: isolation that
// leaks writes through to the live file). Factory is hoisted → `mock` prefix.
let mockHistoryEntries = [];
jest.mock(
  '../../src/cli/repl/history',
  () => ({
    MAX_HISTORY: 500,
    loadHistory: () => mockHistoryEntries,
    saveHistory: () => {},
    flushHistorySync: () => {},
    HISTORY_FILE: '/nonexistent/ccOverlayFit.history',
  }),
  { virtual: false },
);

const COLS = 80;
const ROWS = 24;
const DOWN = `${String.fromCharCode(27)}[B`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** hist-01…hist-30 + 一条 60 列宽的中文长句（专打「一条折三行 → 帧高失控」那一刀）。 */
const ENTRIES = Array.from({ length: 30 }, (_, i) => `hist-${String(i + 1).padStart(2, '0')}`)
  .concat(['用一段连续的中文长句回答为什么不该把 .env 提交进 git，句中提到 `git status` 与 `khy update`']);

/** 面板反序展示 → ↓×12 之后光标落在第 13 条；水印由列表派生，不手写数字。 */
const TWELFTH = ENTRIES.slice().reverse()[12];

function fakeStdout(rows = ROWS, cols = COLS) {
  let buffer = '';
  const writes = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const s = chunk.toString();
      buffer += s;
      writes.push(s);
      cb();
    },
  });
  stream.columns = cols;
  stream.rows = rows;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  // ink 的差量写只重画变化的那一两行，**全屏分支**则一次写完整个 output ——
  // 所以「单次 write 的行数」是帧高的现场读数，逐帧留档才能钉住顶破屏幕那一帧。
  stream.getWrites = () => writes.slice();
  return stream;
}

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

const stripAnsi = (s) =>
  String(s)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[=>78]/g, '');

/**
 * Simulate a terminal of a given size for the component under test: CcApp reads
 * process.stdout at mount (sanitized, `|| 80 / || 24`) and threads cols/rows
 * into every overlay, so setting the two dims before mounting is enough.
 * `null` means "a conpty/pipe that reports nothing at all".
 *
 * `process` is shared across suites in one jest worker, and a sibling suite
 * fakes the size with `defineProperty({value})` — which defaults to
 * `writable: false` and makes plain assignment throw. Always install our own
 * configurable+writable descriptor and restore the original descriptor.
 */
async function withTerm({ rows = ROWS, cols = COLS } = {}, fn) {
  const saved = {
    rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
    cols: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
  };
  const put = (axis, value) => {
    if (value === null) delete process.stdout[axis];
    else {
      Object.defineProperty(process.stdout, axis, { value, configurable: true, writable: true });
    }
  };
  put('rows', rows);
  put('cols', cols);
  const eff = require('../../src/cli/tui/effectiveDims');
  eff._resetStickyForTest();
  try {
    return await fn();
  } finally {
    for (const [axis, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(process.stdout, axis, desc);
      else delete process.stdout[axis];
    }
    eff._resetStickyForTest();
  }
}

/** ink 的全屏分支是残影之源：一帧里出现一次 \x1b[2J 就算失败。 */
const clearCount = (raw) => raw.split('\x1b[2J').length - 1;

async function mountCcApp(rows = ROWS, cols = COLS) {
  await rt.loadInk();                    // CcApp 在模块顶层取 ink，必须先 loadInk
  const CcApp = require('../../src/cli/tui/ink-components/CcApp');
  const ink = rt.get();
  const stdout = fakeStdout(rows, cols);
  const stdin = pressableStdin();
  const instance = ink.render(React.createElement(CcApp, { options: {} }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await wait(700);
  return { instance, stdout, stdin };
}

/** 打开浮层 → 按 n 次 ↓ → 交回原始字节流与去 ANSI 的帧。 */
async function openAndWalk(stdout, stdin, key, steps) {
  stdin.push(key);
  await wait(450);
  for (let i = 0; i < steps; i += 1) {
    stdin.push(DOWN);
    await wait(120);
  }
  const raw = stdout.getBuffer();
  return { raw, frame: stripAnsi(raw) };
}

describeOrSkip('CC 浮层：接线 + 高度预算 + 窗口跟随（BUG-67…72）', () => {
  beforeAll(() => { mockHistoryEntries = ENTRIES.slice(); });

  test('Ctrl+P 命令面板：不崩、顶边在屏、导航 12 次不触发一次 clearTerminal', async () => {
    await withTerm({}, async () => {
      const { instance, stdout, stdin } = await mountCcApp();
      try {
        const { raw, frame } = await openAndWalk(stdout, stdin, '\x10', 12);
        expect(frame).not.toMatch(/ERROR/);
        expect(frame).toMatch(/┌/);
        expect(clearCount(raw)).toBe(0);
        // 窗口必须跟到最后一组：/doctor 是列表末条，旧写法永远不画它
        expect(frame).toMatch(/\/doctor/);
        expect(frame).toMatch(/▸ \/doctor/);
      } finally {
        instance.unmount();
      }
    });
  }, 30000);

  test('Ctrl+P 命令面板：12 行的小终端同样装得下（帧高不超终端）', async () => {
    await withTerm({ rows: 12 }, async () => {
      const { instance, stdout, stdin } = await mountCcApp(12, COLS);
      try {
        const { raw, frame } = await openAndWalk(stdout, stdin, '\x10', 6);
        expect(frame).not.toMatch(/ERROR/);
        expect(clearCount(raw)).toBe(0);
        expect(frame).toMatch(/▸/);
      } finally {
        instance.unmount();
      }
    });
  }, 30000);

  test('Ctrl+R 历史搜索：列的是真历史，↓ 过第 10 条高亮仍在屏上', async () => {
    await withTerm({}, async () => {
      const { instance, stdout, stdin } = await mountCcApp();
      try {
        const { raw, frame } = await openAndWalk(stdout, stdin, '\x12', 12);
        expect(frame).not.toMatch(/ERROR/);
        expect(clearCount(raw)).toBe(0);
        // 旧写法 slice(0, 10) 连第 13 条都不画
        expect(frame).toMatch(TWELFTH);
        expect(frame).toMatch(new RegExp(`▸ ${TWELFTH}`));
        // 一条历史 = 一行：长句被裁，不把帧高顶破
        const { displayWidth } = require('../../src/cli/formatters');
        const over = frame.split('\n').filter((l) => displayWidth(l) > COLS);
        expect(over).toEqual([]);
        expect(frame).toMatch(/用一段连续的中文长句/);
      } finally {
        instance.unmount();
      }
    });
  }, 40000);

  test('非 TTY（stdout.columns/rows 读不到）：条目不得塌成省略号', async () => {
    await withTerm({ rows: null, cols: null }, async () => {
      const { instance, stdout, stdin } = await mountCcApp();
      try {
        const { frame } = await openAndWalk(stdout, stdin, '\x12', 2);
        expect(frame).not.toMatch(/ERROR/);
        // 病灶：NaN 宽度 → clipLine 落到地板 4 → 整列画成「h...」
        expect(frame).toMatch(/hist-\d\d/);
        expect(frame).not.toMatch(/h\.\.\./);
      } finally {
        instance.unmount();
      }
    });
  }, 30000);

  test('Ctrl+O 转录视图：元素类型合法（不报 Element type is invalid）', async () => {
    await withTerm({}, async () => {
      const { instance, stdout, stdin } = await mountCcApp();
      try {
        const { frame } = await openAndWalk(stdout, stdin, '\x0f', 0);
        expect(frame).not.toMatch(/ERROR/);
        expect(frame).toMatch(/转录视图|Esc/);
      } finally {
        instance.unmount();
      }
    });
  }, 30000);
});

describeOrSkip('CcHistorySearch：窗口跟随到第 13 条后，Enter 交出的就是看见的那条', () => {
  beforeAll(() => { mockHistoryEntries = ENTRIES.slice(); });

  test('↓×12 + Enter → onSelect(第 13 条)', async () => {
    await withTerm({}, async () => {
      await rt.loadInk();
      const ink = rt.get();
      const { CcHistorySearch } = require('../../src/cli/tui/ink-components/CcViewStack');
      let picked = null;
      const stdout = fakeStdout();
      const stdin = pressableStdin();
      const instance = ink.render(
        React.createElement(CcHistorySearch, {
          onSelect: (entry) => { picked = entry; },
          onClose: () => {},
        }),
        { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
      );
      try {
        await wait(400);
        for (let i = 0; i < 12; i += 1) {
          stdin.push(DOWN);
          await wait(120);
        }
        stdin.push('\r');
        await wait(400);
        expect(picked).toBe(TWELFTH);
      } finally {
        instance.unmount();
      }
    });
  }, 40000);
});

/**
 * ── BUG-76：转录视图（Ctrl+O）的行/宽预算 ────────────────────────────────
 *
 * 缺陷本体（实测 AU/repro-before-bug76.txt）：`VISIBLE_WINDOW = 8` 是**条数**，
 * 而一条消息至少 2 行（头 + 正文）、展开工具后更多，正文还不按显示宽度裁 →
 * 12 条消息恒画 30 行，**与终端行数无关**（80×24 与 80×12 都是 30 行），
 * ink 因此走全屏分支：按 8 次 ↓ = 8 次 \x1b[2J = 8 份整屏残影。
 *
 * 这里的判据：帧高随终端收缩、每行不超终端宽、重画不触发 2J、
 * 且「选中那条」永远在屏上（窗口锚在选中项，与 BUG-61/71/72 同一条判据）。
 */
// 270 个汉字 ≈ 540 显示列 → 在 78 列内宽下折 8 行，必然超过 CONTENT_ROW_CAP(4)。
const LONG_BODY = '这是一段很长的回复：' + '需要先看日志，再定位问题；'.repeat(20);
const TRANSCRIPT = Array.from({ length: 12 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  model: i % 2 ? 'claude-x' : '你',
  timestamp: 1760000000000 + i * 60000,
  content: i % 2 ? LONG_BODY : `第 ${i + 1} 条消息`,
  steps: i % 4 === 0 ? [{ tool: 'read', input: 'a.js', result: 'ok' }] : undefined,
}));

async function mountTranscript({ rows = ROWS, cols = COLS, messages = TRANSCRIPT } = {}) {
  await rt.loadInk();
  const ink = rt.get();
  const { CcTranscriptView } = require('../../src/cli/tui/ink-components/CcTranscriptView');
  const stdout = fakeStdout(rows, cols);
  const stdin = pressableStdin();
  // 门控由**调用方**在挂载前后设置/还原：ccLayout.isEnabled() 每次渲染都读 env，
  // 挂载时就还原会让「重画那一帧」悄悄回到新语义，负控制就量不到旧行为了。
  const instance = ink.render(
    React.createElement(CcTranscriptView, { messages, onClose: () => {}, cols, rows }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  await wait(450);
  const raw = stdout.getBuffer();
  const lines = stripAnsi(raw).split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { instance, stdout, stdin, raw, lines, height: lines.length };
}

describeOrSkip('转录视图 CcTranscriptView：帧高随终端收缩（BUG-76）', () => {
  test('transcriptWindow 纯函数：预算即行数，锚点在选中项，指示器对得上账', () => {
    const { transcriptWindow } = require('../../src/cli/tui/ink-components/CcTranscriptView');
    const mk = (anchor, budget, extra = {}) => transcriptWindow({
      messages: TRANSCRIPT, inner: 78, budget, anchor, ...extra,
    });
    for (const budget of [4, 8, 12, 20]) {
      for (const anchor of [0, 5, 11]) {
        const w = mk(anchor, budget, { isExpanded: () => false });
        expect(w.used).toBeLessThanOrEqual(budget);
        expect(w.visible.length).toBeGreaterThanOrEqual(1);
        expect(w.visible[0].index).toBe(anchor);   // 高亮恒在屏上
        expect(w.above + w.visible.length + w.below).toBe(TRANSCRIPT.length);
        for (const entry of w.visible) expect(entry.rows.length).toBeLessThanOrEqual(Math.max(2, budget));
      }
    }
    // 展开工具调用会多占行，但预算照样封顶
    const exp = mk(0, 8, { isExpanded: () => true });
    expect(exp.used).toBeLessThanOrEqual(8);
    // 门控关的旧语义：按条数取 8 条，不设行限
    const legacy = transcriptWindow({ messages: TRANSCRIPT, inner: 78, budget: Infinity, anchor: 0, maxItems: 8 });
    expect(legacy.visible.length).toBe(8);
  });

  test.each([24, 12, 8])('80×%i：帧高 ≤ 终端行数-1，无一行超宽，重画零次 \x1b[2J', async (rows) => {
    await withTerm({ rows }, async () => {
      const { instance, stdin, stdout, raw, lines, height } = await mountTranscript({ rows });
      try {
        expect(height).toBeLessThanOrEqual(rows - 1);
        const { displayWidth } = require('../../src/cli/formatters');
        expect(lines.filter((l) => displayWidth(l) > COLS)).toEqual([]);
        for (let i = 0; i < 6; i += 1) {
          stdin.push(DOWN);
          await wait(120);
        }
        expect(clearCount(stdout.getBuffer())).toBe(0);
      } finally {
        instance.unmount();
      }
      expect(clearCount(raw)).toBe(0);
    });
  }, 40000);

  test('正文被截时明说「另有 K 行」，不静默丢；↓×8 后选中的那条在屏上', async () => {
    await withTerm({}, async () => {
      const { instance, stdin, stdout, lines } = await mountTranscript({});
      try {
        expect(lines.join('\n')).toMatch(/… 另有 \d+ 行/);
        for (let i = 0; i < 8; i += 1) {
          stdin.push(DOWN);
          await wait(120);
        }
        // buffer 是 ink 的**增量帧序列**，这里只证明「选中那条确实被画过」；
        // 「不越屏 / 帧高随终端收缩」由上面那组用例逐行锁死。
        expect(stripAnsi(stdout.getBuffer())).toMatch(/第 9 条消息/);
      } finally {
        instance.unmount();
      }
    });
  }, 40000);

  test('负控制：门控 KHY_CC_OVERLAY_FIT=0 退回旧的「一屏 8 条」，矮终端重新溢出', async () => {
    await withTerm({ rows: 12 }, async () => {
      const saved = process.env.KHY_CC_OVERLAY_FIT;
      process.env.KHY_CC_OVERLAY_FIT = '0';
      let off;
      let on;
      try {
        on = await mountTranscript({ rows: 12 });
        off = on.height;
        expect(off).toBeGreaterThan(11);            // 旧语义不看行 → 顶破 12 行终端
        on.stdin.push(DOWN);
        await wait(250);
        expect(clearCount(on.stdout.getBuffer())).toBeGreaterThan(0);
      } finally {
        if (on) on.instance.unmount();
        if (saved === undefined) delete process.env.KHY_CC_OVERLAY_FIT;
        else process.env.KHY_CC_OVERLAY_FIT = saved;
      }
      const fit = await mountTranscript({ rows: 12 });
      try {
        expect(fit.height).toBeLessThanOrEqual(off - 1);
      } finally {
        fit.instance.unmount();
      }
    });
  }, 40000);
});

// ── BUG-77 / BUG-78：CcApp **主表面** 的行数账本与「不谎报状态」───────────────
//
// BUG-77：主表面的消息尾窗原本按 `1 + text.split('\n').length` 计费 —— 数的是
// **逻辑** 换行；而 `<Text>` 按**显示宽度**折行。一条 84 显示列的单行汉字回复在
// 80 列终端实画 2 行、只估 1 行，助手行还要为固定 1 列的 `●` + 空格少算 2 列。
// 实测（AU/repro-before-bug77.txt）：6 条长消息估算 12 行 / 实画 16 行（低估 25%），
// cap=10 收下 5 条 = 实画 13 行 → 帧高顶破 rows → 80×24 一次 \x1b[2J、80×12 六次。
// 同一函数的另一半病灶：`cap <= 0` 时旧分支「回吐全部消息」，恰好把 cap 想防的
// 整屏残影放大到最大（8 行终端上渲染 6 条 = 20 行帧）。
//
// BUG-78：`subAgents` 在挂载时被塞进**手写假数据**（「基本面分析师/风控经理」
// 「Running 2 agents…」「⏱ 40s」），且全仓再无第二处赋值 —— 真实会话从第一帧起
// 就常驻一行不存在的活动。这是谎报状态（规则 2 / RUNTIME-002），不是预览。
// 处置：默认不挂，KHY_CC_DEMO_AGENTS=1 显式打开（组件与其设计文档背书都不动）。
const REPLY_A = '这段回复故意写得很长，' + '一直不分行，看屏幕怎么处置它：'.repeat(2);
const REPLY_B = REPLY_A.slice(2) + '乙';
const REPLY_C = REPLY_A.slice(4) + '丙';

/** 走线上提交路径（handleSubmit 落 user 消息 + 桩 AI 500ms 后落 assistant），不手塞 state。 */
async function submitAll(stdin, texts) {
  for (const t of texts) {
    stdin.push(t);
    await wait(200);
    stdin.push('\r');
    await wait(900);
  }
}

describeOrSkip('CcApp 主表面：消息尾窗按显示宽度计费（BUG-77）+ 不挂假 Agent 树（BUG-78）', () => {
  test('80×24 三条长消息：重画零次 \\x1b[2J，最后一条与输入行都在屏上', async () => {
    await withTerm({}, async () => {
      const { instance, stdout, stdin } = await mountCcApp();
      try {
        await submitAll(stdin, [REPLY_A, REPLY_B, REPLY_C]);
        const raw = stdout.getBuffer();
        const frame = stripAnsi(raw);
        expect(clearCount(raw)).toBe(0);
        // 尾窗的「留最后一条」判据不许因为计费变准而失效
        expect(frame).toMatch(/丙/);
        expect(frame).toMatch(/Send a message/);
        // 收起了就必须说出来 —— 静默丢消息比残影更难诊断
        expect(frame).toMatch(/已收起上方 \d+ 条消息/);
      } finally {
        instance.unmount();
      }
    });
  }, 40000);

  test('负控制：KHY_CC_MESSAGE_CAP=0（不窗口化）在同一场景重新溢出', async () => {
    await withTerm({}, async () => {
      const saved = process.env.KHY_CC_MESSAGE_CAP;
      process.env.KHY_CC_MESSAGE_CAP = '0';
      let on;
      let off;
      try {
        on = await mountCcApp();
        await submitAll(on.stdin, [REPLY_A, REPLY_B, REPLY_C, REPLY_A, REPLY_B, REPLY_C]);
        off = clearCount(on.stdout.getBuffer());
        expect(off).toBeGreaterThan(0);            // 全量渲染 → 帧高越过 24 行
      } finally {
        on.instance.unmount();
        if (saved === undefined) delete process.env.KHY_CC_MESSAGE_CAP;
        else process.env.KHY_CC_MESSAGE_CAP = saved;
      }
      const fit = await mountCcApp();
      try {
        await submitAll(fit.stdin, [REPLY_A, REPLY_B, REPLY_C, REPLY_A, REPLY_B, REPLY_C]);
        expect(clearCount(fit.stdout.getBuffer())).toBe(0);
      } finally {
        fit.instance.unmount();
      }
    });
  }, 60000);

  test('退化几何（80×8）：窗口归零也只留最后一条，绝不回吐全部', async () => {
    await withTerm({ rows: 8 }, async () => {
      const { instance, stdout, stdin } = await mountCcApp(8, COLS);
      try {
        await submitAll(stdin, [REPLY_A, REPLY_B, REPLY_C]);
        const frame = stripAnsi(stdout.getBuffer());
        const hidden = Number((frame.match(/已收起上方 (\d+) 条消息/) || [])[1] || '0');
        // 旧分支在此处渲染全部 6 条（帧高 20 行 vs 终端 8 行）；现在最多收起 5 条。
        expect(hidden).toBeLessThanOrEqual(5);
        expect(frame).toMatch(/Send a message/);   // 输入行永远在屏上
      } finally {
        instance.unmount();
      }
    });
  }, 40000);

  test('BUG-78：默认不出现假 Agent 树与假 ⏱；KHY_CC_DEMO_AGENTS=1 才回来', async () => {
    await withTerm({}, async () => {
      const plain = await mountCcApp();
      try {
        const frame = stripAnsi(plain.stdout.getBuffer());
        expect(frame).not.toMatch(/Running 2 agents/);
        expect(frame).not.toMatch(/基本面分析师/);
        expect(frame).not.toMatch(/⏱/);           // 那个 40s 是从假 stats 推算的
      } finally {
        plain.instance.unmount();
      }
      const saved = process.env.KHY_CC_DEMO_AGENTS;
      process.env.KHY_CC_DEMO_AGENTS = '1';
      const demo = await mountCcApp();
      try {
        const frame = stripAnsi(demo.stdout.getBuffer());
        expect(frame).toMatch(/Running 2 agents/);  // 门控走的是开关，不是删除
      } finally {
        demo.instance.unmount();
        if (saved === undefined) delete process.env.KHY_CC_DEMO_AGENTS;
        else process.env.KHY_CC_DEMO_AGENTS = saved;
      }
    });
  }, 40000);

  test('BUG-81：CcPromptInput 不裸读 process.stdout —— 非 TTY 时高度窗口仍生效', async () => {
    // 结构守卫：全仓唯一允许读 stdout 尺寸的是 ../effectiveDims（DESIGN-ARCH-102 P4/H8）。
    // 注释里**故意**留着旧算式的原文（讲清病因），所以只扫非注释行。
    const fs = require('fs');
    const code = fs.readFileSync(
      require.resolve('../../src/cli/tui/ink-components/CcPromptInput.js'), 'utf8'
    ).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/process\.stdout/);
    // 同一条算式只许存在一份：组件与投影都必须走 ccLayout.inputRenderRows，
    // 谁再手写 `× 0.3` 谁就把「账本 vs 画面」的分叉重新埋回去（BUG-81 的根因）。
    const proj = fs.readFileSync(
      require.resolve('../../src/cli/tui/ink-components/ccMessageProjection.js'), 'utf8'
    );
    for (const [name, src] of [['CcPromptInput', code], ['ccMessageProjection', proj]]) {
      const bare = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(bare).toMatch(/inputRenderRows\(/);
      expect(bare).not.toMatch(/0\.3/);
    }

    // 行为守卫：rows 读不到时（conpty/管道）旧算式得 NaN ⇒ `len > NaN` 恒 false ⇒
    // 12 行输入原样画满（实测帧高 12）；现在只信宿主 maxRows=3 ⇒ 3 行 + 省略号。
    await withTerm({ rows: null, cols: null }, async () => {
      await rt.loadInk();
      const { CcPromptInput } = require('../../src/cli/tui/ink-components/CcPromptInput');
      const ink = rt.get();
      const stdout = fakeStdout(24, COLS);
      const value = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行输入内容`).join('\n');
      const instance = ink.render(React.createElement(CcPromptInput, {
        value, onChange() {}, onSubmit() {}, cols: COLS, maxRows: 3,
      }), { stdout, stdin: pressableStdin(), exitOnCtrlC: false, patchConsole: false });
      try {
        await wait(500);
        const painted = stripAnsi(stdout.getBuffer()).split('\n').filter((l) => l !== '').length;
        expect(painted).toBeLessThanOrEqual(4);   // 3 行正文 + 1 行「上面还有 N 行」
        expect(painted).toBeGreaterThan(1);
      } finally {
        instance.unmount();
      }
    });
  }, 30000);

  test('BUG-82：状态栏段数拉满仍恒 1 行 —— 账本给 1 行，画就不许出 2 行', async () => {
    await rt.loadInk();
    const ink = rt.get();
    const { CcStatusLine } = require('../../src/cli/tui/ink-components/CcStatusLine');
    const { visWidth } = require('../../src/cli/tui/wrapCell');
    // 八段同时给满：模型 │ 上下文 │ 费用 │ vim │ ⏱ │ 模式 │ ⚡命中率 │ MCP。
    // 旧实现只看列数阈值（>=50 / >=80 / >=90）决定段落有无，行宽从不参与，
    // 实测 90 列折成 2 行 —— 整帧比终端高 1 行 ⇒ ink 走全屏分支写 \x1b[2J。
    const fat = {
      modelId: 'anthropic:claude-sonnet-4-5',
      contextUsed: 148000,
      cost: 3.72,
      vimMode: 'normal',
      taskEstimate: '2m',
      permissionProfile: 'acceptEdits',
      cacheHitRate: 82,
      mcpStatus: { servers: [{ name: 'a', state: 'connected' }, { name: 'b', state: 'failed' }] },
    };
    for (const cols of [40, 55, 60, 80, 90, 120]) {
      const stdout = fakeStdout(24, cols);
      const instance = ink.render(
        React.createElement(CcStatusLine, Object.assign({}, fat, { cols })),
        { stdout, stdin: pressableStdin(), exitOnCtrlC: false, patchConsole: false }
      );
      try {
        await wait(300);
        const lines = stripAnsi(stdout.getBuffer()).split('\n').filter((l) => l !== '');
        expect(lines.length).toBe(1);                        // 折一行就是重影
        expect(visWidth(lines[0])).toBeLessThanOrEqual(cols); // 也不许顶破列宽
      } finally {
        instance.unmount();
      }
    }
  }, 30000);
});

// ── BUG-89：空态画的行数必须就是行预算买到的行数 ─────────────────────────────
//
// `KHY_CC_VIEW_STACK=0` 的回退路径上，命令面板是 CcFuzzyPicker（`CcApp.js:790`）。
// 它的行预算 = `listRows({rows, chrome: 6, total})`，`total = 0` 时兜到地板 1 行；
// 但空态渲染的是 `Box { paddingY: 1 }` —— paddingY 上下各 1 行 + 文字 1 行 = **3 行**，
// 于是「账本 6+1=7 / 实画 6+3=9」（BUG-88② 的「预算之外多画」换表面重演）。
// 判据与另外三个 CC 浮层同一条：一帧严格小于 rows，且整段字节流里 \x1b[2J 计数为 0。
// 默认路径（CcCommandPalette）一并量：它空态**少**画 1 行（买到的行没有内容可画），
// 白留一行不越屏，与本体的「多画顶破屏幕」是两种病，故只按上限判。

const FUZZY_ITEMS = ['clear', 'compact', 'cost', 'copy', 'model', 'mcp', 'permissions']
  .map((v) => ({ label: `/${v}`, value: v, description: `desc-${v}` }));

/** 挂载浮层 → 逐字符喂真键盘过滤词 → 量**最后一帧**的框高（raw 里叠着增量帧）。 */
async function mountOverlay(element, { rows = ROWS, cols = COLS, query = '' } = {}) {
  await rt.loadInk();
  const ink = rt.get();
  const stdout = fakeStdout(rows, cols);
  const stdin = pressableStdin();
  const instance = ink.render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false });
  await wait(350);
  for (const ch of String(query)) {
    // eslint-disable-next-line no-await-in-loop
    await wait(60);
    stdin.push(ch);
  }
  await wait(350);
  const raw = stdout.getBuffer();
  const flat = stripAnsi(raw);
  // 圆角框（选择器/帮助菜单）与直角框（命令面板/历史搜索）都要认，否则量不到就没有帧。
  let start = -1;
  let end = -1;
  for (const [top, bottom] of [['╭', '╰'], ['┌', '└']]) {
    const s = flat.lastIndexOf(top);
    const e = s === -1 ? -1 : flat.indexOf(bottom, s);
    if (s > -1 && e > s && (start === -1 || s > start)) {
      start = s;
      end = e;
    }
  }
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const lines = flat.slice(start, end + 1).split('\n');
  return { instance, stdout, raw, lines, height: lines.length };
}

function mountFuzzy({ rows = ROWS, cols = COLS, query = '' } = {}) {
  const { CcFuzzyPicker } = require('../../src/cli/tui/ink-components/CcFuzzyPicker');
  const { helpMenuWidth } = require('../../src/cli/tui/utils/ccLayout');
  return mountOverlay(React.createElement(CcFuzzyPicker, {
    items: FUZZY_ITEMS,
    onSelect: () => {},
    onClose: () => {},
    maxWidth: helpMenuWidth(cols), // 与 CcApp 传给它的同一个宽
    cols,
    rows,
  }), { rows, cols, query });
}

/** 默认路径（KHY_CC_VIEW_STACK 开）的命令面板，与 CcApp.js 传的是同一组 props。 */
function mountPalette({ rows = ROWS, cols = COLS, query = '' } = {}) {
  const { CcCommandPalette } = require('../../src/cli/tui/ink-components/CcViewStack');
  return mountOverlay(React.createElement(CcCommandPalette, {
    onExecute: () => {},
    onClose: () => {},
    cols,
    rows,
  }), { rows, cols, query });
}

describeOrSkip('CC 命令浮层（两条路径）：空态不得多吃两行（BUG-89）', () => {
  // 帧高 = 账本 = chrome 6 + 买到的 1 行 = **7 行**，与终端多高无关。
  // 改前回吐 9 行（paddingY 上下各垫 1），在 8~9 行终端上顶破屏幕；
  // 只断言 `height <= rows-1` 会在 10/12 行放绿（9 <= 9），所以这里把 7 钉死。
  // rows ≤ 7 仍需 6 行装饰让位才装得下 —— 那是 BUG-89b，登记不修，见缺陷清单。
  test.each([12, 10, 9, 8])('80×%i：回退路径（CcFuzzyPicker）无匹配时帧高即账本 7 行且不擦屏', async (rows) => {
    await withTerm({ rows }, async () => {
      const r = await mountFuzzy({ rows, query: 'zzz' });
      try {
        expect(r.lines.join('\n')).toMatch(/No matches/); // 空态本身要说得出话
        expect(r.height).toBe(7);
        expect(r.height).toBeLessThanOrEqual(rows - 1);
        expect(clearCount(r.raw)).toBe(0);
      } finally {
        r.instance.unmount();
      }
    });
  }, 40000);

  test.each([12, 9, 8])('80×%i：默认路径（CcCommandPalette）无匹配时不越屏且不擦屏', async (rows) => {
    await withTerm({ rows }, async () => {
      const r = await mountPalette({ rows, query: 'zzz' });
      try {
        expect(r.lines.join('\n')).toMatch(/0 commands/);
        // 默认路径空态少画 1 行（买到的那行没东西可画）——白留一行，不越屏，
        // 与「多画顶破屏幕」是两种病，只按后者判。
        expect(r.height).toBeLessThanOrEqual(7);
        expect(r.height).toBeLessThanOrEqual(rows - 1);
        expect(clearCount(r.raw)).toBe(0);
      } finally {
        r.instance.unmount();
      }
    });
  }, 40000);

  test('有匹配与无匹配的帧高同一档（空态不比列表更占行）', async () => {
    await withTerm({ rows: 12 }, async () => {
      const empty = await mountFuzzy({ rows: 12, query: 'zzz' });
      try {
        const full = await mountFuzzy({ rows: 12, query: 'co' });
        try {
          expect(full.lines.join('\n')).toMatch(/\/copy/);
          expect(empty.height).toBeLessThanOrEqual(full.height);
        } finally {
          full.instance.unmount();
        }
      } finally {
        empty.instance.unmount();
      }
    });
  }, 40000);
});

// ── BUG-90：全局热键 `?` 在开浮层的同时把问号打进了输入框 ─────────────────────
//
// ink 的 `useInput` **不是互斥的**（BUG-86 已实测过同一件事）：挂载中的每个处理器都会
// 收到同一个按键。`CcApp.js:614` 的 `?` 分支 `setShowHelp(true)` 之后 `return`，
// 那个 `return` 只退出 CcApp 自己的处理器，管不到 `CcPromptInput.js:426` 的插入分支
// （它只要求 `!key.ctrl && !key.meta`）——于是这一键既开了菜单又写进了 value。
// 症状：按 `?` 看帮助、Esc 关掉，输入框里躺着一个来路不明的问号（80×24 / 60×14 /
// 80×12 三档终端全部复现，见 AU/repro-before-bug90.txt）。
// Legacy 没有这一族病灶，因为它把两件事写在**同一个**处理器里
// （`App.js:5261`：`if (!completion.active && input === '?' && value === '')`），
// `return` 天然互斥；并且它还多带一条 `value === ''` —— 正在打字时按 `?` 是打问号，
// 不是呼出帮助。CC 表面两条都缺。
//
// 判据分两半，各自钉死一个病因：
//   ① 空输入按 `?` → 帮助菜单该开，Esc 关掉后输入框**必须还是空的**；
//   ② 已有文字时按 `?` → 问号进文字，**不**开帮助菜单。

/** 字节流里**最后**一次画出的提示符行（首列是 `>`，全仓只有 CcPromptInput 画它）。
 *
 * ink 只重画**发生变化**的行，所以累积字节流不能用来判「某内容此刻不在屏上」
 * （浮层关掉后，它那些行的字节还留在流里）；但「最后一行的提示符写了什么」
 * 是当前帧的真值 —— 漏进输入框的问号必然要经这一行画出来。
 * 「菜单此刻不在屏上」由 AU/probe-overlay-residue.cjs 的 VT 屏幕模型判，见
 * AU/repro-before-bug90.txt。 */
function lastPromptLine(frame) {
  const lines = frame.split('\n').filter((l) => l.startsWith('>'));
  expect(lines.length).toBeGreaterThan(0); // 一行都没画 → 量具没量到输入框
  return lines[lines.length - 1];
}

describeOrSkip('CC 全局热键不得漏进输入框（BUG-90）', () => {
  test('80×24：`?` 开帮助菜单，Esc 关掉后输入框仍然为空', async () => {
    await withTerm({}, async () => {
      const { instance, stdout, stdin } = await mountCcApp();
      try {
        stdin.push('?');
        await wait(600);
        // 量具自检：浮层没开就谈不上「关掉后残留」，先确认水印真的被画过。
        expect(stripAnsi(stdout.getBuffer())).toMatch(/Esc close/);
        stdin.push('\x1b');
        await wait(600);
        // 缺陷本体：提示符行上躺着一个来路不明的问号。
        expect(lastPromptLine(stripAnsi(stdout.getBuffer()))).not.toMatch(/\?/);
      } finally {
        instance.unmount();
      }
    });
  }, 40000);

  test('80×24：正在打字时按 `?` 只打问号，不呼出帮助菜单（Legacy 对齐）', async () => {
    await withTerm({}, async () => {
      const { instance, stdout, stdin } = await mountCcApp();
      try {
        stdin.push('a');
        await wait(300);
        stdin.push('?');
        await wait(600);
        const frame = stripAnsi(stdout.getBuffer());
        // 「不在屏上」这一句这里**能**判：整段流里从未写过水印，即菜单从未开过。
        expect(frame).not.toMatch(/Esc close/);
        expect(lastPromptLine(frame)).toMatch(/^> a\?/);
      } finally {
        instance.unmount();
      }
    });
  }, 40000);
});

// ── BUG-88b/89b：三个命令浮层的装饰让位梯 ────────────────────────────────────
//
// 改前 `CcCommandPalette` / `CcHistorySearch` / `CcFuzzyPicker` 把 chrome **写死 6**，
// `listRows()` 的地板再兜 1 行 → 帧高恒 7 行：`rows ≤ 7` 时 `7 >= rows` 撞进 ink 的
// 全屏分支，每次重画写一遍 \x1b[2J —— win32 conpty 下按一键就往回滚缓冲塞一份整屏
// 副本（改前数字见 AU/repro-before-bug89b.txt）。`CcHelpMenu` 在 BUG-88 已用
// `ccOverlayLayout.chromePlan` 修过同一件事，本片把同一台机器接到这三个浮层上。
//
// 守卫分三层，缺任何一层都会退化成「改个数字也算修好」：
//   ① 纯函数：逐档砍哪件、按什么顺序砍、账本多少行，钉死绝对值（不钉 `<= rows-1`，
//      那种断言在 10/12 行档放绿，正是 BUG-89 踩过的假绿）；
//   ② 真帧：让位在**画面上真的发生**了 —— 计划说砍 footer，帧里就不许再有 `Esc close`；
//      账本与帧高逐行对上，且装得下时 2J 零次；
//   ③ 回退档：门 `KHY_CC_OVERLAY_FIT=0` 时账本回到「chrome 恒 6、一件不让」的旧口径，
//      装饰照旧全画。门是这片的回滚杆，不测就等于没有。

const boxText = (lines) => lines.join('\n');

describeOrSkip('CC 浮层装饰让位梯：账本（纯函数，BUG-88b/89b）', () => {
  const stack = require('../../src/cli/tui/ink-components/CcViewStack');
  const fuzzy = require('../../src/cli/tui/ink-components/CcFuzzyPicker');

  // [rows, 面板/历史 chrome, 面板让位件, 选择器 chrome, 选择器让位件]（total = 0 空态）
  const EMPTY_LADDER = [
    [12, 6, '', 6, ''],
    [10, 6, '', 6, ''],
    [9, 6, '', 6, ''],
    [8, 6, '', 6, ''],
    [7, 5, 'spacer', 5, 'topRule'],
    [6, 4, 'spacer/rule', 4, 'topRule/bottomRule'],
    [5, 3, 'spacer/rule/footer', 3, 'topRule/bottomRule/hint'],
  ];

  test.each(EMPTY_LADDER)(
    '80×%i 空态：面板 chrome %i（让位 %s）· 选择器 chrome %i（让位 %s）',
    (rows, palChrome, palShed, fzChrome, fzShed) => {
      const p = stack.paletteChromePlan(rows, 0);
      const f = fuzzy.fuzzyChromePlan(rows, 0);
      expect(p.chrome).toBe(palChrome);
      expect(p.shed.join('/')).toBe(palShed);
      expect(f.chrome).toBe(fzChrome);
      expect(f.shed.join('/')).toBe(fzShed);
      expect(p.budget).toBeGreaterThanOrEqual(1); // 地板 1 行不许被砍没
    },
  );

  test('让位顺序固定为「最没用在前」，且 chrome 随终端变矮单调不升', () => {
    const order = stack.PALETTE_CHROME.shed.map((s) => s.name);
    expect(order).toEqual(['spacer', 'rule', 'footer']);
    // 底栏写着 `Esc close`，是唯一告诉用户怎么退出这一层的东西 → 必须最后砍。
    expect(order[order.length - 1]).toBe('footer');
    let prev = Infinity;
    for (const rows of [12, 10, 9, 8, 7, 6, 5, 4]) {
      const p = stack.paletteChromePlan(rows, 3);
      expect(p.chrome).toBeLessThanOrEqual(prev);
      prev = p.chrome;
      // 砍出来的件只能是顺序表的前缀，不许跳着砍。
      expect(p.shed).toEqual(order.slice(0, p.shed.length));
      if (rows >= 5) expect(p.chrome + p.budget).toBeLessThanOrEqual(rows - 1);
    }
  });

  test('门 KHY_CC_OVERLAY_FIT=0：账本回到旧口径（chrome 恒 6、一件不让）', () => {
    const saved = process.env.KHY_CC_OVERLAY_FIT;
    process.env.KHY_CC_OVERLAY_FIT = '0';
    try {
      for (const rows of [8, 7, 6, 5]) {
        expect(stack.paletteChromePlan(rows, 3)).toEqual({ chrome: 6, budget: 3, shed: [], fits: true });
        expect(stack.historyChromePlan(rows, 3)).toEqual({ chrome: 6, budget: 3, shed: [], fits: true });
        expect(fuzzy.fuzzyChromePlan(rows, 3)).toEqual({ chrome: 6, budget: 3, shed: [], fits: true });
      }
    } finally {
      if (saved === undefined) delete process.env.KHY_CC_OVERLAY_FIT;
      else process.env.KHY_CC_OVERLAY_FIT = saved;
    }
  });
});

describeOrSkip('CC 浮层装饰让位梯：画面真的按账本让位（真帧，BUG-88b/89b）', () => {
  const stack = require('../../src/cli/tui/ink-components/CcViewStack');
  const fuzzy = require('../../src/cli/tui/ink-components/CcFuzzyPicker');

  /** 帧高 = 计划 chrome（+ 空态那一句占的行数），且装得下时零次全屏擦除。 */
  async function expectLedger({ planOf, mount, rows, extra }) {
    await withTerm({ rows }, async () => {
      const r = await mount({ rows, query: 'zzz' });
      try {
        const plan = planOf(rows, 0);
        // 空态得说得出话——但底栏已让位的档除外：面板/历史的「0 commands」就写在
        // 底栏那一行上，砍掉底栏必然连带砍掉这句话。这正是 `chromePlan` 保守的代价：
        // 它按「列表至少 1 行」判装不下，若为留话而保底栏，列表态就会画到 5 = rows，
        // 又撞回全屏分支（见 PALETTE_CHROME 注释）。
        if (!plan.shed.includes('footer')) expect(boxText(r.lines)).toMatch(/No matches|0 commands/);
        expect(r.height).toBe(plan.chrome + extra);                 // 账本=画面，逐行对上
        expect(r.height).toBeLessThanOrEqual(rows - 1);
        expect(clearCount(r.raw)).toBe(0);                          // 不再走 ink 全屏分支
      } finally {
        r.instance.unmount();
      }
    });
  }

  // 面板/历史的空态不额外占行（「0 commands」就写在底栏里）；选择器单占 1 行。
  test.each([8, 7, 6, 5])('80×%i：默认路径（CcCommandPalette）帧高 = chrome', async (rows) => {
    await expectLedger({ planOf: stack.paletteChromePlan, mount: mountPalette, rows, extra: 0 });
  }, 40000);

  test.each([8, 7, 6, 5])('80×%i：回退路径（CcFuzzyPicker）帧高 = chrome + 1 行提示', async (rows) => {
    await expectLedger({ planOf: fuzzy.fuzzyChromePlan, mount: mountFuzzy, rows, extra: 1 });
  }, 40000);

  test.each([7, 6])('80×%i：底栏（唯一写着 Esc close 的行）还没到让位的时候', async (rows) => {
    await withTerm({ rows }, async () => {
      const r = await mountPalette({ rows, query: 'zzz' });
      try {
        expect(stack.paletteChromePlan(rows, 0).shed).not.toContain('footer');
        expect(boxText(r.lines)).toMatch(/Esc close/);
      } finally {
        r.instance.unmount();
      }
    });
  }, 40000);

  test('80×5：计划砍掉底栏，帧里就不许再画它（让位不许只记账不落画面）', async () => {
    await withTerm({ rows: 5 }, async () => {
      const r = await mountPalette({ rows: 5, query: 'zzz' });
      try {
        expect(stack.paletteChromePlan(5, 0).shed).toContain('footer');
        expect(boxText(r.lines)).not.toMatch(/Esc close/);
        expect(r.height).toBe(3);
        expect(clearCount(r.raw)).toBe(0);
      } finally {
        r.instance.unmount();
      }
    });
  }, 40000);

  test.each([7, 6, 5])('80×%i：历史搜索同机接线 —— 装得下且不擦屏', async (rows) => {
    // 不断言帧高逐行对上：`CcHistorySearch` 读的是**真实**历史文件（BUG-67 的修法），
    // 条数随机器变化。此处只钉「本族的病」——不越屏、不走全屏分支；
    // 账本对账由纯函数档（historyChromePlan）负责。
    await withTerm({ rows }, async () => {
      const r = await mountOverlay(React.createElement(
        require('../../src/cli/tui/ink-components/CcViewStack').CcHistorySearch,
        { onSelect: () => {}, onClose: () => {}, cols: COLS, rows }
      ), { rows, query: 'zzz' });
      try {
        expect(r.height).toBeLessThanOrEqual(rows - 1);
        expect(clearCount(r.raw)).toBe(0);
      } finally {
        r.instance.unmount();
      }
    });
  }, 40000);

  test('80×5 关门：装饰一件不让、帧高回到改前的老账本（门是回滚杆）', async () => {
    const saved = process.env.KHY_CC_OVERLAY_FIT;
    process.env.KHY_CC_OVERLAY_FIT = '0';
    try {
      await withTerm({ rows: 5 }, async () => {
        const r = await mountPalette({ rows: 5, query: 'zzz' });
        try {
          expect(boxText(r.lines)).toMatch(/Esc close/); // 全画，包括该让位的两件
          // 改前的老账本：chrome 恒 6（无地板：门关上时 `listRows` 走 legacy 分支，
          // 过滤到 0 条就是 0 行）→ 空态末帧 6 行；真正顶破屏幕的是**首帧全量列表**
          // （chrome 6 + 所有条目，与终端多高无关），见 AU/repro-before-bug89b.txt。
          expect(r.height).toBe(6);
        } finally {
          r.instance.unmount();
        }
      });
    } finally {
      if (saved === undefined) delete process.env.KHY_CC_OVERLAY_FIT;
      else process.env.KHY_CC_OVERLAY_FIT = saved;
    }
  }, 40000);
});

// ── 第 10 片：BUG-91 —— CcApp **主表面** busy 帧的地板（浮层之外的另一半）────
//
// 第 9 片把三个浮层的 chrome 接上了让位梯，80×6 的随机按键普查仍命中 9 次
// \x1b[2J —— 因为超屏的帧不是浮层，是宿主主表面。busy 帧地板 =
// 一条消息(2 行，含 marginTop 空行) + 思考行(2 行，含 marginTop) + 状态栏(1)
// + 输入框(2) = 7 行 = rows，而 logo 那三档在 rows ≤ 8 早已全让位。
// 复现/复诊存证：AU/repro-before-bug91.txt（80×5/6/7 各 3 帧带 2J）、
// AU/repro-after-bug91.txt（80×5..9 全 0；rows ≤ 4 是已登记地板 BUG-88b）。
describeOrSkip('CcApp 主表面 busy 帧：让位梯走到「空行」这一档（BUG-91）', () => {
  /** 提交三条短消息，覆盖「静置帧 / busy 帧 / 回答落地帧」三种几何。 */
  async function feedThree(stdout, stdin) {
    for (const t of ['第一条', '第二条', '第三条']) {
      stdin.push(t);
      await wait(180);
      stdin.push('\r');
      await wait(800);
    }
    return stdout.getBuffer();
  }

  /** 单次 write 的最大行数：ink 走全屏分支时那一笔必然写完整个 output。 */
  const maxWriteRows = (stdout) => Math.max(
    ...stdout.getWrites().map((w) => stripAnsi(w).replace(/\n$/, '').split('\n').length),
  );

  test('80×5 / 80×6 / 80×7：三条短消息全程零次 2J，且单笔写入不到 rows 行', async () => {
    for (const rows of [5, 6, 7]) {
      await withTerm({ rows }, async () => {
        const { instance, stdout, stdin } = await mountCcApp(rows, COLS);
        try {
          const raw = await feedThree(stdout, stdin);
          expect(raw).not.toMatch(/ERROR/);
          expect(clearCount(raw)).toBe(0);
          // 改前：80×7 上有一笔 7 行的整帧写入（= rows）→ 下一笔就是 2J。
          expect(maxWriteRows(stdout)).toBeLessThan(rows);
        } finally {
          instance.unmount();
        }
      });
    }
  }, 90000);

  test('让位不许只记账不落画面：账本承诺省几行，实画最高帧就少几行', async () => {
    const CB = require('../../src/cli/tui/chromeBudget');
    const { getLayout } = require('../../src/cli/tui/utils/ccLayout');
    for (const rows of [5, 6, 7, 8]) {
      const shares = { inputRows: getLayout(80, rows).inputMaxHeight };
      const plan = CB.ccChromePlan(rows, shares);
      // 基线**不**从 plan 取（那会自指：账本说没让位、画面也没让位时永远绿）。
      // 基线 = 「两条空行都在」的地板，即本组件族的物理形状（marginTop 1 ×2）。
      //
      // 破坏性验证（把 CcApp 三处 chromePlan.msgGap/busyGap 写死成「保留空行」，
      // 即只拆落点不拆账本）：80×5 本行数 4 → 5 且 2J 归 3 → 本断言失败；
      // 80×6/7/8 不变 —— 那里消息窗口 cap 还开着，账本用「少收一条消息」吸收了
      // 多画的这一行。所以逐高度断言**等式**而非只断言 `< rows`：等式在 rows=5
      // 才与「少收一条」这条路分得开。存证 AU/repro-after-bug91.txt 终态复诊。
      const base = CB.ccFrameFloorRows(shares, { msgGap: true, busyGap: true });
      const promised = (plan.msgGap ? 0 : 1) + (plan.busyGap ? 0 : 1);
      await withTerm({ rows }, async () => {
        const { instance, stdout, stdin } = await mountCcApp(rows, COLS);
        try {
          await feedThree(stdout, stdin);
          expect(maxWriteRows(stdout)).toBe(base - promised);
        } finally {
          instance.unmount();
        }
      });
    }
  }, 90000);

  // 前两条钉的是**字节流**（2J 计数、单笔写入行数）；这一条把字节流喂进 VT
  // 屏幕模型，按**此刻屏幕上的行号**判 —— 「画面最后一行行号 < rows」只有
  // 过屏幕模型才算数（累积流里两行相邻不代表屏幕相邻，BUG-90 同款教训）。
  // 空行数按当档 plan 推（busyGap 留不留都由账本定），断言的是形状与行号，
  // 不是写死的数字。
  test('80×5 / 80×6 / 80×7 busy 帧上真屏幕：思考行与消息之间的空行数 = 账本那一档', async () => {
    const CB = require('../../src/cli/tui/chromeBudget');
    const { getLayout } = require('../../src/cli/tui/utils/ccLayout');
    const { createScreen } = require('./vtScreen');
    for (const rows of [5, 6, 7]) {
      const plan = CB.ccChromePlan(rows, { inputRows: getLayout(80, rows).inputMaxHeight });
      await withTerm({ rows }, async () => {
        const { instance, stdout, stdin } = await mountCcApp(rows, COLS);
        try {
          stdin.push('第三条');
          await wait(180);
          stdin.push('\r');
          // busy 窗口只有 ~500ms（桩 AI 500ms 落回复），jest 机器慢时固定 280ms
          // 会拍到「还没进 busy」的帧。改为**轮询取景**：屏幕上凑齐「第三条 +
          // ● 思考中」这一帧才开枪；有界等待，超时把末次屏幕如实抛出（规则 3）。
          let sc = null;
          let rowMsg;
          const rowOfMsg = (s) => Array.from({ length: rows }, (_, i) => i)
            .find((i) => s.lineAt(i) === '第三条');
          const deadline = Date.now() + 2500;
          for (;;) {
            sc = createScreen(rows, 80);
            sc.feed(stdout.getBuffer());
            const rm = rowOfMsg(sc);
            if (rm !== undefined && /^● 思考中/.test(sc.lineAt(rm + 1 + (plan.busyGap ? 1 : 0)))) {
              rowMsg = rm;
              break;
            }
            if (Date.now() > deadline) {
              const dump = Array.from({ length: rows }, (_, i) => `${i}|${sc.lineAt(i)}`).join('\n');
              throw new Error(`busy 帧未在 2500ms 内出现（rows=${rows}）：\n${dump}`);
            }
            // eslint-disable-next-line no-await-in-loop
            await wait(80);
          }
          expect(rowMsg).toBeDefined();          // 用户消息此刻在屏上
          const expectDot = rowMsg + 1 + (plan.busyGap ? 1 : 0);
          if (plan.busyGap) expect(sc.lineAt(rowMsg + 1)).toBe('');       // 空行确实画在中间
          else expect(sc.lineAt(rowMsg + 1)).toMatch(/^● 思考中/);        // 让位后紧贴
          expect(sc.lineAt(expectDot)).toMatch(/^● 思考中/);
          let lastRow = -1;
          for (let i = rows - 1; i >= 0; i -= 1) if (sc.lineAt(i) !== '') { lastRow = i; break; }
          expect(lastRow).toBeLessThan(rows - 1); // 末行 < rows 且留 trailer（H1）
          expect(clearCount(stdout.getBuffer())).toBe(0);
        } finally {
          instance.unmount();
        }
      });
    }
  }, 90000);
});

// ── 第 10 片续：BUG-92 —— 让位判据必须知道「窗口恒留那条消息实画几行」──────
//
// BUG-91 的空行档只在 `cap < 2`（消息窗收到地板）时登场，而它写死的地板是
// 「一条 1 行消息」。一条折 2 行的 CJK 回复在 80×8 上：内容 2 + 思考行 2
// + 状态栏 1 + 输入框 2 = 7，账本以为还有富余 → 两条空行都留着 = 9 行 = rows
// → 每轮回答擦一次全屏。复现/复诊：AU/repro-before-bug92.txt（80×5..8 各 1 次
// 2J，把 ccGapPlan 写死成改前状态是 7/3/3/1）与同文件 after 段。
//
// ⚠ 病根不在算法而在**接线**：`ccLayout.ccChromePlan` 是 chromeBudget 的薄适配器，
// 写成两参形时新增的位置参数被静默吞掉 —— 账本自洽、画面不动。叶子档
// (tests/cli/tui/chromeBudget.test.js) 钉住了那条转发，本档钉住用户可见的结果。
describeOrSkip('CcApp 主表面 busy 帧：让位深度跟着内容行数走（BUG-92）', () => {
  // 82 显示列（41 个全角字）→ 80 列终端上实画 2 行。
  const LONG = '这段回复故意写得很长，' + '一直不分行，看屏幕怎么处置它：'.repeat(2) + '丙';

  async function feedLong(stdout, stdin) {
    stdin.push(LONG);
    await wait(200);
    stdin.push('\r');
    await wait(900);
    return stdout.getBuffer();
  }

  const maxWriteRows = (stdout) => Math.max(
    ...stdout.getWrites().map((w) => stripAnsi(w).replace(/\n$/, '').split('\n').length),
  );

  test('80×6 / 80×7 / 80×8：一条折 2 行的长消息全程零次 2J', async () => {
    for (const rows of [6, 7, 8]) {
      await withTerm({ rows }, async () => {
        const { instance, stdout, stdin } = await mountCcApp(rows, COLS);
        try {
          const raw = await feedLong(stdout, stdin);
          expect(clearCount(raw)).toBe(0);
          expect(maxWriteRows(stdout)).toBeLessThan(rows);
        } finally {
          instance.unmount();
        }
      });
    }
  }, 90000);

  test('帧高恰等于「内容 + 已让到位的空行」：富余不许以空行形式留在帧里', async () => {
    const CB = require('../../src/cli/tui/chromeBudget');
    const { visualRows } = require('../../src/cli/tui/wrapCell');
    const { getLayout } = require('../../src/cli/tui/utils/ccLayout');
    const contentRows = Math.max(1, visualRows(LONG, COLS));
    expect(contentRows).toBe(2); // 场景前提：这条消息确实折行，否则本档量不到 BUG-92
    for (const rows of [5, 6, 7, 8]) {
      const shares = { inputRows: getLayout(80, rows).inputMaxHeight };
      const plan = CB.ccChromePlan(rows, shares, contentRows);
      await withTerm({ rows }, async () => {
        const { instance, stdout, stdin } = await mountCcApp(rows, COLS);
        try {
          await feedLong(stdout, stdin);
          // 地板由 chromeBudget 自己算（守卫不复制公式）。rows=5 时它 = rows，
          // 即「内容本身比可让的空间还高」那一档 —— 已登记地板，如实钉住而不是回避。
          expect(maxWriteRows(stdout)).toBe(CB.ccFrameFloorRows(shares, plan, contentRows));
        } finally {
          instance.unmount();
        }
      });
    }
  }, 90000);

  // 窄列同样量一遍。60 列时同一条消息折 3 行，让位梯在 rows ≤ 7 已经**无档可让**
  // （两条空行都给了、横幅早已下线），帧高 = 内容 + 思考行 + 状态栏 + 输入框，
  // 物理上顶到 rows —— 这一档不假装能修好（那是新增「消息内部行窗口」的活，
  // 见缺陷清单第 12 片 BUG-93 / 规则 6 待答）。此处钉的是另一件事：
  // **饱和态下账本仍与画面逐行相等**，且「出现 2J」恰好等价于「地板 ≥ rows」。
  // 哪天有人往窄列帧里塞进一行没入账的 chrome（BUG-82 同族），等式先断。
  test('60 列 × 3 行内容：饱和态账本=画面，且 2J 与「地板 ≥ rows」同真假（BUG-93 证据）', async () => {
    const CB = require('../../src/cli/tui/chromeBudget');
    const { visualRows } = require('../../src/cli/tui/wrapCell');
    const { getLayout } = require('../../src/cli/tui/utils/ccLayout');
    const NARROW = 60;
    const LONG3 = `${LONG}${LONG}丙`;
    const contentRows = Math.max(1, visualRows(LONG3, NARROW - 2));
    expect(contentRows).toBe(3); // 场景前提：窄列把同一条消息折到 3 行
    for (const rows of [5, 6, 7, 8, 9]) {
      const shares = { inputRows: getLayout(NARROW, rows).inputMaxHeight };
      const plan = CB.ccChromePlan(rows, shares, contentRows);
      const floor = CB.ccFrameFloorRows(shares, plan, contentRows);
      await withTerm({ rows, cols: NARROW }, async () => {
        const { instance, stdout, stdin } = await mountCcApp(rows, NARROW);
        try {
          stdin.push(LONG3);
          await wait(200);
          stdin.push('\r');
          await wait(900);
          const clears = clearCount(stdout.getBuffer());
          expect(maxWriteRows(stdout)).toBe(floor);
          expect(clears > 0).toBe(floor >= rows);
        } finally {
          instance.unmount();
        }
      });
    }
  }, 90000);
});

describeOrSkip('CcApp 主表面：AgentTree 的行数必须进 chrome 账本（BUG-95）', () => {
  // 病灶（存证 AU/repro-before-bug95.txt / repro-after-bug95.txt）：旧 treeRows
  // `subAgents.length>0 && !expanded ? 1 : 0` 不知道渲染器是 `live||expanded`
  // 就吐全树 —— busy（live=true）帧实画 4 行树只记 1 行，cap 因此虚高，busy 帧
  // 顶到 `outputHeight >= rows`，ink 在**落回复那一帧**写 clearTerminal 讨债
  // （ink.js:322 的 lastOutputHeight 分支）→ 每轮一次整屏残影。
  // 演示档（KHY_CC_DEMO_AGENTS=1）是全仓唯一能喂 subAgents 的通路：真实后端
  // 尚无供数链路（BUG-78 门注释），故本守卫量的是**账本判据本身**。
  const CB = require('../../src/cli/tui/chromeBudget');
  const { getLayout } = require('../../src/cli/tui/utils/ccLayout');
  const { agentTreePaintRows } = require('../../src/cli/agentTreeView');
  const { createScreen } = require('./vtScreen');

  const maxWriteRows = (stdout) => Math.max(
    ...stdout.getWrites().map((w) => stripAnsi(w).replace(/\n$/, '').split('\n').length),
  );

  beforeAll(() => { process.env.KHY_CC_DEMO_AGENTS = '1'; });
  afterAll(() => { delete process.env.KHY_CC_DEMO_AGENTS; });

  // 演示树恒为 2 agents（1 个带 currentTool → detail 行）：header + ├ + │└ + └ = 4。
  const DEMO_AGENTS = [
    { name: '基本面分析师', status: 'running', stats: ['5 tool uses', '2.1s'], currentTool: 'Reading server.js', steps: [] },
    { name: '风控经理', status: 'completed', stats: ['3 tool uses', '1.5s'], steps: [] },
  ];
  const treeRows = agentTreePaintRows(DEMO_AGENTS);

  test('80×10 / 80×12 一轮「发送→落回复→Ctrl+T 展开」全程零次 2J', async () => {
    // 80×10 是判别档：改前 busy 帧 11 行 ≥ 10 → 落回复帧 1 次 2J；改后 busy 帧
    // 收到 9 行（空行让位梯照常生效），零次。展开态旧算式记 0，同样在这档断。
    expect(treeRows).toBe(4);
    for (const rows of [10, 12]) {
      await withTerm({ rows }, async () => {
        const { instance, stdout, stdin } = await mountCcApp(rows, COLS);
        try {
          stdin.push('甲');
          await wait(200);
          stdin.push('\r');
          await wait(900);
          stdin.push('\x14'); // Ctrl+T 展开
          await wait(600);
          expect(clearCount(stdout.getBuffer())).toBe(0);
        } finally {
          instance.unmount();
        }
      });
    }
  }, 90000);

  test('80×9 饱和档：busy 帧高恰等于「含全树」的地板账，且屏上树行数与账本同数', async () => {
    // rows ≤ 9 的演示树档是**已登记地板**（BUG-88b 口径）：树 4 + 消息 1 + 思考 1
    // + 状态栏 1 + 输入 2 = 9 = rows，装不下是内容事实，不粉饰。本例钉的是
    // 「账本 == 画面」这半边：地板若再少记一行（回归 treeRows=1，或未来给
    // AgentTree 加行忘了进 paintRows），等式先断，而不是悄悄多一次 2J。
    const rows = 9;
    const shares = { inputRows: getLayout(COLS, rows).inputMaxHeight, agentTreeRows: treeRows };
    const plan = CB.ccChromePlan(rows, shares, 1);
    await withTerm({ rows }, async () => {
      const { instance, stdout, stdin } = await mountCcApp(rows, COLS);
      try {
        stdin.push('甲');
        await wait(200);
        stdin.push('\r');
        await wait(900);
        stdin.push('\x14');
        await wait(600);
        expect(maxWriteRows(stdout)).toBe(CB.ccFrameFloorRows(shares, plan, 1));
        // 屏幕侧独立量一遍树占的行：展开后 header..最后一条子行连续排在回复之前。
        const sc = createScreen(rows, COLS);
        sc.feed(stdout.getBuffer());
        const replyRow = Array.from({ length: rows }, (_, i) => i)
          .find((i) => sc.lineAt(i).startsWith('● [预览]'));
        expect(replyRow).toBeDefined();
        expect(replyRow).toBe(treeRows); // 树把 0..treeRows-1 全占了
      } finally {
        instance.unmount();
      }
    });
  }, 90000);
});
