'use strict';

/**
 * editFileHealHint.test.js — editFile 失败时 _healHint 字段验收。
 *
 * 验证 Replacer-missed / count>1 / count=0 三种失败路径都给出可操作的
 * LLM 自检提示。集成 editReplacer(默认开)与 KHY_EDIT_REPLACER=off 两条路径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 临时目录 + 临时文件
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-editfile-heal-'));
const testFile = path.join(tmpDir, 'test.js');

function setup(content) {
  fs.writeFileSync(testFile, content, 'utf8');
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const editFile = require('../../src/tools/editFile');

test('Replacer-missed(默认开)返回 _healHint 给出 read_file 自检建议', async () => {
  setup('const x = 1;\nconst y = 2;\n');
  // 提供一个完全不存在的 oldString,即使 8 层 Replacer 也救不回来
  const result = await editFile.execute({
    file_path: testFile,
    old_string: 'function nonexistent() { return "zzz"; }',
    new_string: 'function replacement() {}',
  });
  assert.equal(result.success, false);
  assert.ok(result._healHint, 'must have _healHint');
  assert.match(result._healHint, /read_file|grep/);
  assert.match(result._healHint, /建议/);
});

test('Replacer-off + count=0 路径返回 _healHint', async () => {
  setup('const x = 1;\n');
  const orig = process.env.KHY_EDIT_REPLACER;
  process.env.KHY_EDIT_REPLACER = 'off';
  // 重新 require editFile 才会读到新 env(模块级 require 一次缓存)
  // 但 _isEditReplacerEnabled 是 lazy 调用,应当立即生效
  try {
    const result = await editFile.execute({
      file_path: testFile,
      old_string: 'function nonexistent() {}',
      new_string: 'function replacement() {}',
    });
    assert.equal(result.success, false);
    assert.ok(result._healHint, 'must have _healHint');
    assert.match(result._healHint, /read_file/);
  } finally {
    if (orig === undefined) {
      delete process.env.KHY_EDIT_REPLACER;
    } else {
      process.env.KHY_EDIT_REPLACER = orig;
    }
  }
});

test('Replacer-off + count>1 路径返回 _healHint 提示唯一化', async () => {
  setup('const x = 1;\nconst x = 2;\nconst x = 3;\n');
  const orig = process.env.KHY_EDIT_REPLACER;
  process.env.KHY_EDIT_REPLACER = 'off';
  try {
    const result = await editFile.execute({
      file_path: testFile,
      old_string: 'const x = ',
      new_string: 'const X = ',
    });
    assert.equal(result.success, false);
    assert.ok(result._healHint, 'must have _healHint');
    assert.match(result._healHint, /唯一|replace_all/);
  } finally {
    if (orig === undefined) {
      delete process.env.KHY_EDIT_REPLACER;
    } else {
      process.env.KHY_EDIT_REPLACER = orig;
    }
  }
});

test('成功路径不返回 _healHint', async () => {
  setup('const x = 1;\n');
  const result = await editFile.execute({
    file_path: testFile,
    old_string: 'const x = 1;',
    new_string: 'const x = 999;',
  });
  assert.equal(result.success, true);
  assert.ok(!result._healHint, 'success path should not include _healHint');
});

test('Replacer-on + 简单成功路径不包含 _healHint', async () => {
  setup('const x = 1;\nconst y = 2;\n');
  const result = await editFile.execute({
    file_path: testFile,
    old_string: 'const x = 1;',
    new_string: 'const x = 100;',
  });
  assert.equal(result.success, true);
  assert.ok(!result._healHint);
});

test('Replacer-on + 行 trim 漂移自愈成功(strategy 字段可见)', async () => {
  setup('  const x = 1;\n  const y = 2;\n');
  const result = await editFile.execute({
    file_path: testFile,
    old_string: 'const x = 1;\nconst y = 2;\n', // LLM 给的少了缩进
    new_string: 'const x = 999;\nconst y = 888;\n',
  });
  // 即使 Replacer 命中,也可能因为首行精确匹配走 Simple。
  // 这里要的是:如果 Replacer 命中,result.strategy 字段存在。
  assert.equal(result.success, true);
  // strategy 字段证明走的是 Replacer 链(Simple 也会带 'SimpleReplacer')
  assert.ok(result.strategy, 'strategy should be set on success');
  assert.match(result.strategy, /Replacer/);
});
