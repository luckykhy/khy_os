'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listAtEntries } = require('../src/cli/repl/atPicker');

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atpicker-'));
  fs.writeFileSync(path.join(dir, 'alpha.js'), '');
  fs.writeFileSync(path.join(dir, 'Beta.txt'), '');
  fs.writeFileSync(path.join(dir, '.hidden'), '');
  fs.writeFileSync(path.join(dir, '.env.example'), '');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, '.claude'));
  return dir;
}

test('列举不再抛错（修复 _DIR_SKIP 未定义的潜伏 bug），返回结构正确', () => {
  const dir = mkTmp();
  const r = listAtEntries(dir);
  // node_modules 被跳过；.hidden 被跳过；.env.example / .claude 保留
  const names = r.map(e => e.name);
  assert.ok(!names.includes('node_modules'), 'node_modules 应跳过');
  assert.ok(!names.includes('.hidden'), '.hidden 应跳过');
  assert.ok(names.includes('.env.example'), '.env.example 应保留');
  assert.ok(names.includes('.claude'), '.claude 应保留');
});

test('目录在前、名称升序', () => {
  const dir = mkTmp();
  const r = listAtEntries(dir);
  const dirs = r.filter(e => e.isDir).map(e => e.name);
  const firstNonDir = r.findIndex(e => !e.isDir);
  const lastDir = r.map(e => e.isDir).lastIndexOf(true);
  assert.ok(lastDir < firstNonDir, '所有目录应排在文件之前');
  // 目录区段内升序（.claude 与 src）
  assert.deepStrictEqual(dirs, [...dirs].sort((a, b) => a.localeCompare(b)));
});

test('目录条目 display 带尾斜杠，文件不带', () => {
  const dir = mkTmp();
  const r = listAtEntries(dir);
  const src = r.find(e => e.name === 'src');
  const alpha = r.find(e => e.name === 'alpha.js');
  assert.strictEqual(src.display, 'src/');
  assert.strictEqual(alpha.display, 'alpha.js');
});

test('filter 大小写不敏感子串过滤', () => {
  const dir = mkTmp();
  const r = listAtEntries(dir, 'beta');
  assert.deepStrictEqual(r.map(e => e.name), ['Beta.txt']);
});

test('目录读取失败 → 空数组（不抛）', () => {
  const r = listAtEntries(path.join(os.tmpdir(), 'definitely-not-here-' + process.pid));
  assert.deepStrictEqual(r, []);
});
