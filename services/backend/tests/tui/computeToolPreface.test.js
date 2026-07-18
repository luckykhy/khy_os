'use strict';

/**
 * computeToolPreface — the ink-TUI bridge's Issue B「先说要做什么，再执行」gate.
 *
 * Before, the TUI jumped straight to executing a tool (the screenshot: a user
 * asked "我的桌面上有什么" and saw only "✓ 已批准: ls(...)" → "LS(...)" with no
 * narration). The bridge now injects a short first-person preface ahead of a
 * tool WHEN the model produced no narration for that segment. This is the pure
 * decision behind that injection — gating + the shared toolPrefaceVoice text.
 */

const {
  computeToolPreface,
  computeToolProgress,
  computeToolOutcome,
  computePlanAnnouncement,
  computePlanProgress,
} = require('../../src/cli/tui/hooks/useQueryBridge');

describe('computeToolPreface (Issue B intent narration)', () => {
  test('narrates a silent ls on the desktop path (the reported case)', () => {
    const out = computeToolPreface({
      name: 'LS',
      params: { path: 'D:\\HuaweiMoveData\\Users\\25789\\Desktop' },
      segmentNarrated: false,
      env: {},
    });
    // Separator-agnostic basename → "Desktop", not the full Windows path.
    expect(out).toContain('Desktop');
    // 自然口吻:不再强开「我先」,只要求确实叙述了一句(非空)。
    expect(out.length).toBeGreaterThan(0);
  });

  test('stays silent when the model already narrated this segment', () => {
    const out = computeToolPreface({
      name: 'LS',
      params: { path: '/home/x/Desktop' },
      segmentNarrated: true,
      env: {},
    });
    expect(out).toBe('');
  });

  test('批2: model said something generic but did NOT name this tool → still narrates', () => {
    const out = computeToolPreface({
      name: 'read',
      params: { file_path: '/a/b/foo.js' },
      segmentNarrated: true,            // coarse boolean would have silenced…
      segmentText: '好的，我来处理一下。', // …but the relaxed check sees no mention of read/foo.js
      env: {},
    });
    expect(out).toContain('foo.js');
  });

  test('批2: model already named this tool in its prose → stays silent (no double)', () => {
    const out = computeToolPreface({
      name: 'read',
      params: { file_path: '/a/b/foo.js' },
      segmentNarrated: true,
      segmentText: '我先读一下 foo.js 看看实现。',
      env: {},
    });
    expect(out).toBe('');
  });

  test('KHY_TOOL_PREFACE=0 disables narration', () => {
    const out = computeToolPreface({
      name: 'read',
      params: { file_path: '/a/b/foo.js' },
      segmentNarrated: false,
      env: { KHY_TOOL_PREFACE: '0' },
    });
    expect(out).toBe('');
  });

  test('narrates a silent read with the basename', () => {
    const out = computeToolPreface({
      name: 'read',
      params: { file_path: '/a/b/foo.js' },
      segmentNarrated: false,
      env: {},
    });
    expect(out).toContain('foo.js');
  });

  test('narrates a silent bash with the command', () => {
    const out = computeToolPreface({
      name: 'bash',
      params: { command: 'npm test' },
      segmentNarrated: false,
      env: {},
    });
    expect(out).toContain('npm test');
  });

  test('never throws on missing/garbage input', () => {
    expect(computeToolPreface()).toBe('');
    expect(computeToolPreface({ name: null, params: null, segmentNarrated: false, env: {} })).toBe('');
    expect(computeToolPreface({ name: 'unknown_tool_xyz', params: {}, segmentNarrated: false, env: {} })).toBe('');
  });
});

describe('computeToolProgress (执行中 staged narration)', () => {
  test('present-continuous narration for a running ls', () => {
    const out = computeToolProgress({ name: 'LS', params: { path: 'D:\\x\\Desktop' }, env: {} });
    expect(out).toBe('正在列出 Desktop 的条目…');
  });

  test('NOT gated on segmentNarrated — shows even when intent was narrated', () => {
    // computeToolProgress has no segmentNarrated param: a running tool always
    // describes itself, regardless of whether the model narrated intent above.
    const out = computeToolProgress({ name: 'read', params: { file_path: '/a/foo.js' }, env: {} });
    expect(out).toBe('正在读取 foo.js…');
  });

  test('master KHY_TOOL_PREFACE=0 disables it too', () => {
    const out = computeToolProgress({ name: 'LS', params: { path: '/x/Desktop' }, env: { KHY_TOOL_PREFACE: '0' } });
    expect(out).toBe('');
  });

  test('dedicated KHY_TOOL_PROGRESS=0 disables only the running line', () => {
    const out = computeToolProgress({ name: 'LS', params: { path: '/x/Desktop' }, env: { KHY_TOOL_PROGRESS: '0' } });
    expect(out).toBe('');
  });

  test('unknown tool falls back to a generic running line (never blank/throw)', () => {
    expect(computeToolProgress({ name: 'unknown_xyz', params: {}, env: {} })).toBe('正在执行…');
    expect(computeToolProgress()).toBe('正在执行…');
  });

  test('模型推理优先: stands down when the MODEL narrated this segment', () => {
    // The model is reasoning in prose → no mechanical "正在…" line under it.
    expect(computeToolProgress({ name: 'LS', params: { path: '/x/Desktop' }, env: {}, modelNarrated: true })).toBe('');
    // …but a SYNTHETIC preface above (silent model) does NOT suppress it — that
    // is exactly the Stage C transparency path (modelNarrated stays false).
    expect(computeToolProgress({ name: 'LS', params: { path: '/x/Desktop' }, env: {}, modelNarrated: false }))
      .toBe('正在列出 Desktop 的条目…');
  });
});

describe('computeToolOutcome (结果+行动 completion reflection gate)', () => {
  test('reflects the structured count of a completed ls (the reported desktop case)', () => {
    const out = computeToolOutcome({
      name: 'LS',
      result: { success: true, count: 24 },
      params: { path: 'D:\\HuaweiMoveData\\Users\\25789\\Desktop' },
      env: {},
    });
    expect(out).toContain('24');
    expect(out).toContain('Desktop');
  });

  test('reads from the RAW result fields the view projection would have stripped', () => {
    // projectToolResultForView drops entries[]; the outcome voice must see them.
    const out = computeToolOutcome({
      name: 'ls',
      result: { success: true, entries: ['a', 'b'] },
      params: { path: '/x/Desktop' },
      env: {},
    });
    expect(out).toContain('2');
  });

  test('master KHY_TOOL_PREFACE=0 disables it', () => {
    const out = computeToolOutcome({
      name: 'LS', result: { success: true, count: 5 }, params: {}, env: { KHY_TOOL_PREFACE: '0' },
    });
    expect(out).toBe('');
  });

  test('dedicated KHY_TOOL_OUTCOME=0 disables only the completion reflection', () => {
    const out = computeToolOutcome({
      name: 'LS', result: { success: true, count: 5 }, params: {}, env: { KHY_TOOL_OUTCOME: '0' },
    });
    expect(out).toBe('');
  });

  test('批2: a failed step now narrates a recovery beat by default; garbage never throws', () => {
    expect(computeToolOutcome({ name: 'read', result: { success: false }, params: {}, env: {} })).toContain('没走通');
    expect(computeToolOutcome()).toBe('');
    expect(computeToolOutcome({ name: 'unknown_xyz', result: { success: true }, params: {}, env: {} })).toBe('');
  });
});

describe('computePlanAnnouncement (task-level proactive plan gate)', () => {
  const plan = {
    steps: [
      { id: 1, description: '读取 repl.js 摸清结构' },
      { id: 2, description: '改 useQueryBridge' },
    ],
  };

  test('surfaces the upfront announcement for a multi-step plan', () => {
    const out = computePlanAnnouncement({ plan, segmentModelNarrated: false, env: {} });
    expect(out).toContain('我先讲下这件事打算怎么做');
    expect(out).toContain('读取 repl.js 摸清结构');
  });

  test('模型推理优先: stands down when the model already narrated this segment', () => {
    expect(computePlanAnnouncement({ plan, segmentModelNarrated: true, env: {} })).toBe('');
  });

  test('master KHY_TOOL_PREFACE=0 disables it', () => {
    expect(computePlanAnnouncement({ plan, segmentModelNarrated: false, env: { KHY_TOOL_PREFACE: '0' } })).toBe('');
  });

  test('dedicated KHY_PLAN_ANNOUNCE=0 disables only the plan announcement', () => {
    expect(computePlanAnnouncement({ plan, segmentModelNarrated: false, env: { KHY_PLAN_ANNOUNCE: '0' } })).toBe('');
  });

  test('trivial / absent plan stays silent; garbage never throws', () => {
    expect(computePlanAnnouncement({ plan: { steps: [{ id: 1, description: '只有一步' }] }, env: {} })).toBe('');
    expect(computePlanAnnouncement({ plan: null, env: {} })).toBe('');
    expect(computePlanAnnouncement()).toBe('');
  });
});

describe('computePlanProgress (task-level step-transition gate — 批2 default-on)', () => {
  const plan = {
    steps: [
      { id: 1, description: '读取 repl.js' },
      { id: 2, description: '改 useQueryBridge' },
    ],
  };

  test('ON by default — narrates the step transition for a multi-step plan', () => {
    expect(computePlanProgress({ plan, stepIndex: 1, status: 'in_progress', env: {} }))
      .toBe('第 2 步：改 useQueryBridge。');
  });

  test('KHY_PLAN_PROGRESS=0 opts out (restores the old silent behavior)', () => {
    expect(computePlanProgress({ plan, stepIndex: 1, status: 'in_progress', env: { KHY_PLAN_PROGRESS: '0' } })).toBe('');
  });

  test('model narrated → stands down; master kill-switch also wins', () => {
    expect(computePlanProgress({ plan, stepIndex: 1, status: 'in_progress', segmentModelNarrated: true, env: {} })).toBe('');
    expect(computePlanProgress({ plan, stepIndex: 1, status: 'in_progress', env: { KHY_TOOL_PREFACE: '0' } })).toBe('');
  });

  test('never throws on garbage', () => {
    expect(computePlanProgress()).toBe('');
    expect(computePlanProgress({ plan: null, stepIndex: 0, status: 'in_progress', env: {} })).toBe('');
  });
});
