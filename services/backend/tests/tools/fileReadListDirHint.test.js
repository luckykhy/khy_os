'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FileReadTool = require('../../src/tools/FileReadTool');

function makeTool() {
  // FileReadTool 导出可能是类或实例;两种都兼容。
  const T = FileReadTool && FileReadTool.default ? FileReadTool.default : FileReadTool;
  return typeof T === 'function' ? new T() : T;
}

test('prompt():默认开 → 引导 ListDir(不再叫用 Bash ls)', () => {
  const prev = process.env.KHY_FILEREAD_LISTDIR_HINT;
  delete process.env.KHY_FILEREAD_LISTDIR_HINT;
  try {
    const p = makeTool().prompt();
    assert.ok(p.includes('ListDir'), '含 ListDir 引导');
    assert.ok(!/use an ls command via the Bash tool/.test(p), '不再叫用 Bash ls');
  } finally {
    if (prev === undefined) delete process.env.KHY_FILEREAD_LISTDIR_HINT;
    else process.env.KHY_FILEREAD_LISTDIR_HINT = prev;
  }
});

test('prompt():门控 off → 逐字节回退旧「Bash ls」文案', () => {
  const prev = process.env.KHY_FILEREAD_LISTDIR_HINT;
  process.env.KHY_FILEREAD_LISTDIR_HINT = 'off';
  try {
    const p = makeTool().prompt();
    assert.ok(/use an ls command via the Bash tool/.test(p), 'off → 旧文案');
    assert.ok(!p.includes('use the ListDir tool'), 'off → 无 ListDir 引导');
  } finally {
    if (prev === undefined) delete process.env.KHY_FILEREAD_LISTDIR_HINT;
    else process.env.KHY_FILEREAD_LISTDIR_HINT = prev;
  }
});

test('读到目录:默认开 → 错误引导 ListDir;off → 旧 ls 文案', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-frt-'));
  const tool = makeTool();
  try {
    const prev = process.env.KHY_FILEREAD_LISTDIR_HINT;
    delete process.env.KHY_FILEREAD_LISTDIR_HINT;
    let res = await tool.execute({ file_path: dir });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('ListDir'), `默认开引导 ListDir: ${res.error}`);

    process.env.KHY_FILEREAD_LISTDIR_HINT = 'off';
    res = await tool.execute({ file_path: dir });
    assert.strictEqual(res.success, false);
    assert.ok(res.error.includes('ls command instead'), `off 回退旧文案: ${res.error}`);

    if (prev === undefined) delete process.env.KHY_FILEREAD_LISTDIR_HINT;
    else process.env.KHY_FILEREAD_LISTDIR_HINT = prev;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
