'use strict';

/**
 * ccMessageProjection ORACLE test (node:test) — 用 ink 的 `renderToString` 对拍。
 *
 * 这是 [DESIGN-ARCH-124] C3 方案的正确性基石：
 *   运行时走**手写纯字符串投影**（零 ink 开销，22 行帧 ~0.1ms vs
 *   renderToString 的 12.78ms）；正确性则由**真 ink 渲染**在这里背书 ——
 *   任何一个组件的视觉规则变了，本测试会立刻红，而不是等用户拖选出乱码。
 *
 * 树的来源：本文件复刻 `CcApp.js:560-645` 的主布局（用**真组件**，不是重写）。
 * 改动 CcApp 主布局时必须同步改这里，否则 oracle 失去权威性。
 *
 * 历史坑（已在组件侧消除，留档以免有人改回去）：
 *   原先 CcAssistantMessage 把 `●` 与正文做成**裸兄弟** Text。正文一长到接近
 *   终端宽度，yoga 就把 `●` 挤成 0 列 —— `●` 整个消失，且消息块凭空多出
 *   **条数不可预测**的 1~2 个空行。那种布局下投影的行号必然与屏幕错位，
 *   拖选复制会选到相邻行。现在 `●` 包在 `width:1 / flexShrink:0` 的 Box 里，
 *   布局确定，本测试因此可以做到**零容忍**的逐字节对拍。
 *
 * Run: `node --test tests/cli/tui/ccMessageProjection.oracle.test.js`
 */

// chalk 在模块求值时读一次 env，必须在任何 require 之前置顶，
// 否则 level=0 → ink 的 inverse/颜色一字节不吐，对拍全假红。
process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';

const assert = require('node:assert');
const test = require('node:test');
const path = require('path');

const TUI = path.resolve(__dirname, '../../../src/cli/tui');
const INK_COMP = path.join(TUI, 'ink-components');

// pnpm 双 React 实例：必须解析到 tui 实际用的那份，否则 Invalid hook call。
const React = require(require.resolve('react', { paths: [TUI] }));

const stripAnsi = require(path.resolve(__dirname, '../../../src/utils/stripAnsi'));
const P = require(path.join(INK_COMP, 'ccMessageProjection'));
const { formatModelName, formatContext, formatCost } = require(path.join(TUI, 'utils/ccFormatters'));
const { getContextWindow } = require(path.join(TUI, 'utils/ccContextWindows'));

let ink = null;
let Comps = null;

async function loadOnce() {
  if (ink) {
    return;
  }
  const ir = require(path.join(TUI, 'inkRuntime'));
  // 真机 startInkApp() 走的就是这一步 —— 不能自己 import('ink')，会拿到另一份引用。
  await ir.loadInk();
  ink = ir.get();
  Comps = {
    CcLogo: require(path.join(INK_COMP, 'CcLogo')).CcLogo,
    CcAssistantMessage: require(path.join(INK_COMP, 'CcAssistantMessage')).CcAssistantMessage,
    CcStreamingMessage: require(path.join(INK_COMP, 'CcAssistantMessage')).CcStreamingMessage,
    CcStatusLine: require(path.join(INK_COMP, 'CcStatusLine')).CcStatusLine,
    CcPromptInput: require(path.join(INK_COMP, 'CcPromptInput')).CcPromptInput,
    CcToastContainer: require(path.join(TUI, 'components/CcToast')).CcToastContainer,
    CcMessageBar: require(path.join(TUI, 'components/CcMessageBar')).CcMessageBar,
  };
}

/**
 * 复刻 CcApp.js:560-645 的主布局（真组件）。
 * scene 字段与 projectCcScene 一一对应。
 */
function buildTree(scene) {
  const { Box, Text } = ink;
  const {
    CcLogo,
    CcAssistantMessage,
    CcStreamingMessage,
    CcStatusLine,
    CcPromptInput,
    CcToastContainer,
    CcMessageBar,
  } = Comps;
  const s = scene;
  const messages = Array.isArray(s.messages) ? s.messages : [];
  const status = s.status || {};

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(CcLogo, { subtitle: true }),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      s.hiddenCount > 0
        ? React.createElement(
            Text,
            { key: 'msg-window-hint', dimColor: true },
            P.windowHint(s.hiddenCount)
          )
        : null,
      messages.map((msg) =>
        msg.role === 'user'
          ? React.createElement(
              Box,
              { key: msg.id, marginTop: 1 },
              React.createElement(Text, null, msg.text)
            )
          : React.createElement(CcAssistantMessage, { key: msg.id, text: msg.text })
      ),
      s.busy ? React.createElement(CcStreamingMessage, { text: '思考中...' }) : null
    ),
    s.messageBar
      ? React.createElement(CcMessageBar, {
          type: s.messageBar.type,
          message: s.messageBar.message,
          suggestion: s.messageBar.suggestion,
          onClose: () => {},
        })
      : null,
    React.createElement(CcToastContainer, { toasts: s.toasts || [], onDismiss: () => {} }),
    React.createElement(CcStatusLine, {
      modelId: status.modelId,
      contextUsed: status.contextUsed || 0,
      cost: status.cost || 0,
      cols: s.cols,
      mcpStatus: status.mcpStatus || null,
      permissionProfile: status.permissionProfile || null,
      cacheHitRate: status.cacheHitRate == null ? null : status.cacheHitRate,
      vimMode: status.vimMode || null,
      taskEstimate: status.taskEstimate || null,
    }),
    React.createElement(CcPromptInput, {
      value: (s.prompt && s.prompt.value) || '',
      onChange: () => {},
      onSubmit: () => {},
      busy: !!(s.prompt && s.prompt.busy),
      cols: s.cols,
      maxRows: (s.prompt && s.prompt.maxRows) || 10,
    })
  );
}

/** 渲染成纯文本行数组。 */
function oracleLines(scene) {
  const out = ink.renderToString(buildTree(scene), { columns: scene.cols });
  return stripAnsi(out).replace(/\n$/, '').split('\n');
}

/** 把 oracle 需要的 status 换算成投影要的已格式化片段。 */
function statusFor(status, cols) {
  const st = status || {};
  return {
    cols,
    modelName: formatModelName(st.modelId),
    contextStr: formatContext(st.contextUsed || 0, getContextWindow(st.modelId)),
    cost: st.cost || 0,
    costStr: formatCost(st.cost || 0),
    vimMode: st.vimMode || null,
    taskEstimate: st.taskEstimate || null,
    permissionProfile: st.permissionProfile || null,
    cacheHitRate: st.cacheHitRate == null ? null : st.cacheHitRate,
    mcpStatus: st.mcpStatus || null,
  };
}

function compare(name, scene) {
  const want = oracleLines(scene);
  const got = P.projectCcScene(
    Object.assign({}, scene, {
      status: statusFor(scene.status, scene.cols),
    })
  ).lines;

  const n = Math.max(want.length, got.length);
  const diffs = [];
  for (let i = 0; i < n; i++) {
    if (want[i] !== got[i]) {
      diffs.push(
        '  row ' + i + '\n    ink : |' + fmt(want[i]) + '|\n    proj: |' + fmt(got[i]) + '|'
      );
    }
  }
  assert.strictEqual(
    diffs.length,
    0,
    name + ' 与 ink 渲染不一致（' + diffs.length + ' 行）:\n' + diffs.join('\n')
  );
  // 顺带锁住不变式
  assert.strictEqual(got.length, want.length, name + ' 行数不符');
}

function fmt(v) {
  return v === undefined ? '<MISSING>' : v;
}

// ── 场景 ────────────────────────────────────────────────────────────────────

const MODEL = 'Khy-4';

test('oracle: 空会话（只有 chrome）', async () => {
  await loadOnce();
  for (const cols of [60, 80, 100, 120]) {
    compare('空会话 cols=' + cols, { cols, rows: 24, messages: [], status: { modelId: MODEL } });
  }
});

test('oracle: 状态栏段数拉满 —— 恒 1 行且投影与画一致（BUG-82）', async () => {
  await loadOnce();
  // 模型 │ 上下文 │ 费用 │ vim │ ⏱ │ 模式 │ ⚡命中率 │ MCP 八段同时给：
  // 旧实现在 90 列就把这一条折成 2 行，而账本只给状态栏记 1 行 ⇒ 整帧比终端高
  // 1 行 ⇒ ink 走全屏分支写 \x1b[2J（win32 重影）。`compare` 会同时校验
  // 「行数相等」与「逐行内容相等」，任何一边重新折行都会立刻报出来。
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
  for (const cols of [40, 55, 60, 80, 90, 100, 120]) {
    compare('状态栏拉满 cols=' + cols, {
      cols, rows: 24, messages: [], status: fat,
    });
  }
});

test('oracle: user + assistant 短文本', async () => {
  await loadOnce();
  for (const cols of [60, 80, 120]) {
    compare('短文本 cols=' + cols, {
      cols,
      rows: 24,
      messages: [
        { id: 1, role: 'user', text: '你好' },
        { id: 2, role: 'assistant', text: '这是一条回复' },
      ],
      status: { modelId: MODEL },
    });
  }
});

test('oracle: CJK 长文本触发软换行（前缀四情形）', async () => {
  await loadOnce();
  for (const cols of [60, 80]) {
    compare('CJK 软换行 cols=' + cols, {
      cols,
      rows: 24,
      messages: [
        {
          id: 1,
          role: 'assistant',
          text: '这是一条很长的中文回复，用来验证按显示宽度折行而不是按码元切分。这是第二行的内容。',
        },
      ],
      status: { modelId: MODEL },
    });
  }
});

test('oracle: 多逻辑行（含 \\n）', async () => {
  await loadOnce();
  compare('多逻辑行', {
    cols: 60,
    rows: 24,
    messages: [
      { id: 1, role: 'user', text: '第一行\n第二行\n第三行' },
      { id: 2, role: 'assistant', text: '回应 A\n回应 B' },
    ],
    status: { modelId: MODEL },
  });
});

test('oracle: 长 ASCII 行软换行', async () => {
  await loadOnce();
  compare('长 ASCII', {
    cols: 60,
    rows: 24,
    messages: [{ id: 1, role: 'assistant', text: 'x'.repeat(120) }],
    status: { modelId: MODEL },
  });
});

// ── 已知偏差 ────────────────────────────────────────────────────────────────

/**
 * 超长无断点串（URL / base64 / 连续字符）是折行最容易错位的输入。
 * `●` 固定 1 列后这里已经是**确定性**布局，可以逐字节对拍 —— 不再留任何宽容度。
 */
test('零容忍：超长无断点串逐字节对拍（● 不再被挤没）', async () => {
  await loadOnce();
  for (const cols of [60, 80]) {
    for (const len of [30, 59, 60, 61, 119, 120, 200, 500]) {
      compare('超长串 cols=' + cols + ' len=' + len, {
        cols,
        rows: 24,
        messages: [{ id: 1, role: 'assistant', text: 'x'.repeat(len) }],
        status: { modelId: MODEL },
      });
      compare('CJK 长串 cols=' + cols + ' len=' + len, {
        cols,
        rows: 24,
        messages: [{ id: 1, role: 'assistant', text: '中'.repeat(Math.ceil(len / 2)) }],
        status: { modelId: MODEL },
      });
    }
  }
});

test('行数护栏：长度 × 列宽扫描，行号必须与 ink 一致', async () => {
  await loadOnce();
  const bodies = [
    'x'.repeat(30),
    'x'.repeat(59),
    'x'.repeat(60),
    'x'.repeat(61),
    'x'.repeat(150),
    '中'.repeat(20),
    '中'.repeat(40),
    '中'.repeat(80),
    'hello world '.repeat(12),
    'a\nb\nc',
    '中\n文\n混\n排',
  ];
  for (const cols of [20, 40, 60, 80, 100, 120]) {
    for (const role of ['assistant', 'user']) {
      for (const body of bodies) {
        const scene = {
          cols,
          rows: 24,
          messages: [{ id: 1, role, text: body }],
          status: { modelId: MODEL },
        };
        // 行数是拖选正确性的硬前提：差一行，选中的就是隔壁那行。
        compare('护栏 cols=' + cols + ' role=' + role, scene);
      }
    }
  }
});

// ── astral / emoji 覆盖（此前 bodies 全是 ASCII / CJK，无表情符号）────────────
//
// 折行用 wrap-ansi（与 ink 同一份依赖），消息又是左对齐 ⇒ 分段不因表情错位。
// 实测结论（.khy/.../AU/repro-bug109-scope.cjs）：
//   · 基本 astral 😀 / 旗帜 🇨🇳 / 变体选择符 ❤️ / 键帽 1️⃣ / 肤色 👍🏽 —— 两侧逐字节一致。
//   · 只有 ZWJ 序列 👨‍👩‍👧 分叉：ink 渲染剥离 U+200D、投影保留 ⇒ 行内内容不同（行数相等）。
//     与折行无关（单行也分叉），是**已知未修项 BUG-109**（修法属 ZWJ 归一化 Rule-6 决定）。
// 故拆两档：非-ZWJ 走严格逐行对拍（真·新增护栏），ZWJ 只钉「行数相等」硬护栏。
test('oracle: astral emoji / 旗帜 / 变体符 折行与投影逐行相等', async () => {
  await loadOnce();
  // 非-ZWJ 表情（基本 astral / 旗帜 / 变体选择符 / 键帽 / 肤色）实测两侧逐字节一致，
  // 做**严格**逐行对拍 —— 真正的、可回归的新护栏。
  const okBodies = [
    '部署完成 😀😀😀 一切正常',
    '中国 🇨🇳 旗帜 英国 🇬🇧 结尾',
    '红心 ❤️ 键帽 1️⃣ 变体选择符混排文本，再加一大段让它必然在窄列折行看锚点是否仍然对得上。',
    '点赞 👍🏽 鼓掌 👏🏿 肤色修饰符序列混排文本，也来一大段确保在窄列折行时锚点映射仍然正确。',
  ];
  for (const cols of [20, 24, 40, 60, 80]) {
    for (const role of ['assistant', 'user']) {
      for (const body of okBodies) {
        compare(
          'emoji cols=' + cols + ' role=' + role,
          { cols, rows: 24, messages: [{ id: 1, role, text: body }], status: { modelId: MODEL } }
        );
      }
    }
  }
});

// BUG-109：含 ZWJ 序列（👨‍👩‍👧 家庭 / 职业 / 情侣）时，ink 渲染把 U+200D 连接符从
// 画出的行里剥离，而投影保留 ⇒ 行内内容分叉（**行数仍相等**，非拖选行移位级破坏）。
// 归一化契约（两侧都保留 vs 都剥离）是 Rule-6 设计决定，未定 → 这里先只钉住
// 「行数相等」这条不塌的硬护栏；严格逐行 compare 留待修复后开启。
test('oracle: ZWJ emoji 行数护栏（内容暂不逐字节，见 BUG-109）', async () => {
  await loadOnce();
  const zwjBodies = [
    '家庭 👨‍👩‍👧 与单独 👍 皮肤 👍🏽 修饰',
    '混合 😀 中 🇨🇳 文 👨‍👩‍👧 本 ❤️ 结束，再加一大段让它必然在窄列折行看跨软换行锚点。',
  ];
  const stripLead = (arr) => {
    const i = arr.findIndex((l) => l.replace(/^\s+/, '').startsWith('●'));
    return i >= 0 ? arr.slice(i) : arr;
  };
  for (const cols of [20, 30, 40, 60, 80]) {
    for (const body of zwjBodies) {
      const scene = { cols, rows: 24, messages: [{ id: 1, role: 'assistant', text: body }], status: { modelId: MODEL } };
      const want = stripLead(oracleLines(scene));
      const got = stripLead(P.projectCcScene(
        Object.assign({}, scene, { status: statusFor(scene.status, cols) })
      ).lines);
      assert.strictEqual(got.length, want.length,
        `ZWJ 消息行数必须与 ink 相等（cols=${cols}）—— 差一行拖选即选隔壁行`);
    }
  }
});

test('oracle: messageBar + toasts', async () => {
  await loadOnce();
  compare('bar+toast', {
    cols: 80,
    rows: 24,
    messages: [{ id: 1, role: 'user', text: 'u' }],
    messageBar: { type: 'error', message: '出错了', suggestion: '重试' },
    toasts: [
      { id: 1, message: 'copied 3 lines', type: 'success' },
      { id: 2, message: 'rejected', type: 'error' },
    ],
    status: { modelId: MODEL },
  });
});

test('oracle: busy 流式行', async () => {
  await loadOnce();
  compare('busy', {
    cols: 80,
    rows: 24,
    messages: [{ id: 1, role: 'user', text: 'u' }],
    busy: true,
    status: { modelId: MODEL },
  });
});

test('oracle: 窗口化提示行', async () => {
  await loadOnce();
  compare('窗口化', {
    cols: 80,
    rows: 24,
    messages: [{ id: 1, role: 'user', text: 'u' }],
    hiddenCount: 7,
    status: { modelId: MODEL },
  });
});

test('oracle: 输入框多行 + 占位符', async () => {
  await loadOnce();
  compare('占位符', {
    cols: 80,
    rows: 24,
    messages: [],
    prompt: { value: '' },
    status: { modelId: MODEL },
  });
  compare('多行输入', {
    cols: 80,
    rows: 24,
    messages: [],
    prompt: { value: 'aaa\nbbb\nccc' },
    status: { modelId: MODEL },
  });
});

test('oracle: prompt busy 显示 thinking 占位', async () => {
  await loadOnce();
  compare('prompt busy', {
    cols: 80,
    rows: 24,
    messages: [],
    prompt: { value: '', busy: true },
    status: { modelId: MODEL },
  });
});

// ── 抽取正确性（不需要 ink，但放这里保证「渲染 ↔ 取词」同一场景被一起验证）──

test('oracle: 拖选命中原文（跨软换行不掺前缀、不插硬 \\n）', async () => {
  await loadOnce();
  const text = 'a'.repeat(80) + 'b'.repeat(80);
  const r = P.projectCcScene({
    cols: 60,
    rows: 24,
    messages: [{ id: 1, role: 'assistant', text }],
  });
  const first = r.lines.findIndex((l) => l.startsWith('●'));
  const last = r.lines.reduce((acc, l, i) => (r.anchors[i] ? i : acc), -1);
  const got = P.extractByAnchors(
    r,
    { anchor: { line: first, col: 2 }, head: { line: last, col: r.lines[last].length }, dragging: false }
  );
  assert.strictEqual(got, text, '整条拖选应还原原文（无 ●、无软换行硬 \\n）');
});
