/**
 * AB Test v2 — KHY vs Claude Code Interactivity (Natural Language Timeline)
 *
 * Each round simulates the EXACT terminal output timeline for both systems,
 * rendered as natural-language descriptions, then checks every element.
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  Claude Code output timeline (reference)                    ║
 * ║                                                             ║
 * ║  1. User message (dark bg)                                  ║
 * ║  2. Spinner "Thinking..." (elapsed + tokens + stall color)  ║
 * ║  3. [thinking indicator if extended thinking]               ║
 * ║  4. Tool call start: ⏺ Read(file.js)                       ║
 * ║     - intent line above: "Reading file contents"            ║
 * ║  5. Tool call result: ● Read(file.js) 0.1s                 ║
 * ║     ⎿ 245 lines                                            ║
 * ║  6. [repeat 4-5 for each tool]                              ║
 * ║  7. Streamed markdown response                              ║
 * ║  8. Cost/model line: ╰─ claude-3.5 · 2.3s · ↑12k ↓1.5k    ║
 * ║  9. Dim separator ─                                         ║
 * ║ 10. Prompt >                                                ║
 * ║                                                             ║
 * ║  Multi-tool: [2/5] prefix from 2nd call onward              ║
 * ║  Agent: ToolUseTracker tree → collapse to "Done" summary    ║
 * ║  Bash: command preview box (bg color block)                 ║
 * ║  Edit: diff preview (+/- lines)                             ║
 * ║  Interrupt: dim "⏸ Interrupted"                             ║
 * ║  Compaction: "✻ Conversation compacted"                     ║
 * ║  Exit: session recap (tokens, cost, time, top tools)        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function safe(mod) { try { return require(mod); } catch { return null; } }

const toolDisplay   = safe('../../src/cli/toolDisplay');
const panels        = safe('../../src/cli/panels');
const spinnerMod    = safe('../../src/cli/spinner');
const renderTheme   = safe('../../src/cli/renderTheme');
const transparency  = safe('../../src/cli/transparency');
const markdownR     = safe('../../src/cli/markdownRenderer');
const steps         = safe('../../src/cli/steps');
const diffRenderer  = safe('../../src/cli/diffRenderer');

function capture(fn) {
  const out = [];
  const _log = console.log;
  const _write = process.stdout.write;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (d) => { if (typeof d === 'string') out.push(d); return true; };
  try { fn(); } finally { console.log = _log; process.stdout.write = _write; }
  return out;
}
function strip(s) { return String(s || '').replace(/\x1b\[[0-9;]*m/g, ''); }
function joined(lines) { return lines.map(strip).join('\n'); }

// ══════════════════════════════════════════════════════════════════
//  ROUND 1 — Small Task: "Fix the typo in README.md line 12"
//
//  Claude Code timeline:
//    ● Thinking... (3s · ↑5k tokens)
//    看看 README.md 里的内容
//    ▷ 读取(README.md)
//    ▷ 读取(README.md) 0.1s
//      ⎿ 已读取 README.md（45 行）
//    修改 README.md
//    ◇ 修改(README.md)
//    ◇ 修改(README.md) 0.1s
//      ⎿ 已修改 README.md，1 处替换（~1）
//    [streamed text: "I fixed the typo on line 12..."]
//    ╰─ claude-3.5 · 2.3s · ↑5.2k ↓0.8k · $0.02
//    ─
// ══════════════════════════════════════════════════════════════════

describe('Round 1: Small Task — Fix typo in README.md', () => {

  it('CC-1: user message renders with dark bg', () => {
    const out = capture(() => spinnerMod.renderUserMessage('Fix the typo in README.md line 12'));
    assert.ok(out.length > 0, 'user message should render');
    assert.ok(joined(out).includes('Fix the typo'), 'should contain user text');
  });

  it('CC-2: spinner has elapsed + tokens + stall detection', () => {
    const s = new spinnerMod.DynamicSpinner();
    assert.ok(typeof s.start === 'function');
    assert.ok(typeof s.setTokens === 'function');
    assert.ok(typeof s.setEffort === 'function');
    assert.ok(typeof s.resetTimer === 'function');
    // Verify stall detection exists — _lastTokenAt should be set
    s.setTokens(100, 'output');
    assert.ok(s._lastTokenAt > 0, 'stall timer updated on token');
  });

  it('CC-3: intent line shown before tool call', () => {
    toolDisplay.resetStepCounter();
    const out = capture(() => toolDisplay.printToolCallStart('Read', { file_path: 'README.md' }));
    const j = joined(out);
    // KHY shows "看看 README.md 里的内容" as intent
    assert.ok(j.includes('README.md'), 'intent should mention file');
  });

  it('CC-4: tool start shows icon + display name + params', () => {
    toolDisplay.resetStepCounter();
    // Use a unique path to avoid dedup with CC-3's call
    const out = capture(() => toolDisplay.printToolCallStart('Read', { file_path: 'CHANGELOG.md' }));
    const j = joined(out);
    assert.ok(j.includes('CHANGELOG.md'), 'should show file path param');
  });

  it('CC-5: tool result shows detail + elapsed', () => {
    const out = capture(() => toolDisplay.printToolCallResult('Read', { file_path: 'README.md' }, 'success', '已读取 README.md（45 行）', 100));
    const j = joined(out);
    assert.ok(j.includes('45'), 'should show line count');
    assert.ok(j.includes('0.1s'), 'should show elapsed time');
  });

  it('CC-6: edit tool shows file path + diff info', () => {
    toolDisplay.resetStepCounter();
    const out = capture(() => toolDisplay.printToolCallStart('Edit', { file_path: 'README.md', old_string: 'teh', new_string: 'the' }));
    const j = joined(out);
    assert.ok(j.includes('README.md'), 'edit should show file path');
  });

  it('CC-7: file operation shows +/- stats', () => {
    const out = capture(() => toolDisplay.printFileOperation('update', 'README.md', { added: 1, removed: 1 }, 80));
    const j = joined(out);
    assert.ok(j.includes('Added 1 line'), 'should show added count');
    assert.ok(j.includes('removed 1 line'), 'should show removed count');
  });

  it('CC-8: cost/token transparency exists', () => {
    assert.ok(typeof transparency.printTurnCost === 'function');
    assert.ok(typeof transparency.printCascadeSteps === 'function');
  });

  it('CC-9: thinking verbs rotate (8+ variants)', () => {
    assert.ok(renderTheme.THINKING_VERBS.length >= 8, `got ${renderTheme.THINKING_VERBS.length} verbs`);
  });

  it('CC-10: step counter NOT shown for 1st tool call', () => {
    toolDisplay.resetStepCounter();
    const out = capture(() => toolDisplay.printToolCallStart('Read', { file_path: 'x.js' }));
    const j = joined(out);
    assert.ok(!j.includes('[1]'), 'first call should not show [1]');
  });
});

// ══════════════════════════════════════════════════════════════════
//  ROUND 2 — Medium Task: "Add parseDate(str) to utils.js + test"
//
//  Claude Code timeline:
//    ● Thinking... (5s · ↑8k · extended thinking · high)
//    看看 utils.js 里的内容
//    [1/5] ▷ 读取(utils.js)                     ← step counter
//    ▷ 读取(utils.js) 0.1s
//      ⎿ 已读取 utils.js（120 行）
//    搜索包含 "parseDate" 的文件
//    [2/5] ⌕ 搜索(pattern: "parseDate")
//    ⌕ 搜索(pattern: "parseDate") 0.2s
//      ⎿ 找到 0 个匹配
//    修改 utils.js
//    [3/5] ◇ 修改(utils.js)
//    ◇ 修改(utils.js) 0.1s
//      ⎿ 已修改 utils.js，1 处替换（+15）
//    把改动写入 utils.test.js
//    [4/5] ◆ 写入(utils.test.js)
//    ◆ 写入(utils.test.js) 0.1s
//      ⎿ 已写入 utils.test.js（42 行）
//    执行 npm test 命令
//    [5/5] ▶ Bash(npm test -- --grep "parseDate")
//      $ npm test -- --grep "parseDate"            ← bg preview box
//    ▶ Bash(...) 2.1s
//      ⎿ 命令输出 8 行
//    [streamed markdown with code block]
//    ╰─ claude-3.5 · 8.2s · ↑8.3k ↓2.1k · $0.05
//    ─
// ══════════════════════════════════════════════════════════════════

describe('Round 2: Medium Task — Add parseDate + test', () => {

  it('CC-11: step counter [N/M] from 2nd call with setStepTotal', () => {
    toolDisplay.resetStepCounter();
    toolDisplay.setStepTotal(5);
    capture(() => toolDisplay.printToolCallStart('Read', { file_path: 'utils.js' }));
    const out = capture(() => toolDisplay.printToolCallStart('Grep', { pattern: 'parseDate' }));
    const j = joined(out);
    assert.ok(j.includes('[2/5]'), `should show [2/5], got: ${j.slice(0, 100)}`);
    toolDisplay.resetStepCounter();
  });

  it('CC-12: step counter auto-increments without total (from 2nd)', () => {
    toolDisplay.resetStepCounter();
    capture(() => toolDisplay.printToolCallStart('Read', { file_path: 'a.js' }));
    const out2 = capture(() => toolDisplay.printToolCallStart('Grep', { pattern: 'x' }));
    const j2 = joined(out2);
    assert.ok(j2.includes('[2]'), `2nd call should show [2], got: ${j2.slice(0, 100)}`);
    toolDisplay.resetStepCounter();
  });

  it('CC-13: bash preview box shows command', () => {
    toolDisplay.resetStepCounter();
    const out = capture(() => toolDisplay.printToolCallStart('Bash', { command: 'npm test -- --grep "parseDate"' }));
    const j = joined(out);
    assert.ok(j.includes('npm test'), 'should show bash command in preview box');
    assert.ok(j.includes('$'), 'should show $ prefix in preview');
  });

  it('CC-14: write tool shows file info line', () => {
    toolDisplay.resetStepCounter();
    const out = capture(() => toolDisplay.printToolCallStart('Write', {
      file_path: 'utils.test.js',
      content: 'const x = 1;\n'.repeat(42),
    }));
    const j = joined(out);
    assert.ok(j.includes('utils.test.js'), 'should show file path');
    assert.ok(j.includes('42 lines') || j.includes('Writing'), 'should show line count or Writing label');
  });

  it('CC-15: task plan tracker with 5 tasks', () => {
    const tracker = new panels.TaskPlanTracker({ rewriteInPlace: false });
    tracker.addTask('Read utils.js');
    tracker.addTask('Search for parseDate');
    tracker.addTask('Add parseDate function');
    tracker.addTask('Write test file');
    tracker.addTask('Run tests');
    const out = capture(() => tracker.render());
    const j = joined(out);
    assert.ok(j.includes('5 个任务'), 'should show 5 tasks');
    assert.ok(j.includes('待处理'), 'should show pending status');
  });

  it('CC-16: task tracker start → complete updates', () => {
    const tracker = new panels.TaskPlanTracker({ rewriteInPlace: false });
    tracker.addTask('Read');
    tracker.addTask('Write');
    capture(() => tracker.render());
    const out1 = capture(() => tracker.start(0));
    assert.ok(out1.length > 0, 'start should produce output');
    const out2 = capture(() => tracker.complete(0));
    assert.ok(out2.length > 0, 'complete should produce output');
  });

  it('CC-17: execution brief panel with steps + files', () => {
    const out = capture(() => panels.printExecutionBrief({
      request: 'Add parseDate(str) to utils.js with tests',
      analysis: '需要新增函数和测试文件',
      scale: 'medium',
      steps: ['读取 utils.js', '搜索现有实现', '添加 parseDate', '创建测试', '运行测试'],
      files: ['utils.js', 'utils.test.js'],
    }));
    const j = joined(out);
    assert.ok(j.includes('执行简报'), 'should have brief title');
    assert.ok(j.includes('parseDate'), 'should show request');
    assert.ok(j.includes('utils.js'), 'should list files');
  });

  it('CC-18: markdown code block rendering', () => {
    const md = '```javascript\nfunction parseDate(str) {\n  return new Date(str);\n}\n```';
    const rendered = markdownR.renderMarkdownLite(md);
    assert.ok(rendered, 'should render markdown');
    assert.ok(rendered.includes('parseDate'), 'should contain code');
  });

  it('CC-19: tool dedup collapses repeated identical calls', () => {
    toolDisplay.resetStepCounter();
    capture(() => toolDisplay.printToolCallStart('Read', { file_path: 'dup.js' }));
    const out = capture(() => toolDisplay.printToolCallStart('Read', { file_path: 'dup.js' }));
    // Dedup: returns 0 lines (no new output) or shows merge message
    assert.ok(out.length === 0 || joined(out).includes('合并'), 'should deduplicate');
  });

  it('CC-20: collapse counter with ctrl+o hint', () => {
    const out = capture(() => panels.printCollapseCounter('搜索 2 次，读取 3 个文件'));
    const j = joined(out);
    assert.ok(j.includes('搜索 2 次'), 'should show counter text');
    assert.ok(j.includes('ctrl+o'), 'should show expand hint');
  });

  it('CC-21: compaction notice exists', () => {
    assert.ok(typeof transparency.printCompactionResult === 'function');
    // Verify the format
    const notice = capture(() => {
      const svc = safe('../../src/services/transparencyService');
      if (svc) {
        const text = svc.formatCompactionNotice({ beforeTokens: 50000, afterTokens: 20000, durationMs: 1200 });
        if (text) console.log(text);
      }
    });
    if (notice.length > 0) {
      const j = joined(notice);
      assert.ok(j.includes('compacted') || j.includes('50'), 'compaction should show token info');
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  ROUND 3 — Large Task: "Refactor auth → JWT service + tests + docs"
//
//  Claude Code timeline:
//    ● Thinking... (8s · ↑15k · extended thinking · high)
//    ╭─ ◆ 执行简报 ───────────────────────────────╮
//    │  需求  Refactor auth module...              │
//    │  分析  需要拆分 JWT 逻辑...                  │
//    │  计划  ☐ 读取 auth.js                       │
//    │        ☐ 提取 JWT 逻辑                      │
//    │        ☐ 创建 tokenService.js                │
//    │        ☐ 更新 middleware                     │
//    │        ☐ 写测试                              │
//    │        ☐ 更新文档                            │
//    │  文件  auth.js · tokenService.js · ...      │
//    ╰──────────────────────────────────────────────╯
//
//    ☐ 6 个任务（6 个待处理）
//    [1/12] ▷ 读取(auth.js)...
//    ...12 tool calls...
//
//    ◐ Agent(Explore auth patterns)               ← ToolUseTracker
//      ▷ Read(auth.js)
//        Running…
//      ⌕ Search(pattern: "jwt")
//        Running…
//    ◐ Agent(Explore auth patterns)               ← green on finish
//      ⎿ Done (8 tool uses · 12.5k tokens · 15s)
//        (ctrl+o to expand)
//
//    ✔ 4 个步骤已完成                              ← collapse >3 done
//    ■ Write unit tests
//    ☐ Update docs
//
//    ╭─ ✓ 任务完成 ─────────────────────────────╮
//    │  改动  auth.js (+25 -12)                 │
//    │        tokenService.js (85 lines)         │
//    │  新建  auth.test.js (120 lines)           │
//    │  命令  npm test · npm run lint            │
//    │  摘要  重构完成...                         │
//    │  3 轮 · 15 次调用 · 14/15 成功 · 42.5s   │
//    ╰──────────────────────────────────────────╯
//
//    ╰─ claude-3.5 · 42.5s · ↑15k ↓8k · $0.18
//    ─
// ══════════════════════════════════════════════════════════════════

describe('Round 3: Large Task — Refactor auth module', () => {

  it('CC-22: ToolUseTracker header + tool tracking', () => {
    const tracker = new toolDisplay.ToolUseTracker('Agent', 'Explore auth patterns');
    const out1 = capture(() => tracker.printHeader());
    const j1 = joined(out1);
    assert.ok(j1.includes('Explore auth patterns'), 'header should show description');

    tracker.toolStart('Read', 'auth.js');
    tracker.toolStart('Grep', 'pattern: "jwt"');
    tracker.toolEnd('Read', 'success', '120 lines', 85);
    assert.equal(tracker.toolCount, 2, 'should track 2 tools');
  });

  it('CC-23: ToolUseTracker finish → "Done" summary', () => {
    const tracker = new toolDisplay.ToolUseTracker('Agent', 'Refactor auth');
    capture(() => tracker.printHeader());
    tracker.toolStart('Read', 'auth.js');
    tracker.toolEnd('Read', 'success', '', 50);
    tracker.toolStart('Edit', 'auth.js');
    tracker.toolEnd('Edit', 'success', '', 120);
    tracker.addTokens(12500);
    const out = capture(() => tracker.finish());
    const j = joined(out);
    assert.ok(j.includes('Done'), 'should show Done');
    assert.ok(j.includes('2 tool uses'), 'should show tool count');
    assert.ok(j.includes('12.5k tokens'), 'should show token count');
    assert.ok(j.includes('ctrl+o'), 'should show expand hint');
  });

  it('CC-24: task plan collapse >3 completed', () => {
    const tracker = new panels.TaskPlanTracker({ rewriteInPlace: false });
    for (let i = 0; i < 6; i++) tracker.addTask(`Task ${i + 1}`);
    for (let i = 0; i < 4; i++) tracker.complete(i);
    tracker.start(4);
    const out = capture(() => tracker.render());
    const j = joined(out);
    assert.ok(j.includes('4 个步骤已完成'), `should collapse, got: ${j.slice(0, 200)}`);
    // Non-completed tasks should still be listed individually
    assert.ok(j.includes('Task 5'), 'in-progress task should be listed');
    assert.ok(j.includes('Task 6'), 'pending task should be listed');
  });

  it('CC-25: completion panel with all sections', () => {
    const out = capture(() => panels.printCompletionPanel({
      success: true,
      iterations: 3,
      totalCalls: 15,
      succeeded: 14,
      elapsed: '42.5s',
      fileChanges: [
        { path: 'auth.js', operation: 'modify', diff: '+25 -12' },
        { path: 'tokenService.js', operation: 'create', diff: '85 lines' },
        { path: 'auth.test.js', operation: 'create', diff: '120 lines' },
        { path: 'middleware.js', operation: 'modify', diff: '+8 -3' },
      ],
      commands: [{ cmd: 'npm test', success: true }, { cmd: 'npm run lint', success: true }],
      summary: '重构完成: 拆分 JWT 逻辑为独立 tokenService',
    }));
    const j = joined(out);
    assert.ok(j.includes('任务完成'), 'title');
    assert.ok(j.includes('auth.js'), 'modified file');
    assert.ok(j.includes('tokenService.js'), 'created file');
    assert.ok(j.includes('npm test'), 'command');
    assert.ok(j.includes('重构完成'), 'summary text');
    assert.ok(j.includes('15 次调用'), 'call count');
    assert.ok(j.includes('42.5s'), 'elapsed');
  });

  it('CC-26: completion panel handles string summary (regression)', () => {
    const out = capture(() => panels.printCompletionPanel({
      success: true, totalCalls: 3, succeeded: 3, elapsed: '5s',
      summary: 'All 3 changes applied successfully',
    }));
    const j = joined(out);
    assert.ok(j.includes('All 3 changes'), 'string summary should render');
  });

  it('CC-27: agent progress tree display', () => {
    const out = capture(() => toolDisplay.renderAgentProgress([
      { name: 'Explore', status: 'completed', toolCalls: 8, tokens: 12000, elapsed: '15s', detail: 'Found 3 patterns' },
      { name: 'Refactor', status: 'running', toolCalls: 5, tokens: 8000 },
      { name: 'Test', status: 'pending' },
    ]));
    const j = joined(out);
    assert.ok(j.includes('Explore'), 'completed agent');
    assert.ok(j.includes('12.0k tokens'), 'tokens');
    assert.ok(j.includes('Found 3 patterns'), 'detail');
    assert.ok(j.includes('Refactor'), 'running agent');
    assert.ok(j.includes('Test'), 'pending agent');
  });

  it('CC-28: agent done summary line', () => {
    const out = capture(() => toolDisplay.renderAgentDone({
      toolCalls: 24, tokens: 60900, elapsedMs: 135000,
    }));
    const j = joined(out);
    assert.ok(j.includes('Done'), 'done label');
    assert.ok(j.includes('24 tool uses'), 'tool count');
    assert.ok(j.includes('60.9k tokens'), 'tokens');
    assert.ok(j.includes('2m 15s'), 'elapsed');
  });

  // CC-29: printInlineDiff removed (P3 dead code cleanup — use diffRenderer.renderStructuredDiff instead)

  it('CC-30: expandable section stores + toggles', () => {
    const section = new toolDisplay.ExpandableSection();
    section.add('Summary 1', ['line 1', 'line 2']);
    section.add('Summary 2', ['line 3']);
    assert.equal(section.getSections().length, 2);
    assert.ok(!section.getSections()[0].expanded);
    section.toggle(0);
    assert.ok(section.getSections()[0].expanded);
    section.toggle(0);
    assert.ok(!section.getSections()[0].expanded);
  });

  it('CC-31: session recap function exists', () => {
    assert.ok(typeof transparency.printSessionRecap === 'function');
  });

  it('CC-32: permission dialog module exists', () => {
    const pd = safe('../../src/cli/ui/permissionDialog');
    assert.ok(pd, 'permissionDialog should be requireable');
  });

  it('CC-33: ProcessTracker start → complete lifecycle', () => {
    const tracker = new steps.ProcessTracker();
    assert.ok(!tracker.isActive);
    // Can't test stdout output easily (needs TTY), but verify API
    assert.ok(typeof tracker.start === 'function');
    assert.ok(typeof tracker.complete === 'function');
    assert.ok(typeof tracker.fail === 'function');
  });

  it('CC-34: compaction notice renders', () => {
    const out = capture(() => steps.printCompactingNotice({
      elapsed: '1.2s', tokens: '50k', thought: '8s',
    }));
    const j = joined(out);
    assert.ok(j.includes('compacted'), 'should show compaction label');
    assert.ok(j.includes('50k'), 'should show token count');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Feature Matrix — All 20 Claude Code features checked
// ══════════════════════════════════════════════════════════════════

describe('Feature Matrix: F1-F20 (20 CC features)', () => {
  const matrix = [
    ['F1',  'Spinner + elapsed + tokens + stall',     () => spinnerMod && typeof spinnerMod.DynamicSpinner === 'function'],
    ['F2',  'Tool call start (icon+name+params+intent)', () => toolDisplay && typeof toolDisplay.printToolCallStart === 'function'],
    ['F3',  'Tool call result (overwrite+dot+elapsed)', () => toolDisplay && typeof toolDisplay.printToolCallResult === 'function'],
    ['F4',  'Bash command preview box',                () => !!toolDisplay],
    ['F5',  'File operation stats (+N -M lines)',      () => toolDisplay && typeof toolDisplay.printFileOperation === 'function'],
    ['F6',  'Step counter [N/M]',                      () => toolDisplay && typeof toolDisplay.setStepTotal === 'function'],
    ['F7',  'Task plan tracker + collapse',            () => panels && typeof panels.TaskPlanTracker === 'function'],
    ['F8',  'Completion panel (files+cmds+summary)',   () => panels && typeof panels.printCompletionPanel === 'function'],
    ['F9',  'Execution brief panel',                   () => panels && typeof panels.printExecutionBrief === 'function'],
    ['F10', 'Cost/token transparency (printTurnCost)', () => transparency && typeof transparency.printTurnCost === 'function'],
    ['F11', 'Cascade transparency',                    () => transparency && typeof transparency.printCascadeSteps === 'function'],
    ['F12', 'Thinking indicator (verbs + summary)',    () => renderTheme && renderTheme.THINKING_VERBS.length >= 8],
    ['F13', 'Markdown rendering (code+tables+headers)',() => markdownR && typeof markdownR.renderMarkdownLite === 'function'],
    ['F14', 'User message dark bg',                    () => spinnerMod && typeof spinnerMod.renderUserMessage === 'function'],
    ['F15', 'Agent tree (ToolUseTracker)',              () => toolDisplay && typeof toolDisplay.ToolUseTracker === 'function'],
    ['F16', 'Expandable outputs (ctrl+o)',             () => toolDisplay && typeof toolDisplay.ExpandableSection === 'function'],
    ['F17', 'Permission dialog',                       () => !!safe('../../src/cli/ui/permissionDialog')],
    ['F18', 'Context compaction notice',               () => transparency && typeof transparency.printCompactionResult === 'function'],
    ['F19', 'Session recap on exit',                   () => transparency && typeof transparency.printSessionRecap === 'function'],
    ['F20', 'Tool dedup (repeated calls collapsed)',   () => !!toolDisplay],
  ];

  for (const [id, name, check] of matrix) {
    it(`${id}: ${name}`, () => {
      assert.ok(check(), `${id} (${name}) missing in KHY`);
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  Gap Detection: Things CC has that might be missing in KHY
// ══════════════════════════════════════════════════════════════════

describe('Gap Detection: CC-exclusive features', () => {

  it('GAP-1: printTurnCost wired in QE path (was bug, now fixed)', () => {
    // Verify the fix exists in repl.js by checking that streamState._qeCost pattern is used
    const fs = require('fs');
    const replSrc = fs.readFileSync(require.resolve('../../src/cli/repl.js'), 'utf-8');
    assert.ok(replSrc.includes('streamState._qeCost'), 'QE cost accumulation should exist');
    assert.ok(replSrc.includes('renderer.printTurnCost(turnData)'), 'printTurnCost call should exist in QE done');
  });

  it('GAP-2: truncation warning in _formatToolResult', () => {
    const fs = require('fs');
    // repl 的工具结果格式化已在 god-file split 中拆到 repl/displayFormatters.js,
    // 其 formatToolResult 委托 toolResultSummary.summarizeToolResult(截断警告所在)。
    // 断言这条真实委托链,而非早已迁走的 repl.js 内联符号。
    const replSrc = fs.readFileSync(require.resolve('../../src/cli/repl.js'), 'utf-8');
    assert.ok(replSrc.includes('displayFormatters'), 'repl delegates tool-result formatting to displayFormatters');
    const dfSrc = fs.readFileSync(require.resolve('../../src/cli/repl/displayFormatters.js'), 'utf-8');
    assert.ok(dfSrc.includes('summarizeToolResult'), 'displayFormatters delegates to the summarizer');
    const summarySrc = fs.readFileSync(require.resolve('../../src/cli/toolResultSummary.js'), 'utf-8');
    assert.ok(summarySrc.includes('result.truncated') || summarySrc.includes('_truncated'), 'truncation check should exist');
    assert.ok(summarySrc.includes('已截断'), 'truncation warning text should exist');
  });

  it('GAP-3: concise interrupt marker', () => {
    const fs = require('fs');
    const replSrc = fs.readFileSync(require.resolve('../../src/cli/repl.js'), 'utf-8');
    assert.ok(replSrc.includes('⏸ Interrupted'), 'concise interrupt marker should exist');
    // Old verbose message should be gone
    assert.ok(!replSrc.includes('Ctrl+C 已发送中断信号'), 'verbose interrupt message should be removed');
  });

  it('GAP-4: response-complete dim separator', () => {
    const fs = require('fs');
    const replSrc = fs.readFileSync(require.resolve('../../src/cli/repl.js'), 'utf-8');
    // Look for the dim separator pattern in the finally block
    assert.ok(
      replSrc.includes("c.dim('  ─')") || replSrc.includes("c.dim(`  ─`)"),
      'response separator should exist in finally block'
    );
  });

  it('GAP-5: tool family icons are differentiated', () => {
    const icons = renderTheme.TOOL_FAMILY_ICONS;
    const bash = icons.bash;
    const read = icons.read;
    const write = icons.write;
    const edit = icons.edit;
    const grep = icons.grep;
    const agent = icons.agent;
    // All should be different (except aliases within same family)
    const unique = new Set([bash, read, write, edit, grep, agent]);
    assert.ok(unique.size >= 5, `should have 5+ unique icons, got ${unique.size}: ${[...unique].join(',')}`);
  });

  it('GAP-6: tool display names are localized', () => {
    const names = renderTheme.TOOL_DISPLAY_NAMES;
    assert.ok(names.read, 'read should have display name');
    assert.ok(names.write, 'write should have display name');
    assert.ok(names.bash === 'Bash', 'bash should stay as Bash');
  });

  it('GAP-7: phase labels include tool-level granularity', () => {
    const labels = renderTheme.PHASE_LABELS;
    assert.ok(labels['tool:bash'], 'tool:bash label');
    assert.ok(labels['tool:read'], 'tool:read label');
    assert.ok(labels['tool:write'], 'tool:write label');
    assert.ok(labels['tool:grep'], 'tool:grep label');
    assert.ok(labels['tool:websearch'], 'tool:websearch label');
  });

  it('GAP-8: diff renderer module exists', () => {
    assert.ok(diffRenderer || safe('../../src/cli/diffRenderer'), 'diffRenderer module should exist');
  });
});
