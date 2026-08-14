'use strict';

/**
 * projectHygiene.assessScaffold — batch project-generation hygiene
 * ([DESIGN-ARCH-054]). Locks the seam that stops the Khyos agent from emitting a
 * god component (or a duplicate module) when it scaffolds a whole project via
 * the batch writer instead of single writeFile. Pure, disk-free, node:test.
 */

const test = require('node:test');
const assert = require('node:assert');

const hygiene = require('../../src/services/projectHygiene');

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; process.env[k] = overrides[k]; }
  try { return fn(); }
  finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const bigJs = (lines) => Array.from({ length: lines }, (_, i) => `const v${i} = ${i};`).join('\n');

test('clean batch of small focused files → ok', () => {
  const verdict = hygiene.assessScaffold({
    files: [
      { path: 'src/routes/user.js', content: 'module.exports = function user() {};\n' },
      { path: 'src/services/userService.js', content: 'module.exports = { save() {} };\n' },
    ],
  });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.violations.length, 0);
});

test('a single oversized generated file → god-component violation, with file path', () => {
  withEnv({ KHY_PROJECT_GOD_FILE_LOC: '20' }, () => {
    const verdict = hygiene.assessScaffold({
      files: [
        { path: 'src/app.js', content: bigJs(50) },
        { path: 'src/ok.js', content: bigJs(3) },
      ],
    });
    assert.strictEqual(verdict.ok, false);
    const god = verdict.violations.find((v) => v.type === 'god-file');
    assert.ok(god, 'expected a god-file violation');
    assert.strictEqual(god.file, 'src/app.js');
    assert.ok(god.loc > god.threshold);
    assert.match(god.message, /上帝组件/);
  });
});

test('non-code data file over the ceiling is NOT a god component', () => {
  withEnv({ KHY_PROJECT_GOD_FILE_LOC: '20' }, () => {
    const verdict = hygiene.assessScaffold({
      files: [{ path: 'data/seed.json', content: bigJs(200) }],
    });
    assert.strictEqual(verdict.ok, true);
  });
});

test('two near-identical modules in one batch → one duplicate-module violation', () => {
  const body = [
    "const db = require('./db');",
    'function findUser(id) { return db.get("user", id); }',
    'function saveUser(u) { return db.put("user", u); }',
    'function deleteUser(id) { return db.del("user", id); }',
    'module.exports = { findUser, saveUser, deleteUser };',
  ].join('\n');
  const verdict = hygiene.assessScaffold({
    files: [
      { path: 'src/userRepo.js', content: body },
      { path: 'src/userRepo2.js', content: body },
    ],
  });
  assert.strictEqual(verdict.ok, false);
  const dups = verdict.violations.filter((v) => v.type === 'duplicate-module');
  assert.strictEqual(dups.length, 1, 'a clone pair yields exactly one violation, not two mirror-image');
});

test('master kill-switch KHY_PROJECT_HYGIENE=off disables all checks', () => {
  withEnv({ KHY_PROJECT_HYGIENE: 'off', KHY_PROJECT_GOD_FILE_LOC: '5' }, () => {
    const verdict = hygiene.assessScaffold({ files: [{ path: 'src/app.js', content: bigJs(100) }] });
    assert.strictEqual(verdict.ok, true);
  });
});

test('empty / malformed input is fail-open', () => {
  assert.strictEqual(hygiene.assessScaffold({}).ok, true);
  assert.strictEqual(hygiene.assessScaffold({ files: [] }).ok, true);
  assert.strictEqual(hygiene.assessScaffold({ files: [null, { path: '' }] }).ok, true);
});
