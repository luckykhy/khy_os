'use strict';

/**
 * projectBoundaryAnchor.test.js — 纯叶子契约 + inputValidators 边界接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、anchorWithinBase(base 本身/base 下→true·
 * 兄弟名前缀→false·关门/非串→null·自定义 sep)、fail-soft;接线活验:门开兄弟目录
 * proj-secrets 被拦(写 + 严格读),真项目内路径不回归,门关逐字节回退(兄弟目录重新逃逸)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/projectBoundaryAnchor'));

test('projectBoundaryAnchorEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.projectBoundaryAnchorEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf.projectBoundaryAnchorEnabled({ KHY_PROJECT_BOUNDARY_ANCHOR: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.projectBoundaryAnchorEnabled({ KHY_PROJECT_BOUNDARY_ANCHOR: 'yes' }), true);
});

test('anchorWithinBase: ON → anchored membership', () => {
  const base = '/home/u/proj';
  assert.strictEqual(leaf.anchorWithinBase(base, base, '/', {}), true);            // base itself
  assert.strictEqual(leaf.anchorWithinBase('/home/u/proj/src/x.js', base, '/', {}), true); // inside
  assert.strictEqual(leaf.anchorWithinBase('/home/u/proj-secrets/x', base, '/', {}), false); // sibling prefix
  assert.strictEqual(leaf.anchorWithinBase('/home/u/proj.bak/x', base, '/', {}), false);
  assert.strictEqual(leaf.anchorWithinBase('/home/u/other/x', base, '/', {}), false);
  // custom separator (Windows-like)
  assert.strictEqual(leaf.anchorWithinBase('C:\\proj\\a', 'C:\\proj', '\\', {}), true);
  assert.strictEqual(leaf.anchorWithinBase('C:\\proj-secrets\\a', 'C:\\proj', '\\', {}), false);
});

test('anchorWithinBase: OFF → null; non-string → null', () => {
  assert.strictEqual(leaf.anchorWithinBase('/a/b', '/a', '/', { KHY_PROJECT_BOUNDARY_ANCHOR: '0' }), null);
  assert.strictEqual(leaf.anchorWithinBase(null, '/a', '/', {}), null);
  assert.strictEqual(leaf.anchorWithinBase('/a/b', 42, '/', {}), null);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.anchorWithinBase('/a', '/a', '/', undefined));
  assert.doesNotThrow(() => leaf.projectBoundaryAnchorEnabled(null));
});

// ── inputValidators 接线(真跑;strict 模式强制走边界判定)──────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function freshValidators() {
  delete require.cache[require.resolve('../src/tools/inputValidators')];
  delete require.cache[require.resolve('../src/services/projectBoundaryAnchor')];
  return require('../src/tools/inputValidators');
}

const BASE = '/home/u/proj';

test('wiring ON: sibling proj-secrets blocked for write + strict read; real inside allowed', () => {
  withEnv({
    KHY_PROJECT_BOUNDARY_ANCHOR: undefined,
    KHY_STRICT_WRITE_BOUNDARY: '1', KHY_STRICT_READ_BOUNDARY: '1',
  }, () => {
    const v = freshValidators();
    // sibling dir sharing name prefix → now OUTSIDE → refused
    assert.strictEqual(v.validateNoPathTraversal('../proj-secrets/steal.txt', BASE).valid, false);
    assert.strictEqual(v.validateReadAccess('../proj-secrets/steal.txt', BASE).valid, false);
    // genuine inside-project path unaffected
    assert.strictEqual(v.validateNoPathTraversal('src/index.js', BASE).valid, true);
    assert.strictEqual(v.validateReadAccess('src/index.js', BASE).valid, true);
  });
});

test('wiring OFF: byte-revert → sibling escapes again', () => {
  withEnv({
    KHY_PROJECT_BOUNDARY_ANCHOR: '0',
    KHY_STRICT_WRITE_BOUNDARY: '1', KHY_STRICT_READ_BOUNDARY: '1',
  }, () => {
    const v = freshValidators();
    // pre-existing bug returns → proves gate is a pure superset
    assert.strictEqual(v.validateNoPathTraversal('../proj-secrets/steal.txt', BASE).valid, true);
    assert.strictEqual(v.validateReadAccess('../proj-secrets/steal.txt', BASE).valid, true);
    // inside-project still allowed under both gates
    assert.strictEqual(v.validateNoPathTraversal('src/index.js', BASE).valid, true);
  });
});
