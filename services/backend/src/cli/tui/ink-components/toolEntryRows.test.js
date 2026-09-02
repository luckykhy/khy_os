'use strict';

/**
 * toolEntryRows / toolCostOf leaf tests (node:test).
 *
 * Covers:
 *   - estimateToolEntryRows branch parity with ToolLines' live rendering
 *     (header / progress / error fold / shell literal fold / summary / agent tree)
 *   - gate KHY_TOOL_ROW_BUDGET off → flat 1 (byte fallback)
 *   - ToolLines.estimateLiteralRows fold arithmetic (live cap + committed policy)
 *   - liveHeightClamp.tailTimelineToVisualRows with toolCostOf: contiguous-suffix
 *     admission, first-visible-entry always kept, truncated flag honesty
 *   - byte fallback: no toolCostOf → legacy flat-1 walk
 */

const assert = require('node:assert');
const test = require('node:test');

const toolEntryRows = require('./toolEntryRows');
const { estimateToolEntryRows, isEnabled } = toolEntryRows;
const ToolLines = require('./ToolLines');
const liveHeightClamp = require('./liveHeightClamp');

const withEnv = (key, value, fn) => {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
};

const shellTool = (name, result, extra) =>
  Object.assign({ name: name || 'Bash', input: { command: 'ls' } }, extra || {}, { result });

const lines = (n) => Array.from({ length: n }, (_, i) => `line-${i + 1}`).join('\n');

// ── gate ───────────────────────────────────────────────────────────────────
test('gate on by default, off via explicit falsy', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    assert.equal(isEnabled(process.env), true);
  });
  for (const v of ['0', 'false', 'off', 'no']) {
    withEnv('KHY_TOOL_ROW_BUDGET', v, () => {
      assert.equal(isEnabled(process.env), false);
    });
  }
});

test('gate off → flat 1 regardless of shape', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', '0', () => {
    const t = shellTool('Bash', { output: lines(30) });
    assert.equal(estimateToolEntryRows(t, { live: true }), 1);
    assert.equal(estimateToolEntryRows(null, {}), 1);
  });
});

// ── header / progress / agent tree ─────────────────────────────────────────
test('pending tool without progress: header only', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    assert.equal(estimateToolEntryRows({ name: 'Bash', input: {} }, { live: true }), 1);
  });
});

test('running tool with progress narration: header + 1', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    assert.equal(
      estimateToolEntryRows({ name: 'Bash', input: {}, progress: '接着跑 pip install' }, { live: true }),
      2
    );
  });
});

test('agent tree keeps the flat legacy charge', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    assert.equal(
      estimateToolEntryRows({ name: 'Task', _agentTree: [{ id: 'a' }, { id: 'b' }] }, { live: true }),
      1
    );
  });
});

// ── error fold parity ──────────────────────────────────────────────────────
test('failed tool: header + detail lines', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    const t = shellTool('createDocument', { isError: true, error: '第一行\n第二行' });
    assert.equal(estimateToolEntryRows(t, { expanded: false, live: true }), 1 + 2);
  });
});

test('failed tool folds to MAX_RENDERED_LINES + footer, expanded shows all', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    const err = Array.from({ length: 15 }, (_, i) => `e${i + 1}`).join('\n');
    const t = shellTool('createDocument', { isError: true, error: err });
    // collapsed: headline(空详情时才加 → 有 10 行详情不加) + 10 + footer(+N 行)
    assert.equal(estimateToolEntryRows(t, { expanded: false, live: true }), 1 + 10 + 1);
    // expanded: 15 lines, no fold footer
    assert.equal(estimateToolEntryRows(t, { expanded: true, live: true }), 1 + 15);
  });
});

test('denied tool: headline rides above the detail lines', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    const t = shellTool('Bash', { isError: true, denied: true, error: '被拒\n原因' });
    assert.equal(estimateToolEntryRows(t, { expanded: false, live: true }), 1 + 1 + 2);
  });
});

// ── shell literal fold parity ──────────────────────────────────────────────
test('done shell tool, short output: shown in full', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    withEnv('KHY_LIVE_SHELL_CAP', undefined, () => {
      const t = shellTool('Bash', { output: lines(3) });
      assert.equal(estimateToolEntryRows(t, { expanded: false, live: true }), 1 + 3);
    });
  });
});

test('done shell tool, long output: live cap bounds the body', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    withEnv('KHY_LIVE_SHELL_CAP', undefined, () => {
      const t = shellTool('Bash', { output: lines(30) });
      // live policy {maxLines:8, foldHead:6, foldTail:1} → 8 body rows + truncation tag
      const cost = estimateToolEntryRows(t, { expanded: false, live: true });
      assert.equal(cost, 1 + 8 + 1);
      // committed policy (live:false) stays the generous 20-line fold: 12+1+6 + tag
      const committed = ToolLines.estimateLiteralRows(t.result, {
        expanded: false,
        live: false,
        shell: true,
      });
      assert.equal(committed, 19 + 1);
    });
  });
});

test('live shell cap gate off → committed policy', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    withEnv('KHY_LIVE_SHELL_CAP', '0', () => {
      const t = shellTool('Bash', { output: lines(30) });
      assert.equal(estimateToolEntryRows(t, { expanded: false, live: true }), 1 + 19 + 1);
    });
  });
});

test('done non-shell tool collapsed: header + summary row', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    const t = shellTool('Read', { summary: '读取 10 行' });
    assert.equal(estimateToolEntryRows(t, { expanded: false, live: true }), 2);
  });
});

test('write diff rows are charged at their real length', () => {
  withEnv('KHY_TOOL_ROW_BUDGET', undefined, () => {
    const t = shellTool('Write', {
      _khyWriteDiff: { before: '', after: lines(5) },
    });
    const cost = estimateToolEntryRows(t, { expanded: false, live: true });
    assert.ok(cost > 2, `diff body should cost more than header+summary, got ${cost}`);
    // and the estimator must agree with the renderer's own diff-row count
    const rendered = ToolLines.buildWriteDiffRows(t.result._khyWriteDiff, false);
    assert.equal(cost, 1 + rendered.length);
  });
});

// ── tail integration ───────────────────────────────────────────────────────
const entry = (tool) => ({ type: 'tool', tool });
const text = (s) => ({ type: 'text', text: s });

test('tail with toolCostOf: expensive oldest tool is dropped, suffix stays contiguous', () => {
  const timeline = [entry({ id: 'A' }), text('hello'), entry({ id: 'C' })];
  const cost = (e) => (e.tool && e.tool.id === 'A' ? 22 : e.tool ? 5 : 3);
  const out = liveHeightClamp.tailTimelineToVisualRows(timeline, 10, 80, process.env, null, cost);
  assert.deepEqual(
    out.entries.map((e) => (e.type === 'tool' ? e.tool.id : e.text)),
    ['hello', 'C']
  );
  assert.equal(out.truncated, true);
});

test('tail with toolCostOf: first visible entry is kept even when oversized', () => {
  const timeline = [entry({ id: 'A' })];
  const out = liveHeightClamp.tailTimelineToVisualRows(timeline, 4, 80, process.env, null, () => 22);
  assert.equal(out.entries.length, 1);
  assert.equal(out.truncated, false);
});

test('tail with toolCostOf: non-fitting tool stops the window above it', () => {
  const timeline = [entry({ id: 'A' }), entry({ id: 'B' }), entry({ id: 'C' })];
  const cost = (e) => ({ A: 22, B: 5, C: 5 })[e.tool.id];
  const out = liveHeightClamp.tailTimelineToVisualRows(timeline, 10, 80, process.env, null, cost);
  assert.deepEqual(out.entries.map((e) => e.tool.id), ['B', 'C']);
  assert.equal(out.truncated, true);
});

test('tail without toolCostOf keeps the legacy flat-1 walk', () => {
  const timeline = [entry({ id: 'A' }), text('hello'), entry({ id: 'C' })];
  const out = liveHeightClamp.tailTimelineToVisualRows(timeline, 10, 80, process.env, null, null);
  assert.deepEqual(out.entries.map((e) => (e.type === 'tool' ? e.tool.id : e.text)), [
    'A',
    'hello',
    'C',
  ]);
  assert.equal(out.truncated, false);
});

test('hard-clamp gate off delegates to the raw walker with toolCostOf', () => {
  withEnv('KHY_LIVE_HARD_CLAMP', '0', () => {
    const timeline = [entry({ id: 'A' }), entry({ id: 'B' })];
    const cost = (e) => (e.tool.id === 'B' ? 2 : 22);
    const out = liveHeightClamp.tailTimelineToVisualRows(timeline, 4, 80, process.env, null, cost);
    assert.deepEqual(out.entries.map((e) => e.tool.id), ['B']);
  });
});
