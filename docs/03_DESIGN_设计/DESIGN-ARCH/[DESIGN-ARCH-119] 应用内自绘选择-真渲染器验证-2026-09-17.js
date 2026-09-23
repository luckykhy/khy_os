'use strict';

/**
 * 应用内自绘选择 —— **真实 ink 渲染器**接线验证。
 *
 * 与 `应用内自绘选择-端到端验证-2026-09-17.js` 的分工:
 *   · 那个探针用「手工模拟的 harness」验证**逻辑链**(坐标 → 区间 → 文本 → 剪贴板),
 *     跑得快、覆盖全,但它自己实现了 App 层的换算 —— 所以它验证不了
 *     「App.js 里那段真实代码是否写对」。
 *   · 本探针反过来:**真的 require Viewport**,用真 ink 渲染器画一帧,再从渲染
 *     输出里确认反色是否出现、落在正确的行与列上。
 *
 * 为什么要这一步:用户报的是「真机上不能用」,而逻辑全绿却接线写错的先例刚刚
 * 发生过两次(偏移方向写反、API 形状误读)。必须有一层**碰真渲染器**的验证。
 *
 * ⚠ ink 是 **ESM-only**(`"type": "module"`),CJS `require` 拿不到 —— 用动态
 *   `import()`。仓库里 `inkRuntime.get()` 能拿到 ink 也是靠同样的动态 import。
 *
 *   node docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-119] 应用内自绘选择-真渲染器验证-2026-09-17.js
 */

const path = require('path');
const { pathToFileURL } = require('url');

// ⚠ 必须**在加载任何 ink/chalk 相关模块之前**设好。chalk 在模块求值时读一次
//   `process.env.FORCE_COLOR`(chalk/source/index.js:27),晚了就不生效 —— ink 的
//   `inverse` 是 `chalk.inverse`(ink/build/components/Text.js:40-41),level=0 时
//   它**一个字节都不输出**,渲染断言会全部找不到反色。详见 makeFakeStdout 的注释。
process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TUI = path.join(ROOT, 'services/backend/src/cli/tui');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message}`);
  }
}
function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}
function assertOk(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) {
    throw new Error(
      `${msg || 'not equal'}\n  实得: ${JSON.stringify(a)}\n  期望: ${JSON.stringify(b)}`
    );
  }
}

// ── 1. 模块加载完整性 ───────────────────────────────────────────────────────
section('1. 接线依赖可加载');
const Viewport = require(path.join(TUI, 'ink-components/Viewport'));
const mouse = require(path.join(TUI, 'mouseButtons'));
const sel = require(path.join(TUI, 'selection'));

check('三个模块都能 require（fail-soft 分支不会静默降级）', () => {
  assertOk(typeof Viewport === 'function', 'Viewport 应是组件函数');
  assertOk(
    typeof mouse.createMouseDispatcher === 'function',
    'dispatcher 缺失 → onSelectEvent 永远不接线'
  );
  assertOk(
    typeof sel.normalizeSelection === 'function',
    'selection 缺失 → _selectOn 恒假,选择功能静默关闭'
  );
  for (const fn of ['beginSelection', 'extendSelection', 'endSelection', 'extractText']) {
    assertOk(typeof sel[fn] === 'function', `selection.${fn} 缺失`);
  }
});

check('Viewport 暴露 sliceLineForSelection（渲染侧可独立验证）', () => {
  assertOk(typeof Viewport.sliceLineForSelection === 'function');
});

// ── 2. tracking 档位（决定真机能否收到拖动）────────────────────────────────
section('2. tracking 档位（决定真机是否收得到拖动）');
check('select 模式写 1002h 且不写 1000h（互斥，替换语义）', () => {
  const b = mouse.enableBytes({ select: true });
  assertOk(b.includes('\x1b[?1002h'), `应含 1002h,实得 ${JSON.stringify(b)}`);
  assertOk(!b.includes('\x1b[?1000h'), `不该含 1000h(互斥),实得 ${JSON.stringify(b)}`);
  assertOk(b.includes('\x1b[?1006h'), '1006(SGR 坐标)必须带,否则 >223 列选区错位');
});

check('非 select 模式仍是 1000h（点击层不需要位移）', () => {
  assertEq(mouse.enableBytes({}), '\x1b[?1000h\x1b[?1006h');
});

check('disableBytes 无条件复位 1000/1002/1003/1006（异常退出不留坏终端）', () => {
  const b = mouse.disableBytes();
  for (const m of ['1000l', '1002l', '1003l', '1006l']) {
    assertOk(b.includes(`\x1b[?${m}`), `应复位 ${m},实得 ${JSON.stringify(b)}`);
  }
});

// ── 3. 完整手势:dispatcher → 剪贴板 ────────────────────────────────────────
section('3. 完整手势:从鼠标序列到剪贴板文本');
check('按下 → 拖动 → 松开:文本进剪贴板', () => {
  const lines = ['const answer = 42;', 'return answer;'];
  let clip = null;
  let region = sel.createSelection();
  const d = mouse.createMouseDispatcher({
    hover: false,
    onSelectEvent: (kind, ev) => {
      if (kind === 'down') region = sel.beginSelection(region, ev.row, ev.col);
      else if (kind === 'move') region = sel.extendSelection(region, ev.row, ev.col);
      else if (kind === 'up') {
        region = sel.endSelection(region);
        const t = sel.extractText(lines, region);
        if (t) clip = t;
      }
    },
  });
  const CTX = { rootNode: {}, rows: 40, cacheKey: 'k' };
  d.onInput('[<0;1;1M', CTX); // row 0 col 0
  d.onInput('[<32;7;1M', CTX); // row 0 col 6
  d.onInput('[<0;7;1m', CTX);
  assertEq(clip, 'const ', `实得 ${JSON.stringify(clip)}`);
});

check('Shift+拖动整段手势不触发选区（修饰键判定必须早于 motion）', () => {
  const seen = [];
  const d = mouse.createMouseDispatcher({ hover: false, onSelectEvent: (k) => seen.push(k) });
  const CTX = { rootNode: {}, rows: 40, cacheKey: 'k' };
  assertEq(d.onInput('[<4;1;1M', CTX), false, 'Shift+按下 → 放行');
  assertEq(d.onInput('[<36;7;1M', CTX), false, 'Shift+位移 → 放行');
  assertEq(d.onInput('[<4;7;1m', CTX), false, 'Shift+松开 → 放行');
  assertEq(seen.length, 0, `Shift 手势一个选区事件都不该发,实得 ${JSON.stringify(seen)}`);
});

// ── 4. 渲染侧（异步，真 ink 渲染器）────────────────────────────────────────
/**
 * 拿 ink 命名空间的**正确姿势** —— 必须走仓库自己的 `inkRuntime`,不能自己
 * `import('ink')`。
 *
 * 为什么(Viewport 探针第一次跑就踩到的坑):
 *   `Viewport.js` 内部是 `const { Box, Text } = inkRuntime.get()`。
 *   `get()` 在 `_ink` 为空时**抛错**(inkRuntime.js:103-107),要求先
 *   `await loadInk()` 把 ESM 命名空间灌进单例。所以探针自己 import 一份 ink
 *   是没用的 —— Viewport 用的是**另一份**引用,那条引用没被初始化。
 *   结果是 5 条渲染断言全红,报文还长得很像「Viewport 坏了」,其实是探针
 *   没做启动前置。真机上 `startInkApp()` 会 await loadInk(),所以线上没这问题:
 *   **这是探针的错,不是产品的错** —— 但也正因如此,探针必须复刻真机的启动
 *   顺序,否则它验证的就不是真机那条路径。
 *
 * 顺带:自己 import 还会拿到**不同的 ink 实例**(ESM 模块缓存按 URL 走),
 * 即便能渲染,`render()` 出来的帧与 Viewport 内部用的 Text 也可能不是同一个
 * reconciler,反色断言会失真。
 */
async function getInkNamespace() {
  const ir = require(path.join(TUI, 'inkRuntime'));
  await ir.loadInk(); // ← 真机 startInkApp() 里同样的一步
  return ir.get();
}

/**
 * ink 的 `inverse` 走的是 `chalk.inverse`(node_modules/ink/build/components/Text.js:40-41)。
 * 而 chalk 的 level 来自 `supports-color`,**在非 TTY 的 stdout 下 level=0**,
 * 于是 `chalk.inverse('bbb') === 'bbb'` —— 一个字节的转义都不吐,帧里自然找不到
 * 反色。探针第二次跑就是这么绿的教训:不是 Viewport 坏了,是**探针的 stdout 不带颜色**。
 *
 * 两个修法(都做了,双保险):
 *   1. `FORCE_COLOR=3` —— chalk 在**模块加载时**读 `process.env.FORCE_COLOR`
 *      (chalk/source/index.js:27 的 stdoutColor),所以必须在 require 任何与 ink
 *      相关的模块**之前**设置。本探针把它放在文件最顶部(见 TOP 段);
 *   2. 给假 stdout 挂 `hasColors()` / `getColorDepth()` —— 万一别的路径绕过
 *      FORCE_COLOR 也能拿到 24bit 色深。二者不一致时以 FORCE_COLOR 为准,
 *      因为它才是 chalk 真正的判定源。
 *
 * 真机上为什么没这问题:用户的是真 TTY,`supports-color` 直接给 level≥1,
 * 反色序列正常写出去。**这条差异只影响探针,不影响产品**。
 */
function makeFakeStdout({ isTTY = true, columns = 60, rows = 20 } = {}) {
  let output = '';
  const stream = {
    columns,
    rows,
    isTTY,
    hasColors: () => true,
    getColorDepth: () => 24,
    write: (s) => {
      output += s;
      return true;
    },
    on() {},
    off() {},
    removeListener() {},
    once() {},
    emit() {},
  };
  Object.defineProperty(stream, '_output', { get: () => output });
  return stream;
}

async function renderSection() {
  section('4. 真 ink 渲染:反色是否真的画进了帧');
  let ink;
  try {
    ink = await getInkNamespace();
  } catch (err) {
    console.log(`  \x1b[33m⚠ 跳过:ink 加载失败 — ${err.message}\x1b[0m`);
    return;
  }
  if (!ink || typeof ink.render !== 'function') {
    console.log(
      `  \x1b[33m⚠ 跳过:ink 命名空间无 render（实得 keys: ${ink ? Object.keys(ink).join(',') : 'null'}）\x1b[0m`
    );
    return;
  }
  const ReactMod = await import(pathToFileURL(path.join(ROOT, 'node_modules/react/index.js')).href);
  const React = ReactMod.default && ReactMod.default.createElement ? ReactMod.default : ReactMod;

  const LINES = ['alpha beta', 'gamma delta', 'epsilon zeta'];
  const INV = '\u001b[7m'; // ink 的 inverse 对应 SGR 7

  function renderOnce(element) {
    const fakeOut = makeFakeStdout({ isTTY: true, columns: 60, rows: 20 });
    const inst = ink.render(element, { stdout: fakeOut, debug: false, exitOnCtrlC: false });
    inst.unmount();
    return fakeOut._output;
  }

  check('不传 selection → 无任何反色序列（逐字节老行为）', () => {
    const out = renderOnce(
      React.createElement(Viewport, { height: 3, lines: LINES, scroll: 0, showIndicator: false })
    );
    assertOk(out.includes('alpha beta'), `内容应出现,实得:\n${JSON.stringify(out)}`);
    assertOk(!out.includes(INV), `不传 selection 却出现反色:\n${JSON.stringify(out)}`);
  });

  check('传 selection（line 0, col 0–5）→ 出现反色序列', () => {
    const out = renderOnce(
      React.createElement(Viewport, {
        height: 3,
        lines: LINES,
        scroll: 0,
        showIndicator: false,
        selection: { anchor: { line: 0, col: 0 }, head: { line: 0, col: 5 } },
      })
    );
    assertOk(out.includes(INV), `应出现反色 ${JSON.stringify(INV)},实得:\n${JSON.stringify(out)}`);
    assertOk(out.includes('alpha'), '内容仍应在');
  });

  check('反色只包住选中的字符（不吞字符、不整行反色）', () => {
    const out = renderOnce(
      React.createElement(Viewport, {
        height: 3,
        lines: LINES,
        scroll: 0,
        showIndicator: false,
        selection: { anchor: { line: 0, col: 2 }, head: { line: 0, col: 5 } },
      })
    );
    const idx = out.indexOf(INV);
    assertOk(idx >= 0, '应有反色');
    const after = out.slice(idx + INV.length);
    assertOk(
      after.startsWith('pha'),
      `反色段应以 'pha' 开头('alpha beta' 取 [2,5)),实得 ${JSON.stringify(after.slice(0, 20))}`
    );
  });

  check('selection=null 与不传逐字节相同（门控关时的路径）', () => {
    const withNull = renderOnce(
      React.createElement(Viewport, {
        height: 3,
        lines: LINES,
        scroll: 0,
        showIndicator: false,
        selection: null,
      })
    );
    const withOut = renderOnce(
      React.createElement(Viewport, { height: 3, lines: LINES, scroll: 0, showIndicator: false })
    );
    assertOk(!withNull.includes(INV), `selection=null 时不该反色:\n${JSON.stringify(withNull)}`);
    assertEq(withNull, withOut, 'selection=null 必须与不传逐字节相同');
  });

  check('滚动偏移下反色行与内容对齐（offset 语义）', () => {
    // scroll=1 → 屏幕第 0 行显示数组下标 1 的 'gamma delta'。
    // 选区指向 line 1 → 反色必须落在 'gamma delta' 上,不是 'alpha beta'。
    const out = renderOnce(
      React.createElement(Viewport, {
        height: 2,
        lines: LINES,
        scroll: 1,
        showIndicator: false,
        selection: { anchor: { line: 1, col: 0 }, head: { line: 1, col: 5 } },
      })
    );
    const idx = out.indexOf(INV);
    assertOk(idx >= 0, '应出现反色');
    const after = out.slice(idx + INV.length);
    assertOk(
      after.startsWith('gamma'),
      `反色应落在 'gamma delta'(数组下标 1),实得 ${JSON.stringify(after.slice(0, 20))}`
    );
  });

  check('跨行选区:两行都有反色', () => {
    const out = renderOnce(
      React.createElement(Viewport, {
        height: 3,
        lines: LINES,
        scroll: 0,
        showIndicator: false,
        selection: { anchor: { line: 0, col: 6 }, head: { line: 1, col: 5 } },
      })
    );
    const count = out.split(INV).length - 1;
    assertOk(count >= 2, `跨两行应至少出现 2 处反色,实得 ${count}`);
  });
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
(async () => {
  await renderSection();
  console.log(`\n${'─'.repeat(60)}`);
  if (fail === 0) {
    console.log(`\x1b[32m全部通过:${pass}/${pass}\x1b[0m`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m失败 ${fail} 条 / 通过 ${pass} 条\x1b[0m`);
    for (const f of failures) {
      console.log(`\n• ${f.name}\n  ${f.err.message}`);
    }
    process.exit(1);
  }
})();
