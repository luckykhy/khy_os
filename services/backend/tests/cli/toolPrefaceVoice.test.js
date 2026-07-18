'use strict';

const {
  toolProgressReason,
  toolRunningNarration,
  toolOutcomeNarration,
  composePlanAnnouncement,
  composePlanProgress,
  buildStreamingToolPreface,
} = require('../../src/cli/toolPrefaceVoice');

describe('toolPrefaceVoice', () => {
  test('keeps the full repl read preface concise and file-specific', () => {
    expect(toolProgressReason('Read', { file_path: 'backend/src/cli/repl.js' }, { mode: 'full' }))
      .toBe('看下 repl.js 是怎么写的，找准要改的地方。');
  });

  test('keeps the lite repl fallback preface more conversational when context is thin', () => {
    expect(toolProgressReason('Read', {}, { mode: 'full' })).toBe('');
    expect(toolProgressReason('Read', {}, { mode: 'lite' }))
      .toBe('看下当前实现，找准要改的地方。');
  });

  test('preserves mode-specific write tone', () => {
    expect(toolProgressReason('CreateFile', { file_path: 'backend/src/cli/repl.js' }, { mode: 'full' }))
      .toBe('把改动写回 repl.js，落盘后顺手验一下。');
    expect(toolProgressReason('CreateFile', { file_path: 'backend/src/cli/repl.js' }, { mode: 'lite' }))
      .toBe('把改动写进 repl.js，写完回头验一下。');
  });

  test('builds streaming prefaces from raw input hints', () => {
    expect(buildStreamingToolPreface('Read', 'backend/src/cli/repl.js', { mode: 'full' }))
      .toBe('看下 repl.js 是怎么写的，找准要改的地方。');
    expect(buildStreamingToolPreface('shellCommand', 'npm test -- --runInBand', { mode: 'lite' }))
      .toBe('跑下 `npm test -- --runInBand`，看看现场跟预期对不对。');
  });

  test('keeps shared partner-style hints for search, web and agent tools', () => {
    expect(toolProgressReason('Grep', { pattern: 'toolResultReflection', path: 'backend/src/cli/repl.js' }, { mode: 'full' }))
      .toBe('在 repl.js 里搜 "toolResultReflection"，定位要动的地方。');
    expect(toolProgressReason('webSearch', { query: 'tool preface streaming' }, { mode: 'lite' }))
      .toBe('查一下 "tool preface streaming" 的外部资料，补齐再回来。');
    expect(toolProgressReason('agent', { role: 'worker' }, { mode: 'full' }))
      .toBe('这部分交给 worker 并行跑，回头我来收。');
  });

  test('separator-agnostic basename: a Windows path narrates the leaf on any host', () => {
    // The reported case: ls on a Windows Desktop path must say "Desktop", not the
    // full backslash path, even when running on a POSIX host (path.basename only
    // splits the host separator).
    expect(toolProgressReason('LS', { path: 'D:\\HuaweiMoveData\\Users\\25789\\Desktop' }, { mode: 'lite' }))
      .toBe('看下 Desktop 的结构，找到切入口。');
  });
});

describe('toolRunningNarration (执行中 staged transparency)', () => {
  test('present-continuous lines name the concrete target', () => {
    expect(toolRunningNarration('LS', { path: 'D:\\x\\Desktop' })).toBe('正在列出 Desktop 的条目…');
    expect(toolRunningNarration('Read', { file_path: '/a/foo.js' })).toBe('正在读取 foo.js…');
    expect(toolRunningNarration('Edit', { file_path: '/a/bar.js' })).toBe('正在修改 bar.js…');
    expect(toolRunningNarration('Grep', { pattern: 'TODO', path: '/a/src' })).toBe('正在 src 里搜索 "TODO"…');
  });

  test('shell narration echoes (and truncates) the command', () => {
    expect(toolRunningNarration('bash', { command: 'npm test' })).toBe('正在执行 `npm test`…');
    const long = 'x'.repeat(80);
    expect(toolRunningNarration('bash', { command: long })).toBe('正在执行 `' + 'x'.repeat(47) + '...`…');
  });

  test('falls back to a generic running line for thin/unknown input', () => {
    expect(toolRunningNarration('Read', {})).toBe('正在读取…');
    expect(toolRunningNarration('unknown_xyz', {})).toBe('正在执行…');
    expect(toolRunningNarration()).toBe('正在执行…');
  });
});

describe('toolOutcomeNarration (结果+行动 completion reflection)', () => {
  test('ls reflects the entry COUNT from the structured result and names a next move', () => {
    const out = toolOutcomeNarration('LS', { success: true, count: 24 }, { path: 'D:\\x\\Desktop' });
    expect(out).toContain('24');
    expect(out).toContain('Desktop');
    // "结果 + 行动": a concrete readout followed by what happens next.
    expect(out).toContain('接着');
  });

  test('ls falls back to the entries array length when count is absent', () => {
    const out = toolOutcomeNarration('ls', { success: true, entries: ['a', 'b', 'c'] }, { path: '/home/x/Desktop' });
    expect(out).toContain('3');
  });

  test('an empty directory reads as empty, not "0 条目"', () => {
    const out = toolOutcomeNarration('ls', { success: true, count: 0 }, { path: '/tmp/empty' });
    expect(out).toContain('空');
  });

  test('read reflects the line total and the file', () => {
    const out = toolOutcomeNarration('read', { success: true, lines: 42 }, { file_path: '/a/foo.js' });
    expect(out).toContain('foo.js');
    expect(out).toContain('42');
  });

  test('grep reflects the match count', () => {
    expect(toolOutcomeNarration('grep', { success: true, count: 7 }, { pattern: 'TODO' })).toContain('7');
    expect(toolOutcomeNarration('grep', { success: true, count: 0 }, { pattern: 'TODO' })).toContain('没找到');
  });

  test('a successful shell run reads as 跑通; a non-zero exit narrates a recovery beat (KHY_TOOL_OUTCOME_FAIL on)', () => {
    expect(toolOutcomeNarration('bash', { success: true, exitCode: 0 }, { command: 'npm test' })).toContain('跑通');
    // 批2: default-on failure narration — non-zero exit now yields a forward-looking line.
    const nonZero = toolOutcomeNarration('bash', { success: true, exitCode: 2 }, { command: 'npm test' });
    expect(nonZero).toContain('非零');
    expect(nonZero).toContain('报错');
  });

  test('a FAILED / denied step narrates a recovery beat by default (批2)', () => {
    expect(toolOutcomeNarration('read', { success: false }, { file_path: '/a/foo.js' })).toContain('没走通');
    expect(toolOutcomeNarration('write', { denied: true }, { file_path: '/a/foo.js' })).toContain('没走通');
    // 有 error 根因时,失败旁白改为念出根因(2026-07-05「错误根因不会汇报」)并仍带调整动作。
    const withErr = toolOutcomeNarration('bash', { success: true, error: 'boom' }, {});
    expect(withErr).toContain('boom');
    expect(withErr).toContain('据此调整');
  });

  test('KHY_TOOL_OUTCOME_FAIL=0 restores the old "failed step is silent" behavior', () => {
    const prev = process.env.KHY_TOOL_OUTCOME_FAIL;
    process.env.KHY_TOOL_OUTCOME_FAIL = '0';
    try {
      expect(toolOutcomeNarration('read', { success: false }, { file_path: '/a/foo.js' })).toBe('');
      expect(toolOutcomeNarration('write', { denied: true }, { file_path: '/a/foo.js' })).toBe('');
      expect(toolOutcomeNarration('bash', { success: true, exitCode: 2 }, { command: 'npm test' })).toBe('');
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOL_OUTCOME_FAIL;
      else process.env.KHY_TOOL_OUTCOME_FAIL = prev;
    }
  });

  test('never throws on missing/garbage input', () => {
    expect(toolOutcomeNarration()).toBe('');
    expect(toolOutcomeNarration('unknown_xyz', { success: true }, {})).toBe('');
    expect(toolOutcomeNarration('ls', null, null)).toBe('');
  });
});

describe('toolOutcomeNarration 失败旁白念出根因 (KHY_TOOL_OUTCOME_ROOT_CAUSE)', () => {
  const FLAG = 'KHY_TOOL_OUTCOME_ROOT_CAUSE';
  function withFlag(val, fn) {
    const prev = process.env[FLAG];
    if (val === undefined) delete process.env[FLAG];
    else process.env[FLAG] = val;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prev;
    }
  }

  test('门控开 + 非零退出 bash,输出含 ModuleNotFound → 命令旁白念出根因', () => {
    withFlag(undefined, () => {
      const out = toolOutcomeNarration('bash',
        { success: true, exitCode: 1, output: "Traceback...\nModuleNotFoundError: No module named 'flask'" },
        { command: 'python app.py' });
      expect(out).toContain('exit 1');
      expect(out).toContain("No module named 'flask'");
      expect(out).toContain('据此调整');
    });
  });

  test('门控开 + 通用失败分支(read 失败,error 含 fatal)→ 念出根因', () => {
    withFlag(undefined, () => {
      const out = toolOutcomeNarration('read',
        { success: false, error: 'fatal: not a git repository' }, { file_path: '/a/x.js' });
      expect(out).toContain('fatal: not a git repository');
      expect(out).toContain('据此调整');
      expect(out).toContain('x.js');
    });
  });

  test('门控关(0)→ 逐字节回退旧 canned 行(不念根因)', () => {
    withFlag('0', () => {
      const bash = toolOutcomeNarration('bash',
        { success: true, exitCode: 1, output: "ModuleNotFoundError: No module named 'flask'" },
        { command: 'python app.py' });
      expect(bash).toBe('命令返回了非零退出码（1），我先看下输出里的报错再调整。');
      const rd = toolOutcomeNarration('read',
        { success: false, error: 'fatal: not a git repository' }, { file_path: '/a/x.js' });
      expect(rd).toBe('x.js 这一步没走通，我先看下报错信息再调整方案。');
    });
  });

  test('门控开 + 无可提取根因 → 回退旧 canned 行', () => {
    withFlag(undefined, () => {
      const out = toolOutcomeNarration('bash',
        { success: true, exitCode: 3, output: 'nothing recognizable here at all' },
        { command: 'x' });
      expect(out).toBe('命令返回了非零退出码（3），我先看下输出里的报错再调整。');
    });
  });
});

describe('composePlanAnnouncement (task-level proactive plan)', () => {
  const plan = {
    steps: [
      { id: 1, description: '读取 repl.js 摸清结构', toolHint: 'read', status: 'pending' },
      { id: 2, description: '改 useQueryBridge 接线', toolHint: 'edit', status: 'pending' },
      { id: 3, description: '跑测试验证', toolHint: 'bash', status: 'pending' },
    ],
  };

  test('opens with a proactive first-person framing and numbered steps', () => {
    const out = composePlanAnnouncement(plan);
    expect(out.startsWith('我先讲下这件事打算怎么做：')).toBe(true);
    expect(out).toContain('1. 读取 repl.js 摸清结构');
    expect(out).toContain('2. 改 useQueryBridge 接线');
    expect(out).toContain('3. 跑测试验证');
    expect(out.endsWith('我先从第 1 步开始。')).toBe(true);
  });

  test('a single-step plan adds nothing the per-tool preface does not → silent', () => {
    expect(composePlanAnnouncement({ steps: [{ id: 1, description: '只有一步' }] })).toBe('');
  });

  test('caps the shown steps and reports how many remain', () => {
    const big = { steps: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, description: `步骤${i + 1}` })) };
    const out = composePlanAnnouncement(big, { maxSteps: 6 });
    expect(out).toContain('6. 步骤6');
    expect(out).not.toContain('7. 步骤7');
    expect(out).toContain('还有 3 步，共 9 步');
  });

  test('notes parallel groups when any step carries one', () => {
    const withParallel = {
      steps: [
        { id: 1, description: '读 A', parallelGroup: 'A' },
        { id: 2, description: '读 B', parallelGroup: 'A' },
      ],
    };
    expect(composePlanAnnouncement(withParallel)).toContain('可以并行推进');
  });

  test('never throws on absent / garbage plans', () => {
    expect(composePlanAnnouncement()).toBe('');
    expect(composePlanAnnouncement(null)).toBe('');
    expect(composePlanAnnouncement({})).toBe('');
    expect(composePlanAnnouncement({ steps: [] })).toBe('');
    expect(composePlanAnnouncement({ steps: [null, undefined] })).toBe('');
  });
});

describe('composePlanProgress (task-level step transition)', () => {
  const plan = {
    steps: [
      { id: 1, description: '读取 repl.js' },
      { id: 2, description: '改 useQueryBridge' },
      { id: 3, description: '跑测试' },
    ],
  };

  test('narrates a step BECOMING in_progress (step 2+)', () => {
    expect(composePlanProgress(plan, 1, 'in_progress')).toBe('第 2 步：改 useQueryBridge。');
    expect(composePlanProgress(plan, 2, 'in_progress')).toBe('第 3 步：跑测试。');
  });

  test('stays silent on step 1 (covered by the upfront announcement)', () => {
    expect(composePlanProgress(plan, 0, 'in_progress')).toBe('');
  });

  test('stays silent on non-in_progress transitions', () => {
    expect(composePlanProgress(plan, 1, 'completed')).toBe('');
    expect(composePlanProgress(plan, 1, 'pending')).toBe('');
  });

  test('never throws on out-of-range index / garbage', () => {
    expect(composePlanProgress(plan, 9, 'in_progress')).toBe('');
    expect(composePlanProgress(plan, -1, 'in_progress')).toBe('');
    expect(composePlanProgress(null, 1, 'in_progress')).toBe('');
    expect(composePlanProgress({ steps: [] }, 0, 'in_progress')).toBe('');
    expect(composePlanProgress()).toBe('');
  });
});
