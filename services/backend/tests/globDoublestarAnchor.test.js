'use strict';

/**
 * globDoublestarAnchor.test.js — 纯叶子契约 + matchers.globToRegExp 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、doublestarSlashFragment(开门返
 * 锚定片段·关门返 null)、常量、fail-soft;globToRegExp 门开(双星斜杠锚定,拒
 * backup_id_rsa,保 ssh/bare/nested/win)/ 门关(逐字节回退 `^.*id_rsa$`);单星与无斜杠
 * 双星两态不变(严格超集回归)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/globDoublestarAnchor'));

test('globDoublestarAnchorEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.globDoublestarAnchorEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.globDoublestarAnchorEnabled({ KHY_GLOB_DOUBLESTAR_ANCHOR: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.globDoublestarAnchorEnabled({ KHY_GLOB_DOUBLESTAR_ANCHOR: 'sure' }), true);
});

test('doublestarSlashFragment: ON → anchored optional-prefix fragment; OFF → null', () => {
  assert.strictEqual(leaf.doublestarSlashFragment({}), leaf.DOUBLESTAR_SLASH_FRAGMENT);
  assert.strictEqual(leaf.doublestarSlashFragment({ KHY_GLOB_DOUBLESTAR_ANCHOR: '0' }), null);
});

test('constant: fragment is (?:.*[/\\\\])? (matches real separator or empty)', () => {
  assert.strictEqual(leaf.DOUBLESTAR_SLASH_FRAGMENT, '(?:.*[/\\\\])?');
  const re = new RegExp('^' + leaf.DOUBLESTAR_SLASH_FRAGMENT + 'id_rsa$');
  assert.ok(re.test('id_rsa'));               // 自身
  assert.ok(re.test('a/b/id_rsa'));           // 任意目录
  assert.ok(re.test('a\\b\\id_rsa'));         // Windows 分隔
  assert.ok(!re.test('backup_id_rsa'));       // 非分隔符前缀 → 拒
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.doublestarSlashFragment(undefined));
  assert.doesNotThrow(() => leaf.globDoublestarAnchorEnabled(null));
});

// ── matchers.globToRegExp 接线(真跑编译)──────────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function freshMatchers() {
  delete require.cache[require.resolve('../src/services/permissionPolicy/matchers')];
  delete require.cache[require.resolve('../src/services/globDoublestarAnchor')];
  return require('../src/services/permissionPolicy/matchers');
}

test('globToRegExp: gate ON → doublestar-slash anchored (rejects backup_id_rsa)', () => {
  withEnv({ KHY_GLOB_DOUBLESTAR_ANCHOR: undefined }, () => {
    const m = freshMatchers();
    const re = m.globToRegExp('**/id_rsa');
    assert.strictEqual(re.test('/home/u/.ssh/id_rsa'), true);
    assert.strictEqual(re.test('id_rsa'), true);
    assert.strictEqual(re.test('a/b/id_rsa'), true);
    assert.strictEqual(re.test('/home/u/backup_id_rsa'), false); // 修
    assert.strictEqual(re.test('evilid_rsa'), false);            // 修
  });
});

test('globToRegExp: gate OFF → byte-revert to legacy ^.*id_rsa$', () => {
  withEnv({ KHY_GLOB_DOUBLESTAR_ANCHOR: '0' }, () => {
    const m = freshMatchers();
    const re = m.globToRegExp('**/id_rsa');
    assert.strictEqual(re.source, '^.*id_rsa$');
    assert.strictEqual(re.test('/home/u/backup_id_rsa'), true); // legacy over-match preserved
  });
});

test('globToRegExp: single-star and doublestar-without-slash unchanged (both gates)', () => {
  for (const gate of [undefined, '0']) {
    withEnv({ KHY_GLOB_DOUBLESTAR_ANCHOR: gate }, () => {
      const m = freshMatchers();
      assert.strictEqual(m.globToRegExp('*.js').source, '^[^/\\\\]*\\.js$', `gate=${gate}`);
      assert.strictEqual(m.globToRegExp('a**b').source, '^a.*b$', `gate=${gate}`);
    });
  }
});
