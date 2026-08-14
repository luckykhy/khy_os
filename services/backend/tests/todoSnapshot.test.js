'use strict';

/**
 * Tests for V1 TodoWrite snapshot reaching the context-compaction pipeline.
 *
 * Regression guard: V1 todos used to be write-only (tmp file, never surfaced),
 * so they vanished from context after a compaction. They must now appear in the
 * unified _taskStore.snapshot() consumed by the compaction pipeline.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TODO_FILE = path.join(os.tmpdir(), 'khy-todos.json');

function writeTodos(todos) {
  fs.writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2), 'utf-8');
}

function clearTodos() {
  try { fs.unlinkSync(TODO_FILE); } catch { /* ignore */ }
}

describe('TodoWriteTool.snapshot (V1)', () => {
  const TodoWriteTool = require('../src/tools/TodoWriteTool');

  afterEach(() => clearTodos());

  test('empty / missing file → empty string', () => {
    clearTodos();
    assert.strictEqual(TodoWriteTool.snapshot(), '');
  });

  test('renders status icons and high/low priority', () => {
    writeTodos([
      { content: 'design schema', status: 'completed', priority: 'high' },
      { content: 'write migration', status: 'in_progress', priority: 'medium' },
      { content: 'add tests', status: 'pending', priority: 'low' },
    ]);
    const snap = TodoWriteTool.snapshot();
    const lines = snap.split('\n');
    assert.strictEqual(lines.length, 3);
    assert.ok(lines[0].startsWith('✓ design schema (high)'));
    assert.ok(lines[1].startsWith('→ write migration')); // medium priority omitted
    assert.ok(!lines[1].includes('(medium)'));
    assert.ok(lines[2].startsWith('○ add tests (low)'));
  });

  test('malformed file → empty string, no throw', () => {
    fs.writeFileSync(TODO_FILE, '{ not json', 'utf-8');
    assert.strictEqual(TodoWriteTool.snapshot(), '');
  });

  test('in_progress item renders activeForm; other states keep content (CC parity)', () => {
    writeTodos([
      { content: 'Design schema', activeForm: 'Designing schema', status: 'completed' },
      { content: 'Write migration', activeForm: 'Writing migration', status: 'in_progress' },
      { content: 'Add tests', activeForm: 'Adding tests', status: 'pending' },
    ]);
    const lines = TodoWriteTool.snapshot().split('\n');
    // Only the in_progress row swaps to the present-continuous activeForm.
    assert.ok(lines[0].startsWith('✓ Design schema'), lines[0]);
    assert.ok(lines[1].startsWith('→ Writing migration'), lines[1]);
    assert.ok(lines[2].startsWith('○ Add tests'), lines[2]);
  });

  test('in_progress item without activeForm falls back to content', () => {
    writeTodos([{ content: 'Refactor parser', status: 'in_progress' }]);
    assert.ok(TodoWriteTool.snapshot().startsWith('→ Refactor parser'));
  });
});

describe('_taskStore.snapshot folds in V1 todos', () => {
  const taskStore = require('../src/tools/_taskStore');

  afterEach(() => clearTodos());

  test('V1 todos appear in the unified snapshot consumed by compaction', () => {
    writeTodos([{ content: 'refactor auth module', status: 'in_progress' }]);
    const snap = taskStore.snapshot();
    assert.ok(snap.includes('refactor auth module'),
      `expected V1 todo in unified snapshot, got: ${JSON.stringify(snap)}`);
  });

  test('no todos and no tasks → empty string', () => {
    clearTodos();
    // V2 store has no tool-sourced tasks in a fresh test process.
    const snap = taskStore.snapshot();
    assert.strictEqual(typeof snap, 'string');
  });
});

describe('_taskStore activeForm surfaces (V2)', () => {
  const taskStore = require('../src/tools/_taskStore');

  function freshId() {
    // Deterministic-enough unique id without Date.now/random in assertions.
    return 't-test-' + (freshId._n = (freshId._n || 0) + 1);
  }

  afterEach(() => { try { taskStore.clear(); } catch { /* ignore */ } });

  test('in_progress task shows activeForm in snapshot (CC parity)', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'Fix auth bug', activeForm: 'Fixing auth bug', status: 'pending' });
    taskStore.update(id, { status: 'in_progress' });

    const snap = taskStore.snapshot();
    assert.ok(snap.includes('Fixing auth bug'), `expected activeForm in snapshot, got: ${snap}`);
    // Static subject + description must not be shown alongside the activeForm label.
    assert.ok(!snap.includes('Fix auth bug —'), `subject/desc leaked: ${snap}`);
  });

  test('currentActivity returns activeForm of the in_progress task', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'Write migration', activeForm: 'Writing migration', status: 'pending' });
    assert.strictEqual(taskStore.currentActivity(), ''); // nothing running yet
    taskStore.update(id, { status: 'in_progress' });
    assert.strictEqual(taskStore.currentActivity(), 'Writing migration');
  });

  test('currentActivity falls back to subject when activeForm absent', () => {
    const id = freshId();
    taskStore.add({ id, subject: 'Run tests', status: 'pending' });
    taskStore.update(id, { status: 'in_progress' });
    assert.strictEqual(taskStore.currentActivity(), 'Run tests');
  });
});

describe('_taskStore.snapshot blocked-by filtering (刀29, CC openBlockers parity)', () => {
  const taskStore = require('../src/tools/_taskStore');

  function freshId() {
    return 't-blk-' + (freshId._n = (freshId._n || 0) + 1);
  }

  afterEach(() => { try { taskStore.clear(); } catch { /* ignore */ } });

  test('completed dependency is dropped from the [blocked by] annotation', () => {
    const depA = freshId();
    const depB = freshId();
    const main = freshId();
    taskStore.add({ id: depA, subject: 'dep A', status: 'pending' });
    taskStore.add({ id: depB, subject: 'dep B', status: 'pending' });
    taskStore.add({ id: main, subject: 'main task', status: 'pending', blockedBy: [depA, depB] });

    // Both deps open → both listed (with `#` prefix, CC parity).
    let snap = taskStore.snapshot();
    let mainLine = snap.split('\n').find(l => l.includes('main task'));
    assert.ok(mainLine.includes(`#${depA}`), `expected open depA, got: ${mainLine}`);
    assert.ok(mainLine.includes(`#${depB}`), `expected open depB, got: ${mainLine}`);

    // Complete depA → it must vanish from the blocked-by suffix; depB stays.
    taskStore.update(depA, { status: 'completed' });
    snap = taskStore.snapshot();
    mainLine = snap.split('\n').find(l => l.includes('main task'));
    assert.ok(!mainLine.includes(`#${depA}`), `completed depA should be dropped, got: ${mainLine}`);
    assert.ok(mainLine.includes(`#${depB}`), `open depB should remain, got: ${mainLine}`);
  });

  test('all deps completed → blocked-by suffix disappears entirely', () => {
    const dep = freshId();
    const main = freshId();
    taskStore.add({ id: dep, subject: 'the dep', status: 'pending' });
    taskStore.add({ id: main, subject: 'gated task', status: 'pending', blockedBy: [dep] });

    taskStore.update(dep, { status: 'completed' });
    const snap = taskStore.snapshot();
    const mainLine = snap.split('\n').find(l => l.includes('gated task'));
    assert.ok(!mainLine.includes('blocked by'), `suffix should be gone, got: ${mainLine}`);
  });

  test('KHY_TASK_BLOCKED_BY_FILTER=0 → byte-revert to raw join (completed dep still shown)', () => {
    const prev = process.env.KHY_TASK_BLOCKED_BY_FILTER;
    process.env.KHY_TASK_BLOCKED_BY_FILTER = '0';
    try {
      const dep = freshId();
      const main = freshId();
      taskStore.add({ id: dep, subject: 'legacy dep', status: 'pending' });
      taskStore.add({ id: main, subject: 'legacy main', status: 'pending', blockedBy: [dep] });
      taskStore.update(dep, { status: 'completed' });

      const snap = taskStore.snapshot();
      const mainLine = snap.split('\n').find(l => l.includes('legacy main'));
      // Legacy format: raw join(','), no `#`, completed dep NOT filtered.
      assert.ok(mainLine.includes(`[blocked by: ${dep}]`), `expected legacy raw suffix, got: ${mainLine}`);
    } finally {
      if (prev === undefined) delete process.env.KHY_TASK_BLOCKED_BY_FILTER;
      else process.env.KHY_TASK_BLOCKED_BY_FILTER = prev;
    }
  });
});
