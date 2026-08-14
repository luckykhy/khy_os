'use strict';

/**
 * projectMemoryContract.test.js — pure-leaf MEMORY.md contract for project-scoped memory.
 */

const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/memdir/projectMemoryContract');

test('isEnabled: default on; {0,false,off,no} disables', () => {
  assert.strictEqual(c.isEnabled({}), true);
  assert.strictEqual(c.isEnabled({ KHY_PROJECT_MEMORY: '' }), true);
  assert.strictEqual(c.isEnabled({ KHY_PROJECT_MEMORY: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(c.isEnabled({ KHY_PROJECT_MEMORY: v }), false, v);
  }
});

test('buildProjectMemoryIndexContract: embeds project root + dir, declares project scope, has the index section', () => {
  const out = c.buildProjectMemoryIndexContract({ projectRoot: '/work/foo', memoryDir: '/data/projects/abc/memory/' });
  assert.match(out, /项目记忆 \(Project Memory\)/);
  assert.match(out, /\/work\/foo/);
  assert.match(out, /\/data\/projects\/abc\/memory\//);
  assert.match(out, /项目级/); // declares project scope (not global)
  assert.match(out, /## 索引/);
  // four types present
  for (const t of ['user', 'feedback', 'project', 'reference']) {
    assert.match(out, new RegExp(`\\*\\*${t}\\*\\*`));
  }
  assert.ok(out.endsWith('\n'));
});

test('buildProjectMemoryIndexContract: safe defaults on empty input', () => {
  const out = c.buildProjectMemoryIndexContract();
  assert.match(out, /未知项目根/);
  assert.match(out, /项目记忆目录|项目记忆/);
});

test('countIndexEntries: counts only pointer lines `- [..](..)`', () => {
  const raw = [
    '# 项目记忆',
    '',
    '## 索引',
    '- [Alpha](alpha.md) — first hook',
    '- [Beta](beta.md) — second',
    'not an entry',
    '  - [Gamma](gamma.md) — indented still counts',
    '- plain bullet, no link',
  ].join('\n');
  assert.strictEqual(c.countIndexEntries(raw), 3);
  assert.strictEqual(c.countIndexEntries(''), 0);
  assert.strictEqual(c.countIndexEntries(null), 0);
});

test('summarizeProjectMemory: reflects existence and entry count', () => {
  const ready = c.summarizeProjectMemory({ projectRoot: '/r', memoryDir: '/d', indexExists: true, entryCount: 5 });
  assert.strictEqual(ready.length, 3);
  assert.match(ready[1], /已就绪\(5 条索引\)/);
  const missing = c.summarizeProjectMemory({ memoryDir: '/d' });
  assert.match(missing[1], /尚未创建/);
  // fail-soft
  assert.strictEqual(c.summarizeProjectMemory(null).length, 3);
});
