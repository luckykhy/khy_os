'use strict';

/**
 * workflowCliCore.test.js — 纯叶子 services/workflow/workflowCliCore 的确定性核心。
 * 覆盖 parseInputs / validateGraph / summarizeGraph / toMermaid / formatReport /
 * slugify + env 门控字节回退。零 IO。
 */

const test = require('node:test');
const assert = require('node:assert');

const SUT = '../src/services/workflow/workflowCliCore';

function fresh() {
  delete require.cache[require.resolve(SUT)];
  return require(SUT);
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// 端口表(catalog 子集),供 validateGraph 注入。
const portsFor = (t) => ({
  start: { inputs: [], outputs: ['default'] },
  end: { inputs: ['input'], outputs: [] },
  prompt: { inputs: ['input'], outputs: ['default'] },
  ifElse: { inputs: ['input'], outputs: ['branch-true', 'branch-false'] },
}[t] || { inputs: [], outputs: [] });
const knownTypes = ['start', 'end', 'prompt', 'ifElse'];

const goodGraph = () => ({
  nodes: [
    { id: 's', type: 'start' },
    { id: 'p', type: 'prompt', name: '写作' },
    { id: 'e', type: 'end' },
  ],
  connections: [
    { id: 'c1', from: 's', to: 'p', fromPort: 'default', toPort: 'input' },
    { id: 'c2', from: 'p', to: 'e', fromPort: 'default', toPort: 'input' },
  ],
});

// ── parseInputs ──────────────────────────────────────────────────────────────

test('parseInputs: k=v 解析 + JSON 标量强转 + 只在首个 = 切分', () => {
  const m = fresh();
  const out = m.parseInputs(['topic=cats', 'n=3', 'flag=true', 'nul=null', 'q=a=b']);
  assert.deepEqual(out, { topic: 'cats', n: 3, flag: true, nul: null, q: 'a=b' });
});

test('parseInputs: JSON 对象/数组 + 裸字符串原样 + 忽略无 = 项', () => {
  const m = fresh();
  const out = m.parseInputs(['o={"a":1}', 'arr=[1,2]', 'plain=hello world', 'noeq', '=v', null]);
  assert.deepEqual(out.o, { a: 1 });
  assert.deepEqual(out.arr, [1, 2]);
  assert.equal(out.plain, 'hello world');
  assert.equal('noeq' in out, false);
  assert.equal('' in out, false);
});

test('parseInputs: 门控关 / 非数组 → {}(字节回退)', () => {
  withEnv({ KHY_WORKFLOW_CLI: 'off' }, () => {
    assert.deepEqual(fresh().parseInputs(['a=1']), {});
  });
  assert.deepEqual(fresh().parseInputs(null), {});
});

// ── validateGraph ────────────────────────────────────────────────────────────

test('validateGraph: 合法图 strict 通过', () => {
  const m = fresh();
  const v = m.validateGraph(goodGraph(), { portsFor, knownTypes, strict: true });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('validateGraph: 未知类型 / 重复 id / 悬空边 被报出', () => {
  const m = fresh();
  const g = {
    nodes: [{ id: 's', type: 'start' }, { id: 's', type: 'mystery' }],
    connections: [{ id: 'c', from: 's', to: 'ghost', fromPort: 'default', toPort: 'input' }],
  };
  const v = m.validateGraph(g, { portsFor, knownTypes, strict: false });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /重复节点 id/.test(e)));
  assert.ok(v.errors.some((e) => /不存在的目标节点/.test(e)));
});

test('validateGraph: 非法端口被报出', () => {
  const m = fresh();
  const g = {
    nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }],
    connections: [{ id: 'c', from: 's', to: 'e', fromPort: 'loop-body', toPort: 'input' }],
  };
  const v = m.validateGraph(g, { portsFor, knownTypes });
  assert.ok(v.errors.some((e) => /非法源端口/.test(e)));
});

test('validateGraph: strict 要求恰好一个 start、≥1 end', () => {
  const m = fresh();
  const g = { nodes: [{ id: 'p', type: 'prompt' }], connections: [] };
  const v = m.validateGraph(g, { portsFor, knownTypes, strict: true });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /恰好有一个 start/.test(e)));
  assert.ok(v.errors.some((e) => /至少有一个 end/.test(e)));
});

test('validateGraph: 非对象 → fail-soft 返回 ok:false 不抛', () => {
  const m = fresh();
  assert.equal(m.validateGraph(null).ok, false);
  assert.equal(m.validateGraph('x').ok, false);
});

// ── summarizeGraph ───────────────────────────────────────────────────────────

test('summarizeGraph: 计数 / 起点 / 终点 / 类型分布', () => {
  const m = fresh();
  const s = m.summarizeGraph(goodGraph());
  assert.equal(s.nodeCount, 3);
  assert.equal(s.edgeCount, 2);
  assert.equal(s.start, 's');
  assert.deepEqual(s.ends, ['e']);
  assert.deepEqual(s.typeCounts, { start: 1, prompt: 1, end: 1 });
  assert.equal(s.nodes[1].name, '写作');
});

test('summarizeGraph: 空 / 畸形 → fail-soft', () => {
  const m = fresh();
  const s = m.summarizeGraph({});
  assert.equal(s.nodeCount, 0);
  assert.equal(s.edgeCount, 0);
  assert.equal(s.start, null);
});

// ── toMermaid ────────────────────────────────────────────────────────────────

test('toMermaid: flowchart + 节点形状 + 端口标签', () => {
  const m = fresh();
  const g = {
    nodes: [
      { id: 'a-1', type: 'ifElse', name: '判断' },
      { id: 'b', type: 'prompt', name: '写' },
    ],
    connections: [{ from: 'a-1', to: 'b', fromPort: 'branch-true', toPort: 'input' }],
  };
  const out = m.toMermaid(g);
  assert.match(out, /^flowchart TD/);
  assert.match(out, /n_a_1\{".*"\}/);     // ifElse → 菱形 + id 中 '-' → '_'
  assert.match(out, /-- 真 -->/);          // branch-true → 标签「真」
});

// ── formatReport ─────────────────────────────────────────────────────────────

test('formatReport: 渲染计数 / 不支持 / 告警(数组,绝不抛)', () => {
  const m = fresh();
  const lines = m.formatReport({
    source: 'coze', name: 'X', nodeCount: 5, edgeCount: 4,
    droppedComments: 1, typeCounts: { prompt: 2 },
    unsupported: [{ id: 'n1', cozeType: 'KnowledgeRetriever', mappedTo: 'toolCall' }],
    warnings: ['selector collapsed'],
  });
  assert.ok(Array.isArray(lines));
  assert.ok(lines.some((l) => /KnowledgeRetriever/.test(l)));
  assert.ok(lines.some((l) => /selector collapsed/.test(l)));
  assert.deepEqual(m.formatReport(null).length > 0, true);
});

// ── slugify ──────────────────────────────────────────────────────────────────

test('slugify: 保留中文/字母数字,路径分隔→-,空→workflow', () => {
  const m = fresh();
  assert.equal(m.slugify('秋天的诗 v1'), '秋天的诗-v1');
  assert.equal(m.slugify('a/b:c*?'), 'a-b-c');
  assert.equal(m.slugify('   '), 'workflow');
  assert.equal(m.slugify(null), 'workflow');
});

// ── 门控 ─────────────────────────────────────────────────────────────────────

test('_enabled: 默认开,仅 0/false/off/no 关', () => {
  withEnv({ KHY_WORKFLOW_CLI: undefined }, () => assert.equal(fresh()._enabled(), true));
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    withEnv({ KHY_WORKFLOW_CLI: v }, () => assert.equal(fresh()._enabled(), false));
  }
});
