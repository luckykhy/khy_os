'use strict';

/**
 * selfEditAdvisoryService — 壳集成测试(真临时目录 os.tmpdir,做真 IO)。
 *
 * 搭一个含 pyproject.toml name="khy-os" + 两 bundle 根 + 一个源文件的假 khy 根,验证:
 * 探根严格标记(非 khy → null 绝不误触发)、镜像漂移比对(同步 vs 缺失 vs 内容漂移)、
 * emitForPath 端到端(humanLine 含两 bundle 目标路径 / 漂移→需同步 / 非镜像源→null)、
 * 工具编辑去重注册表 TTL、门控关→null。
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./selfEditAdvisoryService');

// ── 搭假 khy monorepo 根 ──────────────────────────────────────────────────
function mkFakeRoot({ withBundles = true, khyName = true, srcContent = 'module.exports = 1;\n', mirror = 'same' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-selfedit-'));
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    `[project]\nname = "${khyName ? 'khy-os' : 'some-other'}"\n`
  );
  const srcRel = 'services/backend/src/services/x.js';
  const srcAbs = path.join(root, srcRel);
  fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
  fs.writeFileSync(srcAbs, srcContent);

  if (withBundles) {
    for (const bundleRoot of ['platform/khy_os/bundled', 'packaging/npm/bundled']) {
      const dstAbs = path.join(root, bundleRoot, srcRel);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      if (mirror === 'same') fs.writeFileSync(dstAbs, srcContent);
      else if (mirror === 'drift') fs.writeFileSync(dstAbs, srcContent + '// drifted\n');
      // mirror === 'missing' → 不写副本
    }
  }
  return { root, srcRel, srcAbs };
}

beforeEach(() => {
  svc._resetCachesForTest();
  delete process.env.KHY_SELF_EDIT_ADVISORY;
});

describe('detectKhyRepoRoot — 严格标记,非 khy 绝不误触发', () => {
  test('齐备标记 → 命中根', () => {
    const { root, srcAbs } = mkFakeRoot();
    assert.equal(svc.detectKhyRepoRoot(path.dirname(srcAbs)), fs.realpathSync(root));
  });
  test('pyproject 非 khy-os → null', () => {
    const { srcAbs } = mkFakeRoot({ khyName: false });
    svc._resetCachesForTest();
    assert.equal(svc.detectKhyRepoRoot(path.dirname(srcAbs)), null);
  });
  test('缺 bundle 根 → null', () => {
    const { srcAbs } = mkFakeRoot({ withBundles: false });
    svc._resetCachesForTest();
    assert.equal(svc.detectKhyRepoRoot(path.dirname(srcAbs)), null);
  });
});

describe('checkMirrorDrift', () => {
  test('两副本一致 → 无漂移', () => {
    const { root, srcRel } = mkFakeRoot({ mirror: 'same' });
    const r = svc.checkMirrorDrift(srcRel, fs.realpathSync(root));
    assert.deepEqual(r, { missing: [], drift: [] });
  });
  test('副本缺失 → missing 两处', () => {
    const { root, srcRel } = mkFakeRoot({ mirror: 'missing' });
    const r = svc.checkMirrorDrift(srcRel, fs.realpathSync(root));
    assert.equal(r.missing.length, 2);
    assert.equal(r.drift.length, 0);
  });
  test('副本内容漂移 → drift 两处', () => {
    const { root, srcRel } = mkFakeRoot({ mirror: 'drift' });
    const r = svc.checkMirrorDrift(srcRel, fs.realpathSync(root));
    assert.equal(r.drift.length, 2);
    assert.equal(r.missing.length, 0);
  });
});

describe('emitForPath — 端到端', () => {
  test('已同步源 → aiNote 含两 bundle 目标路径 + humanLine 已同步', () => {
    const { root, srcAbs } = mkFakeRoot({ mirror: 'same' });
    const r = svc.emitForPath(srcAbs, { cwd: root });
    assert.ok(r, 'expected advisory');
    assert.match(r.aiNote, /platform\/khy_os\/bundled\/services\/backend\/src\/services\/x\.js/);
    assert.match(r.aiNote, /packaging\/npm\/bundled\/services\/backend\/src\/services\/x\.js/);
    assert.match(r.humanLine, /已同步/);
  });
  test('漂移源 → 需同步', () => {
    const { root, srcAbs } = mkFakeRoot({ mirror: 'drift' });
    const r = svc.emitForPath(srcAbs, { cwd: root });
    assert.ok(r);
    assert.match(r.humanLine, /需同步/);
  });
  test('非镜像源(scripts/…)→ null', () => {
    const { root } = mkFakeRoot();
    const other = path.join(root, 'scripts', 'x.js');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'x');
    assert.equal(svc.emitForPath(other, { cwd: root }), null);
  });
  test('非 khy 根 → null(绝不误触发用户工程)', () => {
    const { srcAbs } = mkFakeRoot({ khyName: false });
    svc._resetCachesForTest();
    assert.equal(svc.emitForPath(srcAbs, { cwd: path.dirname(srcAbs) }), null);
  });
  test('门控关 KHY_SELF_EDIT_ADVISORY=0 → null', () => {
    const { root, srcAbs } = mkFakeRoot({ mirror: 'same' });
    process.env.KHY_SELF_EDIT_ADVISORY = '0';
    assert.equal(svc.emitForPath(srcAbs, { cwd: root }), null);
  });
});

describe('工具/监视去重注册表(§4)', () => {
  test('recordToolEdit 后 wasRecentlyToolEdited 命中一次', () => {
    const abs = path.join(os.tmpdir(), 'khy-recent-x.js');
    svc.recordToolEdit(abs);
    assert.equal(svc.wasRecentlyToolEdited(abs), true);
    // 一次性消费
    assert.equal(svc.wasRecentlyToolEdited(abs), false);
  });
  test('未登记 → false', () => {
    assert.equal(svc.wasRecentlyToolEdited(path.join(os.tmpdir(), 'khy-never.js')), false);
  });
});
