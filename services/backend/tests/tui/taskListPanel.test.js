'use strict';

/**
 * taskListPanel.test.js — 批3 常驻任务清单面板(缺口②)纯渲染决策测试。
 *
 * TaskListPanel 是无副作用的函数式组件(React.createElement),不依赖真实 ink 挂载:
 * 直接调用组件函数即可拿到返回的 React element 树(或 null)。我们 mock 掉 inkRuntime
 * (返回字符串标签)与 _taskStore.snapshot(),断言:
 *   - 有任务时渲染多行,行首图标 ✓/→/○ 原样保留,in_progress(→)行 cyan 高亮。
 *   - 空清单 / snapshot 抛错 → 返回 null(fault isolation,绝不拖垮 TUI)。
 *   - KHY_TASK_PANEL=0 → 返回 null(逃生阀)。
 */

const path = require('path');

const PANEL_PATH = path.resolve(__dirname, '../../src/cli/tui/ink-components/TaskListPanel');

// ink runtime stub — Box/Text become inert string tags so React.createElement
// yields a plain inspectable element tree (no ESM ink load). jest.mock is
// hoisted, so the module IDs must be literals (relative to this test file; jest
// resolves them to the same absolute path the component requires).
jest.mock(
  '../../src/cli/tui/inkRuntime',
  () => ({ get: () => ({ Box: 'box', Text: 'text' }) }),
  { virtual: false },
);

// _taskStore.snapshot() is the single source the panel renders. Each test sets
// mockSnap (a string) or mockThrow (to exercise fault isolation). The `mock`
// prefix is required by jest's hoisted-factory scoping rules.
let mockSnap = '';
let mockThrow = false;
jest.mock(
  '../../src/tools/_taskStore',
  () => ({
    snapshot: () => {
      if (mockThrow) throw new Error('store boom');
      return mockSnap;
    },
  }),
  { virtual: false },
);

// taskPanelState.getTasks() is the second source (plan-execution progress). The
// panel merges it with the _taskStore snapshot. mockPlanTasks drives it.
let mockPlanTasks = null;
jest.mock(
  '../../src/services/taskPanelState',
  () => ({ getTasks: () => mockPlanTasks }),
  { virtual: false },
);

const TaskListPanel = require(PANEL_PATH);

/** Flatten a React element tree's Text children into [{text, props}] rows. */
function collectTextRows(el) {
  const rows = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text') {
      const kids = node.props && node.props.children;
      const text = Array.isArray(kids) ? kids.join('') : String(kids == null ? '' : kids);
      rows.push({ text, props: node.props || {} });
      return;
    }
    const kids = node.props && node.props.children;
    if (Array.isArray(kids)) kids.forEach(visit);
    else if (kids) visit(kids);
  };
  visit(el);
  return rows;
}

describe('TaskListPanel (批3 常驻清单面板)', () => {
  const prevFlag = process.env.KHY_TASK_PANEL;
  const prevPlanFlag = process.env.KHY_PLAN_TASK_PANEL;

  beforeEach(() => {
    mockSnap = '';
    mockThrow = false;
    mockPlanTasks = null;
    delete process.env.KHY_TASK_PANEL;
    delete process.env.KHY_PLAN_TASK_PANEL;
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.KHY_TASK_PANEL;
    else process.env.KHY_TASK_PANEL = prevFlag;
    if (prevPlanFlag === undefined) delete process.env.KHY_PLAN_TASK_PANEL;
    else process.env.KHY_PLAN_TASK_PANEL = prevPlanFlag;
  });

  test('renders each snapshot line; in_progress (→) row is cyan-highlighted', () => {
    mockSnap = [
      '✓ #1 读取 repl.js',
      '→ #2 改 useQueryBridge',
      '○ #3 跑测试',
    ].join('\n');

    const el = TaskListPanel();
    expect(el).not.toBeNull();

    const rows = collectTextRows(el);
    // Header + 3 task lines. 刀28: header now carries the CC-aligned status count
    // (1 completed / 1 in_progress / 1 pending over the full set).
    expect(rows.some((r) => r.text === '任务清单（共 3 项:1 完成、1 进行中、1 待办）')).toBe(true);

    const inProgress = rows.find((r) => r.text.startsWith('→'));
    expect(inProgress).toBeTruthy();
    expect(inProgress.props.color).toBe('cyan');
    expect(inProgress.props.bold).toBe(true);

    const completed = rows.find((r) => r.text.startsWith('✓'));
    expect(completed.props.color).toBe('green');
    expect(completed.props.dimColor).toBe(true);
    // 刀23: completed line is struck through (aligns CC TaskListV2 strikethrough={isCompleted}).
    expect(completed.props.strikethrough).toBe(true);

    const pending = rows.find((r) => r.text.startsWith('○'));
    expect(pending.props.dimColor).toBe(true);
    expect(pending.props.color).toBeUndefined();
  });

  test('刀23: KHY_TASK_STRIKETHROUGH=0 → completed line keeps green/dim but no strikethrough', () => {
    const prev = process.env.KHY_TASK_STRIKETHROUGH;
    process.env.KHY_TASK_STRIKETHROUGH = '0';
    try {
      mockSnap = ['✓ #1 完成项', '○ #2 待办'].join('\n');
      const rows = collectTextRows(TaskListPanel());
      const completed = rows.find((r) => r.text.startsWith('✓'));
      expect(completed.props.color).toBe('green');
      expect(completed.props.dimColor).toBe(true);
      expect(completed.props.strikethrough).toBeUndefined(); // byte-revert to legacy
    } finally {
      if (prev === undefined) delete process.env.KHY_TASK_STRIKETHROUGH;
      else process.env.KHY_TASK_STRIKETHROUGH = prev;
    }
  });

  test('empty snapshot → null (no screen real estate)', () => {
    mockSnap = '';
    expect(TaskListPanel()).toBeNull();
    mockSnap = '   \n  ';
    expect(TaskListPanel()).toBeNull();
  });

  test('snapshot throwing → null (fault isolation, never crashes the TUI)', () => {
    mockThrow = true;
    expect(TaskListPanel()).toBeNull();
  });

  test('KHY_TASK_PANEL=0 → null even with tasks present (escape hatch)', () => {
    mockSnap = '→ #1 something';
    process.env.KHY_TASK_PANEL = '0';
    expect(TaskListPanel()).toBeNull();
  });

  test('plan-execution progress (taskPanelState) renders when _taskStore is empty', () => {
    // The exact gap: Ink executePlan seeds taskPanelState (not _taskStore), and the
    // panel must surface it above the input box.
    mockSnap = '';
    mockPlanTasks = [
      { description: '读取网关配置', status: 'completed' },
      { description: '改 resolver', status: 'in_progress' },
      { description: '跑测试', status: 'pending' },
      { description: '构建 wheel', status: 'error' },
    ];

    const el = TaskListPanel();
    expect(el).not.toBeNull();
    const rows = collectTextRows(el);

    const done = rows.find((r) => r.text === '✓ 读取网关配置');
    expect(done.props.color).toBe('green');
    const running = rows.find((r) => r.text === '→ 改 resolver');
    expect(running.props.color).toBe('cyan');
    expect(running.props.bold).toBe(true);
    const errored = rows.find((r) => r.text === '✗ 构建 wheel');
    expect(errored.props.color).toBe('red');
  });

  test('缺口②语义分区:两源并存 → 本会话清单 / 项目任务 分段(计划在会话段、#id 在项目段)', () => {
    mockSnap = '○ #1 模型 TodoWrite 项';
    mockPlanTasks = [{ description: '计划步骤 A', status: 'in_progress' }];

    const rows = collectTextRows(TaskListPanel()).filter((r) => !r.text.startsWith('任务清单'));
    // 分段标签 + 段内行:本会话清单(计划步骤)在前,项目任务(#id 持久化)在后。
    expect(rows[0].text).toBe('— 本会话清单 —');
    expect(rows[1].text).toBe('→ 计划步骤 A');
    expect(rows[2].text).toBe('— 项目任务 · 跨会话 —');
    expect(rows[3].text).toBe('○ #1 模型 TodoWrite 项');
  });

  test('KHY_TASK_PANEL_SPLIT=0 → 逐字节回退扁平合并(计划行在前,snapshot 行在后)', () => {
    const prev = process.env.KHY_TASK_PANEL_SPLIT;
    process.env.KHY_TASK_PANEL_SPLIT = '0';
    try {
      mockSnap = '○ #1 模型 TodoWrite 项';
      mockPlanTasks = [{ description: '计划步骤 A', status: 'in_progress' }];
      const rows = collectTextRows(TaskListPanel()).filter((r) => !r.text.startsWith('任务清单'));
      expect(rows[0].text).toBe('→ 计划步骤 A');
      expect(rows[1].text).toBe('○ #1 模型 TodoWrite 项');
      expect(rows.some((r) => r.text.startsWith('— '))).toBe(false); // 无分段标签
    } finally {
      if (prev === undefined) delete process.env.KHY_TASK_PANEL_SPLIT;
      else process.env.KHY_TASK_PANEL_SPLIT = prev;
    }
  });

  test('KHY_PLAN_TASK_PANEL=0 → plan progress ignored (byte revert to _taskStore-only)', () => {
    mockSnap = '';
    mockPlanTasks = [{ description: '计划步骤 A', status: 'in_progress' }];
    process.env.KHY_PLAN_TASK_PANEL = '0';
    expect(TaskListPanel()).toBeNull();
  });
});

describe('TaskListPanel — coordinated (props-driven) path (A+B 防跳顶)', () => {
  // When App passes `lines` (the SSOT it read & capped via liveRegionBudget), the
  // panel renders those verbatim and does NOT self-read the stores. This keeps the
  // panel height in agreement with StreamingBlock's reserve so the live region
  // stays < terminal rows (no fullscreen clear → no scroll-jump).
  const prevFlag = process.env.KHY_TASK_PANEL;

  beforeEach(() => {
    mockSnap = 'SELF-READ SHOULD NOT APPEAR'; // poison: coordinated mode must ignore the store
    mockThrow = false;
    mockPlanTasks = [{ description: 'plan self-read poison', status: 'in_progress' }];
    delete process.env.KHY_TASK_PANEL;
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.KHY_TASK_PANEL;
    else process.env.KHY_TASK_PANEL = prevFlag;
  });

  test('renders props.lines verbatim, ignoring the task stores (App is SSOT)', () => {
    const el = TaskListPanel({ lines: ['→ a', '✓ b', '○ c'], hidden: 0 });
    expect(el).not.toBeNull();
    const rows = collectTextRows(el);
    // 刀28: coordinated header counts over props.lines (1 done / 1 in_progress / 1 open).
    expect(rows.some((r) => r.text === '任务清单（共 3 项:1 完成、1 进行中、1 待办）')).toBe(true);
    expect(rows.some((r) => r.text === '→ a')).toBe(true);
    expect(rows.some((r) => r.text === '✓ b')).toBe(true);
    expect(rows.some((r) => r.text === '○ c')).toBe(true);
    // Store poison must NOT leak in.
    expect(rows.some((r) => r.text.includes('SELF-READ'))).toBe(false);
    expect(rows.some((r) => r.text.includes('plan self-read poison'))).toBe(false);
    // → row still cyan-highlighted in coordinated mode.
    const running = rows.find((r) => r.text === '→ a');
    expect(running.props.color).toBe('cyan');
  });

  test('缺口②协作路径:props.lines 两源并存 → 同样分段(App SSOT 供行,面板分区)', () => {
    // 协作路径下 App 已合并/截断,面板对 props.lines 施加同一 splitTaskLinesBySource。
    const el = TaskListPanel({ lines: ['→ 计划 A', '✓ #7 项目任务', '○ 会话待办'], hidden: 0 });
    const rows = collectTextRows(el).filter((r) => !r.text.startsWith('任务清单'));
    expect(rows[0].text).toBe('— 本会话清单 —');
    expect(rows[1].text).toBe('→ 计划 A');
    expect(rows[2].text).toBe('○ 会话待办');
    expect(rows[3].text).toBe('— 项目任务 · 跨会话 —');
    expect(rows[4].text).toBe('✓ #7 项目任务');
    // 分段不改样式:→ 行仍 cyan 高亮。
    expect(rows[1].props.color).toBe('cyan');
  });

  test('hidden > 0 → appends the cap notice row (刀30 default-on drops 末尾)', () => {
    const el = TaskListPanel({ lines: ['○ x', '○ y'], hidden: 8 });
    const rows = collectTextRows(el);
    const notice = rows.find((r) => r.text.includes('未显示'));
    expect(notice).toBeTruthy();
    // 刀30:优先级保活默认开 → 留下的非「末尾」而是「优先级最高」,故去掉「末尾」二字。
    expect(notice.text).toContain('仅显示 2 项');
    expect(notice.text).not.toContain('末尾');
    expect(notice.text).toContain('另有 8 项');
    expect(notice.props.dimColor).toBe(true);
  });

  test('刀19: hiddenLines with icons → status breakdown marker (aligns CC hiddenSummary)', () => {
    const el = TaskListPanel({
      lines: ['○ x', '○ y'],
      hidden: 4,
      hiddenLines: ['→ a', '✓ b', '○ c', '→ d'],
    });
    const rows = collectTextRows(el);
    const notice = rows.find((r) => r.text.includes('仅显示'));
    expect(notice).toBeTruthy();
    // CC-order breakdown: 进行中 → 待办 → 已完成. No raw "项未显示" count.
    // 刀30:优先级保活默认开 → 无「末尾」。
    expect(notice.text).toBe('⋯ 仅显示 2 项（另有 2 进行中, 1 待办, 1 已完成）');
    expect(notice.props.dimColor).toBe(true);
  });

  test('刀19: unrecognized hidden line → falls back to raw count (never under-counts)', () => {
    const el = TaskListPanel({
      lines: ['○ x'],
      hidden: 3,
      hiddenLines: ['→ a', 'plain V1 row', '○ c'],
    });
    const rows = collectTextRows(el);
    const notice = rows.find((r) => r.text.includes('仅显示'));
    expect(notice.text).toContain('另有 3 项未显示');
  });

  test('刀30: KHY_TASK_PRIORITY_CAP=0 → marker byte-reverts to 末尾 wording (tail-cap honesty)', () => {
    const prev = process.env.KHY_TASK_PRIORITY_CAP;
    process.env.KHY_TASK_PRIORITY_CAP = '0';
    try {
      const el = TaskListPanel({
        lines: ['○ x', '○ y'],
        hidden: 4,
        hiddenLines: ['→ a', '✓ b', '○ c', '→ d'],
      });
      const rows = collectTextRows(el);
      const notice = rows.find((r) => r.text.includes('仅显示末尾'));
      expect(notice).toBeTruthy();
      // 门控关:回退尾切 → 措辞恢复「末尾」。
      expect(notice.text).toBe('⋯ 仅显示末尾 2 项（另有 2 进行中, 1 待办, 1 已完成）');
    } finally {
      if (prev === undefined) delete process.env.KHY_TASK_PRIORITY_CAP;
      else process.env.KHY_TASK_PRIORITY_CAP = prev;
    }
  });

  test('刀19: KHY_TASK_HIDDEN_BREAKDOWN=0 → byte-revert to raw count', () => {
    const prev = process.env.KHY_TASK_HIDDEN_BREAKDOWN;
    process.env.KHY_TASK_HIDDEN_BREAKDOWN = '0';
    try {
      const el = TaskListPanel({
        lines: ['○ x'],
        hidden: 2,
        hiddenLines: ['→ a', '✓ b'],
      });
      const rows = collectTextRows(el);
      const notice = rows.find((r) => r.text.includes('仅显示'));
      expect(notice.text).toContain('另有 2 项未显示');
    } finally {
      if (prev === undefined) delete process.env.KHY_TASK_HIDDEN_BREAKDOWN;
      else process.env.KHY_TASK_HIDDEN_BREAKDOWN = prev;
    }
  });

  test('刀28: KHY_TASK_PANEL_HEADER=0 → header byte-reverts to static 任务清单', () => {
    const prev = process.env.KHY_TASK_PANEL_HEADER;
    process.env.KHY_TASK_PANEL_HEADER = '0';
    try {
      const el = TaskListPanel({ lines: ['→ a', '✓ b', '○ c'], hidden: 0 });
      const rows = collectTextRows(el);
      expect(rows.some((r) => r.text === '任务清单')).toBe(true);
      expect(rows.some((r) => r.text.startsWith('任务清单（共'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KHY_TASK_PANEL_HEADER;
      else process.env.KHY_TASK_PANEL_HEADER = prev;
    }
  });

  test('KHY_TASK_PANEL=0 → null even in coordinated mode (escape hatch honored)', () => {
    process.env.KHY_TASK_PANEL = '0';
    expect(TaskListPanel({ lines: ['→ a'], hidden: 0 })).toBeNull();
  });

  test('coordinated mode never reads stores even when they would throw', () => {
    mockThrow = true; // store would crash — must be untouched in coordinated mode
    const el = TaskListPanel({ lines: ['○ only'], hidden: 0 });
    expect(el).not.toBeNull();
    const rows = collectTextRows(el);
    expect(rows.some((r) => r.text === '○ only')).toBe(true);
  });
});
