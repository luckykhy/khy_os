'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildTaskSpec, buildStopPlan, describeTask, VALID_KINDS } = require('../src/services/backgroundTaskSpec');

test('shell kind on unix → /bin/sh -c, local_bash type, bg_task source', () => {
  const spec = buildTaskSpec({ kind: 'shell', command: 'echo hi', cwd: '/tmp', platform: 'linux' });
  assert.strictEqual(spec.ok, true);
  assert.strictEqual(spec.type, 'local_bash');
  assert.deepStrictEqual(spec.argv, { file: '/bin/sh', args: ['-c', 'echo hi'] });
  assert.strictEqual(spec.payload_json.source, 'bg_task');
  assert.strictEqual(spec.payload_json.kind, 'shell');
  assert.strictEqual(spec.payload_json.command, 'echo hi');
  assert.strictEqual(spec.payload_json.cwd, '/tmp');
  assert.strictEqual(spec.payload_json.runner_pid, null);
});

test('shell kind on win32 → cmd /c', () => {
  const spec = buildTaskSpec({ kind: 'shell', command: 'dir', platform: 'win32' });
  assert.strictEqual(spec.ok, true);
  assert.deepStrictEqual(spec.argv, { file: 'cmd', args: ['/c', 'dir'] });
  assert.strictEqual(spec.payload_json.cwd, null);
});

test('agent kind → node <khy> ai -p <prompt>, local_agent type', () => {
  const spec = buildTaskSpec({
    kind: 'agent',
    prompt: '梳理 A 模块',
    platform: 'linux',
    nodeExec: '/usr/bin/node',
    khyEntry: '/opt/khy/bin/khy.js',
  });
  assert.strictEqual(spec.ok, true);
  assert.strictEqual(spec.type, 'local_agent');
  assert.deepStrictEqual(spec.argv, { file: '/usr/bin/node', args: ['/opt/khy/bin/khy.js', 'ai', '-p', '梳理 A 模块'] });
  assert.strictEqual(spec.payload_json.kind, 'agent');
  assert.strictEqual(spec.payload_json.prompt, '梳理 A 模块');
});

test('shell kind without command → error', () => {
  const spec = buildTaskSpec({ kind: 'shell', command: '   ', platform: 'linux' });
  assert.strictEqual(spec.ok, false);
  assert.match(spec.error, /shell/);
});

test('agent kind without prompt → error', () => {
  const spec = buildTaskSpec({ kind: 'agent', prompt: '', khyEntry: '/x', platform: 'linux' });
  assert.strictEqual(spec.ok, false);
  assert.match(spec.error, /agent/);
});

test('agent kind without khyEntry → error', () => {
  const spec = buildTaskSpec({ kind: 'agent', prompt: 'do', khyEntry: '', platform: 'linux' });
  assert.strictEqual(spec.ok, false);
  assert.match(spec.error, /khy/);
});

test('unknown kind → error', () => {
  const spec = buildTaskSpec({ kind: 'rocket', command: 'x', platform: 'linux' });
  assert.strictEqual(spec.ok, false);
  assert.match(spec.error, /shell|agent/);
});

test('junk / undefined input → does not throw, returns ok:false', () => {
  for (const bad of [undefined, null, 42, 'str', {}, { kind: 123 }]) {
    let spec;
    assert.doesNotThrow(() => { spec = buildTaskSpec(bad); });
    assert.strictEqual(spec.ok, false);
  }
});

test('buildStopPlan prefers runner_pid, falls back to child_pid, else null', () => {
  assert.deepStrictEqual(buildStopPlan({ payload_json: { runner_pid: 111, child_pid: 222 } }), { pid: 111 });
  assert.deepStrictEqual(buildStopPlan({ payload_json: { runner_pid: null, child_pid: 222 } }), { pid: 222 });
  assert.deepStrictEqual(buildStopPlan({ payload_json: {} }), { pid: null });
  assert.deepStrictEqual(buildStopPlan(null), { pid: null });
  assert.deepStrictEqual(buildStopPlan({ payload_json: { runner_pid: 0, child_pid: -5 } }), { pid: null });
});

test('describeTask summarizes kind + detail without throwing on junk', () => {
  assert.strictEqual(describeTask({ payload_json: { kind: 'shell', command: 'npm run build' } }), '[shell] npm run build');
  assert.strictEqual(describeTask({ payload_json: { kind: 'agent', prompt: 'do a thing' } }), '[agent] do a thing');
  assert.doesNotThrow(() => describeTask(null));
});

test('VALID_KINDS is frozen and contains shell + agent', () => {
  assert.deepStrictEqual([...VALID_KINDS].sort(), ['agent', 'shell']);
  assert.throws(() => { VALID_KINDS.push('x'); });
});
