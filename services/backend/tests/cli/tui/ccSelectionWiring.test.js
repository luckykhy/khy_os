'use strict';

/**
 * ccSelectionWiring — CC 模式自绘选择的**端到端接线**契约（node:test）。
 *
 * 它守的不是某个纯函数的算术，而是「拼起来还对不对」——这类缺陷单测各自自洽时
 * 发现不了（[DESIGN-ARCH-124] §6.2）:
 *
 *   W1  **新布局 vs 投影逐行一致**。CcApp 把「已提交消息」这一段换成
 *      `<Viewport lines={projection 切片}>`，之上/之下仍是真组件。这条断言的是
 *      「换了渲染方式以后，屏幕行仍然 == 投影下标」—— 整个选择模型唯一的地基。
 *      ⚠ 这一点**不能靠推理**:Viewport 内部有 `showIndicator` 的额外一行、
 *      空行的 `line || ' '` 处理、`overflow:hidden` 的裁剪，任何一条都会让帧
 *      与投影差一行，而差一行 = 拖选整体错位。
 *   W2  row===index 不变式：取一个消息行，它的屏幕行号必须等于投影下标。
 *   W3  端到端拖选：down → move → up 之后，按锚点取出的文本 == 屏幕上那段原文。
 *   W4  跨软换行**不插硬 \n**（legacy 版的欠账，这里由 anchor.soft 兜住）。
 *   W5  门控真源：`selectGates` 与 Legacy 共用，不抄第二份。
 *
 * Run: `node --test tests/cli/tui/ccSelectionWiring.test.js`
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
const sel = require(path.join(TUI, 'selection'));
const gates = require(path.join(TUI, 'utils/selectGates'));
const { formatModelName, formatContext } = require(path.join(TUI, 'utils/ccFormatters'));
const { getContextWindow } = require(path.join(TUI, 'utils/ccContextWindows'));

let ink = null;
let Comps = null;
let Viewport = null;

async function loadOnce() {
  if (ink) {
    return;
  }
  const ir = require(path.join(TUI, 'inkRuntime'));
  // 真机 startInkApp() 走的就是这一步 —— 不能自己 import('ink')，会拿到另一份引用。
  await ir.loadInk();
  ink = ir.get();
  Viewport = require(path.join(INK_COMP, 'Viewport'));
  Comps = {
    CcLogo: require(path.join(INK_COMP, 'CcLogo')).CcLogo,
    AgentTree: require(path.join(INK_COMP, 'AgentTree')),
    CcStreamingMessage: require(path.join(INK_COMP, 'CcAssistantMessage')).CcStreamingMessage,
    CcStatusLine: require(path.join(INK_COMP, 'CcStatusLine')).CcStatusLine,
    CcPromptInput: require(path.join(INK_COMP, 'CcPromptInput')).CcPromptInput,
    CcToastContainer: require(path.join(TUI, 'components/CcToast')).CcToastContainer,
  };
}

const MODEL = 'Khy-4';

/** 把 oracle 需要的 status 换算成投影要的已格式化片段。 */
function statusFor(modelId, cols) {
  return {
    modelName: formatModelName(modelId),
    contextStr: formatContext(0, getContextWindow(modelId)),
    cost: 0,
    cols,
  };
}

function project(scene) {
  return P.projectCcScene(
    Object.assign({}, scene, {
      status: statusFor(scene.status && scene.status.modelId, scene.cols),
    })
  );
}

/**
 * 复刻 **接线后** 的 CcApp 主布局：消息段走 `<Viewport lines=投影切片>`。
 * 与 CcApp.js 的 `_vpLines` 分支逐字同构 —— 改了那边必须改这里。
 */
function buildWiredTree(scene, proj) {
  const { Box, Text } = ink;
  const {
    CcLogo,
    AgentTree,
    CcStreamingMessage,
    CcStatusLine,
    CcPromptInput,
    CcToastContainer,
  } = Comps;
  const s = scene;
  const span = proj.spans.viewport;
  const lines = proj.lines.slice(span.start, span.end);
  const agents = Array.isArray(s.subAgents) ? s.subAgents : [];

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(CcLogo, { subtitle: true }),
    React.createElement(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      // AgentTree 是 CC 运行时**恒存在**的兄弟节点(2 个 demo agent),它一展开/
      // 折叠就改变上方行数 —— 投影算错了,拖选会整体错位。
      agents.length > 0
        ? React.createElement(AgentTree, {
            agents,
            expanded: !!s.agentTreeExpanded,
            live: !!s.busy,
          })
        : null,
      s.hiddenCount > 0
        ? React.createElement(
            Text,
            { key: 'msg-window-hint', dimColor: true },
            P.windowHint(s.hiddenCount)
          )
        : null,
      React.createElement(
        Box,
        { key: 'msg-viewport', flexShrink: 0, overflow: 'hidden' },
        React.createElement(Viewport, {
          lines,
          height: lines.length,
          scroll: 0,
          showIndicator: false,
        })
      ),
      s.busy ? React.createElement(CcStreamingMessage, { text: '思考中...' }) : null
    ),
    React.createElement(CcToastContainer, { toasts: s.toasts || [], onDismiss: () => {} }),
    React.createElement(CcStatusLine, {
      modelId: s.status && s.status.modelId,
      contextUsed: 0,
      cost: 0,
      cols: s.cols,
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

function wiredLines(scene, proj) {
  const out = ink.renderToString(buildWiredTree(scene, proj), { columns: scene.cols });
  return stripAnsi(out).replace(/\n$/, '').split('\n');
}

function fmt(v) {
  return v === undefined ? '<MISSING>' : v;
}

/** W1：接线后的真渲染 == 投影（逐行）。 */
function assertWiredMatches(name, scene) {
  const proj = project(scene);
  const want = wiredLines(scene, proj);
  const got = proj.lines;
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
    name + ' 接线后与投影不一致（' + diffs.length + ' 行）:\n' + diffs.join('\n')
  );
  assert.strictEqual(got.length, want.length, name + ' 行数不符');
}

// ── W1 ──────────────────────────────────────────────────────────────────────

test('W-01: 消息段换成 Viewport 后，真渲染仍与投影逐行一致', async () => {
  await loadOnce();
  const LONG = '这是一条很长的回复，用来触发按词折行，跨越多个屏幕行，'.repeat(3);
  for (const cols of [40, 60, 80, 100, 120]) {
    for (const messages of [
      [],
      [{ id: 1, role: 'user', text: '你好' }],
      [
        { id: 1, role: 'user', text: '你好' },
        { id: 2, role: 'assistant', text: '这是一条回复' },
      ],
      [
        { id: 1, role: 'user', text: '解释一下这个仓库的目录结构' },
        { id: 2, role: 'assistant', text: LONG },
        { id: 3, role: 'user', text: '再详细一点' },
      ],
    ]) {
      assertWiredMatches(`cols=${cols} n=${messages.length}`, {
        cols,
        rows: 24,
        messages,
        status: { modelId: MODEL },
        prompt: { value: '', maxRows: 10 },
      });
    }
  }
});

test('W-02: 开启 busy（流式行）与 toast 后仍然一致', async () => {
  await loadOnce();
  assertWiredMatches('busy+toast', {
    cols: 80,
    rows: 24,
    messages: [
      { id: 1, role: 'user', text: '在吗' },
      { id: 2, role: 'assistant', text: '在的，请问需要什么帮助？' },
    ],
    busy: true,
    toasts: [{ id: 1, message: '已复制', type: 'success' }],
    status: { modelId: MODEL },
    prompt: { value: '', busy: true, maxRows: 10 },
  });
});

// CcApp 的 demo 子 agent（与 CcApp.js:92-128 逐字同构）—— AgentTree 会改变
// 消息段**上方**的行数，是「投影 vs 屏幕错位」最容易发生的地方。
const DEMO_AGENTS = [
  {
    id: 'agent-1',
    name: '基本面分析师',
    status: 'running',
    stats: ['5 tool uses', '2.1s'],
    currentTool: 'Reading server.js',
    steps: [
      { tool: 'Read', args: { file_path: '/src/server.js' } },
      { tool: 'Grep', args: { pattern: 'TODO' } },
    ],
  },
  {
    id: 'agent-2',
    name: '风控经理',
    status: 'completed',
    stats: ['3 tool uses', '1.5s'],
    steps: [{ tool: 'Read', args: { file_path: '/src/auth.js' } }],
  },
];

test('W-02b: 存在 AgentTree（CC 运行时恒有）时仍然一致', async () => {
  await loadOnce();
  for (const agentTreeExpanded of [false, true]) {
    for (const cols of [60, 80, 120]) {
      assertWiredMatches(`agentTree expanded=${agentTreeExpanded} cols=${cols}`, {
        cols,
        rows: 24,
        subAgents: DEMO_AGENTS,
        agentTreeExpanded,
        messages: [
          { id: 1, role: 'user', text: '分析一下' },
          { id: 2, role: 'assistant', text: '好的，正在分析。' },
        ],
        status: { modelId: MODEL },
        prompt: { value: '', maxRows: 10 },
      });
    }
  }
});

test('W-03: 消息被窗口化（hiddenCount>0）时提示行仍对齐', async () => {
  await loadOnce();
  assertWiredMatches('hidden=3', {
    cols: 80,
    rows: 24,
    hiddenCount: 3,
    messages: [{ id: 4, role: 'assistant', text: '最后一条' }],
    status: { modelId: MODEL },
    prompt: { value: 'hi', maxRows: 10 },
  });
});

// ── W2：row === index ───────────────────────────────────────────────────────

test('W-04: 屏幕行 == 投影下标（screenRowToIndex 恒等）', async () => {
  await loadOnce();
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [
      { id: 1, role: 'user', text: '第一句' },
      { id: 2, role: 'assistant', text: '第二句' },
    ],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  const total = proj.lines.length;
  for (let row = 0; row < total; row++) {
    assert.strictEqual(
      P.screenRowToIndex(row, 0, total, total),
      row,
      'row ' + row + ' 必须等于下标 —— 不等就说明投影与屏幕差了一行'
    );
  }
  // 越界必须 clamp，不能返回 NaN / undefined
  assert.strictEqual(P.screenRowToIndex(total + 50, 0, total, total), total - 1);
});

// ── W3：端到端拖选 ──────────────────────────────────────────────────────────

test('W-05: down → move → up 取出的文本 == 屏幕上那段原文', async () => {
  await loadOnce();
  const TEXT = '这是一条可以被拖选的回复内容';
  const proj = project({
    cols: 80,
    rows: 24,
    messages: [
      { id: 1, role: 'user', text: '你好' },
      { id: 2, role: 'assistant', text: TEXT },
    ],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  // 找到 assistant 正文所在行（有锚点的最后一行）
  const last = proj.anchors.reduce((acc, a, i) => (a ? i : acc), -1);
  assert.ok(last >= 0, '投影里必须有锚点行');
  const rowText = proj.lines[last];
  assert.ok(rowText.includes('这是一条'), '该行应含正文: |' + rowText + '|');

  // ⚠ 鼠标给的是**显示列**，不是 UTF-16 下标。CJK 占 2 列，混用两种下标正是
  // 「看着选了 4 个字，只复制出 2 个」这类 bug 的来源 —— 这里显式按列算。
  // 该行形如 `● 这是一条可以被拖选的回复内容`：col0=●、col1=空格、col2 起是正文。
  assert.strictEqual(rowText.slice(0, 2), '● ', '首行前缀应为 ● + 空格');
  const fromCol = 2; // 正文第 0 列
  const toCol = 2 + 4 * 2; // 「这是一条」四个 CJK = 8 列
  let s = sel.beginSelection(null, last, fromCol);
  s = sel.extendSelection(s, last, toCol);
  s = sel.endSelection(s);
  const got = P.extractByAnchors(proj, s);
  assert.strictEqual(got, '这是一条', '拖选取出的必须是原文那一段，实际: ' + got);

  // 反向拖（从右往左）必须得到**同一段**文本，不能反着来。
  let r = sel.beginSelection(null, last, toCol);
  r = sel.extendSelection(r, last, fromCol);
  r = sel.endSelection(r);
  assert.strictEqual(P.extractByAnchors(proj, r), '这是一条', '反向拖选必须与正向同结果');
});

test('W-06: 跨行拖选 → 行间有 \\n；跨**软换行** → 无 \\n', async () => {
  await loadOnce();
  const LONG = '连续的长文本用来触发软换行 '.repeat(6);
  const proj = project({
    cols: 40,
    rows: 24,
    messages: [
      { id: 1, role: 'assistant', text: LONG },
      { id: 2, role: 'assistant', text: '第二条消息' },
    ],
    status: { modelId: MODEL },
    prompt: { value: '', maxRows: 10 },
  });
  // 同一条消息内跨软换行
  const firstAnchor = proj.anchors.findIndex((a) => a !== null);
  const sameMsgRows = [];
  for (let i = 0; i < proj.anchors.length; i++) {
    const a = proj.anchors[i];
    if (a && a.msgId === proj.anchors[firstAnchor].msgId) {
      sameMsgRows.push(i);
    }
  }
  assert.ok(sameMsgRows.length >= 2, '长消息必须折成多行，实际 ' + sameMsgRows.length);
  const softJoined = P.extractByAnchors(
    proj,
    sel.endSelection(
      sel.extendSelection(sel.beginSelection(null, sameMsgRows[0], 0), sameMsgRows[1], 3)
    )
  );
  assert.ok(!softJoined.includes('\n'), '软换行续段之间不该有硬 \\n: ' + JSON.stringify(softJoined));

  // 跨两条消息 → 必须有 \n
  const lastOfFirst = sameMsgRows[sameMsgRows.length - 1];
  const secondRow = proj.anchors.findIndex(
    (a, i) => a && i > lastOfFirst && a.msgId !== proj.anchors[firstAnchor].msgId
  );
  assert.ok(secondRow > 0, '应有第二条消息的锚点行');
  const crossJoined = P.extractByAnchors(
    proj,
    sel.endSelection(
      sel.extendSelection(sel.beginSelection(null, lastOfFirst, 0), secondRow, 2)
    )
  );
  assert.ok(crossJoined.includes('\n'), '跨消息必须带 \\n: ' + JSON.stringify(crossJoined));
});

// ── W5：门控真源 ────────────────────────────────────────────────────────────

test('W-07: 三个门控与 Legacy 共用同一叶子（不抄第二份）', () => {
  const off = { KHY_SELECT: '0', KHY_SELECT_CLIP: 'off', KHY_SELECT_DRAG: 'no' };
  assert.strictEqual(gates.selectEnabled(off), false);
  assert.strictEqual(gates.selectClipEnabled(off), false);
  assert.strictEqual(gates.selectDragEnabled(off), false);

  const on = {};
  assert.strictEqual(gates.selectEnabled(on), true, '未设置 → 开（用户报的故障要被修）');
  assert.strictEqual(gates.selectClipEnabled(on), true);
  assert.strictEqual(gates.selectDragEnabled(on), true);

  // 大小写 / 空格都必须被吃掉，否则 `KHY_SELECT=" 0 "` 会静默失效
  assert.strictEqual(gates.selectEnabled({ KHY_SELECT: ' OFF ' }), false);
});
