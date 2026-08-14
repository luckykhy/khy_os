'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  STICKY_WINDOW,
  extractTargets,
  classifyToolBatch,
  buildAttributionDirective,
  createAttributionState,
  recordToolBatch,
} = require('../src/services/actionAttribution');

// ─── classifyToolBatch:破坏性 / 变更 / 只读判定 ────────────────────────────────

test('cmd del is classified destructive', () => {
  const batch = classifyToolBatch([
    { tool: 'Bash', params: { command: 'del "C:\\Users\\me\\Desktop\\KHY-Quant-Setup-8.0.0.exe"' }, result: { output: '找不到 C:\\Users\\me\\Desktop\\KHY-Quant-Setup-8.0.0.exe' } },
  ]);
  assert.strictEqual(batch.mutated, true);
  assert.strictEqual(batch.destructive, true);
  assert.strictEqual(batch.actions[0].verb, 'delete');
  assert.strictEqual(batch.actions[0].noop, true);
  assert.ok(batch.actions[0].target.includes('C:\\Users\\me\\Desktop\\KHY-Quant-Setup-8.0.0.exe'));
});

test('posix rm -rf is destructive', () => {
  const batch = classifyToolBatch([
    { tool: 'bash', params: { command: 'rm -rf /tmp/build' }, result: 'removed' },
  ]);
  assert.strictEqual(batch.destructive, true);
  assert.strictEqual(batch.actions[0].noop, false);
});

test('powershell Remove-Item is destructive', () => {
  const batch = classifyToolBatch([
    { tool: 'shell', params: { command: 'Remove-Item -Force foo.txt' }, result: '' },
  ]);
  assert.strictEqual(batch.destructive, true);
});

test('overwrite redirection is destructive but >> append is not', () => {
  assert.strictEqual(classifyToolBatch([{ tool: 'bash', params: { command: 'echo x > config.json' } }]).destructive, true);
  const append = classifyToolBatch([{ tool: 'bash', params: { command: 'echo x >> log.txt' } }]);
  assert.strictEqual(append.mutated, false, '>> append must not be treated as destructive overwrite');
});

test('move is mutated but not destructive', () => {
  const batch = classifyToolBatch([
    { tool: 'bash', params: { command: 'mv old.txt new.txt' }, result: '' },
  ]);
  assert.strictEqual(batch.mutated, true);
  assert.strictEqual(batch.destructive, false);
  assert.strictEqual(batch.actions[0].verb, 'move');
});

test('Write / Edit tools are mutating', () => {
  const batch = classifyToolBatch([
    { tool: 'Write', params: { file_path: '/a/b.js' }, result: { success: true } },
    { tool: 'Edit', params: { file_path: '/a/c.js' }, result: { success: true } },
  ]);
  assert.strictEqual(batch.mutated, true);
  assert.strictEqual(batch.actions.length, 2);
  assert.deepStrictEqual(batch.actions[0].target, ['/a/b.js']);
});

test('pure read batch (Read/Grep/Glob) is not mutated — zero false positive', () => {
  const batch = classifyToolBatch([
    { tool: 'Read', params: { file_path: '/a/b.js' }, result: 'contents' },
    { tool: 'Grep', params: { pattern: 'foo' }, result: 'matches' },
    { tool: 'Glob', params: { pattern: '*.exe' }, result: 'no files found' },
  ]);
  assert.strictEqual(batch.mutated, false);
  assert.strictEqual(batch.destructive, false);
  assert.strictEqual(batch.actions.length, 0);
});

test('command that merely mentions a deleted path is not destructive (word boundary)', () => {
  // "model" contains no standalone rm/del verb; ensure substring does not trip.
  const batch = classifyToolBatch([
    { tool: 'bash', params: { command: 'echo model_rm_helper' }, result: '' },
  ]);
  assert.strictEqual(batch.mutated, false);
});

test('empty / malformed input is safe', () => {
  assert.strictEqual(classifyToolBatch(null).mutated, false);
  assert.strictEqual(classifyToolBatch([null, undefined, {}]).mutated, false);
  assert.strictEqual(classifyToolBatch([{ tool: 'bash', params: {} }]).mutated, false);
});

// ─── detectNoOp via classify ─────────────────────────────────────────────────

test('no-op outcome detected across cmd / english phrasing', () => {
  for (const out of ['找不到文件', 'Could Not Find', 'The system cannot find the file specified', 'No such file or directory', '文件不存在']) {
    const batch = classifyToolBatch([{ tool: 'bash', params: { command: 'rm x' }, result: out }]);
    assert.strictEqual(batch.actions[0].noop, true, `expected noop for: ${out}`);
  }
});

// ─── extractTargets ──────────────────────────────────────────────────────────

test('extractTargets prefers quoted paths and caps/dedups', () => {
  const t = extractTargets('del "a.exe" "b.exe" "a.exe" "c.exe" "d.exe" "e.exe"');
  assert.ok(t.length <= 4);
  assert.deepStrictEqual(t, ['a.exe', 'b.exe', 'c.exe', 'd.exe']);
});

test('extractTargets falls back to verb args when unquoted', () => {
  const t = extractTargets('rm foo.txt bar.txt');
  assert.deepStrictEqual(t, ['foo.txt', 'bar.txt']);
});

// ─── buildAttributionDirective ───────────────────────────────────────────────

test('directive is a [SYSTEM:] block that forbids vague external attribution', () => {
  const d = buildAttributionDirective({ actions: [{ verb: 'delete', destructive: true, target: ['a.exe'], noop: true }] });
  assert.ok(d.startsWith('[SYSTEM:'));
  assert.ok(d.endsWith(']'));
  assert.ok(d.includes('认领'));
  assert.ok(d.includes('可能之前'), 'must explicitly name the bad phrasing to avoid');
  assert.ok(d.includes('找不到'), 'noop branch should explain the not-found causality');
  assert.ok(d.includes('a.exe'));
});

test('directive without noop omits the not-found clause but keeps ownership', () => {
  const d = buildAttributionDirective({ actions: [{ verb: 'modify', destructive: false, target: [], noop: false }] });
  assert.ok(d.includes('认领'));
  assert.ok(!d.includes('这次命令显示目标'));
});

// ─── recordToolBatch:粘性窗口状态机 ─────────────────────────────────────────

test('directive emitted on the mutating turn', () => {
  const st = createAttributionState();
  const r = recordToolBatch(st, [{ tool: 'bash', params: { command: 'del "x.exe"' }, result: '找不到' }], { options: { actionAttribution: true } });
  assert.ok(r.directive, 'should emit on the turn the deletion happens');
  assert.strictEqual(r.destructive, true);
});

test('sticky window re-emits across following read-only turns then stops', () => {
  const st = createAttributionState();
  // turn 1: delete
  let r = recordToolBatch(st, [{ tool: 'bash', params: { command: 'del "x.exe"' }, result: '找不到' }], { options: { actionAttribution: true } });
  assert.ok(r.directive);
  // turn 2: read-only Glob (the repro's intervening probe) — still within window
  r = recordToolBatch(st, [{ tool: 'Glob', params: { pattern: '*.exe' }, result: 'none' }], { options: { actionAttribution: true } });
  assert.ok(r.directive, 'should still emit one turn after the mutation (sticky)');
  // turn 3: still within STICKY_WINDOW (==2)
  r = recordToolBatch(st, [{ tool: 'Read', params: { file_path: '/a' }, result: 'x' }], { options: { actionAttribution: true } });
  assert.ok(r.directive, 'within sticky window');
  // turn 4: window exceeded → stop
  r = recordToolBatch(st, [{ tool: 'Read', params: { file_path: '/b' }, result: 'y' }], { options: { actionAttribution: true } });
  assert.strictEqual(r.directive, null, 'past sticky window, no more directive');
});

test('pure-read session never emits a directive — byte-identical path', () => {
  const st = createAttributionState();
  for (let i = 0; i < 4; i++) {
    const r = recordToolBatch(st, [{ tool: 'Read', params: { file_path: '/a' }, result: 'x' }], { options: { actionAttribution: true } });
    assert.strictEqual(r.directive, null);
  }
});

test('gate off (option) suppresses directive', () => {
  const st = createAttributionState();
  const r = recordToolBatch(st, [{ tool: 'bash', params: { command: 'del "x.exe"' }, result: '找不到' }], { options: { actionAttribution: 'off' } });
  assert.strictEqual(r.directive, null);
  // but state still tracks the mutation (so toggling back on mid-session is coherent)
  assert.strictEqual(r.destructive, true);
});

test('gate off via env var suppresses directive', () => {
  const prev = process.env.KHY_ACTION_ATTRIBUTION;
  process.env.KHY_ACTION_ATTRIBUTION = 'false';
  try {
    const st = createAttributionState();
    const r = recordToolBatch(st, [{ tool: 'bash', params: { command: 'rm x' }, result: '' }]);
    assert.strictEqual(r.directive, null);
  } finally {
    if (prev === undefined) delete process.env.KHY_ACTION_ATTRIBUTION;
    else process.env.KHY_ACTION_ATTRIBUTION = prev;
  }
});

test('a fresh mutation resets the sticky window', () => {
  const st = createAttributionState();
  recordToolBatch(st, [{ tool: 'bash', params: { command: 'del "x"' }, result: '找不到' }], { options: { actionAttribution: true } });
  recordToolBatch(st, [{ tool: 'Read', params: { file_path: '/a' }, result: 'x' }], { options: { actionAttribution: true } });
  recordToolBatch(st, [{ tool: 'Read', params: { file_path: '/b' }, result: 'y' }], { options: { actionAttribution: true } });
  // window would be exhausted next turn — but a new deletion resets it
  const r = recordToolBatch(st, [{ tool: 'bash', params: { command: 'rm y' }, result: '' }], { options: { actionAttribution: true } });
  assert.ok(r.directive, 'new mutation must re-arm the window');
  assert.strictEqual(st.sinceMutation, 0);
});

test('STICKY_WINDOW constant is exported and small', () => {
  assert.strictEqual(typeof STICKY_WINDOW, 'number');
  assert.ok(STICKY_WINDOW >= 1 && STICKY_WINDOW <= 3);
});
