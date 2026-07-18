'use strict';

// Tests for the SaveMemory tool — model-facing memory write path.
// node:test (jest is broken under rtk — run with `node --test`).
// Isolates writes to a temp dir via KHY_MEMORY_DIR (highest-priority override).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-savemem-'));
process.env.KHY_MEMORY_DIR = tmp;
process.env.KHY_SAVE_MEMORY_TOOL = '1';
process.env.KHY_MEMORY_MERGE_LEGACY = 'off'; // don't read the real legacy dir in tests

const tool = require('../../src/tools/SaveMemory');
const memdir = require('../../src/memdir');

test('execute: persists a memory and reads back via memdir', async () => {
  const res = await tool.execute({
    type: 'user',
    name: 'user-home-address',
    content: '用户家在示例市示例路 1 号。',
    description: '用户家庭地址',
  });
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.ok(res.data && res.data.filename, 'expected filename in result');

  const onDisk = fs.readFileSync(path.join(tmp, res.data.filename), 'utf-8');
  assert.match(onDisk, /示例路 1 号/);

  // Recall side can find it.
  const found = memdir.searchMemories('示例路') || [];
  assert.ok(found.length >= 1, 'expected the saved memory to be recallable');
});

test('execute: rejects invalid type / missing fields', async () => {
  assert.strictEqual((await tool.execute({ type: 'bogus', name: 'x', content: 'y' })).success, false);
  assert.strictEqual((await tool.execute({ type: 'user', name: '', content: 'y' })).success, false);
  assert.strictEqual((await tool.execute({ type: 'user', name: 'x', content: '' })).success, false);
});

test('gate off: KHY_SAVE_MEMORY_TOOL=off → execute refuses and isEnabled false', async () => {
  process.env.KHY_SAVE_MEMORY_TOOL = 'off';
  try {
    assert.strictEqual(tool.isEnabled(), false);
    const res = await tool.execute({ type: 'user', name: 'z', content: 'z' });
    assert.strictEqual(res.success, false);
  } finally {
    process.env.KHY_SAVE_MEMORY_TOOL = '1';
  }
});

test('auto-discovery: tools registry exposes SaveMemory', () => {
  const tools = require('../../src/tools');
  if (typeof tools.loadTools === 'function') tools.loadTools();
  const found = tools.get && tools.get('SaveMemory');
  assert.ok(found, 'expected SaveMemory to be auto-discovered by the tool registry');
});
