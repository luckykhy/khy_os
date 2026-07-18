'use strict';

/**
 * agentTreeView — the SINGLE source of truth for how a parallel sub-agent fan-out
 * is laid out as a tree (branch glyphs, header wording, the progress
 * state-machine), shared by BOTH the classic REPL renderer (cli/agentRenderer)
 * and the ink TUI (cli/tui/ink-components/AgentTree). Pure — no chalk/ink/clock —
 * so these assertions pin the layout/transitions that must not drift between the
 * two front-ends.
 */
const {
  STATUS,
  makeAgentState,
  isAgentFamilyTool,
  classifyAgentTool,
  formatTreePreview,
  formatStats,
  detailText,
  buildAgentTreeRows,
  buildAgentHeader,
  applyProgressEvent,
} = require('../../src/cli/agentTreeView');

describe('isAgentFamilyTool', () => {
  test('matches agent / spawn_worker / sub_agent under name normalisation', () => {
    expect(isAgentFamilyTool('agent')).toBe(true);
    expect(isAgentFamilyTool('Agent')).toBe(true);
    expect(isAgentFamilyTool('spawn_worker')).toBe(true);
    expect(isAgentFamilyTool('spawn worker')).toBe(true);
    expect(isAgentFamilyTool('sub-agent')).toBe(true);
    expect(isAgentFamilyTool('Sub_Agent')).toBe(true);
  });
  test('rejects unrelated tools and junk input', () => {
    expect(isAgentFamilyTool('Read')).toBe(false);
    expect(isAgentFamilyTool('bash')).toBe(false);
    expect(isAgentFamilyTool('')).toBe(false);
    expect(isAgentFamilyTool(null)).toBe(false);
    expect(isAgentFamilyTool(undefined)).toBe(false);
  });
});

describe('buildAgentTreeRows', () => {
  test('non-last agents use ├, the last uses └', () => {
    const rows = buildAgentTreeRows([
      makeAgentState({ name: 'A', status: STATUS.RUNNING }),
      makeAgentState({ name: 'B', status: STATUS.RUNNING }),
      makeAgentState({ name: 'C', status: STATUS.RUNNING }),
    ]);
    const agentRows = rows.filter((r) => r.kind === 'agent');
    expect(agentRows.map((r) => r.branch)).toEqual(['├', '├', '└']);
    expect(agentRows.map((r) => r.name)).toEqual(['A', 'B', 'C']);
  });

  test('a running agent shows its current tool as the detail sub-line', () => {
    const a = makeAgentState({ name: 'A', status: STATUS.RUNNING });
    a.currentTool = 'Read';
    a.currentTarget = 'server.js';
    const rows = buildAgentTreeRows([a]);
    const detail = rows.find((r) => r.kind === 'detail');
    expect(detail).toBeTruthy();
    expect(detail.text).toBe('Read server.js');
    // last (and only) agent → continuation is a space, nothing dangles.
    expect(detail.cont).toBe(' ');
  });

  test('a finished agent shows its outcome detail, non-last keeps │ continuation', () => {
    const done = makeAgentState({ name: 'A', status: STATUS.COMPLETED });
    done.detail = 'Done';
    const last = makeAgentState({ name: 'B', status: STATUS.RUNNING });
    const rows = buildAgentTreeRows([done, last]);
    const detail = rows.find((r) => r.kind === 'detail');
    expect(detail.text).toBe('Done');
    expect(detail.cont).toBe('│'); // not the last branch
  });

  test('empty / non-array input yields no rows', () => {
    expect(buildAgentTreeRows([])).toEqual([]);
    expect(buildAgentTreeRows(null)).toEqual([]);
  });
});

describe('formatStats', () => {
  test('accepts elapsed as ms-number OR a pre-formatted string', () => {
    // KHY_CC_FORMAT default-on: a numeric elapsed now flows through the shared
    // agentStatLine → ccFormatDuration (CC formatDuration floors whole seconds
    // under 60s), so 2100ms renders '2s' (legacy手写 was '2.1s'). A pre-formatted
    // STRING elapsed is passed through untouched ('1.8s' stays '1.8s').
    expect(formatStats({ toolCalls: 5, elapsed: 2100 })).toEqual(['5 tool uses', '2s']);
    expect(formatStats({ toolCalls: 3, elapsed: '1.8s' })).toEqual(['3 tool uses', '1.8s']);
  });
  test('formats token counts and omits empty parts', () => {
    expect(formatStats({ tokens: 2100 })).toEqual(['2.1k tokens']);
    expect(formatStats({ tokens: 900 })).toEqual(['900 tokens']);
    expect(formatStats({})).toEqual([]);
  });
});

describe('buildAgentHeader', () => {
  test('reports running while any agent is still in flight', () => {
    const h = buildAgentHeader([
      makeAgentState({ status: STATUS.RUNNING }),
      makeAgentState({ status: STATUS.COMPLETED }),
    ]);
    expect(h.allDone).toBe(false);
    expect(h.count).toBe(2);
    expect(h.label).toBe('Running 2 agents…');
  });
  test('reports finished only when every agent reached a terminal state', () => {
    const h = buildAgentHeader([
      makeAgentState({ status: STATUS.COMPLETED }),
      makeAgentState({ status: STATUS.ERROR }),
    ]);
    expect(h.allDone).toBe(true);
    expect(h.label).toBe('2 agents finished');
  });
  test('an empty fan-out is never "allDone"', () => {
    expect(buildAgentHeader([]).allDone).toBe(false);
  });
  test('pluralizes a single agent: "Running 1 agent…" / "1 agent finished"', () => {
    const running = buildAgentHeader([makeAgentState({ status: STATUS.RUNNING })]);
    expect(running.label).toBe('Running 1 agent…');
    const done = buildAgentHeader([makeAgentState({ status: STATUS.COMPLETED })]);
    expect(done.label).toBe('1 agent finished');
  });
  test('gate KHY_CC_PLURAL off → byte-reverts to legacy plural form even for count 1', () => {
    const prev = process.env.KHY_CC_PLURAL;
    process.env.KHY_CC_PLURAL = '0';
    try {
      const running = buildAgentHeader([makeAgentState({ status: STATUS.RUNNING })]);
      expect(running.label).toBe('Running 1 agents…');
      const done = buildAgentHeader([makeAgentState({ status: STATUS.COMPLETED })]);
      expect(done.label).toBe('1 agents finished');
    } finally {
      if (prev === undefined) delete process.env.KHY_CC_PLURAL;
      else process.env.KHY_CC_PLURAL = prev;
    }
  });
});

describe('applyProgressEvent (pure reducer)', () => {
  test('does not mutate the input state', () => {
    const a = makeAgentState({ name: 'A', status: STATUS.RUNNING });
    const next = applyProgressEvent(a, { type: 'tool_start', tool: 'Read', target: 'x.js' });
    expect(a.toolCalls).toBe(0); // original untouched
    expect(next.toolCalls).toBe(1);
    expect(next).not.toBe(a);
  });

  test('tool_start increments the count and sets the live tool; tool_end clears it', () => {
    let a = makeAgentState({ status: STATUS.RUNNING });
    a = applyProgressEvent(a, { type: 'tool_start', tool: 'Grep', target: 'auth' });
    expect(a.currentTool).toBe('Grep');
    expect(a.currentTarget).toBe('auth');
    expect(a.toolCalls).toBe(1);
    a = applyProgressEvent(a, { type: 'tool_end' });
    expect(a.currentTool).toBeNull();
    expect(a.currentTarget).toBeNull();
    expect(a.toolCalls).toBe(1); // count is not decremented
  });

  test('agent_spawned/started affirm running and adopt a name without clobbering it', () => {
    let a = makeAgentState({ name: 'agent' }); // default placeholder name
    a = applyProgressEvent(a, { type: 'agent_spawned', name: '子任务A' });
    expect(a.status).toBe(STATUS.RUNNING);
    expect(a.name).toBe('子任务A');
    // a real name already set is not overwritten by a later spawn echo
    a = applyProgressEvent(a, { type: 'agent_started', name: 'other' });
    expect(a.name).toBe('子任务A');
  });

  test('a spawn after a terminal state never revives it (out-of-order safety)', () => {
    let a = makeAgentState({ status: STATUS.RUNNING });
    a = applyProgressEvent(a, { type: 'agent_completed', elapsed: 1200 });
    expect(a.status).toBe(STATUS.COMPLETED);
    a = applyProgressEvent(a, { type: 'agent_started' });
    expect(a.status).toBe(STATUS.COMPLETED); // not reverted to running
  });

  test('agent_completed / agent_failed set the terminal status, detail and elapsed', () => {
    const done = applyProgressEvent(makeAgentState({ status: STATUS.RUNNING }), {
      type: 'agent_completed', elapsed: 2100,
    });
    expect(done.status).toBe(STATUS.COMPLETED);
    expect(done.detail).toBe('Done');
    expect(done.elapsed).toBe(2100);

    const failed = applyProgressEvent(makeAgentState({ status: STATUS.RUNNING }), {
      type: 'agent_failed', error: 'boom',
    });
    expect(failed.status).toBe(STATUS.ERROR);
    expect(failed.detail).toBe('boom');
  });

  test('the leaf `done` event maps success→completed / failure→error with toolCalls', () => {
    const ok = applyProgressEvent(makeAgentState({ status: STATUS.RUNNING }), {
      type: 'done', success: true, toolCalls: 4, elapsed: 900,
    });
    expect(ok.status).toBe(STATUS.COMPLETED);
    expect(ok.toolCalls).toBe(4);

    const bad = applyProgressEvent(makeAgentState({ status: STATUS.RUNNING }), {
      type: 'done', success: false, error: 'nope',
    });
    expect(bad.status).toBe(STATUS.ERROR);
    expect(bad.detail).toBe('nope');
  });

  test('null guards: a null agent or event returns the agent unchanged', () => {
    const a = makeAgentState({});
    expect(applyProgressEvent(a, null)).toBe(a);
    expect(applyProgressEvent(null, { type: 'tool_start' })).toBeNull();
  });
});

describe('detailText', () => {
  test('running prefers the live tool, finished prefers the stored detail', () => {
    expect(detailText({ status: STATUS.RUNNING, currentTool: 'Read' })).toBe('Read');
    expect(detailText({ status: STATUS.COMPLETED, detail: 'Done' })).toBe('Done');
    // KHY_AGENT_INIT_STATUS default-on: a running agent with no tool / no prose
    // surfaces CC's liveness placeholder instead of a bare name (legacy was '').
    expect(detailText({ status: STATUS.RUNNING })).toBe('Initializing…');
    expect(detailText(null)).toBe('');
  });

  test('liveness placeholder: running+idle → "Initializing…" (CC AgentProgressLine), gated', () => {
    // 对齐 CC `!isResolved → lastToolInfo || 'Initializing…'`:未起工具/未吐 prose 的
    // 运行中 agent 也要看起来在活动,父级不会误读成卡死。
    expect(detailText({ status: STATUS.RUNNING })).toBe('Initializing…');
    // a tool / prose / outcome always wins over the placeholder.
    expect(detailText({ status: STATUS.RUNNING, currentTool: 'Read' })).toBe('Read');
    expect(detailText({ status: STATUS.RUNNING, currentText: 'thinking' })).toBe('thinking');
    // never for non-running states (pending stays bare, terminal shows outcome).
    expect(detailText({ status: STATUS.PENDING })).toBe('');
    expect(detailText({ status: STATUS.ERROR, detail: 'Failed' })).toBe('Failed');
    // gate off → byte-identical historical blank (no liveness sub-line).
    expect(detailText({ status: STATUS.RUNNING }, { KHY_AGENT_INIT_STATUS: 'off' })).toBe('');
    expect(detailText({ status: STATUS.RUNNING }, { KHY_AGENT_INIT_STATUS: '0' })).toBe('');
  });

  test('a running command tool surfaces the command line, preferred over target', () => {
    // 执行命令: a Bash row reads what it is running, not a bare "Bash".
    expect(detailText({
      status: STATUS.RUNNING, currentTool: 'Bash', currentCommand: 'python3 setup.py build',
    })).toBe('Bash python3 setup.py build');
    // currentCommand wins when both are present.
    expect(detailText({
      status: STATUS.RUNNING, currentTool: 'Bash', currentTarget: 't', currentCommand: 'ls -la',
    })).toBe('Bash ls -la');
  });

  test('an over-long command is clipped so it never wraps the box', () => {
    const long = 'x'.repeat(200);
    const out = detailText({ status: STATUS.RUNNING, currentTool: 'Bash', currentCommand: long });
    expect(out.length).toBeLessThanOrEqual('Bash '.length + 72);
    expect(out.endsWith('…')).toBe(true);
  });

  test('streamed prose (currentText) shows only when running and no tool is active', () => {
    // 子 agent 正文上浮:无工具在跑时显示正文尾。
    expect(detailText({ status: STATUS.RUNNING, currentText: 'Analyzing the repo' }))
      .toBe('Analyzing the repo');
    // a running tool always wins over the prose tail.
    expect(detailText({ status: STATUS.RUNNING, currentTool: 'Read', currentText: 'some prose' }))
      .toBe('Read');
    // a finished agent shows its outcome, never stale prose.
    expect(detailText({ status: STATUS.COMPLETED, detail: 'Done', currentText: 'leftover' }))
      .toBe('Done');
    // long prose is clipped.
    const long = 'p'.repeat(200);
    const out = detailText({ status: STATUS.RUNNING, currentText: long });
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('applyProgressEvent — agent_text (子 agent 正文流式)', () => {
  test('agent_text sets currentText while running', () => {
    const a = applyProgressEvent(makeAgentState({ status: STATUS.RUNNING }), {
      type: 'agent_text', text: 'reading server.js',
    });
    expect(a.currentText).toBe('reading server.js');
  });

  test('agent_text never resurrects a terminal agent', () => {
    let a = applyProgressEvent(makeAgentState({ status: STATUS.RUNNING }), {
      type: 'agent_completed', elapsed: 100,
    });
    a = applyProgressEvent(a, { type: 'agent_text', text: 'late prose' });
    expect(a.status).toBe(STATUS.COMPLETED);
    expect(a.currentText).toBeNull(); // cleared on terminal, not re-set
  });

  test('terminal events clear currentText', () => {
    let a = applyProgressEvent(makeAgentState({ status: STATUS.RUNNING }), {
      type: 'agent_text', text: 'mid prose',
    });
    expect(a.currentText).toBe('mid prose');
    const done = applyProgressEvent(a, { type: 'done', success: true });
    expect(done.currentText).toBeNull();
    const failed = applyProgressEvent(a, { type: 'agent_failed', error: 'x' });
    expect(failed.currentText).toBeNull();
  });
});

// ── Goal 3: parallel-agent tree shows 目录树 / 执行命令 / done ──────────────────
describe('classifyAgentTool', () => {
  test('groups commands, listings, reads, edits and searches by behaviour', () => {
    for (const n of ['bash', 'Shell', 'run_command', 'exec', 'PowerShell']) {
      expect(classifyAgentTool(n)).toBe('command');
    }
    for (const n of ['ls', 'LS', 'list_dir', 'glob', 'tree', 'find', 'read_directory']) {
      expect(classifyAgentTool(n)).toBe('listing');
    }
    expect(classifyAgentTool('Read')).toBe('read');
    expect(classifyAgentTool('Edit')).toBe('edit');
    expect(classifyAgentTool('Grep')).toBe('search');
    expect(classifyAgentTool('agent')).toBe('agent');
    expect(classifyAgentTool('SomethingElse')).toBe('other');
  });
});

describe('formatTreePreview', () => {
  test('renders ├/└ glyph lines and marks directories with a trailing slash', () => {
    const lines = formatTreePreview([
      { name: 'src', type: 'directory' },
      { name: 'index.js', type: 'file' },
    ]);
    expect(lines).toEqual(['├ src/', '└ index.js']);
  });

  test('bounds the listing and never silently drops entries (+N more tail)', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.js`, type: 'file' }));
    const lines = formatTreePreview(entries, { max: 6 });
    expect(lines.length).toBe(6);
    expect(lines[lines.length - 1]).toBe('└ … +15 more'); // 5 shown + tail of 15
  });

  test('accepts bare strings and empty/garbage input', () => {
    expect(formatTreePreview(['a.js', 'b.js'])).toEqual(['├ a.js', '└ b.js']);
    expect(formatTreePreview([])).toEqual([]);
    expect(formatTreePreview(null)).toEqual([]);
  });
});

describe('applyProgressEvent — command + listing enrichment', () => {
  test('tool_start captures the command; tool_end clears it', () => {
    let a = makeAgentState({ status: STATUS.RUNNING });
    a = applyProgressEvent(a, { type: 'tool_start', tool: 'Bash', command: 'npm test' });
    expect(a.currentCommand).toBe('npm test');
    a = applyProgressEvent(a, { type: 'tool_end' });
    expect(a.currentCommand).toBeNull();
  });

  test('a listing tool_end populates detailLines; later non-listing tools keep it', () => {
    let a = makeAgentState({ status: STATUS.RUNNING });
    a = applyProgressEvent(a, {
      type: 'tool_end',
      tool: 'LS',
      entries: [{ name: 'src', type: 'directory' }, { name: 'pkg.json', type: 'file' }],
    });
    expect(a.detailLines).toEqual(['├ src/', '└ pkg.json']);
    // a subsequent non-listing tool_end (no entries) must NOT wipe the tree
    a = applyProgressEvent(a, { type: 'tool_start', tool: 'Read', target: 'pkg.json' });
    a = applyProgressEvent(a, { type: 'tool_end', tool: 'Read' });
    expect(a.detailLines).toEqual(['├ src/', '└ pkg.json']);
  });
});

describe('buildAgentTreeRows — directory-tree preview rows', () => {
  test('emits kind:"preview" rows under the agent, aligned to its continuation', () => {
    const a = makeAgentState({ name: 'Explorer', status: STATUS.RUNNING });
    a.currentTool = 'LS';
    a.currentTarget = 'src';
    a.detailLines = ['├ cli/', '└ tools/'];
    const rows = buildAgentTreeRows([a]);
    const preview = rows.filter((r) => r.kind === 'preview');
    expect(preview.map((r) => r.text)).toEqual(['├ cli/', '└ tools/']);
    // last (only) agent → space continuation so nothing dangles
    expect(preview.every((r) => r.cont === ' ')).toBe(true);
  });

  test('non-last agent preview rows keep the │ continuation', () => {
    const a = makeAgentState({ name: 'A', status: STATUS.RUNNING });
    a.detailLines = ['└ only.js'];
    const b = makeAgentState({ name: 'B', status: STATUS.RUNNING });
    const rows = buildAgentTreeRows([a, b]);
    const preview = rows.filter((r) => r.kind === 'preview');
    expect(preview).toHaveLength(1);
    expect(preview[0].cont).toBe('│');
  });

  test('no detailLines → no preview rows (byte-identical to before)', () => {
    const a = makeAgentState({ name: 'A', status: STATUS.RUNNING });
    a.currentTool = 'Read';
    a.currentTarget = 'x.js';
    const rows = buildAgentTreeRows([a]);
    expect(rows.some((r) => r.kind === 'preview')).toBe(false);
  });
});
