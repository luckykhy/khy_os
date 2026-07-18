'use strict';

/**
 * deploy.syncEngine.test.js — source→target copy with exclusions.
 *
 * Pure logic (shouldExclude / isInside) is unit-tested directly; syncTree is
 * exercised against a real temp directory so the cross-platform copy path is
 * covered end-to-end with zero mocks.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncTree, shouldExclude, isInside, DEFAULT_EXCLUDES } = require('../src/services/deploy/syncEngine');

describe('shouldExclude', () => {
  test('default excludes match node_modules / .git / dist', () => {
    assert.equal(shouldExclude('node_modules', 'node_modules'), true);
    assert.equal(shouldExclude('.git', '.git'), true);
    assert.equal(shouldExclude('dist', 'dist'), true);
  });
  test('.log files always excluded', () => {
    assert.equal(shouldExclude('debug.log', 'debug.log'), true);
  });
  test('normal source files are kept', () => {
    assert.equal(shouldExclude('src/index.js', 'index.js'), false);
  });
  test('custom exclude list overrides defaults', () => {
    assert.equal(shouldExclude('keepme', 'keepme', { excludes: ['keepme'] }), true);
    assert.equal(shouldExclude('node_modules', 'node_modules', { excludes: ['keepme'] }), false);
  });
  test('excludeDotfiles option drops dot entries', () => {
    assert.equal(shouldExclude('.env', '.env', { excludeDotfiles: true }), true);
  });
});

describe('isInside', () => {
  test('detects nested target', () => {
    assert.equal(isInside('/a/b', '/a/b/c'), true);
    assert.equal(isInside('/a/b', '/a/b'), true);
  });
  test('sibling/outside is not inside', () => {
    assert.equal(isInside('/a/b', '/a/c'), false);
    assert.equal(isInside('/a/b', '/x'), false);
  });
});

describe('syncTree (real fs)', () => {
  let base; let src; let dst;
  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-deploy-sync-'));
    src = path.join(base, 'src');
    dst = path.join(base, 'dst');
    fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(src, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(src, '.git'), { recursive: true });
    fs.writeFileSync(path.join(src, 'index.js'), 'console.log(1)');
    fs.writeFileSync(path.join(src, 'lib', 'util.js'), 'x');
    fs.writeFileSync(path.join(src, 'app.log'), 'noise');
    fs.writeFileSync(path.join(src, 'node_modules', 'pkg', 'a.js'), 'dep');
    fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'ref');
  });
  after(() => { fs.rmSync(base, { recursive: true, force: true }); });

  test('copies source files and dirs, skips excluded', () => {
    const r = syncTree(src, dst);
    assert.ok(fs.existsSync(path.join(dst, 'index.js')));
    assert.ok(fs.existsSync(path.join(dst, 'lib', 'util.js')));
    // excluded
    assert.equal(fs.existsSync(path.join(dst, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(dst, '.git')), false);
    assert.equal(fs.existsSync(path.join(dst, 'app.log')), false);
    assert.ok(r.copied.includes('index.js'));
    assert.ok(r.skipped.includes('node_modules'));
  });

  test('refuses copy into source subtree', () => {
    assert.throws(() => syncTree(src, path.join(src, 'inner')), /递归拷贝/);
  });

  test('refuses identical source and target', () => {
    assert.throws(() => syncTree(src, src), /相同/);
  });

  test('throws when source missing', () => {
    assert.throws(() => syncTree(path.join(base, 'nope'), dst), /不存在/);
  });
});
