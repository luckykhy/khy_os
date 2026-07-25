'use strict';

/**
 * gitignoreAdvisor.test.js — 纯叶子:.gitignore 按栈生成 / 解析 / 求差集的确定性测试。
 *
 * 锁定:① node 栈 → 含 node_modules/;② 现有已含 node_modules/ → 求差集不重复;
 * ③ extraPaths 归一去重;④ 门控关 → 空;⑤ parseGitignore 保留 `!` 否定、去注释/空行;
 * ⑥ 目录 pattern 带/不带尾斜杠视为等价(不重复补);⑦ renderGitignoreBlock 空 → ''。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const adv = require('../../src/services/gitignoreAdvisor');

const ON = { KHY_GITIGNORE_ADVISOR: 'true' };
const OFF = { KHY_GITIGNORE_ADVISOR: 'off' };

describe('gitignoreAdvisor.parseGitignore', () => {
  test('去注释/空行/前后空白,保留 pattern', () => {
    const set = adv.parseGitignore('# comment\n\n  node_modules/  \ndist/\n');
    assert.ok(set.has('node_modules/'));
    assert.ok(set.has('dist/'));
    assert.equal(set.size, 2);
  });

  test('保留 `!` 否定语义(不与非否定合并)', () => {
    const set = adv.parseGitignore('build/\n!build/keep.txt\n');
    assert.ok(set.has('build/'));
    assert.ok(set.has('!build/keep.txt'));
  });

  test('非字符串 / 空 → 空 Set', () => {
    assert.equal(adv.parseGitignore(null).size, 0);
    assert.equal(adv.parseGitignore(undefined).size, 0);
    assert.equal(adv.parseGitignore(123).size, 0);
  });
});

describe('gitignoreAdvisor.buildGitignoreAdditions', () => {
  test('node 栈 → 含 node_modules/', () => {
    const add = adv.buildGitignoreAdditions({ stacks: ['node'], existingText: '', env: ON });
    assert.ok(add.includes('node_modules/'), `additions=${add}`);
  });

  test('现有已含 node_modules/ → 求差集不重复', () => {
    const add = adv.buildGitignoreAdditions({ stacks: ['node'], existingText: 'node_modules/\n', env: ON });
    assert.ok(!add.includes('node_modules/'), `should skip existing, got ${add}`);
  });

  test('目录 pattern 带/不带尾斜杠视为等价(现有 node_modules 无斜杠 → 不补 node_modules/)', () => {
    const add = adv.buildGitignoreAdditions({ stacks: ['node'], existingText: 'node_modules\n', env: ON });
    assert.ok(!add.includes('node_modules/'), `slash-insensitive coverage failed: ${add}`);
  });

  test('extraPaths 归一去重', () => {
    const add = adv.buildGitignoreAdditions({
      stacks: [], includeCommon: false,
      existingText: '', extraPaths: ['  secret.env  ', 'secret.env', 'big.bin'], env: ON,
    });
    assert.deepEqual(add, ['secret.env', 'big.bin']);
  });

  test('别名归一:python/py 都映射到 python 模板', () => {
    const a = adv.buildGitignoreAdditions({ stacks: ['python'], includeCommon: false, existingText: '', env: ON });
    const b = adv.buildGitignoreAdditions({ stacks: ['py'], includeCommon: false, existingText: '', env: ON });
    assert.deepEqual(a, b);
    assert.ok(a.includes('__pycache__/'));
  });

  test('门控关 → 空数组', () => {
    const add = adv.buildGitignoreAdditions({ stacks: ['node'], existingText: '', env: OFF });
    assert.deepEqual(add, []);
  });

  test('坏输入绝不抛 → []', () => {
    assert.deepEqual(adv.buildGitignoreAdditions(null), []);
    // stacks 非数组时被忽略,但 includeCommon 仍默认带 common → 不是 []。
    const bad = adv.buildGitignoreAdditions({ stacks: 'notarray', includeCommon: false, env: ON });
    assert.deepEqual(bad, []);
  });

  test('includeCommon 默认带上 common(.env/.DS_Store)', () => {
    const add = adv.buildGitignoreAdditions({ stacks: [], existingText: '', env: ON });
    assert.ok(add.includes('.env'));
    assert.ok(add.includes('.DS_Store'));
  });
});

describe('gitignoreAdvisor.renderGitignoreBlock', () => {
  test('渲染分组注释 + 行', () => {
    const block = adv.renderGitignoreBlock(['node_modules/', '.env'], { header: 'X', env: ON });
    assert.match(block, /# X/);
    assert.match(block, /node_modules\//);
    assert.match(block, /\.env/);
  });

  test('空 additions → ""', () => {
    assert.equal(adv.renderGitignoreBlock([], { env: ON }), '');
  });

  test('门控关 → ""', () => {
    assert.equal(adv.renderGitignoreBlock(['x'], { env: OFF }), '');
  });
});
