'use strict';

/**
 * inkRenderSmoke — headless render smoke test for the NEW Ink TUI tree
 * (backend/src/cli/tui/ink-components/).
 *
 * Why this is separate from tests/inkComponents.test.js:
 *   That suite covers the OLD synchronous string-helper module
 *   (src/cli/ui/inkComponents.js). The components under src/cli/tui/ink-components/
 *   are real React components rendered by the official, ESM-only `ink` package,
 *   which had NO dedicated render coverage. This file fills that gap.
 *
 * Why it is guarded by --experimental-vm-modules:
 *   `ink` is ESM-only and inkRuntime.loadInk() bridges it via a dynamic
 *   `import('ink')`. Under jest's default CommonJS runtime a dynamic import
 *   callback throws ("A dynamic import callback was invoked without
 *   --experimental-vm-modules"). The plain `jest` invocation (and the sharded CI
 *   job) therefore cannot mount these components, so the suite SKIPS itself there
 *   to keep `npm test` green. Run it for real with:
 *
 *     npm run --workspace backend test:tui
 *
 *   which sets NODE_OPTIONS=--experimental-vm-modules (see scripts/run-ink-tui-tests.js)
 *   and is wired into CI as its own job.
 *
 * What it asserts:
 *   Every component mounts without throwing and emits a non-empty frame to a
 *   headless (non-TTY) stdout, using minimal props that exercise each
 *   component's visible state. This is a render/regression smoke test, not a
 *   pixel/snapshot assertion.
 */

const { Writable } = require('stream');
const { EventEmitter } = require('events');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

// Capability gate: dynamic import('ink') only works when node was started with
// --experimental-vm-modules (propagated to jest workers via NODE_OPTIONS).
const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // Surface why the suite is inert so a green "skipped" in default runs is not
  // mistaken for coverage. Use the dedicated script / CI job to execute it.
  // eslint-disable-next-line no-console
  console.warn(
    '[inkRenderSmoke] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

/** A Writable that records everything ink paints, masquerading as a non-TTY. */
function fakeStdout() {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = 80;
  stream.rows = 24;
  stream.isTTY = false;
  stream.getBuffer = () => buffer;
  return stream;
}

/**
 * A minimal stdin that satisfies ink's useInput() (raw-mode capable) so the
 * interactive components (QuestionPrompt / ModelPicker / FormFlow / App) mount
 * without throwing. It never emits data — we only test the initial frame.
 */
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

const noop = () => {};

/**
 * Component name → minimal props that drive it into its visible (non-null) state.
 * Each prop shape mirrors what the live TUI passes (see App.js render tree).
 */
const CASES = {
  WelcomeBanner: {
    version: '0.1.88',
    model: 'claude-opus-4-8',
    adapter: 'claude',
    authMethod: 'api-key',
    contextWindow: 200000,
    gatewayAdapters: ['claude', 'ollama'],
  },
  FooterBar: {
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    contextPct: 12,
    contextLimit: 200000,
  },
  Spinner: { label: '思考中…', color: 'yellow' },
  ToolLines: {
    tools: [{ name: 'Read', args: { file: 'a.js' }, result: 'ok' }],
    expanded: true,
  },
  ProcessGroup: {
    tools: [
      { name: 'Read', input: { file: 'a.js' }, result: { success: true } },
      { name: 'Edit', input: { file: 'a.js' }, result: { success: true } },
    ],
    expanded: false,
  },
  AgentTree: {
    agents: [
      { id: '1', name: '基本面分析师', status: 'running', toolCalls: 5, elapsed: 2100 },
      { id: '2', name: '风控经理', status: 'completed', detail: 'Done', elapsed: 1800 },
    ],
    expanded: false,
    live: true,
  },
  StreamingBlock: {
    streaming: { thinking: 'pondering', text: 'hello world', tools: [] },
    status: 'streaming',
    expanded: false,
  },
  PromptFrame: { value: 'hello', offset: 0, busy: false, placeholder: 'type…' },
  CompletionMenu: {
    completion: {
      active: true,
      kind: 'slash',
      items: [
        { label: '/help', value: 'help', desc: 'show help' },
        { label: '/model', value: 'model' },
      ],
    },
    selectedIndex: 0,
  },
  HelpMenu: {},
  ShellView: {
    streaming: {
      tools: [{ name: 'Bash', input: { command: 'ls -la' }, result: { text: 'a.js\nb.js\nc.js' } }],
      timeline: [
        { type: 'text', text: '运行命令' },
        { type: 'tool', tool: { name: 'Bash', input: { command: 'ls -la' }, result: { text: 'a.js\nb.js\nc.js' } } },
      ],
    },
    scroll: 0,
  },
  PermissionsPrompt: {
    request: { tool: 'Read', description: 'read a file' },
    onResolve: noop,
  },
  PlanApproval: { plan: { steps: ['step one', 'step two'] }, generating: false, genText: '' },
  CompactionProgress: {
    compaction: { active: true, startedAt: 0, tokensBefore: 100, tokensAfter: 50 },
  },
  Transcript: { messages: [{ role: 'user', content: 'hi' }] },
  QuestionPrompt: {
    request: {
      input: {
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [{ label: 'A', description: 'first' }, { label: 'B' }],
            multiSelect: false,
          },
        ],
      },
    },
    onResolve: noop,
  },
  ModelPicker: {
    choices: [{ label: 'Opus', value: 'opus' }, { label: 'Sonnet', value: 'sonnet' }],
    onResolve: noop,
    title: 'Select model',
    defaultValue: 'opus',
  },
  RewindPicker: {
    targets: [
      { idx: 4, content: '第三个问题', preview: '第三个问题', checkpointId: 'ck_3', rankFromEnd: 1 },
      { idx: 2, content: '第二个问题', preview: '第二个问题', checkpointId: null, rankFromEnd: 2 },
      { idx: 0, content: '第一个问题', preview: '第一个问题', checkpointId: 'ck_1', rankFromEnd: 3 },
    ],
    onResolve: noop,
    title: '回溯到哪条消息',
  },
  FormFlow: {
    fields: [{ name: 'username', label: 'Username', type: 'text' }],
    title: 'Login',
    onResolve: noop,
  },
  App: { options: {} },
};

describeOrSkip('Ink TUI render smoke (src/cli/tui/ink-components)', () => {
  let ink;

  beforeAll(async () => {
    rt.registerJsx();
    await rt.loadInk();
    ink = rt.get();
  });

  test('ink runtime resolves with a render() function', () => {
    expect(typeof ink.render).toBe('function');
  });

  // One render assertion per component: mounts, paints a non-empty frame, unmounts clean.
  for (const [name, props] of Object.entries(CASES)) {
    test(`${name} mounts and renders a non-empty frame`, async () => {
      const Comp = require(`../../src/cli/tui/ink-components/${name}`);
      const stdout = fakeStdout();
      const instance = ink.render(React.createElement(Comp, props), {
        stdout,
        stdin: fakeStdin(),
        exitOnCtrlC: false,
        patchConsole: false,
      });
      // Let mount effects (timers, async layout) flush a first frame.
      await new Promise((resolve) => setTimeout(resolve, 40));
      const frame = stdout.getBuffer();
      instance.unmount();
      expect(frame.length).toBeGreaterThan(0);
    });
  }

  // ── 输入体验三缺口:门控开/关帧断言(Fix 1a/1b/§3) ──────────────────────────
  async function renderCompFrame(name, props) {
    const Comp = require(`../../src/cli/tui/ink-components/${name}`);
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Comp, props), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const firstBorderCol = (frame) => {
    for (const ln of stripAnsi(frame).split('\n')) {
      const idx = ln.indexOf('╭');
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // Fix 1b — CompletionMenu marginLeft shifts the dropdown right; default 0 = 贴左 legacy.
  test('CompletionMenu marginLeft:0 default hugs the left; a positive margin shifts it right', async () => {
    const base = { completion: CASES.CompletionMenu.completion, selectedIndex: 0 };
    const left = await renderCompFrame('CompletionMenu', base);
    const shifted = await renderCompFrame('CompletionMenu', { ...base, marginLeft: 8 });
    const leftCol = firstBorderCol(left);
    const shiftedCol = firstBorderCol(shifted);
    expect(leftCol).toBe(0);              // default: dropdown at column 0
    expect(shiftedCol).toBe(8);           // marginLeft:8 → 8 leading columns
  });

  test('CompletionMenu default (no marginLeft) is byte-identical to marginLeft:0', async () => {
    const base = { completion: CASES.CompletionMenu.completion, selectedIndex: 0 };
    const noMargin = await renderCompFrame('CompletionMenu', base);
    const zero = await renderCompFrame('CompletionMenu', { ...base, marginLeft: 0 });
    expect(zero).toBe(noMargin);          // 逐字节 legacy
  });

  // Fix 1a — non-TTY harness: cursor stays hidden regardless of gate → gate-on and
  // gate-off frames are byte-identical (IME follow only fires on a real TTY).
  test('PromptFrame IME gate on/off render identically under non-TTY and never throw', async () => {
    const props = { value: 'hello', offset: 3, busy: false, placeholder: '' };
    const saved = process.env.KHY_IME_CURSOR;
    try {
      delete process.env.KHY_IME_CURSOR;
      const on = await renderCompFrame('PromptFrame', props);
      process.env.KHY_IME_CURSOR = '0';
      const off = await renderCompFrame('PromptFrame', props);
      expect(on.length).toBeGreaterThan(0);
      expect(off).toBe(on);
    } finally {
      if (saved === undefined) delete process.env.KHY_IME_CURSOR; else process.env.KHY_IME_CURSOR = saved;
    }
  });

  // Fix 3 — a single-select card shows the 「Space 可多选」 hint when the gate is on,
  // and reverts to no hint / no checkbox when the gate is off (byte-revert footer).
  test('QuestionPrompt single-select shows Space-multipick hint when gated on, hides it when off', async () => {
    const props = CASES.QuestionPrompt;
    const saved = process.env.KHY_QUESTION_MULTIPICK;
    try {
      delete process.env.KHY_QUESTION_MULTIPICK;
      const on = stripAnsi(await renderCompFrame('QuestionPrompt', props));
      process.env.KHY_QUESTION_MULTIPICK = '0';
      const off = stripAnsi(await renderCompFrame('QuestionPrompt', props));
      expect(on).toContain('Space 可多选');
      expect(off).not.toContain('Space 可多选');
      expect(off).not.toContain('[ ]');   // gate off: single-select, no checkbox
    } finally {
      if (saved === undefined) delete process.env.KHY_QUESTION_MULTIPICK; else process.env.KHY_QUESTION_MULTIPICK = saved;
    }
  });

  // Tier-gated render trust: the StreamingBlock normalizes small/unknown-model
  // output (selfRender:false) but passes strong-model output through untouched
  // (selfRender:true). A leaked chat-template sentinel is the probe — stripped
  // for the assisted path, preserved for the self-render path.
  async function frameFor(props) {
    const Comp = require('../../src/cli/tui/ink-components/StreamingBlock');
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Comp, props), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  test('StreamingBlock normalizes a small-model stream (selfRender:false)', async () => {
    const frame = await frameFor({
      streaming: { thinking: '', text: 'hi<|im_end|>', tools: [], selfRender: false },
      status: 'streaming',
      expanded: false,
    });
    expect(frame).toContain('hi');
    expect(frame).not.toContain('<|im_end|>'); // sentinel stripped
  });

  test('StreamingBlock passes a strong-model stream through (selfRender:true)', async () => {
    const frame = await frameFor({
      streaming: { thinking: '', text: 'hi<|im_end|>', tools: [], selfRender: true },
      status: 'streaming',
      expanded: false,
    });
    expect(frame).toContain('<|im_end|>'); // self-render: left intact
  });

  // Phase 1.2 (anti-staircase): the live region is tailed ONCE on raw normalized
  // lines, then markdown-rendered once. The window must stay bounded to the
  // viewport (rows=24 here) no matter how long the stream grows, and it must
  // show the TAIL (newest content) — the head scrolls off into <Static> on
  // finalize. Regression guards against the live frame outgrowing the terminal
  // (which staircases the prompt border) and against showing stale head text.
  test('StreamingBlock keeps a long live stream bounded to the viewport (tail shown)', async () => {
    const savedRows = process.stdout.rows;
    try {
      Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
      const lines = [];
      for (let i = 1; i <= 200; i++) lines.push(`line ${i}`);
      const text = lines.join('\n');
      const frame = await frameFor({
        streaming: { thinking: '', text: '', tools: [], selfRender: true, timeline: [{ type: 'text', text }] },
        status: 'streaming',
        expanded: false,
      });
      // Newest lines are visible; the earliest are tailed off (live preview only).
      expect(frame).toContain('line 200');
      expect(frame).not.toContain('line 1\n');
      // The rendered live region must fit inside the viewport (anti-staircase):
      // its painted line count stays under the 24-row terminal.
      const painted = frame.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n');
      const nonEmpty = painted.filter((l) => l.trim().length > 0).length;
      expect(nonEmpty).toBeLessThan(24);
    } finally {
      Object.defineProperty(process.stdout, 'rows', { value: savedRows, configurable: true });
    }
  });

  test('StreamingBlock honors reserveRows: a large reserve shrinks the live window (A 防跳顶)', async () => {
    const savedRows = process.stdout.rows;
    try {
      Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
      const lines = [];
      for (let i = 1; i <= 200; i++) lines.push(`line ${i}`);
      const text = lines.join('\n');
      const streaming = { thinking: '', text: '', tools: [], selfRender: true, timeline: [{ type: 'text', text }] };
      // Legacy reserve (no sibling panels) vs. a big reserve simulating a tall task
      // checklist + plan/queue below. App computes the big one via liveRegionBudget;
      // here we pass it directly to prove StreamingBlock folds it in and yields rows.
      const legacy = await frameFor({ streaming, status: 'streaming', expanded: false });
      const big = await frameFor({ streaming, status: 'streaming', expanded: false, reserveRows: 20 });
      const count = (f) => f.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').filter((l) => l.trim().length > 0).length;
      const legacyN = count(legacy);
      const bigN = count(big);
      // A larger reserve must produce a strictly shorter live window (room ceded to
      // the panels below), and it must still hug the 6-row floor (>= a few lines).
      expect(bigN).toBeLessThan(legacyN);
      expect(bigN).toBeGreaterThanOrEqual(4);
      // Newest content is always the part kept (tail anchoring).
      expect(big).toContain('line 200');
    } finally {
      Object.defineProperty(process.stdout, 'rows', { value: savedRows, configurable: true });
    }
  });

  test('StreamingBlock reserveRows absent/invalid → legacy reserve (byte-revert)', async () => {
    const savedRows = process.stdout.rows;
    try {
      Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
      const lines = [];
      for (let i = 1; i <= 200; i++) lines.push(`line ${i}`);
      const streaming = { thinking: '', text: '', tools: [], selfRender: true, timeline: [{ type: 'text', text: lines.join('\n') }] };
      const count = (f) => f.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').filter((l) => l.trim().length > 0).length;
      const base = count(await frameFor({ streaming, status: 'streaming', expanded: false }));
      // A NaN / negative / non-number reserveRows must fall back to the legacy path,
      // producing an identical line count to passing nothing at all.
      const nan = count(await frameFor({ streaming, status: 'streaming', expanded: false, reserveRows: NaN }));
      const neg = count(await frameFor({ streaming, status: 'streaming', expanded: false, reserveRows: -5 }));
      expect(nan).toBe(base);
      expect(neg).toBe(base);
    } finally {
      Object.defineProperty(process.stdout, 'rows', { value: savedRows, configurable: true });
    }
  });

  // Measurement-feedback clamp (KHY_LIVE_HEIGHT_CLAMP) integration: the App effect
  // reads ink's actual last-frame height and feeds `resolveExtraReserve` into
  // StreamingBlock's reserveRows as `_streamReserve + extraReserve`. That TTY-only
  // effect path can't run in this non-TTY harness, so we validate the exact
  // mechanism it drives: a measured overflow → extra reserve → StrictlY shorter,
  // in-viewport live window; and gate-off → extra 0 → identical to the base reserve.
  // End-to-end fullscreen suppression is only observable on a real TTY and is
  // covered by the clamp leaf's convergence proof (liveRegionClamp.test.js).
  test('clamp leaf composes with StreamingBlock: overflow → extra reserve → shorter window', async () => {
    const savedRows = process.stdout.rows;
    try {
      Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
      const lb = require('../../src/cli/tui/ink-components/liveRegionBudget');
      const lines = [];
      for (let i = 1; i <= 200; i++) lines.push(`line ${i}`);
      const streaming = { thinking: '', text: '', tools: [], selfRender: true, timeline: [{ type: 'text', text: lines.join('\n') }] };
      const count = (f) => f.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').filter((l) => l.trim().length > 0).length;

      const baseReserve = 9; // legacy base, no siblings
      // Simulate ink reporting the live region overflowed the 24-row terminal.
      const extra = lb.resolveExtraReserve({ lastOutputHeight: 30, rows: 24, prevExtra: 0 }, {});
      expect(extra).toBeGreaterThan(0); // clamp engaged

      const baseFrame = await frameFor({ streaming, status: 'streaming', expanded: false, reserveRows: baseReserve });
      const clampedFrame = await frameFor({ streaming, status: 'streaming', expanded: false, reserveRows: baseReserve + extra });
      expect(count(clampedFrame)).toBeLessThan(count(baseFrame)); // composed reserve shrinks live window
      expect(clampedFrame).toContain('line 200'); // tail anchoring preserved

      // Gate off → extra 0 → composed reserve == base → identical window.
      const extraOff = lb.resolveExtraReserve({ lastOutputHeight: 30, rows: 24, prevExtra: 0 }, { KHY_LIVE_HEIGHT_CLAMP: '0' });
      expect(extraOff).toBe(0);
      const offFrame = await frameFor({ streaming, status: 'streaming', expanded: false, reserveRows: baseReserve + extraOff });
      expect(count(offFrame)).toBe(count(baseFrame));
    } finally {
      Object.defineProperty(process.stdout, 'rows', { value: savedRows, configurable: true });
    }
  });

  // Proactive failure display: a failed tool MUST surface its reason even when
  // the result is collapsed (expanded:false) — the user should never have to
  // ask "why did it fail". A successful tool's preview stays hidden until
  // expanded. Covers the {error}, {success:false,reason} and success shapes.
  async function toolFrame(tools, expanded) {
    const Comp = require('../../src/cli/tui/ink-components/ToolLines');
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Comp, { tools, expanded }), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  test('ToolLines surfaces a failure reason when collapsed (expanded:false)', async () => {
    const frame = await toolFrame(
      [{ name: 'writeFile', result: { success: false, error: 'Refused: outside project boundary' } }],
      false,
    );
    expect(frame).toContain('Refused: outside project boundary');
  });

  test('ToolLines surfaces a {success:false, reason} failure (no error field)', async () => {
    const frame = await toolFrame(
      [{ name: 'bash', result: { success: false, reason: 'RATE_LIMIT exceeded' } }],
      false,
    );
    expect(frame).toContain('RATE_LIMIT exceeded');
  });

  // End-to-end regression for the "TUI strips tool-result fields" bug family:
  // render the RAW result the way the live bridge does — through
  // projectToolResultForView — then assert the ink frame. The earlier two tests
  // hand ToolLines an already-shaped result; these prove the BRIDGE no longer
  // strips the reason/denied flag before ToolLines ever sees it.
  const { projectToolResultForView } = require('../../src/cli/tui/hooks/useQueryBridge');
  async function bridgeToolFrame(name, rawResult, expanded = false, params = {}) {
    // Mirror the live bridge (markToolResult): the tool name + params flow into
    // the projection so it can derive the success summary.
    return toolFrame([{ name, result: projectToolResultForView(rawResult, name, params) }], expanded);
  }

  test('HIGH #1: a raw {success:false,error} failure shows its reason through the bridge', async () => {
    const frame = await bridgeToolFrame('writeFile', { success: false, error: 'Refused: outside project boundary' });
    expect(frame).toContain('Refused: outside project boundary');
  });

  test('HIGH #1: a structured {error:{message}} failure surfaces the message through the bridge', async () => {
    const frame = await bridgeToolFrame('editFile', { success: false, error: { code: 'E_BOUNDARY', message: 'outside boundary' } });
    expect(frame).toContain('outside boundary');
  });

  test('HIGH #2: a permission-denied result is labelled 权限被拒绝 through the bridge', async () => {
    const frame = await bridgeToolFrame('shellCommand', { success: false, denied: true, error: '[ExecApproval] blocked (risk:high)' });
    expect(frame).toContain('权限被拒绝');
    expect(frame).toContain('[ExecApproval] blocked'); // reason still shown beneath the label
  });

  test('a failure with no reason text still shows an explanation (never a bare ✗)', async () => {
    const frame = await bridgeToolFrame('someTool', { success: false });
    expect(frame).toContain('failed');
  });

  // 刀18: multi-line tool errors (stack traces, build/stderr output) fold to CC
  // MAX_RENDERED_LINES (10) with an honest "… +N 行 (ctrl+o 展开)" footer instead of
  // the legacy silent slice(0,3). The newline preservation (errorText +
  // stripInternalControlText preserveNewlines) and the fold (toolErrorFold) are both
  // gated by KHY_TOOL_ERROR_FOLD; gate-off collapses to one line, byte-identical.
  const MULTILINE_ERR = Array.from({ length: 13 }, (_, i) => `ERRLN-${String(i + 1).padStart(2, '0')}`).join('\n');

  test('刀18: a 13-line error folds to 10 + honest footer when collapsed', async () => {
    const frame = await toolFrame(
      [{ name: 'bash', result: { success: false, error: MULTILINE_ERR } }],
      false,
    );
    expect(frame).toContain('ERRLN-01');   // head shown
    expect(frame).toContain('ERRLN-10');   // 10th line still shown (the cap)
    expect(frame).not.toContain('ERRLN-13'); // tail folded away, not silently dropped
    expect(frame).toContain('+3');         // honest hidden count
    expect(frame).toContain('ctrl+o');     // and how to reveal it
  });

  test('刀18: expanded (Ctrl+O) reveals every error line, no footer', async () => {
    const frame = await toolFrame(
      [{ name: 'bash', result: { success: false, error: MULTILINE_ERR } }],
      true,
    );
    expect(frame).toContain('ERRLN-13');   // full error now visible
    expect(frame).not.toContain('ctrl+o'); // nothing hidden → no fold footer
  });

  test('刀18: gate off → collapse to one line, byte-fallback (no fold, no marker)', async () => {
    const prev = process.env.KHY_TOOL_ERROR_FOLD;
    process.env.KHY_TOOL_ERROR_FOLD = '0';
    try {
      const frame = await toolFrame(
        [{ name: 'bash', result: { success: false, error: MULTILINE_ERR } }],
        false,
      );
      // Legacy: newlines collapse to one line, slice(0,3) keeps it all on a single
      // (wrapped) line — so the tail is NOT folded behind a marker; ctrl+o footer absent.
      expect(frame).toContain('ERRLN-13');
      expect(frame).not.toContain('ctrl+o');
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOL_ERROR_FOLD;
      else process.env.KHY_TOOL_ERROR_FOLD = prev;
    }
  });

  test('ToolLines hides a success preview until expanded', async () => {
    const collapsed = await toolFrame(
      [{ name: 'readFile', result: { success: true, output: 'SENTINEL_PREVIEW' } }],
      false,
    );
    expect(collapsed).not.toContain('SENTINEL_PREVIEW');
    const open = await toolFrame(
      [{ name: 'readFile', result: { success: true, output: 'SENTINEL_PREVIEW' } }],
      true,
    );
    expect(open).toContain('SENTINEL_PREVIEW');
  });

  test('ToolLines shows the 执行中 progress line under a RUNNING tool (live only)', async () => {
    // Staged transparency: while a tool runs (no result yet) and we're in the
    // live preview, its present-continuous narration renders under the ◆ row so
    // the turn isn't a black box.
    const Comp = require('../../src/cli/tui/ink-components/ToolLines');
    const runFrame = async (tools, live) => {
      const stdout = fakeStdout();
      const instance = ink.render(React.createElement(Comp, { tools, expanded: false, live }), {
        stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const frame = stdout.getBuffer();
      instance.unmount();
      return frame;
    };
    const running = [{ name: 'LS', input: { path: '/x/Desktop' }, progress: '正在列出 Desktop 的条目…' }];

    // live + running → narration shown.
    expect(await runFrame(running, true)).toContain('正在列出 Desktop 的条目…');
    // committed (live:false) → never shows the running line in scrollback.
    expect(await runFrame(running, false)).not.toContain('正在列出 Desktop 的条目…');
    // completed → the row flips to its result; the running line is gone.
    const done = [{ name: 'LS', input: { path: '/x/Desktop' }, progress: '正在列出 Desktop 的条目…', result: { success: true } }];
    expect(await runFrame(done, true)).not.toContain('正在列出 Desktop 的条目…');
  });

  test('ToolLines confirms completion on success when collapsed', async () => {
    // "活做完了" — a finished tool must say so without expanding.
    const withOutput = await toolFrame(
      [{ name: 'writeFile', result: { success: true, output: 'wrote 12 lines' } }],
      false,
    );
    expect(withOutput).toContain('完成');
    const noOutput = await toolFrame(
      [{ name: 'writeFile', result: { success: true } }],
      false,
    );
    expect(noOutput).toContain('完成');
  });

  // 结果行 ✓→⎿ 统一(KHY_RESULT_ELBOW, Image#1 批量测试素材):工具结果/摘要行收在
  // CC 那样的暗色 ⎿ elbow 下,与命令正文同一视觉语言(不再是绿色 ✓)。门控关 → 回退 ✓。
  test('结果行起首字形统一成 CC 的 ⎿ elbow(非命令工具,collapsed)', async () => {
    const frame = await toolFrame(
      [{ name: 'writeFile', result: { success: true } }],
      false,
    );
    expect(frame).toContain('⎿ 完成'); // 暗色 elbow 取代绿色 ✓
    expect(frame).not.toContain('✓ 完成'); // 不再用绿色对勾起首结果行
  });

  test('结果行 门控关 (KHY_RESULT_ELBOW=0) → 回退绿色 ✓ 完成(字节回退)', async () => {
    const prev = process.env.KHY_RESULT_ELBOW;
    process.env.KHY_RESULT_ELBOW = '0';
    try {
      const frame = await toolFrame(
        [{ name: 'writeFile', result: { success: true } }],
        false,
      );
      expect(frame).toContain('✓ 完成');     // 字节回退到旧字形
      expect(frame).not.toContain('⎿ 完成'); // 无 elbow
    } finally {
      if (prev === undefined) delete process.env.KHY_RESULT_ELBOW;
      else process.env.KHY_RESULT_ELBOW = prev;
    }
  });

  // 工具结果透明化(透明原命令真实结果):非命令类工具携带真实输出体时——
  //   collapsed → 保持「摘要一瞥」并补 (ctrl+o 展开) 提示(不内联展开体,CC 风格);
  //   expanded  → 真实输出在 ⎿ 下完整透明显示(取代旧的 12 行弱预览)。
  test('工具结果透明化(collapsed): 有真实输出体的非命令工具补 (ctrl+o 展开) 提示,且不内联展开体', async () => {
    const frame = await toolFrame([{ name: 'webfetch', result: { success: true, text: 'L1\nL2\nL3' } }], false);
    expect(frame).toContain('ctrl+o 展开'); // 明确告知底下有真实输出可展开
    expect(frame).not.toContain('L2');       // collapsed 一瞥:不内联展开体(与 CC 一致)
  });

  test('工具结果透明化(expanded): 非命令工具的真实输出在 ⎿ 下完整透明显示(CC 风格)', async () => {
    const frame = await toolFrame([{ name: 'webfetch', result: { success: true, text: 'L1\nL2\nL3' } }], true);
    expect(frame).toContain('⎿');  // CC 风格 elbow
    expect(frame).toContain('L1');
    expect(frame).toContain('L3'); // 全貌透明,非 12 行硬截
  });

  // 刀17:命令/三方应用 stdout 每行裁切宽度走与 diff 行同一 SSOT(diffClipWidth),取代固定 100 字
  // 硬截。固定 100 与刀15 修掉的 diff 老缺口同病:① 无视终端宽度(80 列下裁 100 仍宽于终端→ink
  // 二次换行撑破行预算);② 展开(Ctrl+O)后仍裁 100→违背「Ctrl+O 显示全貌」。本刀补齐刀15 漏过的
  // literal 分支(它走 truncate 而非 clip)。fakeStdout columns=80 → 折叠 clipW=80-10=70。
  test('刀17 命令 stdout 折叠态按终端宽度裁切(80 列→70),展开态(Ctrl+O)不裁显示全貌', async () => {
    const longLine = 'BEGIN_' + 'x'.repeat(72) + '_ENDMARK'; // 长 86 字 > 70 折叠界、> 80 终端宽
    const collapsed = await toolFrame([{ name: 'bash', result: { text: longLine } }], false);
    expect(collapsed).toContain('BEGIN_');     // 行首保留
    expect(collapsed).not.toContain('_ENDMARK'); // 折叠裁到 70 → 行尾标记被裁掉(适配 80 列终端)
    const expanded = await toolFrame([{ name: 'bash', result: { text: longLine } }], true);
    expect(expanded).toContain('_ENDMARK');     // 展开 clipW=Infinity → 整行完整(ink 自然换行)
  });

  test('刀17 门控关 (KHY_DIFF_CONTENT_WIDTH=0) → 命令 stdout 折叠态恒裁 100 字(字节回退)', async () => {
    const prev = process.env.KHY_DIFF_CONTENT_WIDTH;
    process.env.KHY_DIFF_CONTENT_WIDTH = '0';
    try {
      const longLine = 'BEGIN_' + 'x'.repeat(72) + '_ENDMARK'; // 86 字 < 100 → 门控关恒裁 100 不裁本行
      const collapsed = await toolFrame([{ name: 'bash', result: { text: longLine } }], false);
      expect(collapsed).toContain('BEGIN_');
      expect(collapsed).toContain('_ENDMARK'); // 门控关回退固定 100:86<100 整行保留(与历史逐字节一致)
    } finally {
      if (prev === undefined) delete process.env.KHY_DIFF_CONTENT_WIDTH;
      else process.env.KHY_DIFF_CONTENT_WIDTH = prev;
    }
  });

  test('工具结果透明化 门控关 (KHY_TOOL_RESULT_TRANSPARENT=0) → 无 (ctrl+o 展开) 提示、展开回退原预览(字节回退)', async () => {
    const prev = process.env.KHY_TOOL_RESULT_TRANSPARENT;
    process.env.KHY_TOOL_RESULT_TRANSPARENT = '0';
    try {
      const collapsed = await toolFrame([{ name: 'webfetch', result: { success: true, text: 'L1\nL2' } }], false);
      expect(collapsed).not.toContain('ctrl+o 展开'); // 门控关:不加提示
      const open = await toolFrame([{ name: 'webfetch', result: { success: true, text: 'L1\nL2' } }], true);
      expect(open).not.toContain('⎿'); // 门控关:展开回退原 12 行预览(无 ⎿ elbow)
      expect(open).toContain('L1');     // 仍显示预览
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOL_RESULT_TRANSPARENT;
      else process.env.KHY_TOOL_RESULT_TRANSPARENT = prev;
    }
  });

  test('A/B/C: a success summary reaches the frame through the bridge (not a bare ✓ 完成)', async () => {
    // grep carrying a matches array → CC-aligned content-mode summary "找到 N 行",
    // derived in the projection from the rich result the TUI used to drop.
    const grep = await bridgeToolFrame('grep', { success: true, count: 7, matches: new Array(7).fill('m') });
    expect(grep).toContain('找到 7 行');
    // read → "已读取 <file>（N 行）".
    const read = await bridgeToolFrame('readFile', { success: true, lines: 42, path: 'a.js' });
    expect(read).toContain('已读取 a.js（42 行）');
  });

  test('A/B/C: a non-zero shell exit code is surfaced in the summary', async () => {
    const frame = await bridgeToolFrame('bash', { success: true, exitCode: 2, output: 'a\nb\nc\nd' });
    expect(frame).toContain('退出码 2');
  });

  // GOAL 2: bash / third-party-app stdout shows a FEW lines by default (collapsed),
  // folds the middle with a Claude-Code-style "… +N 行 (ctrl+o 展开)" marker, and
  // reveals everything when expanded. Only shell-family tools get this — the
  // agent's own prose stays full.
  test('GOAL2: a shell tool folds LONG stdout by default with a ctrl+o marker', async () => {
    // > SHELL_COLLAPSED_POLICY.maxLines (20) → folds.
    const output = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\n');
    const collapsed = await toolFrame([{ name: 'bash', result: { success: true, output } }], false);
    // Head lines are visible, the fold marker is present, and the middle is hidden.
    expect(collapsed).toContain('line1');
    expect(collapsed).toContain('ctrl+o 展开');
    expect(collapsed).not.toContain('line25'); // a hidden middle line
  });

  test('GOAL2: a shell tool reveals its full stdout when expanded', async () => {
    const output = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\n');
    const expanded = await toolFrame([{ name: 'bash', result: { success: true, output } }], true);
    expect(expanded).toContain('line1');
    expect(expanded).toContain('line25');
    expect(expanded).toContain('line40');
    expect(expanded).not.toContain('ctrl+o 展开'); // no false promise once open
  });

  // "如果不太长不需要折叠完全展开即可" — output within the threshold shows IN FULL.
  test('GOAL2: a not-too-long shell stdout shows in FULL with no fold marker', async () => {
    const output = Array.from({ length: 15 }, (_, i) => `keep${i + 1}`).join('\n'); // < 20
    const frame = await toolFrame([{ name: 'bash', result: { success: true, output } }], false);
    expect(frame).toContain('keep1');
    expect(frame).toContain('keep15'); // every line shown, nothing hidden
    expect(frame).not.toContain('ctrl+o 展开');
  });

  // "命令原生结果...需要区分" — literal command output carries a Claude-Code "⎿"
  // elbow so it reads distinctly from the AI's prose.
  test('GOAL2: command output is marked with a ⎿ elbow (CC style, distinct from AI prose)', async () => {
    const frame = await toolFrame([{ name: 'bash', result: { success: true, output: 'hello\nworld' } }], false);
    expect(frame).toContain('⎿');
    expect(frame).toContain('hello');
  });

  test('GOAL2: a third-party-app (terminal) tool stdout folds like a shell command', async () => {
    const output = Array.from({ length: 40 }, (_, i) => `out${i + 1}`).join('\n');
    const collapsed = await toolFrame([{ name: 'terminal', result: { success: true, output } }], false);
    expect(collapsed).toContain('out1');
    expect(collapsed).toContain('ctrl+o 展开');
    expect(collapsed).toContain('⎿'); // elbow present on folded output too
  });

  test('ToolLines renders a red/green ±diff for a write/edit result (_khyWriteDiff)', async () => {
    // Goal7 write-diff in the ink TUI: the diff must paint inline even when
    // collapsed (it IS the result), with +/- markers and ANSI color — not just
    // a "完成" line. Regression for "TUI showed no red/green diff".
    const frame = await toolFrame(
      [{
        name: 'edit',
        input: { file_path: 'diff_demo.js' },
        result: {
          success: true,
          _khyWriteDiff: {
            filePath: 'diff_demo.js',
            beforeContent: 'function add(a, b) {\n  return a - b;\n}\n',
            afterContent: 'function add(a, b) {\n  return a + b;\n}\n',
          },
        },
      }],
      false,
    );
    expect(frame).toContain('return a - b;'); // removed line present
    expect(frame).toContain('return a + b;'); // added line present
    expect(frame).toMatch(/[-+]\s*return a [+-] b;/); // ± markers rendered
    expect(frame).not.toContain('✓ 完成'); // diff replaces the generic status
  });

  test('ToolLines renders an all-green preview for a newly created file', async () => {
    const frame = await toolFrame(
      [{
        name: 'writeFile',
        input: { file_path: 'fresh.txt' },
        result: {
          success: true,
          _khyWriteDiff: { filePath: 'fresh.txt', beforeContent: '', afterContent: 'hello\nworld\n' },
        },
      }],
      false,
    );
    expect(frame).toContain('hello');
    expect(frame).toMatch(/\+\s*hello/); // green add marker
  });

  test('D: shell stdout that looks like a diff is coloured red/green when expanded', async () => {
    // `git diff` style output through a bash tool — the classic REPL coloured
    // this (maybeRenderInlineDiffFromToolOutput); the TUI used to show flat text.
    const gitDiff = [
      'diff --git a/f.js b/f.js',
      '@@ -1,2 +1,2 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
    ].join('\n');
    const expanded = await toolFrame(
      [{ name: 'bash', input: { command: 'git diff' }, result: { success: true, output: gitDiff } }],
      true,
    );
    expect(expanded).toContain('const y = 2;'); // removed line shown
    expect(expanded).toContain('const y = 3;'); // added line shown
    expect(expanded).toMatch(/-\s*const y = 2;/); // − marker
    expect(expanded).toMatch(/\+\s*const y = 3;/); // + marker
  });

  // ±diff line numbers (KHY_DIFF_LINE_NUMBERS, Image#2): the rendered gutter shows
  // each row's file line number (ctx/add → new file, del → old file), bound to the
  // parsed @@ hunk header — not fabricated. Gate off → no gutter (byte fallback).
  test('D2: shell diff rows carry a CC-style line-number gutter when expanded', async () => {
    const gitDiff = [
      '@@ -1,2 +1,2 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
    ].join('\n');
    const expanded = await toolFrame(
      [{ name: 'bash', input: { command: 'git diff' }, result: { success: true, output: gitDiff } }],
      true,
    );
    // @@ -1,2 +1,2 @@: ctx 'const x = 1;' → line 1; del/add 'const y' → line 2.
    expect(expanded).toMatch(/1\s+const x = 1;/);   // ctx new-file line 1
    expect(expanded).toMatch(/2\s+-\s*const y = 2;/); // del old-file line 2
    expect(expanded).toMatch(/2\s+\+\s*const y = 3;/); // add new-file line 2
  });

  test('D3: KHY_DIFF_LINE_NUMBERS off → diff renders without the number gutter (byte fallback)', async () => {
    const saved = process.env.KHY_DIFF_LINE_NUMBERS;
    process.env.KHY_DIFF_LINE_NUMBERS = '0';
    try {
      const gitDiff = '@@ -1,2 +1,2 @@\n const x = 1;\n-const y = 2;\n+const y = 3;';
      const expanded = await toolFrame(
        [{ name: 'bash', input: { command: 'git diff' }, result: { success: true, output: gitDiff } }],
        true,
      );
      // Still coloured red/green, but no leading line number before the markers.
      expect(expanded).toContain('const y = 2;');
      expect(expanded).toMatch(/-\s*const y = 2;/);
      expect(expanded).not.toMatch(/2\s+-\s*const y = 2;/);
    } finally {
      if (saved === undefined) delete process.env.KHY_DIFF_LINE_NUMBERS;
      else process.env.KHY_DIFF_LINE_NUMBERS = saved;
    }
  });

  // Decision / Q&A history records: the user's approve-deny choice and the
  // AskUserQuestion question+answer are committed to the transcript so they stay
  // visible in scrollback after the overlay clears.
  async function messageFrame(msg) {
    const Transcript = require('../../src/cli/tui/ink-components/Transcript');
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Transcript.MessageBlock, { msg }), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  test('Transcript renders an approval decision with the tool name', async () => {
    const frame = await messageFrame({
      role: 'decision', decision: 'allow', tool: 'writeFile', argSummary: 'note.md',
    });
    expect(frame).toContain('已批准');
    expect(frame).toContain('writeFile');
  });

  test('Transcript renders a denial decision', async () => {
    const frame = await messageFrame({ role: 'decision', decision: 'deny', tool: 'bash' });
    expect(frame).toContain('已拒绝');
  });

  // Phase 1.3 (live↔committed normalization consistency): a CONTINUATION fragment
  // (a sealed prefix 1.1 committed mid-stream, already shown live via the
  // prefix-stable normalizeStreaming pass) must NOT be re-flowed by the final pass
  // when it lands in <Static> — otherwise the text jumps the instant it crosses
  // from the live region. The probe is a duplicated paragraph: the final pass
  // dedups it (one copy), the streaming pass keeps both. A weak-model (selfRender
  // false) continuation fragment must keep BOTH; a non-continuation commit dedups.
  const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

  test('1.3: a weak-model continuation fragment is NOT re-flowed (matches live)', async () => {
    const frame = await messageFrame({
      role: 'assistant', selfRender: false, continuation: true,
      content: 'ABCwidget done\n\nABCwidget done\n\n',
    });
    // Streaming-grade normalization keeps the duplicate the user already saw.
    expect(countOccurrences(frame, 'ABCwidget done')).toBe(2);
  });

  test('1.3: a weak-model NON-continuation commit still gets the full final pass', async () => {
    const frame = await messageFrame({
      role: 'assistant', selfRender: false, continuation: false,
      content: 'ABCwidget done\n\nABCwidget done\n\n',
    });
    // The authoritative final commit dedups the repeated paragraph.
    expect(countOccurrences(frame, 'ABCwidget done')).toBe(1);
  });

  test('Transcript renders a discuss decision (dependency-install heal)', async () => {
    const frame = await messageFrame({
      role: 'decision', decision: 'discuss', tool: 'install-dependency:cheerio',
    });
    expect(frame).toContain('先一起讨论');
    expect(frame).toContain('install-dependency:cheerio');
  });

  test('Transcript renders an AskUserQuestion record (question + choice)', async () => {
    const frame = await messageFrame({
      role: 'qa', qa: [{ question: '选择部署目标', choice: '生产环境' }],
    });
    expect(frame).toContain('选择部署目标');
    expect(frame).toContain('生产环境');
  });

  test('Transcript renders a cancelled question', async () => {
    const frame = await messageFrame({ role: 'qa', cancelled: true });
    expect(frame).toContain('已取消提问');
  });

  // PermissionsPrompt: a dependency-install heal request advertises a third
  // decision via input.options (discuss). The overlay must surface it as a real
  // selectable row; requests that omit it stay binary-compatible.
  async function permFrame(request) {
    const Comp = require('../../src/cli/tui/ink-components/PermissionsPrompt');
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Comp, { request, onResolve: noop }), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  test('PermissionsPrompt renders the 一起讨论 row when advertised', async () => {
    const frame = await permFrame({
      tool_name: 'install-dependency:cheerio',
      input: { kind: 'dependency-install', depId: 'cheerio', command: 'npm install cheerio', options: ['install', 'discuss', 'skip'] },
    });
    expect(frame).toContain('一起讨论');
    expect(frame).toContain('允许本次');
    expect(frame).toContain('拒绝');
  });

  test('PermissionsPrompt stays binary when no discuss option is advertised', async () => {
    const frame = await permFrame({ tool: 'Read', input: { description: 'read a file' } });
    expect(frame).not.toContain('一起讨论');
    expect(frame).toContain('允许本次');
  });

  // Process Group: consecutive tool calls merge into one collapsible 过程组.
  async function groupFrame(tools, expanded) {
    const ProcessGroup = require('../../src/cli/tui/ink-components/ProcessGroup');
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(ProcessGroup, { tools, expanded }), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  const GROUP3 = [
    { name: 'Read', input: { file: 'a.js' }, result: { success: true } },
    { name: 'Edit', input: { file: 'a.js' }, result: { success: true } },
    { name: 'Bash', input: { command: 'npm test' }, result: { success: false, error: 'EXIT_1' } },
  ];

  test('ProcessGroup collapsed shows a content-derived title, count and status', async () => {
    const frame = await groupFrame(GROUP3, false);
    // Title reflects the actual steps (Read + Edit + Bash), not a generic label.
    expect(frame).toContain('读取');
    expect(frame).toContain('编辑');
    expect(frame).toContain('执行命令');
    expect(frame).toContain('3 个步骤');
    expect(frame).toContain('✓2');
    expect(frame).toContain('✗1');
    expect(frame).toContain('Ctrl+O 展开'); // collapsibility hint
    expect(frame).toContain('▸'); // collapsed caret
    // The steps and the always-on failure reason are still visible collapsed.
    expect(frame).toContain('EXIT_1');
  });

  test('ProcessGroup names a single-action group by its shared target', async () => {
    const frame = await groupFrame([
      { name: 'readFile', input: { path: 'src/server.js' }, result: { success: true } },
      { name: 'readFile', input: { path: 'src/server.js' }, result: { success: true } },
    ], false);
    expect(frame).toContain('读取 server.js'); // category + basename target
  });

  test('ProcessGroup expanded uses the open caret and drops the hint', async () => {
    const frame = await groupFrame(GROUP3, true);
    expect(frame).toContain('▾');
    expect(frame).not.toContain('Ctrl+O 展开');
  });

  // 2.2 true fold: a collapsed committed group folds SUCCESSFUL steps into the
  // header's ✓ count (their per-step lines disappear) while a FAILED step stays
  // visible (red line: never hide failures). Expanding reveals every step.
  test('ProcessGroup collapsed folds successful steps but keeps failures', async () => {
    const collapsed = await groupFrame(GROUP3, false);
    // The successful Read/Edit step args are folded away (only the title remains).
    expect(collapsed).not.toContain('file=a.js');
    // The failed step and its reason are still shown.
    expect(collapsed).toContain('EXIT_1');
    // Expanded brings the successful steps' arg lines back.
    const expanded = await groupFrame(GROUP3, true);
    expect(expanded).toContain('file=a.js');
  });

  test('ProcessGroup live preview always lists its steps (never folded)', async () => {
    const ProcessGroup = require('../../src/cli/tui/ink-components/ProcessGroup');
    const stdout = fakeStdout();
    const instance = ink.render(
      React.createElement(ProcessGroup, { tools: GROUP3, expanded: false, live: true }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    // live forces the step list open even though the global expand flag is false.
    expect(frame).toContain('file=a.js');
    expect(frame).toContain('▾');
  });

  // GOAL 2: in a collapsed committed group, a SUCCESSFUL shell step keeps its
  // (folded) stdout visible — it IS the result the user ran — while a non-shell
  // success (Read) still folds into the header ✓ count. Failures stay visible too.
  test('GOAL2: collapsed group keeps a successful shell step output, folds non-shell success', async () => {
    const output = Array.from({ length: 40 }, (_, i) => `row${i + 1}`).join('\n');
    const tools = [
      { name: 'Read', input: { file: 'a.js' }, result: { success: true } },
      { name: 'Bash', input: { command: 'ls -la' }, result: { success: true, output } },
    ];
    const collapsed = await groupFrame(tools, false);
    // The shell step's output peeks (folded) without expanding.
    expect(collapsed).toContain('row1');
    expect(collapsed).toContain('ctrl+o 展开');
    // The non-shell Read success is still folded into the ✓ count (no arg line).
    expect(collapsed).not.toContain('file=a.js');
  });

  test('ProcessGroup does not wrap a single tool in group chrome', async () => {
    const frame = await groupFrame([{ name: 'Read', result: { success: true } }], false);
    expect(frame).not.toContain('个步骤'); // no group header for a lone step
    expect(frame).toContain('Read');
  });

  test('Transcript merges consecutive timeline tools into one named group', async () => {
    const frame = await messageFrame({
      role: 'assistant',
      timeline: [
        { type: 'text', text: '我先读取再修改：' },
        { type: 'tool', tool: { name: 'Read', result: { success: true } } },
        { type: 'tool', tool: { name: 'Edit', result: { success: true } } },
      ],
    });
    expect(frame).toContain('我先读取再修改'); // text explanation first
    expect(frame).toContain('读取'); // tools merged after, named by content
    expect(frame).toContain('编辑');
    expect(frame).toContain('2 个步骤');
  });

  // G-C: thinking is preserved in committed history. Collapsed shows a folded
  // one-line summary (char count + Ctrl+O hint) and hides the full text; Ctrl+O
  // expands it. Previously thinking was live-only and dropped on finalize.
  test('Transcript folds committed thinking, expands it with Ctrl+O', async () => {
    const Transcript = require('../../src/cli/tui/ink-components/Transcript');
    const renderMsg = async (expanded) => {
      const stdout = fakeStdout();
      const instance = ink.render(
        React.createElement(Transcript.MessageBlock, {
          msg: {
            role: 'assistant',
            timeline: [
              { type: 'thinking', text: 'SECRET_THOUGHT weighing the options' },
              { type: 'text', text: '答复正文' },
            ],
          },
          expanded,
        }),
        { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 40));
      const frame = stdout.getBuffer();
      instance.unmount();
      return frame;
    };
    const collapsed = await renderMsg(false);
    expect(collapsed).toContain('💭 思考'); // fold marker
    expect(collapsed).toContain('字'); // char-count summary
    expect(collapsed).toContain('答复正文'); // answer still shown
    expect(collapsed).not.toContain('SECRET_THOUGHT'); // body hidden when folded
    const open = await renderMsg(true);
    expect(open).toContain('SECRET_THOUGHT'); // revealed on expand
  });

  // G-C2: a committed thinking entry that carries a REAL durationMs renders the
  // CC-style "💭 思考 Ns" line (folded summary AND expanded header). The duration
  // is the captured elapsed (useQueryBridge), never fabricated — here we feed a
  // known durationMs and assert it surfaces. Gate KHY_THINKING_DURATION off → the
  // duration is dropped and the legacy "💭 思考 · N 字" line returns byte-for-byte.
  test('Transcript renders the real thinking duration (Thought-for-Ns), gate off falls back', async () => {
    const Transcript = require('../../src/cli/tui/ink-components/Transcript');
    const renderDur = async (expanded) => {
      const stdout = fakeStdout();
      const instance = ink.render(
        React.createElement(Transcript.MessageBlock, {
          msg: {
            role: 'assistant',
            timeline: [
              { type: 'thinking', text: 'weighing options', durationMs: 7000 },
              { type: 'text', text: '答复正文' },
            ],
          },
          expanded,
        }),
        { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 40));
      const frame = stdout.getBuffer();
      instance.unmount();
      return frame;
    };
    const collapsed = await renderDur(false);
    expect(collapsed).toContain('💭 思考 7s'); // real elapsed surfaced (folded)
    const open = await renderDur(true);
    expect(open).toContain('💭 思考 7s'); // same duration in the expanded header

    // Gate off → byte-fallback to the legacy duration-less line.
    const prev = process.env.KHY_THINKING_DURATION;
    process.env.KHY_THINKING_DURATION = '0';
    try {
      const off = await renderDur(false);
      expect(off).toContain('💭 思考'); // marker still there
      expect(off).not.toContain('7s'); // duration suppressed
    } finally {
      if (prev === undefined) delete process.env.KHY_THINKING_DURATION;
      else process.env.KHY_THINKING_DURATION = prev;
    }
  });

  // G-C3: the turn-stats role renders the CC-style dim completion summary built
  // by the turnStats leaf from real backend metrics. MessageBlock is a dumb
  // renderer of the precomposed content; empty content renders nothing.
  test('Transcript renders the turn-stats completion summary line', async () => {
    const Transcript = require('../../src/cli/tui/ink-components/Transcript');
    const renderStats = async (content) => {
      const stdout = fakeStdout();
      const instance = ink.render(
        React.createElement(Transcript.MessageBlock, {
          msg: { role: 'turn-stats', content },
          expanded: false,
        }),
        { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
      );
      await new Promise((r) => setTimeout(r, 40));
      const frame = stdout.getBuffer();
      instance.unmount();
      return frame;
    };
    // CC-faithful content (ccFormat: "1m 30s" with space) — MessageBlock renders
    // whatever the turnStats leaf precomposed.
    const frame = await renderStats('✓ 1m 30s · 3 工具 · 1.2k tokens');
    expect(frame).toContain('1m 30s');
    expect(frame).toContain('3 工具');
    expect(frame).toContain('1.2k tokens');
    // Empty content → nothing rendered (gate-off / suppressed turns append no msg).
    const empty = await renderStats('');
    expect(empty.replace(/\s/g, '')).toBe('');
  });

  // G-C4: CC backend-logic parity — the turn-stats token is the per-turn OUTPUT
  // token count (CC REPL.tsx:3762 `getTurnOutputTokens()`), NOT input+output total.
  test('pickTurnStatsTokens picks per-turn output tokens (CC parity), gate off → total', () => {
    const { pickTurnStatsTokens } = require('../../src/cli/tui/hooks/useQueryBridge');
    expect(typeof pickTurnStatsTokens).toBe('function');
    const usage = { inputTokens: 9000, outputTokens: 1200, totalTokens: 10200 };
    const total = 10200;
    // Gate on (default): output-only → 1200, ignoring the 9000 input tokens.
    expect(pickTurnStatsTokens(usage, total, {})).toBe(1200);
    // Adapter that reports only a total (no separable outputTokens) → 0 → the
    // stats line honestly omits the token segment (never mislabels total as output).
    expect(pickTurnStatsTokens({ totalTokens: 10200 }, total, {})).toBe(0);
    expect(pickTurnStatsTokens(null, total, {})).toBe(0);
    // Gate off → legacy byte-fallback to the input+output total.
    expect(pickTurnStatsTokens(usage, total, { KHY_TURN_STATS_OUTPUT_TOKENS: '0' })).toBe(10200);
    expect(pickTurnStatsTokens(null, 0, { KHY_TURN_STATS_OUTPUT_TOKENS: 'off' })).toBe(0);
  });

  // G-C5: CC backend-logic parity — the footer context-fill occupancy is the
  // INPUT side (input + cache_read + cache_creation, CC calculateContextPercentages),
  // NOT input+output total. Output just generated is not yet part of the window.
  test('pickContextOccupancyTokens uses input-side tokens (CC parity), gate off → total', () => {
    const { pickContextOccupancyTokens } = require('../../src/cli/tui/hooks/useQueryBridge');
    expect(typeof pickContextOccupancyTokens).toBe('function');
    const usage = { inputTokens: 9000, outputTokens: 1200, totalTokens: 10200 };
    // Gate on (default): input-only → 9000, excluding the 1200 output tokens.
    expect(pickContextOccupancyTokens(usage, 10200, {})).toBe(9000);
    // Cache fields (when an adapter splits them) are summed into the input side.
    const cached = { inputTokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 700, outputTokens: 1200 };
    expect(pickContextOccupancyTokens(cached, 99999, {})).toBe(9200);
    // Output-only turn (no input usable) → 0 → caller keeps the prior occupancy
    // (CC's "don't flash 0%" honesty), never counts output as window fill.
    expect(pickContextOccupancyTokens({ outputTokens: 1200 }, 1200, {})).toBe(0);
    expect(pickContextOccupancyTokens(null, 1200, {})).toBe(0);
    // Gate off → legacy byte-fallback to the input+output total.
    expect(pickContextOccupancyTokens(usage, 10200, { KHY_CONTEXT_FILL_INPUT_ONLY: '0' })).toBe(10200);
  });

  // G-C6: CC backend-logic parity — the footer context segment shows BOTH the
  // used and the window token counts (CC BuiltinStatusLine renders
  // `Context {pct}% ({formatTokens(used)}/{formatTokens(window)})`), not just the
  // window. The used count is the already-computed input-side occupancy that the
  // percentage is derived from; CC surfaces it, so Khy must too (via ccFormatTokens).
  test('buildContextStatus shows used/window token counts (CC parity), gate off → window only', () => {
    const { buildContextStatus } = require('../../src/cli/tui/ink-components/FooterBar');
    expect(typeof buildContextStatus).toBe('function');
    // Gate on (default): both counts, compact-formatted like CC's formatTokens.
    expect(buildContextStatus(12, 24000, 200000, {})).toBe('12% ctx (24k/200k)');
    // Session start (no usage yet) → "0/200k", faithfully mirroring CC's 0 usedTokens.
    expect(buildContextStatus(0, 0, 200000, {})).toBe('0% ctx (0/200k)');
    // Negative/garbage used clamps to 0, never throws or shows a negative count.
    expect(buildContextStatus(0, -5, 200000, {})).toBe('0% ctx (0/200k)');
    // No window → empty (footer hides the segment), same as before.
    expect(buildContextStatus(50, 1000, 0, {})).toBe('');
    // Gate off → byte-fallback to the legacy window-only form.
    expect(buildContextStatus(12, 24000, 200000, { KHY_CONTEXT_FILL_SHOW_USED: '0' })).toBe('12% ctx (200k)');
    expect(buildContextStatus(12, 24000, 200000, { KHY_CONTEXT_FILL_SHOW_USED: 'off' })).toBe('12% ctx (200k)');
  });

  // G-C7: CC backend-logic parity — the compaction progress "↑ N tokens" display
  // routes through the SAME ccFormatTokens SSOT as the footer/spinner, so round
  // thousands strip the trailing ".0" (CC: "24k"/"1k", not the old local "24.0k").
  // The <=0 guard (hide the segment when no token count) is preserved.
  test('CompactionProgress.formatTokens uses ccFormatTokens SSOT (CC parity), gate off → legacy .0', () => {
    const { formatTokens } = require('../../src/cli/tui/ink-components/CompactionProgress');
    expect(typeof formatTokens).toBe('function');
    // Gate on (default): round thousands lose the ".0" — matches CC formatTokens.
    expect(formatTokens(24000, {})).toBe('24k');
    expect(formatTokens(1000, {})).toBe('1k');
    // Non-round values are identical under both code paths.
    expect(formatTokens(1500, {})).toBe('1.5k');
    expect(formatTokens(12345, {})).toBe('12.3k');
    expect(formatTokens(500, {})).toBe('500');
    // <=0 / falsy → empty string (segment hidden), never "0".
    expect(formatTokens(0, {})).toBe('');
    expect(formatTokens(-5, {})).toBe('');
    // Gate off → legacy byte-fallback keeps the trailing ".0".
    expect(formatTokens(24000, { KHY_COMPACTION_CC_TOKENS: '0' })).toBe('24.0k');
    expect(formatTokens(1000, { KHY_COMPACTION_CC_TOKENS: 'off' })).toBe('1.0k');
  });

  // G-C8: CC backend-logic parity — the LIVE spinner's elapsed + streamed-token
  // meta routes through the ccFormat SSOT, matching CC's SpinnerAnimationRow
  // (formatDuration(elapsedMs) → "1m 30s" for ≥60s; formatNumber(tokens) →
  // compact "1.2k"). Khy keeps its "~N tok"/"Ns" wording, only the NUMBER and the
  // DURATION route through ccFormat. Gate off → legacy raw seconds / raw integer.
  test('buildSpinnerMeta routes elapsed + tokens through ccFormat (CC parity), gate off → raw', () => {
    const { buildSpinnerMeta } = require('../../src/cli/tui/ink-components/Spinner');
    expect(typeof buildSpinnerMeta).toBe('function');
    // These assertions focus on the ccFormat NUMBER/DURATION routing, which is
    // orthogonal to the 30s visibility threshold (G-C11). Sub-30s elapsed would be
    // hidden by the default-on reveal gate, so pin KHY_SPINNER_META_GATE off to
    // isolate the formatting口径 at low seconds.
    const noThr = { KHY_SPINNER_META_GATE: 'off' };
    // Gate on (default): sub-minute elapsed stays "Ns"; sub-1k tokens stay raw.
    expect(buildSpinnerMeta(5, 0, noThr)).toBe(' · 5s');
    expect(buildSpinnerMeta(12, 340, noThr)).toBe(' · 12s · ~340 tok');
    // ≥60s → CC formatDuration "1m 30s"; ≥1k tokens → compact "~1.2k tok". These
    // are already >30s so the threshold lets them through with env {} too.
    expect(buildSpinnerMeta(90, 1234, {})).toBe(' · 1m 30s · ~1.2k tok');
    expect(buildSpinnerMeta(125, 12000, {})).toBe(' · 2m 5s · ~12k tok');
    // No elapsed and no tokens → empty (no meta segment).
    expect(buildSpinnerMeta(0, 0, {})).toBe('');
    // Gate off → byte-fallback: raw seconds and raw integer (no compacting).
    expect(buildSpinnerMeta(90, 1234, { KHY_SPINNER_CC_FORMAT: '0' })).toBe(' · 90s · ~1234 tok');
    expect(buildSpinnerMeta(90, 1234, { KHY_SPINNER_CC_FORMAT: 'off' })).toBe(' · 90s · ~1234 tok');
  });

  // G-C11: CC backend-logic parity — the ink TUI live spinner's elapsed+token
  // progress meta is hidden until the turn drags past CC's SHOW_TOKENS_AFTER_MS =
  // 30_000, by CONSUMING the SAME shared `cli/spinnerMeta.js` leaf + the SAME gate
  // KHY_SPINNER_META_GATE the classic REPL spinner already uses (one SSOT, one
  // gate — not a parallel threshold). CC uses strict `>` (exactly 30s stays
  // hidden). Khy has no verbose/teammate bypass on this path, so it is purely the
  // 30s clock. Gate off → byte-fallback to immediate display from second 1.
  test('buildSpinnerMeta hides progress meta until >30s via shared spinnerMeta gate (CC parity), gate off → immediate', () => {
    const { buildSpinnerMeta } = require('../../src/cli/tui/ink-components/Spinner');
    // Default-on: under and at 30s → hidden, even with elapsed + tokens present.
    expect(buildSpinnerMeta(5, 340, {})).toBe('');
    expect(buildSpinnerMeta(29, 999, {})).toBe('');
    expect(buildSpinnerMeta(30, 999, {})).toBe(''); // strict >, so 30s exactly stays hidden
    // Just over the threshold → meta surfaces (ccFormat routing still applies).
    expect(buildSpinnerMeta(31, 340, {})).toBe(' · 31s · ~340 tok');
    expect(buildSpinnerMeta(90, 1234, {})).toBe(' · 1m 30s · ~1.2k tok');
    // Gate off → legacy immediate display from the first second.
    expect(buildSpinnerMeta(5, 340, { KHY_SPINNER_META_GATE: '0' })).toBe(' · 5s · ~340 tok');
    expect(buildSpinnerMeta(12, 340, { KHY_SPINNER_META_GATE: 'off' })).toBe(' · 12s · ~340 tok');
    // Reveal gate is independent of the ccFormat gate: both off → immediate + raw.
    expect(buildSpinnerMeta(5, 1234, { KHY_SPINNER_META_GATE: '0', KHY_SPINNER_CC_FORMAT: '0' }))
      .toBe(' · 5s · ~1234 tok');
  });

  // G-C9: CC backend-logic parity — the compaction progress bar's elapsed clock
  // routes through the SAME ccFormatDuration SSOT as the spinner, instead of a
  // local floor-only reimplementation. Two real divergences are corrected:
  // (1) ≥60s sub-minute seconds use Math.round (60500ms → "1m 1s", not "1m 0s");
  // (2) hours carry ("1h 1m 1s", not "61m 1s"). Gate off → legacy floor form.
  test('CompactionProgress.formatElapsed uses ccFormatDuration SSOT (CC parity), gate off → legacy floor', () => {
    const { formatElapsed } = require('../../src/cli/tui/ink-components/CompactionProgress');
    expect(typeof formatElapsed).toBe('function');
    // Sub-minute and exact-minute are identical under both paths.
    expect(formatElapsed(5000, {})).toBe('5s');
    expect(formatElapsed(59000, {})).toBe('59s');
    expect(formatElapsed(60000, {})).toBe('1m 0s');
    expect(formatElapsed(90000, {})).toBe('1m 30s');
    // Gate on (default): CC rounds the sub-minute seconds → "1m 1s".
    expect(formatElapsed(60500, {})).toBe('1m 1s');
    // Gate on: hours carry like CC formatDuration.
    expect(formatElapsed(3600000, {})).toBe('1h 0m 0s');
    expect(formatElapsed(3661000, {})).toBe('1h 1m 1s');
    // Negative / garbage clamps to "0s", never throws.
    expect(formatElapsed(-100, {})).toBe('0s');
    // Gate off → byte-fallback to the legacy floor-only form.
    expect(formatElapsed(60500, { KHY_COMPACTION_CC_FORMAT: '0' })).toBe('1m 0s');
    expect(formatElapsed(3661000, { KHY_COMPACTION_CC_FORMAT: 'off' })).toBe('61m 1s');
  });

  // G-C10: CC backend-logic parity — the footer model label derives a friendly
  // display name (CC renderModelName → getPublicModelDisplayName → first two
  // words "Opus 4.6"), instead of rendering the raw slug. Non-Claude / unknown
  // slugs fall back to the raw id verbatim (CC's null → raw). Gate off → raw.
  test('formatModelLabel derives a friendly CC-style model name, unknown → raw (CC parity)', () => {
    const { formatModelLabel } = require('../../src/cli/tui/ink-components/FooterBar');
    expect(typeof formatModelLabel).toBe('function');
    // Current Claude slug convention → "Family major.minor".
    expect(formatModelLabel('claude-opus-4-8', {})).toBe('Opus 4.8');
    expect(formatModelLabel('claude-sonnet-4-6', {})).toBe('Sonnet 4.6');
    // Trailing suffixes (e.g. -latest) are ignored; dot or dash minor both parse.
    expect(formatModelLabel('claude-haiku-4-5-latest', {})).toBe('Haiku 4.5');
    expect(formatModelLabel('claude-haiku-3.5', {})).toBe('Haiku 3.5');
    // No minor version → "Family major".
    expect(formatModelLabel('claude-opus-4', {})).toBe('Opus 4');
    // Legacy order (version before family) still resolves.
    expect(formatModelLabel('claude-3-5-sonnet-20241022', {})).toBe('Sonnet 3.5');
    // Non-Claude / arbitrary provider slugs → raw verbatim (CC null → raw).
    expect(formatModelLabel('agnes-2.0-flash', {})).toBe('agnes-2.0-flash');
    expect(formatModelLabel('gpt-5-codex', {})).toBe('gpt-5-codex');
    expect(formatModelLabel('auto', {})).toBe('auto');
    // Empty / nullish → empty string, never throws.
    expect(formatModelLabel('', {})).toBe('');
    expect(formatModelLabel(null, {})).toBe('');
    // Gate off → byte-fallback to the raw slug.
    expect(formatModelLabel('claude-opus-4-8', { KHY_MODEL_DISPLAY_NAME: '0' })).toBe('claude-opus-4-8');
    expect(formatModelLabel('claude-opus-4-8', { KHY_MODEL_DISPLAY_NAME: 'off' })).toBe('claude-opus-4-8');
  });

  // G-B: spinner surfaces elapsed time, a streamed-token estimate, and a stall
  // flag so the user can answer "is it stuck / how long has it run".
  async function spinnerFrame(props) {
    const Comp = require('../../src/cli/tui/ink-components/Spinner');
    const stdout = fakeStdout();
    const instance = ink.render(React.createElement(Comp, props), {
      stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    return frame;
  }

  test('Spinner shows elapsed seconds and a token estimate', async () => {
    // >30s so CC's SHOW_TOKENS_AFTER_MS threshold (G-C11) lets the progress meta
    // surface in the rendered frame; under 30s the spinner stays clean by design.
    const frame = await spinnerFrame({ label: '生成中…', elapsedSec: 35, tokens: 340 });
    expect(frame).toContain('35s');
    expect(frame).toContain('~340 tok');
  });

  test('Spinner flags a stall with 等待响应', async () => {
    const frame = await spinnerFrame({ label: '执行工具…', elapsedSec: 9, stalled: true });
    expect(frame).toContain('等待响应');
  });

  // G-A: the footer renders a REAL context-fill percentage when fed one (the bug
  // was contextPct pinned to 0 → a fake 0% regardless of usage).
  test('FooterBar renders a real context-fill percentage', async () => {
    const Comp = require('../../src/cli/tui/ink-components/FooterBar');
    const stdout = fakeStdout();
    const instance = ink.render(
      React.createElement(Comp, { model: 'claude-opus-4-8', contextPct: 42, contextLimit: 200000 }),
      { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    expect(frame).toContain('42% ctx');
  });

  // G-A2: CC parity — the footer left cluster carries a process-memory (RSS) · pid
  // segment (CC useRssDisplay `{formatFileSize(rss)} · pid:{pid}` with threshold
  // color bands). The pure threshold logic lives in cli/tui/footerMemory.js; here
  // we assert the wired FooterBar actually surfaces it, and that gate off removes it.
  test('FooterBar surfaces a process-memory · pid segment (CC parity), gate off removes it', async () => {
    const Comp = require('../../src/cli/tui/ink-components/FooterBar');
    const renderFooter = () => {
      const stdout = fakeStdout();
      const instance = ink.render(
        React.createElement(Comp, { model: 'claude-opus-4-8', contextPct: 12, contextLimit: 200000 }),
        { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
      );
      return { stdout, instance };
    };
    const { stdout, instance } = renderFooter();
    await new Promise((r) => setTimeout(r, 40));
    const frame = stdout.getBuffer();
    instance.unmount();
    // Real RSS at test time → a humanized size (MB/GB/KB) plus the live pid.
    expect(frame).toMatch(/pid:\d+/);
    expect(frame).toMatch(/(MB|GB|KB|bytes)/);

    // Gate off → the segment disappears; footer falls back to today's layout.
    const prev = process.env.KHY_FOOTER_MEMORY;
    process.env.KHY_FOOTER_MEMORY = 'off';
    try {
      const { stdout: s2, instance: i2 } = renderFooter();
      await new Promise((r) => setTimeout(r, 40));
      const frame2 = s2.getBuffer();
      i2.unmount();
      expect(frame2).not.toMatch(/pid:\d+/);
    } finally {
      if (prev === undefined) delete process.env.KHY_FOOTER_MEMORY;
      else process.env.KHY_FOOTER_MEMORY = prev;
    }
  });

  // G-A3: CC parity — when an active persistent goal exists, the footer carries a
  // `◎ /goal 进行中 (Nm)` indicator (CC's footer goal chip). The elapsed label
  // comes from the pure leaf goalKickoff.formatGoalElapsed; goalActive=null (no
  // goal / gate off / exception) removes the segment (byte-revert to today's footer).
  // 默认中文(对齐项目语言策略),KHY_UI_LANG=en 时走英文 'active'。
  test('FooterBar renders ◎ /goal 进行中 (Nm) when goalActive is present, none otherwise', async () => {
    const Comp = require('../../src/cli/tui/ink-components/FooterBar');
    const renderFooter = (props) => {
      const stdout = fakeStdout();
      const instance = ink.render(
        React.createElement(Comp, { model: 'claude-opus-4-8', contextPct: 5, contextLimit: 200000, ...props }),
        { stdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false },
      );
      return { stdout, instance };
    };
    // Active goal → indicator with the elapsed label.
    const { stdout, instance } = renderFooter({ goalActive: { id: 'g1', elapsedLabel: '4m' } });
    await new Promise((r) => setTimeout(r, 40));
    const frame = stripAnsi(stdout.getBuffer());
    instance.unmount();
    expect(frame).toContain('◎ /goal 进行中 (4m)');

    // No goal (null) → segment absent.
    const { stdout: s2, instance: i2 } = renderFooter({ goalActive: null });
    await new Promise((r) => setTimeout(r, 40));
    const frame2 = stripAnsi(s2.getBuffer());
    i2.unmount();
    expect(frame2).not.toContain('◎ /goal');
  });

  // G-B: the pure progress derivation behind the spinner props.
  test('_spinnerProgress derives elapsed / stall / tokens from the clock', () => {
    const App = require('../../src/cli/tui/ink-components/App');
    const fn = App._spinnerProgress;
    expect(typeof fn).toBe('function');
    // elapsed: 43000 − 1000 = 42s (past the 30s meta-reveal gate, so the live
    // token estimate is computed); activity 1000ms ago is fine (not stalled).
    const a = fn(1000, 43000, 42000, { text: 'hello world', thinking: '' });
    expect(a.elapsedSec).toBe(42);
    expect(a.stalled).toBe(false);
    expect(a.tokens).toBeGreaterThan(0);
    // stall: last activity was 12s ago (> 3s).
    expect(fn(1000, 13000, 1000, null).stalled).toBe(true);
    // no turn start → 0 elapsed; no stream → 0 tokens; activity 0 → not stalled.
    const z = fn(0, 0, 0, null);
    expect(z.elapsedSec).toBe(0);
    expect(z.tokens).toBe(0);
    expect(z.stalled).toBe(false);
  });

  // G-B2: CC parity — the live token hint estimates RESPONSE TEXT only (CC's
  // responseLength excludes thinking). Gate on (default): thinking is NOT counted;
  // gate off: legacy behavior counts text + thinking.
  // Clock is past the 30s spinner-meta reveal gate so the token estimate is
  // actually computed (KHY_SPINNER_TOKEN_LAZY skips it while the meta is hidden).
  test('_spinnerProgress excludes thinking from the live token hint (CC parity)', () => {
    const App = require('../../src/cli/tui/ink-components/App');
    const fn = App._spinnerProgress;
    // Pure thinking, no answer text yet → CC parity counts 0 (visible answer only).
    const ccOn = fn(1000, 43000, 42000, { text: '', thinking: 'a long stream of reasoning tokens here' });
    expect(ccOn.tokens).toBe(0);
    // Gate off → legacy includes thinking → > 0.
    const legacy = fn(1000, 43000, 42000, { text: '', thinking: 'a long stream of reasoning tokens here' }, { KHY_SPINNER_CC_TOKENS: '0' });
    expect(legacy.tokens).toBeGreaterThan(0);
    // With real answer text present, both modes count it; CC parity ignores the
    // thinking suffix, so its estimate is ≤ the legacy (text+thinking) estimate.
    const stream = { text: 'the visible answer so far', thinking: 'plus hidden reasoning' };
    const onT = fn(1000, 43000, 42000, stream).tokens;
    const offT = fn(1000, 43000, 42000, stream, { KHY_SPINNER_CC_TOKENS: '0' }).tokens;
    expect(onT).toBeGreaterThan(0);
    expect(onT).toBeLessThanOrEqual(offT);
  });
});
