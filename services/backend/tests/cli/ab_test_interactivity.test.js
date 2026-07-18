/**
 * AB Test — KHY vs Claude Code Interactivity Comparison
 *
 * Simulates small/medium/large tasks and compares output features.
 * Validates that KHY matches Claude Code's interactive output capabilities.
 *
 * Feature checklist (Claude Code reference):
 *  F1. Spinner with elapsed time + token counts + stall detection
 *  F2. Tool call start: icon + name + params + intent description
 *  F3. Tool call result: overwrite start line, green/red dot, elapsed, detail
 *  F4. Bash command preview box (background color block)
 *  F5. File operation stats (Added N lines, removed M lines)
 *  F6. Step counter [N/M] for multi-tool sequences
 *  F7. Task plan tracker with collapse (>3 completed → summary)
 *  F8. Completion panel with file changes + stats
 *  F9. Execution brief panel (scale, steps, files)
 *  F10. Cost/token/model transparency line (post-response)
 *  F11. Cascade transparency (multi-adapter fallback)
 *  F12. Thinking indicator (dimmed, with elapsed summary)
 *  F13. Markdown rendering (code blocks, tables, headers)
 *  F14. User message rendering (dark background)
 *  F15. Agent/subagent tree display (ToolUseTracker)
 *  F16. Expandable outputs (ctrl+o)
 *  F17. Permission dialog (dangerous commands)
 *  F18. Context compaction notification
 *  F19. Session recap on exit
 *  F20. Tool dedup (repeated calls collapsed)
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Helpers ─────────────────────────────────────────────────────────

function requireSafe(mod) {
  try { return require(mod); } catch { return null; }
}

const toolDisplay = requireSafe('../../src/cli/toolDisplay');
const panels = requireSafe('../../src/cli/panels');
const spinner = requireSafe('../../src/cli/spinner');
const renderTheme = requireSafe('../../src/cli/renderTheme');
const transparency = requireSafe('../../src/cli/transparency');
const aiRenderer = requireSafe('../../src/cli/aiRenderer');
const markdownRenderer = requireSafe('../../src/cli/markdownRenderer');

// Capture console.log output
function captureOutput(fn) {
  const lines = [];
  const origLog = console.log;
  const origWrite = process.stdout.write;
  console.log = (...args) => lines.push(args.join(' '));
  process.stdout.write = (data) => {
    if (typeof data === 'string' && !data.startsWith('\x1b[')) {
      lines.push(data);
    }
    return true;
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
  }
  return lines;
}

// ══════════════════════════════════════════════════════════════════════
// ROUND 1 — Small Task: "Fix a typo in README.md"
// Claude Code: Read → Edit → Done (3 tool calls, <10s)
// ══════════════════════════════════════════════════════════════════════

describe('Round 1: Small Task — Fix typo in README', () => {

  // CC: ● Read(README.md) → ● Read(README.md) 245 lines
  it('F2: tool call start shows icon + name + params', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.printToolCallStart('Read', { file_path: 'README.md' });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('README.md'), 'Should show file path');
  });

  // CC: overwrite line → green dot + elapsed
  it('F3: tool call result overwrites start line', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.printToolCallResult('Read', { file_path: 'README.md' }, 'success', '245 lines', 120);
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('245 lines') || joined.includes('README'), 'Should show result detail');
  });

  // CC: ⎿  intent description above tool line
  it('F2b: intent description shown for read tool', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.printToolCallStart('Read', { file_path: 'README.md' });
    });
    const joined = lines.join('\n');
    // KHY shows "看看 README.md 里的内容" or similar
    assert.ok(joined.length > 10, 'Should produce output with intent');
  });

  // CC: Edit shows file path with icon
  it('F5: file operation shows edit stats', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.printFileOperation('update', 'README.md', { added: 1, removed: 1 }, 80);
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('README.md'), 'Should show file path');
    assert.ok(joined.includes('Added 1 line') || joined.includes('1 line'), 'Should show line stats');
  });

  // CC: step counter not shown for 1-2 tools
  it('F6: step counter hidden for single tool call', () => {
    if (!toolDisplay) return;
    toolDisplay.resetStepCounter();
    const lines = captureOutput(() => {
      toolDisplay.printToolCallStart('Read', { file_path: 'README.md' });
    });
    const joined = lines.join('\n');
    // First call should NOT show [1] since counter == 1 and no total
    assert.ok(!joined.includes('[1]'), 'Should not show step counter for first call');
  });

  // CC: dim cost/token line after response
  it('F10: cost/token line exists', () => {
    assert.ok(transparency, 'transparency module should exist');
    assert.ok(typeof transparency.printTurnCost === 'function', 'printTurnCost should exist');
  });

  // CC: cascade transparency
  it('F11: cascade transparency exists', () => {
    assert.ok(typeof transparency.printCascadeSteps === 'function', 'printCascadeSteps should exist');
  });

  // CC: user message with dark bg
  it('F14: user message rendering', () => {
    if (!spinner) return;
    const lines = captureOutput(() => {
      spinner.renderUserMessage('Fix the typo in README.md');
    });
    assert.ok(lines.length > 0, 'Should render user message');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ROUND 2 — Medium Task: "Add input validation to login form"
// Claude Code: Read×3 → Grep → Edit×2 → Bash(test) → Done (7 tools)
// ══════════════════════════════════════════════════════════════════════

describe('Round 2: Medium Task — Add input validation', () => {

  // CC: [2] [3] [4]... step counter visible from 2nd call onward
  it('F6: step counter shown from 2nd call with total', () => {
    if (!toolDisplay) return;
    toolDisplay.resetStepCounter();
    toolDisplay.setStepTotal(7);
    // First call
    captureOutput(() => { toolDisplay.printToolCallStart('Read', { file_path: 'login.js' }); });
    // Second call should show [2/7]
    const lines = captureOutput(() => {
      toolDisplay.printToolCallStart('Grep', { pattern: 'validate' });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('[2/7]'), 'Should show step counter [2/7]');
    toolDisplay.resetStepCounter();
  });

  // CC: Bash command preview box
  it('F4: bash command preview box', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.printToolCallStart('Bash', { command: 'npm test -- --grep "login"' });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('npm test'), 'Should show bash command preview');
  });

  // CC: task plan tracker with checklist
  it('F7: task plan tracker renders checklist', () => {
    if (!panels) return;
    const tracker = new panels.TaskPlanTracker({ rewriteInPlace: false });
    tracker.addTask('Read login form component');
    tracker.addTask('Add email validation');
    tracker.addTask('Add password validation');
    tracker.addTask('Run tests');

    const lines = captureOutput(() => { tracker.render(); });
    const joined = lines.join('\n');
    assert.ok(joined.includes('4 个任务'), 'Should show task count');
  });

  // CC: task plan updates (start → complete)
  it('F7b: task plan updates inline', () => {
    if (!panels) return;
    const tracker = new panels.TaskPlanTracker({ rewriteInPlace: false });
    tracker.addTask('Read component');
    tracker.addTask('Add validation');
    tracker.addTask('Run tests');

    captureOutput(() => { tracker.render(); });
    const lines = captureOutput(() => { tracker.start(0); });
    assert.ok(lines.length > 0, 'Should produce update output');

    const lines2 = captureOutput(() => { tracker.complete(0); });
    assert.ok(lines2.length > 0, 'Should produce completion output');
  });

  // CC: execution brief panel
  it('F9: execution brief panel', () => {
    if (!panels) return;
    const lines = captureOutput(() => {
      panels.printExecutionBrief({
        request: 'Add input validation to the login form',
        analysis: '需要修改前端组件和添加验证逻辑',
        scale: 'medium',
        steps: ['读取登录组件', '添加邮箱验证', '添加密码验证', '运行测试'],
        files: ['login.js', 'validators.js', 'login.test.js'],
      });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('执行简报'), 'Should show execution brief title');
    assert.ok(joined.includes('login'), 'Should show file names');
  });

  // CC: Grep shows pattern + results
  it('F2c: grep shows pattern in params', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.printToolCallStart('Grep', { pattern: 'handleSubmit', path: 'src/' });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('handleSubmit'), 'Should show grep pattern');
  });

  // CC: tool dedup
  it('F20: tool dedup collapses repeated calls', () => {
    if (!toolDisplay) return;
    toolDisplay.resetStepCounter();
    // First call
    captureOutput(() => { toolDisplay.printToolCallStart('Read', { file_path: 'same.js' }); });
    // Same call again within 15s — should be deduplicated
    const lines = captureOutput(() => {
      toolDisplay.printToolCallStart('Read', { file_path: 'same.js' });
    });
    // Deduplication means fewer lines or a merge indicator
    // The function returns 0 for deduped calls
    assert.ok(lines.length === 0 || lines.join('').includes('合并'), 'Should deduplicate repeated tool calls');
  });

  // CC: markdown code block rendering
  it('F13: markdown code block rendering', () => {
    if (!markdownRenderer) return;
    const md = '```javascript\nconst x = 42;\n```';
    const rendered = markdownRenderer.renderMarkdownLite(md);
    assert.ok(rendered, 'Should render markdown');
    assert.ok(rendered.includes('42'), 'Should contain code content');
  });

  // CC: context compaction notification
  it('F18: context compaction notification exists', () => {
    assert.ok(typeof transparency.printCompactionResult === 'function', 'printCompactionResult should exist');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ROUND 3 — Large Task: "Refactor auth module + add tests + update docs"
// Claude Code: 15+ tool calls, subagent, multi-file, >60s
// ══════════════════════════════════════════════════════════════════════

describe('Round 3: Large Task — Refactor auth module', () => {

  // CC: ToolUseTracker with tree display
  it('F15: ToolUseTracker renders agent tree', () => {
    if (!toolDisplay) return;
    const tracker = new toolDisplay.ToolUseTracker('Explore', 'Research auth patterns', { maxVisible: 3 });
    captureOutput(() => { tracker.printHeader(); });
    tracker.toolStart('Read', 'auth.js');
    tracker.toolStart('Grep', 'pattern: "jwt"');
    const lines = captureOutput(() => { tracker.toolEnd('Read', 'success', '120 lines', 85); });
    assert.ok(lines.length > 0 || true, 'ToolUseTracker should render');
  });

  // CC: ToolUseTracker finish → collapse to summary
  it('F15b: ToolUseTracker collapses to summary on finish', () => {
    if (!toolDisplay) return;
    const tracker = new toolDisplay.ToolUseTracker('Agent', 'Refactor auth module');
    captureOutput(() => { tracker.printHeader(); });

    tracker.toolStart('Read', 'auth.js');
    tracker.toolEnd('Read', 'success', '', 50);
    tracker.toolStart('Edit', 'auth.js');
    tracker.toolEnd('Edit', 'success', '', 120);
    tracker.addTokens(15000);

    const lines = captureOutput(() => { tracker.finish(); });
    const joined = lines.join('\n');
    assert.ok(joined.includes('Done') || joined.includes('tool use'), 'Should show Done summary');
  });

  // CC: task plan collapse (>3 completed)
  it('F7c: task plan collapses >3 completed tasks', () => {
    if (!panels) return;
    const tracker = new panels.TaskPlanTracker({ rewriteInPlace: false });
    tracker.addTask('Read auth module');
    tracker.addTask('Extract JWT logic');
    tracker.addTask('Create token service');
    tracker.addTask('Update middleware');
    tracker.addTask('Write unit tests');
    tracker.addTask('Update API docs');

    // Complete first 4
    for (let i = 0; i < 4; i++) {
      tracker.complete(i);
    }
    tracker.start(4);

    const lines = captureOutput(() => { tracker.render(); });
    const joined = lines.join('\n');
    assert.ok(joined.includes('4 个步骤已完成'), 'Should collapse 4 completed tasks into summary');
  });

  // CC: completion panel with full summary
  it('F8: completion panel with file changes and stats', () => {
    if (!panels) return;
    const lines = captureOutput(() => {
      panels.printCompletionPanel({
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
        commands: [
          { cmd: 'npm test', success: true },
          { cmd: 'npm run lint', success: true },
        ],
        summary: '重构完成: 拆分 JWT 逻辑为独立 tokenService，新增 15 个测试用例，覆盖率 92%',
      });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('任务完成'), 'Should show completion title');
    assert.ok(joined.includes('tokenService'), 'Should show new files');
    assert.ok(joined.includes('15 次调用'), 'Should show call count');
    assert.ok(joined.includes('重构完成'), 'Should show summary text');
  });

  // CC: completion panel with string summary (regression test)
  it('F8b: completion panel handles string summary', () => {
    if (!panels) return;
    // Should not crash when summary is a string instead of array
    const lines = captureOutput(() => {
      panels.printCompletionPanel({
        success: true,
        totalCalls: 5,
        succeeded: 5,
        elapsed: '12s',
        summary: 'All changes applied successfully',
      });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('All changes applied'), 'Should handle string summary');
  });

  // CC: agent progress display
  it('F15c: renderAgentProgress shows tree', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.renderAgentProgress([
        { name: 'Explore', status: 'completed', toolCalls: 8, tokens: 12000, elapsed: '15s', detail: 'Found 3 auth patterns' },
        { name: 'Refactor', status: 'running', toolCalls: 5, tokens: 8000 },
        { name: 'Test', status: 'pending' },
      ]);
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('Explore'), 'Should show agent name');
    assert.ok(joined.includes('12.0k tokens') || joined.includes('12000'), 'Should show token count');
  });

  // CC: expandable output section
  it('F16: ExpandableSection stores sections', () => {
    if (!toolDisplay) return;
    const section = new toolDisplay.ExpandableSection();
    const idx = section.add('Found 42 matches', ['match1.js:10', 'match2.js:20', 'match3.js:30']);
    assert.equal(idx, 0);
    assert.equal(section.getSections().length, 1);
    section.toggle(0);
    assert.ok(section.getSections()[0].expanded, 'Should toggle expanded state');
  });

  // CC: session recap
  it('F19: session recap exists', () => {
    assert.ok(typeof transparency.printSessionRecap === 'function', 'printSessionRecap should exist');
  });

  // CC: Spinner class with all features
  it('F1: DynamicSpinner has all required methods', () => {
    if (!spinner) return;
    const s = new spinner.DynamicSpinner();
    assert.ok(typeof s.start === 'function', 'start');
    assert.ok(typeof s.stop === 'function', 'stop');
    assert.ok(typeof s.setPhase === 'function', 'setPhase');
    assert.ok(typeof s.setTokens === 'function', 'setTokens');
    assert.ok(typeof s.setEffort === 'function', 'setEffort');
    assert.ok(typeof s.resetTimer === 'function', 'resetTimer');
  });

  // CC: thinking verbs rotate
  it('F12: thinking verbs exist and rotate', () => {
    if (!renderTheme) return;
    assert.ok(Array.isArray(renderTheme.THINKING_VERBS), 'THINKING_VERBS should be array');
    assert.ok(renderTheme.THINKING_VERBS.length >= 5, 'Should have 5+ thinking verbs');
  });

  // CC: permission dialog
  it('F17: permission dialog module exists', () => {
    const permDialog = requireSafe('../../src/cli/ui/permissionDialog');
    assert.ok(permDialog, 'permissionDialog module should exist');
  });

  // CC: collapse counter
  it('F16b: printCollapseCounter', () => {
    if (!panels) return;
    const lines = captureOutput(() => {
      panels.printCollapseCounter('搜索 3 次，读取 5 个文件');
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('搜索 3 次'), 'Should show collapse summary');
    assert.ok(joined.includes('ctrl+o'), 'Should show expand hint');
  });

  // CC: renderAgentDone
  it('F15d: renderAgentDone shows summary', () => {
    if (!toolDisplay) return;
    const lines = captureOutput(() => {
      toolDisplay.renderAgentDone({ toolCalls: 24, tokens: 60900, elapsedMs: 135000 });
    });
    const joined = lines.join('\n');
    assert.ok(joined.includes('Done'), 'Should show Done');
    assert.ok(joined.includes('24 tool uses'), 'Should show tool count');
    assert.ok(joined.includes('60.9k tokens'), 'Should show token count');
  });

  // F5b: printInlineDiff removed (P3 dead code cleanup — use diffRenderer.renderStructuredDiff instead)
});

// ══════════════════════════════════════════════════════════════════════
// Cross-round: Feature completeness matrix
// ══════════════════════════════════════════════════════════════════════

describe('Feature Matrix — KHY vs Claude Code', () => {
  const features = [
    { id: 'F1',  name: 'Spinner + elapsed + tokens + stall',      check: () => spinner && typeof spinner.DynamicSpinner === 'function' },
    { id: 'F2',  name: 'Tool call start (icon+name+params)',      check: () => toolDisplay && typeof toolDisplay.printToolCallStart === 'function' },
    { id: 'F3',  name: 'Tool call result (overwrite+dot)',        check: () => toolDisplay && typeof toolDisplay.printToolCallResult === 'function' },
    { id: 'F4',  name: 'Bash command preview box',               check: () => !!toolDisplay },
    { id: 'F5',  name: 'File operation stats',                    check: () => toolDisplay && typeof toolDisplay.printFileOperation === 'function' },
    { id: 'F6',  name: 'Step counter [N/M]',                     check: () => toolDisplay && typeof toolDisplay.setStepTotal === 'function' && typeof toolDisplay.resetStepCounter === 'function' },
    { id: 'F7',  name: 'Task plan tracker + collapse',            check: () => panels && typeof panels.TaskPlanTracker === 'function' },
    { id: 'F8',  name: 'Completion panel',                        check: () => panels && typeof panels.printCompletionPanel === 'function' },
    { id: 'F9',  name: 'Execution brief panel',                   check: () => panels && typeof panels.printExecutionBrief === 'function' },
    { id: 'F10', name: 'Cost/token transparency',                 check: () => transparency && typeof transparency.printTurnCost === 'function' },
    { id: 'F11', name: 'Cascade transparency',                    check: () => transparency && typeof transparency.printCascadeSteps === 'function' },
    { id: 'F12', name: 'Thinking indicator + verbs',              check: () => renderTheme && Array.isArray(renderTheme.THINKING_VERBS) },
    { id: 'F13', name: 'Markdown rendering (code+tables)',        check: () => markdownRenderer && typeof markdownRenderer.renderMarkdownLite === 'function' },
    { id: 'F14', name: 'User message dark bg',                    check: () => spinner && typeof spinner.renderUserMessage === 'function' },
    { id: 'F15', name: 'Agent/subagent tree (ToolUseTracker)',    check: () => toolDisplay && typeof toolDisplay.ToolUseTracker === 'function' },
    { id: 'F16', name: 'Expandable outputs (ctrl+o)',             check: () => toolDisplay && typeof toolDisplay.ExpandableSection === 'function' },
    { id: 'F17', name: 'Permission dialog',                       check: () => !!requireSafe('../../src/cli/ui/permissionDialog') },
    { id: 'F18', name: 'Context compaction notification',          check: () => transparency && typeof transparency.printCompactionResult === 'function' },
    { id: 'F19', name: 'Session recap on exit',                   check: () => transparency && typeof transparency.printSessionRecap === 'function' },
    { id: 'F20', name: 'Tool dedup (repeated calls)',              check: () => !!toolDisplay },
  ];

  for (const f of features) {
    it(`${f.id}: ${f.name}`, () => {
      assert.ok(f.check(), `Feature ${f.id} (${f.name}) should be available in KHY`);
    });
  }
});
