'use strict';

/**
 * toolTargetMemo.test.js — 工具目标抽取按对象身份记忆(纯叶子 + ProcessGroup 集成,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关。
 *  - 门控开:同一 tool 对象连续多帧只算一次(命中返回缓存字符串)。
 *  - 不同 tool 对象独立;运行中工具每帧换新对象 → 每帧 miss 重算(不取陈旧)。
 *  - 门控关 / 非对象键 → 每帧直算(逐字节回退)。
 *  - computeFn 抛错 → 绝不向上抛(兜底 '')。
 *  - **集成逐字节等价**:ProcessGroup.groupTitle(tools) 在 memo ON 与 OFF 下对同输入产出相同字符串。
 *  - **性能证据**:同一 tool 对象跨两次 groupTitle,memo ON 只读一次 input(JSON.parse 一次);OFF 读两次。
 *
 * 运行:node --test services/backend/tests/cli/toolTargetMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const memo = require('../../src/cli/tui/ink-components/toolTargetMemo');
const ProcessGroup = require('../../src/cli/tui/ink-components/ProcessGroup');

const ON = {};
const OFF = { KHY_TOOL_TARGET_MEMO: 'off' };

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_TOOL_TARGET_MEMO: 'off' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_TARGET_MEMO: '0' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_TARGET_MEMO: 'false' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_TARGET_MEMO: 'no' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_TARGET_MEMO: 'on' }), true);
});

test('门控开:同一 tool 对象多帧只算一次,命中返回同值', () => {
  const t = { input: '{"command":"ls -la"}' };
  let calls = 0;
  const compute = () => { calls++; return 'ls -la'; };
  const a = memo.memoToolTarget(t, compute, ON);
  const b = memo.memoToolTarget(t, compute, ON);
  const c = memo.memoToolTarget(t, compute, ON);
  assert.equal(calls, 1, '冻结 tool 的多帧应只算一次');
  assert.equal(a, 'ls -la');
  assert.equal(b, 'ls -la');
  assert.equal(c, 'ls -la');
});

test('不同 tool 对象独立;每帧新对象 → 每帧重算', () => {
  let calls = 0;
  const compute = () => { calls++; return 'x'; };
  memo.memoToolTarget({ input: '1' }, compute, ON);
  memo.memoToolTarget({ input: '1' }, compute, ON); // 内容同但引用不同
  memo.memoToolTarget({ input: '1' }, compute, ON);
  assert.equal(calls, 3, '每帧换新 tool 对象应每帧 miss 重算');
});

test('门控关 / 非对象键 → 每帧直算', () => {
  const t = { input: 'a' };
  let calls = 0;
  const compute = () => { calls++; return 'r'; };
  memo.memoToolTarget(t, compute, OFF);
  memo.memoToolTarget(t, compute, OFF);
  assert.equal(calls, 2, '门控关每帧直算');
  let c2 = 0;
  const cf = () => { c2++; return 'r'; };
  assert.equal(memo.memoToolTarget(null, cf, ON), 'r');
  assert.equal(memo.memoToolTarget('str', cf, ON), 'r');
  assert.equal(c2, 2, '非对象键每次直算');
});

test('computeFn 抛错 → 绝不向上抛(兜底 空串)', () => {
  const t = { input: 'a' };
  const throwing = () => { throw new Error('boom'); };
  let out;
  assert.doesNotThrow(() => { out = memo.memoToolTarget(t, throwing, ON); });
  assert.equal(out, '', '两次都抛 → 兜底 空串');
});

// ── 集成:ProcessGroup.groupTitle 逐字节等价(memo ON vs OFF) ────────────────────────
test('集成:groupTitle 在 memo ON/OFF 下逐字节等价', () => {
  const mk = () => [{ name: 'bash', input: '{"command":"ls -la"}' }];
  const prev = process.env.KHY_TOOL_TARGET_MEMO;
  try {
    process.env.KHY_TOOL_TARGET_MEMO = 'off';
    const off = ProcessGroup.groupTitle(mk());
    delete process.env.KHY_TOOL_TARGET_MEMO; // 默认 on
    const on = ProcessGroup.groupTitle(mk());
    assert.equal(on, off, 'memo 不改变 groupTitle 输出');
    assert.ok(on.includes('ls -la'), `目标应含 ls -la,实得: ${on}`);
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_TARGET_MEMO;
    else process.env.KHY_TOOL_TARGET_MEMO = prev;
  }
});

test('性能证据:同一 tool 跨两次 groupTitle,memo ON 只读一次 input(OFF 读两次)', () => {
  function makeTool() {
    let reads = 0;
    const t = { name: 'bash' };
    Object.defineProperty(t, 'input', {
      get() { reads++; return '{"command":"echo hi"}'; },
      enumerable: true,
    });
    return { t, reads: () => reads };
  }
  const prev = process.env.KHY_TOOL_TARGET_MEMO;
  try {
    // OFF:每次 groupTitle 都 toolTarget → 读 input 一次 → 两次调用读两次。
    process.env.KHY_TOOL_TARGET_MEMO = 'off';
    const offTool = makeTool();
    ProcessGroup.groupTitle([offTool.t]);
    ProcessGroup.groupTitle([offTool.t]);
    assert.equal(offTool.reads(), 2, 'memo 关:两次 groupTitle 应读 input 两次');

    // ON:第二次命中 WeakMap → 不再 toolTarget → 不读 input。
    delete process.env.KHY_TOOL_TARGET_MEMO;
    const onTool = makeTool();
    ProcessGroup.groupTitle([onTool.t]);
    ProcessGroup.groupTitle([onTool.t]);
    assert.equal(onTool.reads(), 1, 'memo 开:同一 tool 第二次应命中缓存,input 只读一次');
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_TARGET_MEMO;
    else process.env.KHY_TOOL_TARGET_MEMO = prev;
  }
});

// ── memoCondensedTarget:压缩目标(basename)同按 tool 对象身份记忆 ──────────────────────
test('memoCondensedTarget:门控开同一 tool 多帧只算一次;缓存命中返同值', () => {
  const t = { input: '{"file_path":"/a/b/server.js"}' };
  let calls = 0;
  const compute = () => { calls++; return 'server.js'; };
  const a = memo.memoCondensedTarget(t, compute, ON);
  const b = memo.memoCondensedTarget(t, compute, ON);
  const c = memo.memoCondensedTarget(t, compute, ON);
  assert.equal(calls, 1, '冻结 tool 的压缩目标多帧应只算一次');
  assert.equal(a, 'server.js');
  assert.equal(b, 'server.js');
  assert.equal(c, 'server.js');
});

test('memoCondensedTarget:门控关 / 非对象键 → 每帧直算;抛错兜底 空串', () => {
  const t = { input: 'x' };
  let calls = 0;
  const compute = () => { calls++; return 'r'; };
  memo.memoCondensedTarget(t, compute, OFF);
  memo.memoCondensedTarget(t, compute, OFF);
  assert.equal(calls, 2, '门控关每帧直算');
  let c2 = 0;
  const cf = () => { c2++; return 'r'; };
  assert.equal(memo.memoCondensedTarget(null, cf, ON), 'r');
  assert.equal(memo.memoCondensedTarget(undefined, cf, ON), 'r');
  assert.equal(c2, 2, '非对象键每次直算');
  const throwing = () => { throw new Error('boom'); };
  let out;
  assert.doesNotThrow(() => { out = memo.memoCondensedTarget({ input: 'a' }, throwing, ON); });
  assert.equal(out, '', '两次都抛 → 兜底 空串');
});

test('memoCondensedTarget:target 与 condensed 两级缓存独立(同 tool 各只算一次)', () => {
  // 同一 tool 对象:两级 WeakMap 各自命中,分别只算一次。
  const t = { input: '{"file_path":"/x/y/z.txt"}' };
  let tCalls = 0, cCalls = 0;
  memo.memoToolTarget(t, () => { tCalls++; return '/x/y/z.txt'; }, ON);
  memo.memoToolTarget(t, () => { tCalls++; return '/x/y/z.txt'; }, ON);
  memo.memoCondensedTarget(t, () => { cCalls++; return 'z.txt'; }, ON);
  memo.memoCondensedTarget(t, () => { cCalls++; return 'z.txt'; }, ON);
  assert.equal(tCalls, 1, 'target 级缓存命中');
  assert.equal(cCalls, 1, 'condensed 级缓存命中');
});

test('集成:representativeTarget 经 groupTitle,多路径 basename 折叠在 ON/OFF 逐字节等价', () => {
  // 全部工具指向同一路径的不同写法 → condense 后同 basename → 单一目标进标题。
  const mk = () => [
    { name: 'readFile', input: '{"file_path":"/deep/nested/app.js"}' },
    { name: 'editFile', input: '{"file_path":"/deep/nested/app.js"}' },
  ];
  const prev = process.env.KHY_TOOL_TARGET_MEMO;
  try {
    process.env.KHY_TOOL_TARGET_MEMO = 'off';
    const off = ProcessGroup.groupTitle(mk());
    delete process.env.KHY_TOOL_TARGET_MEMO;
    const on = ProcessGroup.groupTitle(mk());
    assert.equal(on, off, 'condense memo 不改变 groupTitle 输出');
    assert.ok(on.includes('app.js'), `应折叠为 basename app.js,实得: ${on}`);
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_TARGET_MEMO;
    else process.env.KHY_TOOL_TARGET_MEMO = prev;
  }
});

test('LIVE wiring:ProcessGroup.js 经 memoCondensedTarget + 直接 condenseTarget 回退', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/tui/ink-components/ProcessGroup.js'), 'utf8');
  assert.ok(/_toolTargetMemo\.memoCondensedTarget\(t,/.test(src), '委托 condense 经 memoCondensedTarget');
  assert.ok(/typeof _toolTargetMemo\.memoCondensedTarget === 'function'/.test(src), '旧叶子无此函数时守卫回退');
  assert.ok(/:\s*condenseTarget\(target\)\)/.test(src), '直接 condenseTarget 回退保留');
});
