'use strict';
/**
 * selfEditAdvisoryService �?壳集成测�?真临时目�?os.tmpdir,做真 IO)�? *
 * 搭一个含 pyproject.toml name="khy-os" + �?bundle �?+ 一个源文件的假 khy �?验证:
 * 探根严格标记(�?khy �?null 绝不误触�?、镜像漂移比�?同步 vs 缺失 vs 内容漂移)�? * emitForPath 端到�?humanLine 含两 bundle 目标路径 / 漂移→需同步 / 非镜像源→null)�? * 工具编辑去重注册�?TTL、门控关→null�? */
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('./selfEditAdvisoryService');
// ── 搭假 khy monorepo �?──────────────────────────────────────────────────
function mkFakeRoot({
  withBundles = true,
  khyName = true,
  srcContent = 'module.exports = 1;\n',
  mirror = 'same',
} = {}) {
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
      if (mirror === 'same') {
        fs.writeFileSync(dstAbs, srcContent);
      } else if (mirror === 'drift') {
        fs.writeFileSync(dstAbs, srcContent + '// drifted\n');
      }
      // mirror === 'missing' �?不写副本
    }
  }
  return { root, srcRel, srcAbs };
}
beforeEach(() => {
  svc._resetCachesForTest();
  delete process.env.KHY_SELF_EDIT_ADVISORY;
});
describe('detectKhyRepoRoot �?严格标记,�?khy 绝不误触�?, () => {
});
describe('checkMirrorDrift', () => {
});
describe('emitForPath �?端到�?, () => {
});
describe('工具/监视去重注册�?§4)', () => {
});

describe('Self Edit Advisory Service', () => {
  test('齐备标记 �?命中�?, () => {
        const { root, srcAbs } = mkFakeRoot();
        expect(svc.detectKhyRepoRoot(path.dirname(srcAbs))).toBe(fs.realpathSync(root);
  });

  test('pyproject �?khy-os �?null', () => {
        const { srcAbs } = mkFakeRoot({ khyName: false });
        svc._resetCachesForTest();
        expect(svc.detectKhyRepoRoot(path.dirname(srcAbs))).toBe(null);
  });

  test('�?bundle �?�?null', () => {
        const { srcAbs } = mkFakeRoot({ withBundles: false });
        svc._resetCachesForTest();
        expect(svc.detectKhyRepoRoot(path.dirname(srcAbs))).toBe(null);
  });

  test('两副本一�?�?无漂�?, () => {
        const { root, srcRel } = mkFakeRoot({ mirror: 'same' });
        const r = svc.checkMirrorDrift(srcRel, fs.realpathSync(root));
        assert.deepEqual(r, { missing: [], drift: [] });
  });

  test('副本缺失 �?missing 两处', () => {
        const { root, srcRel } = mkFakeRoot({ mirror: 'missing' });
        const r = svc.checkMirrorDrift(srcRel, fs.realpathSync(root));
        expect(r.missing.length).toBe(2);
        expect(r.drift.length).toBe(0);
  });

  test('副本内容漂移 �?drift 两处', () => {
        const { root, srcRel } = mkFakeRoot({ mirror: 'drift' });
        const r = svc.checkMirrorDrift(srcRel, fs.realpathSync(root));
        expect(r.drift.length).toBe(2);
        expect(r.missing.length).toBe(0);
  });

  test('已同步源 �?aiNote 含两 bundle 目标路径 + humanLine 已同�?, () => {
        const { root, srcAbs } = mkFakeRoot({ mirror: 'same' });
        const r = svc.emitForPath(srcAbs, { cwd: root });
        expect(r).toBeTruthy();
        expect(r.aiNote).toMatch(/platform\/khy_os\/bundled\/services\/backend\/src\/services\/x\.js/);
        expect(r.aiNote).toMatch(/packaging\/npm\/bundled\/services\/backend\/src\/services\/x\.js/);
        expect(r.humanLine).toMatch(/已同�?);
  });

  test('漂移�?�?需同步', () => {
        const { root, srcAbs } = mkFakeRoot({ mirror: 'drift' });
        const r = svc.emitForPath(srcAbs, { cwd: root });
        expect(r).toBeTruthy();
        expect(r.humanLine).toMatch(/需同步/);
  });

  test('非镜像源(scripts/�?�?null', () => {
        const { root } = mkFakeRoot();
        const other = path.join(root, 'scripts', 'x.js');
        fs.mkdirSync(path.dirname(other), { recursive: true });
        fs.writeFileSync(other, 'x');
        expect(svc.emitForPath(other, { cwd: root })).toBe(null);
  });

  test('�?khy �?�?null(绝不误触发用户工�?', () => {
        const { srcAbs } = mkFakeRoot({ khyName: false });
        svc._resetCachesForTest();
        expect(svc.emitForPath(srcAbs, { cwd: path.dirname(srcAbs) })).toBe(null);
  });

  test('门控�?KHY_SELF_EDIT_ADVISORY=0 �?null', () => {
        const { root, srcAbs } = mkFakeRoot({ mirror: 'same' });
        process.env.KHY_SELF_EDIT_ADVISORY = '0';
        expect(svc.emitForPath(srcAbs, { cwd: root })).toBe(null);
  });

  test('recordToolEdit �?wasRecentlyToolEdited 命中一�?, () => {
        const abs = path.join(os.tmpdir(), 'khy-recent-x.js');
        svc.recordToolEdit(abs);
        expect(svc.wasRecentlyToolEdited(abs)).toBe(true);
        // 一次性消�?        expect(svc.wasRecentlyToolEdited(abs)).toBe(false);
  });

  test('未登�?�?false', () => {
        expect(svc.wasRecentlyToolEdited(path.join(os.tmpdir()).toBe('khy-never.js')), false);
  });

});

