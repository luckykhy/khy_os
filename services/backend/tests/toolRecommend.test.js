'use strict';

/**
 * toolRecommend.test.js —— 纯叶子 tools/toolRecommend 的确定性推荐核心。
 * 覆盖 parseToolName / scoreTool 权重 / recommendTools 前 N / 门控字节回退 / fail-soft。
 * 零 IO,node:test。
 */

const test = require('node:test');
const assert = require('node:assert');

const SUT = '../src/tools/toolRecommend';

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

const TOOLS = [
  { name: 'readFile', description: 'Read a file from disk', category: 'filesystem', searchHint: 'open view cat' },
  { name: 'writeFile', description: 'Write content to a file', category: 'filesystem', aliases: ['saveFile'] },
  { name: 'shellCommand', description: 'Run a shell command', category: 'execution', searchHint: 'bash terminal exec' },
  { name: 'webSearch', description: 'Search the web for information', category: 'data' },
  { name: 'mcp__github__create_issue', description: 'Create a GitHub issue', category: 'mcp' },
];

// ── parseToolName ─────────────────────────────────────────────────────────────

test('parseToolName: camelCase 拆词', () => {
  const m = fresh();
  assert.deepEqual(m.parseToolName('readFile'), { parts: ['read', 'file'], full: 'read file' });
});

test('parseToolName: mcp__server__tool 拆词', () => {
  const m = fresh();
  const r = m.parseToolName('mcp__github__create_issue');
  assert.deepEqual(r.parts, ['github', 'create', 'issue']);
  assert.equal(r.full, 'github create issue');
});

test('parseToolName: 空 → 空', () => {
  const m = fresh();
  assert.deepEqual(m.parseToolName(''), { parts: [], full: '' });
});

// ── scoreTool 权重 ────────────────────────────────────────────────────────────

test('scoreTool: 精确名 10 > 别名 8 > 名字词块 5 > searchHint 4 > 名字子串 3 > 描述 2', () => {
  const m = fresh();
  assert.equal(m.scoreTool({ name: 'readFile' }, ['readfile']), 10);          // 精确名
  assert.equal(m.scoreTool({ name: 'writeFile', aliases: ['saveFile'] }, ['savefile']), 8); // 别名
  assert.equal(m.scoreTool({ name: 'readFile' }, ['read']), 5);               // 名字词块
  assert.equal(m.scoreTool({ name: 'shellCommand', searchHint: 'bash' }, ['bash']), 4); // hint
  assert.equal(m.scoreTool({ name: 'webSearch', description: 'find the web' }, ['web']), 5); // 'web' 是名字词块优先于描述
  assert.equal(m.scoreTool({ name: 'foo', description: 'search the web' }, ['search']), 2); // 仅描述
});

test('scoreTool: 非法入参 → 0 不抛', () => {
  const m = fresh();
  assert.equal(m.scoreTool(null, ['x']), 0);
  assert.equal(m.scoreTool({ name: 'x' }, null), 0);
});

// ── recommendTools ────────────────────────────────────────────────────────────

test('recommendTools: 数组候选,按分降序取前 N', () => {
  const m = fresh();
  const out = m.recommendTools('read file', TOOLS, { limit: 3 });
  assert.ok(out.length <= 3);
  assert.equal(out[0].name, 'readFile'); // read(词块5)+file(词块5)=10 最高
  assert.ok(out.every((r) => typeof r.score === 'number' && r.score > 0));
  assert.ok('category' in out[0] && 'description' in out[0]);
});

test('recommendTools: Map 候选 + exclude 自身', () => {
  const m = fresh();
  const map = new Map(TOOLS.map((t) => [t.name, t]));
  const out = m.recommendTools('file', map, { limit: 5, exclude: ['writeFile'] });
  assert.ok(out.every((r) => r.name !== 'writeFile'));
  assert.ok(out.some((r) => r.name === 'readFile'));
});

test('recommendTools: 默认 limit=5', () => {
  const m = fresh();
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `fileTool${i}`, description: 'file' }));
  const out = m.recommendTools('file', many);
  assert.equal(out.length, 5);
});

test('recommendTools: 无匹配 → []', () => {
  const m = fresh();
  assert.deepEqual(m.recommendTools('zzz nonexistent', TOOLS), []);
});

test('recommendTools: 门控关 → [](字节回退)', () => {
  withEnv({ KHY_TOOL_RECOMMEND: 'off' }, () => {
    assert.deepEqual(fresh().recommendTools('read file', TOOLS), []);
  });
});

test('recommendTools: 空 query / 空候选 → fail-soft []', () => {
  const m = fresh();
  assert.deepEqual(m.recommendTools('', TOOLS), []);
  assert.deepEqual(m.recommendTools('read', null), []);
  assert.deepEqual(m.recommendTools('  ', TOOLS), []);
});

// ── 门控 ──────────────────────────────────────────────────────────────────────

test('_enabled: 默认开,仅 0/false/off/no 关', () => {
  withEnv({ KHY_TOOL_RECOMMEND: undefined }, () => assert.equal(fresh()._enabled(), true));
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    withEnv({ KHY_TOOL_RECOMMEND: v }, () => assert.equal(fresh()._enabled(), false));
  }
});
