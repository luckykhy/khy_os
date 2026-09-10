'use strict';
/**
 * selfEditAdvisory �?纯叶子单元测�?合成输入,不碰 IO)�? *
 * 覆盖:门控梯、镜像源判定(�?payload + bundle 内排�?+ 测试文件排除)、镜像路径映�? * (�?kernel/alpine→alpine)、极简纯叶子侦测、反馈文�?漂移 vs 同步 / isLeaf / 守卫
 * pass·fail / 安装态降�?/ 门控关→null)�? */
const m = require('./selfEditAdvisory');
describe('门控�?�?默认开,仅显�?falsy �?, () => {
});
describe('isMirroredSourcePath �?�?payload 命中,bundle 内与测试文件排除', () => {
});
describe('computeMirrorPaths �?映射到两 bundle �?, () => {
});
describe('detectPureLeaf �?标记 + 契约词同现于首块注释', () => {
});
describe('buildSelfEditAdvisory', () => {
  const rel = 'services/backend/src/services/x.js';
});

describe('Self Edit Advisory', () => {
  test('unset / �?env �?开', () => {
        expect(m.selfEditAdvisoryEnabled({})).toBe(true);
        expect(m.selfEditWatchEnabled({})).toBe(true);
        expect(m.selfEditAdvisoryEnabled(undefined)).toBe(true);
  });

  test('显式 falsy(大小�?空白不敏�?�?�?, () => {
        for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
          assert.equal(
            m.selfEditAdvisoryEnabled({ KHY_SELF_EDIT_ADVISORY: v }),
            false,
            `advisory ${v}`
          );
          expect(m.selfEditWatchEnabled({ KHY_SELF_EDIT_WATCH: v })).toBe(false);
        }
  });

  test('其他�?�?开', () => {
        expect(m.selfEditAdvisoryEnabled({ KHY_SELF_EDIT_ADVISORY: 'yes' })).toBe(true);
        expect(m.selfEditWatchEnabled({ KHY_SELF_EDIT_WATCH: '1' })).toBe(true);
  });

  test('services/backend 源命�?, () => {
        const r = m.isMirroredSourcePath('services/backend/src/services/x.js');
        expect(r.mirrored).toBe(true);
        expect(r.dst).toBe('services/backend');
        expect(r.payloadRel).toBe('src/services/x.js');
  });

  test('docs 源命�?, () => {
        const r = m.isMirroredSourcePath('docs/07_OPS/x.md');
        expect(r.mirrored).toBe(true);
        expect(r.dst).toBe('docs');
        expect(r.payloadRel).toBe('07_OPS/x.md');
  });

  test('kernel/alpine 源命中并映射�?alpine', () => {
        const r = m.isMirroredSourcePath('kernel/alpine/mkimg.sh');
        expect(r.mirrored).toBe(true);
        expect(r.dst).toBe('alpine');
        expect(r.payloadRel).toBe('mkimg.sh');
  });

  test('前导 ./ 与反斜杠归一', () => {
        expect(m.isMirroredSourcePath('./services\\backend\\src\\a.js').mirrored).toBe(true);
  });

  test('bundle 树内的文件不算源', () => {
        assert.equal(
          m.isMirroredSourcePath('platform/khy_os/bundled/services/backend/src/x.js').mirrored,
          false
        );
        assert.equal(
          m.isMirroredSourcePath('packaging/npm/bundled/services/backend/src/x.js').mirrored,
          false
        );
  });

  test('测试文件不进载荷 �?不算�?, () => {
        expect(m.isMirroredSourcePath('services/backend/src/x.test.js').mirrored).toBe(false);
        expect(m.isMirroredSourcePath('services/backend/src/x.test.cjs').mirrored).toBe(false);
  });

  test('仓库根其它路径非镜像�?, () => {
        expect(m.isMirroredSourcePath('scripts/check-leaf-contract.js').mirrored).toBe(false);
        expect(m.isMirroredSourcePath('pyproject.toml').mirrored).toBe(false);
        expect(m.isMirroredSourcePath('').mirrored).toBe(false);
  });

  test('services/backend �?, () => {
        assert.deepEqual(m.computeMirrorPaths('services/backend/src/services/x.js'), [
          'platform/khy_os/bundled/services/backend/src/services/x.js',
          'packaging/npm/bundled/services/backend/src/services/x.js',
        ]);
  });

  test('kernel/alpine �?�?alpine/', () => {
        assert.deepEqual(m.computeMirrorPaths('kernel/alpine/mkimg.sh'), [
          'platform/khy_os/bundled/alpine/mkimg.sh',
          'packaging/npm/bundled/alpine/mkimg.sh',
        ]);
  });

  test('非镜像源 �?[]', () => {
        assert.deepEqual(m.computeMirrorPaths('scripts/x.js'), []);
        assert.deepEqual(m.computeMirrorPaths('platform/khy_os/bundled/services/backend/src/x.js'), []);
  });

  test('自声明纯叶子 �?true', () => {
        assert.equal(
          m.detectPureLeaf('/**\n * foo �?纯叶�?�?IO、确定�?。\n */\nmodule.exports={};'),
          true
        );
  });

  test('pure leaf 英文变体 �?true', () => {
        expect(m.detectPureLeaf('/**\n * pure-leaf: deterministic 单一真源\n */')).toBe(true);
  });

  test('仅提到但无契约词 �?false', () => {
        expect(m.detectPureLeaf('/**\n * 这个文件描述了纯叶子的概念\n */')).toBe(false);
  });

  test('无块注释 �?false', () => {
        expect(m.detectPureLeaf('const x = 1;')).toBe(false);
        expect(m.detectPureLeaf('')).toBe(false);
  });

  test('已同�?+ 非叶�?+ 守卫全过', () => {
        const r = m.buildSelfEditAdvisory(
          {
            repoRel: rel,
            isLeaf: false,
            mirrorState: { missing: [], drift: [] },
            guardResults: [
              { name: 'leaf-contract', ok: true },
              { name: 'model-hardcoding', ok: true },
            ],
            guardsAvailable: true,
          },
          {}
        );
        expect(r).toBeTruthy();
        expect(r.humanLine).toMatch(/镜像已同�?);
        expect(r.humanLine).toMatch(/�?leaf-contract/);
        expect(r.humanLine).not.toMatch(/纯叶子契�?); // 非叶子不加契约行
        expect(r.aiNote).toMatch(/platform\/khy_os\/bundled\/services\/backend\/src\/services\/x\.js/);
        expect(r.aiNote).toMatch(/packaging\/npm\/bundled\/services\/backend\/src\/services\/x\.js/);
        expect(r.aiNote).toMatch(/已同�?);
  });

  test('漂移 + 叶子 + 守卫失败(内联 error 计数与样�?', () => {
        const r = m.buildSelfEditAdvisory(
          {
            repoRel: rel,
            isLeaf: true,
            mirrorState: {
              missing: ['packaging/npm/bundled/services/backend/src/services/x.js'],
              drift: [],
            },
            guardResults: [
              {
                name: 'model-hardcoding',
                ok: false,
                errorCount: 1,
                warnCount: 0,
                sample: "'claude-3'",
              },
            ],
            guardsAvailable: true,
          },
          {}
        );
        expect(r).toBeTruthy();
        expect(r.humanLine).toMatch(/�?需同步/);
        expect(r.humanLine).toMatch(/纯叶子契�?);
        expect(r.humanLine).toMatch(/�?model-hardcoding\(1 error\)/);
        expect(r.aiNote).toMatch(/当前缺失/);
        expect(r.aiNote).toMatch(/model-hardcoding: 1 error/);
        expect(r.aiNote).toMatch(/claude-3/);
        expect(r.aiNote).toMatch(/纯叶子契�?);
  });

  test('安装�?守卫不可�?�?降级为手动提�?不假装跑�?, () => {
        const r = m.buildSelfEditAdvisory(
          {
            repoRel: rel,
            isLeaf: false,
            mirrorState: { missing: [], drift: [] },
            guardResults: [],
            guardsAvailable: false,
          },
          {}
        );
        expect(r).toBeTruthy();
        expect(r.humanLine).toMatch(/安装态无 scripts/);
        expect(r.aiNote).toMatch(/安装�?);
        expect(r.aiNote).toMatch(/手动运行/);
  });

  test('非镜像源 �?null', () => {
        expect(m.buildSelfEditAdvisory({ repoRel: 'scripts/x.js' }, {})).toBe(null);
  });

  test('门控�?�?null(逐字节回退)', () => {
        expect(m.buildSelfEditAdvisory({ repoRel: rel }, { KHY_SELF_EDIT_ADVISORY: '0' })).toBe(null);
        // env 也可�?p.env 传入
        assert.equal(
          m.buildSelfEditAdvisory({ repoRel: rel, env: { KHY_SELF_EDIT_ADVISORY: 'off' } }),
          null
        );
  });

  test('坏输入不�?, () => {
        expect(() => m.buildSelfEditAdvisory(undefined, {}).not.toThrow());
        expect(() => m.buildSelfEditAdvisory({ repoRel: null }, {}).not.toThrow());
  });

});

