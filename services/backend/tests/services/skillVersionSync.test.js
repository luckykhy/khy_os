'use strict';

/**
 * skillVersionSync.test.js — 契约测试（node:test 双轨）
 *
 * 锁定 [DESIGN-ARCH-096] §D 内置技能指纹升级的完整契约：
 *   1. 内容指纹：目录级、位置无关、内容敏感
 *   2. 首次释放：内置技能复制到用户技能目录 + 写 builtin_released.json 索引
 *   3. 版本未变快路径：跳过且不触碰副本
 *   4. 未改动 → 随新版原子替换；改动过 → 保留 + userModified；删除 → 不复活
 *   5. restore-builtin 守卫：仅「曾释放且内置源仍在」可恢复
 *   6. 上游移除：用户副本保留为普通技能，索引不再管理
 *   7. 门控 / 索引 schema 守卫 / 崩溃残留清理 / 路径碰撞不覆盖
 *
 * 全部用注入的 tmp 目录，绝不触碰真实 dataHome 与真实 built-in 目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

const SERVICE_PATH = require.resolve('../../src/services/skillVersionSync');

/** Fresh module instance per test (module-level state must not leak). */
function freshService() {
  delete require.cache[SERVICE_PATH];
  return require(SERVICE_PATH);
}

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-skill-sync-'));
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

/** Isated env: fake builtin dir (alpha/beta) + empty user skills dir + index path. */
function makeEnv() {
  const tmp = makeTmp();
  const builtinDir = path.join(tmp, 'builtin');
  const userDir = path.join(tmp, 'data', 'skills');
  const indexFile = path.join(userDir, 'builtin_released.json');
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  writeSkill(path.join(builtinDir, 'alpha'), 'alpha');
  writeSkill(path.join(builtinDir, 'beta'), 'beta');
  return { tmp, builtinDir, userDir, indexFile, env: {} };
}

function readIndex(e) {
  return JSON.parse(fs.readFileSync(e.indexFile, 'utf8'));
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

// ── 1. 指纹 ───────────────────────────────────────────────────────────────────

test('指纹：重复计算稳定，位置无关，内容/文件集变化则变化', () => {
  const svc = freshService();
  const tmp = makeTmp();
  const dir = writeSkill(path.join(tmp, 'alpha'), 'alpha');

  const fp1 = svc.computeDirFingerprint(dir);
  assert.strictEqual(typeof fp1, 'string');
  assert.ok(fp1.length > 0);
  assert.strictEqual(svc.computeDirFingerprint(dir), fp1, 'same dir, same fingerprint');

  // Location-independent: byte-identical copy has the same fingerprint
  const copy = path.join(tmp, 'alpha-copy');
  fs.cpSync(dir, copy, { recursive: true });
  assert.strictEqual(svc.computeDirFingerprint(copy), fp1, 'copy has same fingerprint');

  // Content change → different
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'changed content');
  assert.notStrictEqual(svc.computeDirFingerprint(dir), fp1, 'content change detected');

  // File-set change (new nested file) → different
  const fp2 = svc.computeDirFingerprint(dir);
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'extra.txt'), 'extra');
  assert.notStrictEqual(svc.computeDirFingerprint(dir), fp2, 'file-set change detected');
});

// ── 2. 首次释放 ─────────────────────────────────────────────────────────────

test('首次同步：释放全部内置技能副本并写入指纹索引', () => {
  const svc = freshService();
  const e = makeEnv();

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  assert.strictEqual(r.skipped, undefined, 'first sync must run');
  assert.deepStrictEqual(r.releasedNew.slice().sort(), ['alpha', 'beta']);
  assert.ok(fs.existsSync(path.join(e.userDir, 'alpha', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(e.userDir, 'beta', 'prompt.md')));
  assert.ok(!fs.existsSync(path.join(e.userDir, 'alpha', 'assets')), 'no stray tmp content');

  const idx = readIndex(e);
  assert.strictEqual(idx.version, 1);
  assert.strictEqual(idx.khyVersion, '1.0.0');
  assert.ok(idx.released.alpha && idx.released.beta);
  assert.strictEqual(
    idx.released.alpha.fingerprint,
    svc.computeDirFingerprint(path.join(e.builtinDir, 'alpha')),
    'index fingerprint equals the released source fingerprint'
  );
});

// ── 3. 版本未变快路径 ───────────────────────────────────────────────────────

test('版本未变：跳过同步且不触碰已释放副本', () => {
  const svc = freshService();
  const e = makeEnv();
  svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));
  const userCopy = path.join(e.userDir, 'alpha', 'prompt.md');
  const before = fs.readFileSync(userCopy, 'utf8');

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  assert.strictEqual(r.skipped, true);
  assert.ok(String(r.reason).includes('版本'), 'skip reason states the version gate');
  assert.strictEqual(fs.readFileSync(userCopy, 'utf8'), before, 'user copy untouched');
});

// ── 4. 升级三分支：未改动 / 改动过 / 删除 ────────────────────────────────────

test('未改动的内置技能随新版本自动升级（内容替换为新版并刷新指纹）', () => {
  const svc = freshService();
  const e = makeEnv();
  svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  // Package upgrade: alpha's content changes, beta unchanged
  fs.writeFileSync(path.join(e.builtinDir, 'alpha', 'prompt.md'), 'v2 content\n');

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));

  assert.deepStrictEqual(r.upgraded, ['alpha'], 'only changed skill is replaced');
  assert.deepStrictEqual(r.releasedNew, []);
  assert.strictEqual(
    fs.readFileSync(path.join(e.userDir, 'alpha', 'prompt.md'), 'utf8'),
    'v2 content\n',
    'user copy upgraded to new package content'
  );
  const idx = readIndex(e);
  assert.strictEqual(idx.khyVersion, '1.1.0');
  assert.strictEqual(
    idx.released.alpha.fingerprint,
    svc.computeDirFingerprint(path.join(e.builtinDir, 'alpha'))
  );
});

test('用户改动过的副本被保留并标记 user_modified，绝不被升级覆盖', () => {
  const svc = freshService();
  const e = makeEnv();
  svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  // User edits their copy; package also upgrades underneath
  fs.writeFileSync(path.join(e.userDir, 'alpha', 'prompt.md'), 'user edited\n');
  fs.writeFileSync(path.join(e.builtinDir, 'alpha', 'prompt.md'), 'v2 package\n');

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));

  assert.deepStrictEqual(r.userModified, ['alpha']);
  assert.deepStrictEqual(r.upgraded, []);
  assert.strictEqual(
    fs.readFileSync(path.join(e.userDir, 'alpha', 'prompt.md'), 'utf8'),
    'user edited\n',
    'user modification preserved verbatim'
  );
  const idx = readIndex(e);
  assert.ok(idx.userModified.includes('alpha'), 'index records the user_modified mark');
  assert.ok(idx.released.alpha, 'still managed by the index');
});

test('用户删除的内置技能不被复活（tombstone 跨多次同步持续生效）', () => {
  const svc = freshService();
  const e = makeEnv();
  svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  // User deletes their released copy of alpha
  fs.rmSync(path.join(e.userDir, 'alpha'), { recursive: true, force: true });

  const r1 = svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));
  assert.deepStrictEqual(r1.tombstoned, ['alpha']);
  assert.ok(!fs.existsSync(path.join(e.userDir, 'alpha')), 'deleted skill stays deleted');
  assert.ok(readIndex(e).deleted.includes('alpha'), 'tombstone persisted in index');

  // Yet another upgrade: still no resurrection
  const r2 = svc.syncBuiltinSkills(syncOpts(e, '1.2.0'));
  assert.ok(!fs.existsSync(path.join(e.userDir, 'alpha')), 'no resurrection on next sync');
  assert.deepStrictEqual(r2.releasedNew, [], 'tombstoned name never auto-re-released');
});

// ── 5. restore-builtin ───────────────────────────────────────────────────────

test('restore-builtin：恢复内置版并刷新指纹，清除 userModified/tombstone 标记', () => {
  const svc = freshService();
  const e = makeEnv();
  svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  fs.writeFileSync(path.join(e.userDir, 'alpha', 'prompt.md'), 'user edited\n');
  const restored = svc.restoreBuiltinSkill('alpha', syncOpts(e));

  assert.strictEqual(restored.name, 'alpha');
  assert.strictEqual(
    fs.readFileSync(path.join(e.userDir, 'alpha', 'prompt.md'), 'utf8'),
    fs.readFileSync(path.join(e.builtinDir, 'alpha', 'prompt.md'), 'utf8'),
    'copy restored to package content'
  );
  const idx = readIndex(e);
  assert.strictEqual(
    idx.released.alpha.fingerprint,
    svc.computeDirFingerprint(path.join(e.builtinDir, 'alpha')),
    'fingerprint refreshed to the restored content'
  );
  assert.ok(!idx.userModified.includes('alpha'), 'user_modified mark cleared');

  // Tombstoned skill (released then deleted) is also restorable — the explicit
  // escape hatch from the no-resurrect rule
  fs.rmSync(path.join(e.userDir, 'alpha'), { recursive: true, force: true });
  svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));
  svc.restoreBuiltinSkill('alpha', syncOpts(e));
  assert.ok(fs.existsSync(path.join(e.userDir, 'alpha', 'manifest.json')), 'restored after tombstone');
  assert.ok(!readIndex(e).deleted.includes('alpha'), 'tombstone cleared');
});

test('restore 守卫：从未释放的同名用户技能 / 内置源不存在 → 明确拒绝', () => {
  const svc = freshService();
  const e = makeEnv();

  // User's own skill shadows builtin alpha by name, but it was NEVER released
  writeSkill(path.join(e.userDir, 'alpha-mine'), 'alpha', 'my own fork');

  assert.throws(
    () => svc.restoreBuiltinSkill('alpha', syncOpts(e)),
    /从未|never/i,
    'un-released name refused with a clear message'
  );
  assert.throws(
    () => svc.restoreBuiltinSkill('no-such-skill', syncOpts(e)),
    /内置|not a built-in/i,
    'unknown name refused with a clear message'
  );
  // The user's own fork is untouched
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(e.userDir, 'alpha-mine', 'manifest.json'), 'utf8')).name,
    'alpha'
  );
});

// ── 6. 上游移除 ─────────────────────────────────────────────────────────────

test('上游移除的内置技能：用户副本保留为普通技能，索引不再管理', () => {
  const svc = freshService();
  const e = makeEnv();
  svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  fs.rmSync(path.join(e.builtinDir, 'beta'), { recursive: true, force: true });

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.1.0'));

  assert.deepStrictEqual(r.orphaned, ['beta']);
  assert.ok(fs.existsSync(path.join(e.userDir, 'beta', 'manifest.json')), 'user copy preserved');
  assert.ok(!readIndex(e).released.beta, 'dropped from the managed index');
});

// ── 7. 门控 / schema 守卫 / 清理 / 碰撞 ─────────────────────────────────────

test('门控：KHY_SKILL_VERSION_SYNC=0 跳过同步（force 可越过）', () => {
  const svc = freshService();
  const e = makeEnv();
  e.env.KHY_SKILL_VERSION_SYNC = '0';

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));
  assert.strictEqual(r.skipped, true);
  assert.ok(String(r.reason).includes('门控'), 'reason names the gate');
  assert.ok(!fs.existsSync(path.join(e.userDir, 'alpha')), 'nothing released while gated off');

  const forced = svc.syncBuiltinSkills({ ...syncOpts(e, '1.0.0'), force: true });
  assert.ok(!forced.skipped, 'force bypasses the gate');
  assert.ok(fs.existsSync(path.join(e.userDir, 'alpha', 'manifest.json')));
});

test('索引 schema 守卫：不认识的索引版本跳过且零改动', () => {
  const svc = freshService();
  const e = makeEnv();
  fs.writeFileSync(e.indexFile, JSON.stringify({ version: 99, khyVersion: '0.0.1' }));

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));
  assert.strictEqual(r.skipped, true);
  assert.ok(String(r.reason).includes('schema'), 'reason names the schema guard');
  assert.ok(!fs.existsSync(path.join(e.userDir, 'alpha')), 'no release on unsupported schema');
});

test('崩溃残留：同步前清理 .tmp-sync 临时目录', () => {
  const svc = freshService();
  const e = makeEnv();
  fs.mkdirSync(path.join(e.userDir, '.tmp-sync', 'alpha-1234'), { recursive: true });
  fs.writeFileSync(path.join(e.userDir, '.tmp-sync', 'alpha-1234', 'manifest.json'), '{}');
  fs.mkdirSync(path.join(e.userDir, '.tmp-old', 'beta-1234'), { recursive: true });

  svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  assert.ok(!fs.existsSync(path.join(e.userDir, '.tmp-sync')), 'stale tmp swept');
  assert.ok(!fs.existsSync(path.join(e.userDir, '.tmp-old')), 'stale swap leftovers swept');
  // And the sync still released normally after sweeping
  assert.ok(fs.existsSync(path.join(e.userDir, 'alpha', 'manifest.json')));
});

test('路径碰撞：目标目录被用户自建技能占用时报告冲突且不覆盖', () => {
  const svc = freshService();
  const e = makeEnv();
  // User dir named "alpha" but with a DIFFERENT skill name inside
  writeSkill(path.join(e.userDir, 'alpha'), 'my-alpha');

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  assert.deepStrictEqual(r.conflicts, ['alpha']);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(e.userDir, 'alpha', 'manifest.json'), 'utf8')).name,
    'my-alpha',
    'user skill at the colliding path untouched'
  );
  assert.deepStrictEqual(r.releasedNew, ['beta'], 'other skills still release');
});

test('用户自建的同名遮蔽技能（从未释放）不被同步管理', () => {
  const svc = freshService();
  const e = makeEnv();
  // Name collision via manifest name in a differently-named dir
  writeSkill(path.join(e.userDir, 'alpha-mine'), 'alpha', 'my own fork');

  const r = svc.syncBuiltinSkills(syncOpts(e, '1.0.0'));

  assert.deepStrictEqual(r.preservedUserOwn, ['alpha']);
  assert.deepStrictEqual(r.releasedNew, ['beta']);
  assert.strictEqual(
    fs.readFileSync(path.join(e.userDir, 'alpha-mine', 'prompt.md'), 'utf8'),
    '# alpha\nmy own fork\n',
    'user shadow untouched'
  );
});

// ── 8. 启动包装 ──────────────────────────────────────────────────────────────

test('启动包装 runStartupSkillSync：进程内只跑一次且吞异常', () => {
  const svc = freshService();
  const e = makeEnv();

  const first = svc.runStartupSkillSync(syncOpts(e, '1.0.0'));
  assert.ok(!first.skipped, 'first startup sync runs');

  const second = svc.runStartupSkillSync(syncOpts(e, '1.1.0'));
  assert.strictEqual(second.skipped, true, 'second call in the same process is a no-op');
  assert.ok(String(second.reason).includes('进程'), 'reason mentions the process guard');

  // Fail-soft: a throwing sync never escapes the wrapper
  const svc2 = freshService();
  const boom = svc2.runStartupSkillSync({
    env: {},
    currentVersion: '1.0.0',
    builtinDir: path.join(makeTmp(), 'missing-builtin'),
    userSkillsDir: makeTmp(),
    indexFile: path.join(makeTmp(), 'missing-index.json'),
  });
  assert.ok(boom, 'wrapper always returns a report instead of throwing');
});
