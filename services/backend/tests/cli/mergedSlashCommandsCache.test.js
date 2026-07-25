'use strict';

/**
 * mergedSlashCommandsCache 单测 — 经典 REPL 斜杠命令合并结果短 TTL 缓存(纯叶子)。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - mergeCommands:既有优先 · 补位缺失 · 无补位返回 baseCmds 原引用 · 坏输入安全。
 *  - getMergedCommands:TTL 内命中同一引用(discoverFn 不重跑)· TTL 过后重扫 · 门控关每次现扫 ·
 *    baseCmds 身份区分 · discoverFn 抛错 → 视作空发现(返回 baseCmds)· 非对象 baseCmds 回退。
 *  - LIVE wiring:repl.js 确实 require 并消费本叶子。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leaf = require('../../src/cli/repl/mergedSlashCommandsCache');

const base = () => [
  { cmd: '/help', label: 'help', desc: '' },
  { cmd: '/model', label: 'model', desc: '' },
];

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_MERGED_SLASH_COMMANDS_CACHE: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_MERGED_SLASH_COMMANDS_CACHE: off }), false, `off=${off}`);
  }
  assert.deepEqual(leaf.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('mergeCommands: no skills/cc → returns baseCmds SAME reference', () => {
  const b = base();
  assert.strictEqual(leaf.mergeCommands(b, [], []), b);
  assert.strictEqual(leaf.mergeCommands(b, null, undefined), b);
});

test('mergeCommands: appends missing, existing wins on collision', () => {
  const b = base();
  const skills = [
    { cmd: '/help', label: 'DUP', desc: 'should be ignored' }, // collides → skipped
    { cmd: '/mySkill', label: 'skill', desc: 's' },
  ];
  const cc = [{ cmd: '/ccCmd', label: 'cc', desc: 'c' }];
  const out = leaf.mergeCommands(b, skills, cc);
  const cmds = out.map((c) => c.cmd);
  assert.deepEqual(cmds, ['/help', '/model', '/mySkill', '/ccCmd']);
  // existing /help untouched
  assert.equal(out.find((c) => c.cmd === '/help').label, 'help');
  // did not mutate base
  assert.equal(b.length, 2);
});

test('mergeCommands: bad inputs are safe', () => {
  assert.deepEqual(leaf.mergeCommands(null, null, null), []);
  assert.deepEqual(leaf.mergeCommands(undefined, [{ cmd: '/x' }], null).map((c) => c.cmd), ['/x']);
  // null skill entries skipped
  assert.deepEqual(
    leaf.mergeCommands(base(), [null, { cmd: '/y' }, { label: 'no-cmd' }], []).map((c) => c.cmd),
    ['/help', '/model', '/y'],
  );
});

test('getMergedCommands: hit within TTL → same reference, discoverFn once', () => {
  const b = base();
  let calls = 0;
  const discover = () => { calls++; return { userSkills: [{ cmd: '/s' }], ccCommands: [] }; };
  let clock = 1000;
  const now = () => clock;
  const a = leaf.getMergedCommands(b, discover, { env: {}, nowFn: now, ttlMs: 500 });
  clock = 1400; // within TTL
  const c = leaf.getMergedCommands(b, discover, { env: {}, nowFn: now, ttlMs: 500 });
  assert.strictEqual(a, c, 'same merged reference within TTL');
  assert.equal(calls, 1, 'discoverFn not re-run within TTL');
  assert.deepEqual(a.map((x) => x.cmd), ['/help', '/model', '/s']);
});

test('getMergedCommands: TTL expiry → re-discovers', () => {
  const b = base();
  let calls = 0;
  const discover = () => { calls++; return { userSkills: [{ cmd: '/s' + calls }], ccCommands: [] }; };
  let clock = 1000;
  const now = () => clock;
  leaf.getMergedCommands(b, discover, { env: {}, nowFn: now, ttlMs: 500 });
  clock = 1600; // past TTL
  const second = leaf.getMergedCommands(b, discover, { env: {}, nowFn: now, ttlMs: 500 });
  assert.equal(calls, 2, 'discoverFn re-run after TTL');
  assert.deepEqual(second.map((x) => x.cmd), ['/help', '/model', '/s2']);
});

test('getMergedCommands: gate off → discoverFn every call (byte-revert)', () => {
  const b = base();
  let calls = 0;
  const discover = () => { calls++; return { userSkills: [{ cmd: '/s' }], ccCommands: [] }; };
  const off = { KHY_MERGED_SLASH_COMMANDS_CACHE: 'off' };
  const a = leaf.getMergedCommands(b, discover, { env: off, nowFn: () => 1000, ttlMs: 500 });
  const c = leaf.getMergedCommands(b, discover, { env: off, nowFn: () => 1000, ttlMs: 500 });
  assert.equal(calls, 2, 'no caching when gated off');
  assert.notStrictEqual(a, c, 'fresh array each call when off');
  assert.deepEqual(a.map((x) => x.cmd), c.map((x) => x.cmd));
});

test('getMergedCommands: distinct baseCmds identities are cached separately', () => {
  const b1 = base();
  const b2 = base();
  let calls = 0;
  const discover = () => { calls++; return { userSkills: [{ cmd: '/s' }], ccCommands: [] }; };
  const now = () => 1000;
  const r1 = leaf.getMergedCommands(b1, discover, { env: {}, nowFn: now, ttlMs: 500 });
  const r2 = leaf.getMergedCommands(b2, discover, { env: {}, nowFn: now, ttlMs: 500 });
  assert.equal(calls, 2, 'each identity discovered once');
  assert.notStrictEqual(r1, r2);
  // re-hit b1 within TTL
  const r1b = leaf.getMergedCommands(b1, discover, { env: {}, nowFn: now, ttlMs: 500 });
  assert.strictEqual(r1, r1b);
  assert.equal(calls, 2, 'b1 re-hit does not re-discover');
});

test('getMergedCommands: discoverFn throws → treated as empty discovery (returns baseCmds)', () => {
  const b = base();
  const discover = () => { throw new Error('fs boom'); };
  const out = leaf.getMergedCommands(b, discover, { env: {}, nowFn: () => 1000 });
  assert.strictEqual(out, b, 'empty discovery → baseCmds same reference');
});

test('getMergedCommands: non-object baseCmds → fresh compute, no throw', () => {
  const discover = () => ({ userSkills: [{ cmd: '/s' }], ccCommands: [] });
  // null/undefined base + non-empty discovery → skills appended onto empty base
  assert.deepEqual(leaf.getMergedCommands(null, discover, { env: {} }).map((c) => c.cmd), ['/s']);
  assert.deepEqual(
    leaf.getMergedCommands(undefined, discover, { env: {} }).map((c) => c.cmd),
    ['/s'],
  );
  // empty discovery + null base → []
  const empty = () => ({ userSkills: [], ccCommands: [] });
  assert.deepEqual(leaf.getMergedCommands(null, empty, { env: {} }), []);
});

test('getMergedCommands: default TTL is 1000ms', () => {
  assert.equal(leaf.DEFAULT_TTL_MS, 1000);
  const b = base();
  let calls = 0;
  const discover = () => { calls++; return { userSkills: [], ccCommands: [] }; };
  let clock = 0;
  const now = () => clock;
  leaf.getMergedCommands(b, discover, { env: {}, nowFn: now }); // default ttl
  clock = 900;
  leaf.getMergedCommands(b, discover, { env: {}, nowFn: now });
  assert.equal(calls, 1, 'within default 1000ms → cached');
  clock = 1100;
  leaf.getMergedCommands(b, discover, { env: {}, nowFn: now });
  assert.equal(calls, 2, 'past default 1000ms → re-discovered');
});

test('LIVE wiring: repl.js requires + consumes mergedSlashCommandsCache', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/repl.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/repl\/mergedSlashCommandsCache['"]\)/.test(src),
    'repl.js requires the leaf',
  );
  assert.ok(/getMergedCommands\(baseCmds,\s*_discover\)/.test(src), 'calls getMergedCommands(baseCmds, _discover)');
});
