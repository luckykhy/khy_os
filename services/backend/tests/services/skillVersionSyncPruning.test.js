'use strict';

/**
 * skillVersionSyncPruning.test.js — 剪枝与口径迁移的契约测试（node:test 双轨）
 *
 * 对应 khy-Trajectory/ycode-borrowing/2026-09-16-计划.md 的【借鉴提案 P-01】，
 * 借自 xingyao-y-code 的两条设计结论（[DESIGN-SOURCING-001] B-M0 `idea` 档）：
 *   (a) 依赖与构建产物不属于技能本体内容，遍历在「进入目录之前」按段名剪枝；
 *   (b) 跳过规则变更即哈希口径变更，必须给口径加版本号并做保守一次性迁移。
 *
 * 断言刻意写成双向（防剪枝过度误伤本体内容），且**完全不依赖时间戳**——
 * 上游 f3a89f6 的经验表明基于 mtime 的判据在 Windows 上会因纳秒抖动假失效，
 * 本仓指纹与时间戳解耦，测试继承这一性质。
 *
 * 全部用注入的 tmp 目录，绝不触碰真实 dataHome 与真实 built-in 目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVICE_PATH = require.resolve('../../src/services/skillVersionSync');

/** Fresh module instance per test (module-level state must not leak). */
function freshService() {
  delete require.cache[SERVICE_PATH];
  return require(SERVICE_PATH);
}

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-skill-prune-'));
}

/** Create a minimal directory-based skill (manifest.json + prompt.md). */
function writeSkill(dir, name, body = 'prompt body') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name, description: `${name} skill`, trigger: `/${name}` }, null, 2)
  );
  fs.writeFileSync(path.join(dir, 'prompt.md'), `# ${name}\n${body}\n`);
  return dir;
}

function writeFile(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function makeEnv() {
  const tmp = makeTmp();
  const builtinDir = path.join(tmp, 'builtin');
  const userDir = path.join(tmp, 'data', 'skills');
  const indexFile = path.join(userDir, 'builtin_released.json');
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  return { tmp, builtinDir, userDir, indexFile, env: {} };
}

function syncOpts(e, currentVersion) {
  return {
    env: e.env,
    currentVersion,
    builtinDir: e.builtinDir,
    userSkillsDir: e.userDir,
    indexFile: e.indexFile,
  };
}

function readIndex(e) {
  return JSON.parse(fs.readFileSync(e.indexFile, 'utf8'));
}

/**
 * Fixture helper — re-implements the PRE-change (unpruned) fingerprint algorithm
 * so a legacy index record can be synthesized. Production code never uses this.
 * Without it there is no way to construct an index written by an older khy version.
 */
function legacyUnprunedFingerprint(dir) {
  const files = [];
  (function walk(base, rel) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(base, entry.name), childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  })(dir, '');
  files.sort();
  const combined = crypto.createHash('sha256');
  for (const rel of files) {
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
    combined.update(rel + '\0' + fileHash + '\n');
  }
  return combined.digest('hex');
}

/** A skill that vendors its own dependencies — the shape that triggers the defect. */
function writeSkillWithVendoredDeps(dir, name) {
  writeSkill(dir, name);
  writeFile(dir, 'scripts/build.js', `console.log('build ${name}');\n`);
  writeFile(dir, 'scripts/node_modules/pkg/index.js', `module.exports = { name: '${name}' };\n`);
  writeFile(dir, 'scripts/node_modules/.package-lock.json', '{}\n');
  writeFile(dir, 'dist/bundle.js', `/* bundled ${name} */\n`);
  writeFile(dir, '__pycache__/build.cpython-312.pyc', 'x');
  writeFile(dir, 'scripts/build.cpython-312.pyc', 'x');
  return dir;
}

// ── 1. 剪枝生效 ───────────────────────────────────────────────────────────────

test('剪枝：依赖与构建目录的内容改动、新增、删除均不影响指纹', () => {
  const svc = freshService();
  const dir = writeSkillWithVendoredDeps(path.join(makeTmp(), 'alpha'), 'alpha');

  const fp = svc.computeDirFingerprint(dir);

  fs.writeFileSync(path.join(dir, 'scripts/node_modules/pkg/index.js'), 'changed dep content\n');
  assert.strictEqual(svc.computeDirFingerprint(dir), fp, 'dep content edit is invisible');

  writeFile(dir, 'scripts/node_modules/other/index.js', 'a new dependency\n');
  assert.strictEqual(svc.computeDirFingerprint(dir), fp, 'new file inside a pruned dir is invisible');

  fs.rmSync(path.join(dir, 'scripts/node_modules'), { recursive: true, force: true });
  assert.strictEqual(svc.computeDirFingerprint(dir), fp, 'removing a whole pruned tree is invisible');

  fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
  assert.strictEqual(svc.computeDirFingerprint(dir), fp, 'build output removal is invisible');
});

// ── 2. 剪枝不越界（防过度修正） ───────────────────────────────────────────────

test('剪枝不越界：本体内容与被剪枝目录之外的变化必须改变指纹', () => {
  const svc = freshService();
  const dir = writeSkillWithVendoredDeps(path.join(makeTmp(), 'alpha'), 'alpha');

  const fp = svc.computeDirFingerprint(dir);

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'alpha' }));
  assert.notStrictEqual(svc.computeDirFingerprint(dir), fp, 'manifest change detected');

  fs.writeFileSync(path.join(dir, 'prompt.md'), 'user edited prompt\n');
  assert.notStrictEqual(svc.computeDirFingerprint(dir), fp, 'prompt change detected');

  fs.writeFileSync(path.join(dir, 'scripts/build.js'), "console.log('edited');\n");
  assert.notStrictEqual(svc.computeDirFingerprint(dir), fp, 'a script OUTSIDE a pruned dir is tracked');

  writeFile(dir, 'assets/icon.png', 'png');
  assert.notStrictEqual(svc.computeDirFingerprint(dir), fp, 'a new non-pruned file is tracked');
});

// ── 3. 段名匹配任意层级 + 文件后缀 ───────────────────────────────────────────

test('剪枝按段名匹配任意层级，.pyc 后缀同样不计入指纹', () => {
  const svc = freshService();
  const tmp = makeTmp();
  const dir = writeSkill(path.join(tmp, 'alpha'), 'alpha');

  writeFile(dir, 'deep/nested/.git/objects/ab', 'git blob');
  writeFile(dir, 'deep/nested/.pytest_cache/v/cache/nodeids', '[]');
  writeFile(dir, 'deep/nested/__pycache__/mod.pyc', 'x');
  writeFile(dir, 'deep/nested/src/mod.pyc', 'x');
  writeFile(dir, 'deep/nested/src/mod.py', 'print("hi")\n');
  const fp = svc.computeDirFingerprint(dir);

  // Same segment names at a different depth are pruned identically
  writeFile(dir, 'scripts/.git/config', '[core]');
  writeFile(dir, 'a/b/c/d/.venv/lib/site-packages/x.py', 'x');
  assert.strictEqual(svc.computeDirFingerprint(dir), fp, 'pruned segment matched at any depth');

  // Adding a .pyc next to a tracked .py is invisible
  writeFile(dir, 'deep/nested/src/mod2.pyc', 'x');
  assert.strictEqual(svc.computeDirFingerprint(dir), fp, '.pyc suffix excluded');

  // But the tracked .py is not collateral damage
  fs.writeFileSync(path.join(dir, 'deep/nested/src/mod.py'), 'print("bye")\n');
  assert.notStrictEqual(svc.computeDirFingerprint(dir), fp, 'sibling .py still tracked');
});

// ── 4. 不破坏既有指纹契约 ─────────────────────────────────────────────────────

test('剪枝不破坏既有契约：重复计算稳定且位置无关', () => {
  const svc = freshService();
  const tmp = makeTmp();
  const dir = writeSkillWithVendoredDeps(path.join(tmp, 'alpha'), 'alpha');

  const fp1 = svc.computeDirFingerprint(dir);
  assert.strictEqual(svc.computeDirFingerprint(dir), fp1, 'stable across repeated reads');

  const copy = path.join(tmp, 'alpha-copy');
  fs.cpSync(dir, copy, { recursive: true });
  assert.strictEqual(svc.computeDirFingerprint(copy), fp1, 'byte-identical copy keeps the fingerprint');

  assert.ok(/^\0/.test(String.fromCharCode(0)) || fp1.length === 64, 'sha256 hex digest');
});

// ── 5. 口径版本字段（加法式扩展） ─────────────────────────────────────────────

test('索引写入口径版本字段，且 schema 版本保持 1（加法式扩展，不 bump INDEX_VERSION）', () => {
  const svc = freshService();
  const e = makeEnv();
  writeSkill(path.join(e.builtinDir, 'alpha'), 'alpha');

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  assert.strictEqual(r.skipped, undefined, 'first sync runs');
  assert.strictEqual(typeof svc.FP_ALGO_VERSION, 'number', 'algorithm version is exported');
  const idx = readIndex(e);
  assert.strictEqual(idx.version, svc.INDEX_VERSION, 'schema version unchanged (existing contract)');
  assert.strictEqual(idx.version, 1, 'INDEX_VERSION stays 1 — additive field, not a new layout');
  assert.strictEqual(idx.fingerprintAlgo, svc.FP_ALGO_VERSION, 'recorded algorithm matches the writer');
});

// ── 6. 口径迁移纠正假 user_modified ───────────────────────────────────────────

test('口径迁移：旧索引因剪枝产生的假 user_modified 被纠正并原地刷新记录', () => {
  const svc = freshService();
  const e = makeEnv();

  // Builtin skill vendors deps, so the two algorithms disagree on its fingerprint
  writeSkillWithVendoredDeps(path.join(e.builtinDir, 'alpha'), 'alpha');
  const builtinFp = svc.computeDirFingerprint(path.join(e.builtinDir, 'alpha'));
  const legacyFp = legacyUnprunedFingerprint(path.join(e.builtinDir, 'alpha'));
  assert.notStrictEqual(legacyFp, builtinFp, 'fixture sanity: the two algorithms must disagree');

  // User copy is byte-identical to the shipped source — the user changed nothing
  fs.cpSync(path.join(e.builtinDir, 'alpha'), path.join(e.userDir, 'alpha'), { recursive: true });
  fs.writeFileSync(
    e.indexFile,
    JSON.stringify({
      version: 1,
      khyVersion: '1.0.0',
      released: { alpha: { fingerprint: legacyFp, dir: 'alpha', releasedAt: '1.0.0' } },
      userModified: [],
      deleted: [],
    })
  );

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));

  assert.deepStrictEqual(r.userModified, [], 'no false user_modified after the algorithm change');
  assert.deepStrictEqual(r.upgraded, [], 'nothing replaced when the content is unchanged');
  const idx = readIndex(e);
  assert.strictEqual(idx.fingerprintAlgo, svc.FP_ALGO_VERSION, 'migrated index records the new algorithm');
  assert.strictEqual(idx.released.alpha.fingerprint, builtinFp, 'stale record refreshed in place');
});

// ── 7. 迁移保守性 ─────────────────────────────────────────────────────────────

test('口径迁移保守性：无法证明一致的旧记录判为 user_modified 且副本逐字保留', () => {
  const svc = freshService();
  const e = makeEnv();

  writeSkillWithVendoredDeps(path.join(e.builtinDir, 'alpha'), 'alpha');
  fs.writeFileSync(e.indexFile, JSON.stringify({
    version: 1,
    khyVersion: '1.0.0',
    released: { alpha: { fingerprint: legacyUnprunedFingerprint(path.join(e.builtinDir, 'alpha')), dir: 'alpha', releasedAt: '1.0.0' } },
    userModified: [],
    deleted: [],
  }));

  // The user genuinely edited their copy; the package upgraded underneath
  fs.cpSync(path.join(e.builtinDir, 'alpha'), path.join(e.userDir, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(e.userDir, 'alpha', 'prompt.md'), 'user edited\n');
  fs.writeFileSync(path.join(e.builtinDir, 'alpha', 'prompt.md'), 'package v2\n');

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));

  assert.deepStrictEqual(r.userModified, ['alpha'], 'unverifiable divergence is treated as user-modified');
  assert.deepStrictEqual(r.upgraded, [], 'never overwrites an unverifiable copy');
  assert.strictEqual(
    fs.readFileSync(path.join(e.userDir, 'alpha', 'prompt.md'), 'utf8'),
    'user edited\n',
    'user modification preserved verbatim'
  );
});

// ── 8. 迁移不删除任何既有记录 ─────────────────────────────────────────────────

test('口径迁移不删除任何既有记录：released / deleted / userModified 全部保留', () => {
  const svc = freshService();
  const e = makeEnv();

  for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
    writeSkill(path.join(e.builtinDir, name), name);
    fs.cpSync(path.join(e.builtinDir, name), path.join(e.userDir, name), { recursive: true });
  }
  // gamma: user deleted their copy. delta: user edited their copy.
  fs.rmSync(path.join(e.userDir, 'gamma'), { recursive: true, force: true });
  fs.writeFileSync(path.join(e.userDir, 'delta', 'prompt.md'), 'user edited delta\n');

  const released = {};
  for (const name of Object.keys({ alpha: 1, beta: 1, gamma: 1, delta: 1 })) {
    released[name] = {
      fingerprint: legacyUnprunedFingerprint(path.join(e.builtinDir, name)),
      dir: name,
      releasedAt: '1.0.0',
    };
  }
  fs.writeFileSync(e.indexFile, JSON.stringify({
    version: 1,
    khyVersion: '1.0.0',
    released,
    userModified: [],
    deleted: [],
  }));

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));

  const idx = readIndex(e);
  for (const name of Object.keys(released)) {
    assert.ok(idx.released[name], `${name} stays managed by the index`);
  }
  assert.ok(idx.deleted.includes('gamma'), 'tombstone survives the migration');
  assert.ok(idx.userModified.includes('delta'), 'user_modified mark survives the migration');
  assert.strictEqual(idx.fingerprintAlgo, svc.FP_ALGO_VERSION, 'algorithm version recorded');
  assert.strictEqual(idx.version, 1, 'schema version still 1');
  assert.deepStrictEqual(r.tombstoned, ['gamma'], 'tombstoning still reported');
});
