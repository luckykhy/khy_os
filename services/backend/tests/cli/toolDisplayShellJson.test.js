'use strict';

// 端到端验证 toolDisplay 经典渲染路径的接线:bash 命令输出里的压扁 JSON 行,在
// 渲染(切行/折叠)前先经纯叶子 shellOutputJson 美化(对齐 CC OutputLine)。
// 门控关 → 逐字节回退原压扁一行。非 bash 工具 → 不动(CC 只对 shell 输出做)。
const test = require('node:test');
const assert = require('node:assert');
const { printToolCallResult } = require('../../src/cli/toolDisplay');

// 去 ANSI,把每次 console.log 的实参拼成一段文本捕获。
function capture(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { fn(); } finally { console.log = orig; }
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\[[0-9;]*m/g, '');
}

function withEnv(key, value, fn) {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
}

test('bash 输出含压扁 JSON → 经典路径渲染时被缩进美化(门控开)', () => {
  const out = withEnv('KHY_SHELL_OUTPUT_JSON', undefined, () =>
    capture(() => printToolCallResult('bash', { command: 'echo x' }, 'success', '{"a":1,"b":2}', 100))
  );
  // 美化后会出现独立缩进行 `"a": 1`(冒号后有空格),压扁形 `{"a":1` 不应作为整行残留。
  assert.ok(out.includes('"a": 1'), `期望出现美化行 "a": 1,实际:\n${out}`);
  assert.ok(out.includes('"b": 2'), `期望出现美化行 "b": 2,实际:\n${out}`);
});

test('门控关 KHY_SHELL_OUTPUT_JSON=0 → 逐字节回退,保持压扁一行', () => {
  const out = withEnv('KHY_SHELL_OUTPUT_JSON', '0', () =>
    capture(() => printToolCallResult('bash', { command: 'echo x' }, 'success', '{"a":1,"b":2}', 100))
  );
  assert.ok(out.includes('{"a":1,"b":2}'), `期望保留压扁形,实际:\n${out}`);
  assert.ok(!out.includes('"a": 1'), `门控关不应美化,实际:\n${out}`);
});

test('非 bash 工具(grep)→ detail 不做 JSON 美化(CC 只对 shell 输出做)', () => {
  // grep 策略 boxPreview=false → isBash=false → 不经 JSON 美化,detail 原样切行。
  const out = withEnv('KHY_SHELL_OUTPUT_JSON', undefined, () =>
    capture(() => printToolCallResult('grep', { pattern: 'x' }, 'success', '{"a":1,"b":2}', 100))
  );
  assert.ok(out.includes('{"a":1,"b":2}'), `非 bash 应保留原样,实际:\n${out}`);
  assert.ok(!out.includes('"a": 1'), `非 bash 不应美化,实际:\n${out}`);
});

test('bash 输出为普通文本 → 原样,不受影响', () => {
  const out = withEnv('KHY_SHELL_OUTPUT_JSON', undefined, () =>
    capture(() => printToolCallResult('bash', { command: 'ls' }, 'success', 'file1.txt\nfile2.txt', 100))
  );
  assert.ok(out.includes('file1.txt'));
  assert.ok(out.includes('file2.txt'));
});
