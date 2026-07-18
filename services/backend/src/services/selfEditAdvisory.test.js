'use strict';

/**
 * selfEditAdvisory — 纯叶子单元测试(合成输入,不碰 IO)。
 *
 * 覆盖:门控梯、镜像源判定(三 payload + bundle 内排除 + 测试文件排除)、镜像路径映射
 * (含 kernel/alpine→alpine)、极简纯叶子侦测、反馈文案(漂移 vs 同步 / isLeaf / 守卫
 * pass·fail / 安装态降级 / 门控关→null)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const m = require('./selfEditAdvisory');

describe('门控梯 — 默认开,仅显式 falsy 关', () => {
  test('unset / 空 env → 开', () => {
    assert.equal(m.selfEditAdvisoryEnabled({}), true);
    assert.equal(m.selfEditWatchEnabled({}), true);
    assert.equal(m.selfEditAdvisoryEnabled(undefined), true);
  });
  test('显式 falsy(大小写/空白不敏感)→ 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(m.selfEditAdvisoryEnabled({ KHY_SELF_EDIT_ADVISORY: v }), false, `advisory ${v}`);
      assert.equal(m.selfEditWatchEnabled({ KHY_SELF_EDIT_WATCH: v }), false, `watch ${v}`);
    }
  });
  test('其他值 → 开', () => {
    assert.equal(m.selfEditAdvisoryEnabled({ KHY_SELF_EDIT_ADVISORY: 'yes' }), true);
    assert.equal(m.selfEditWatchEnabled({ KHY_SELF_EDIT_WATCH: '1' }), true);
  });
});

describe('isMirroredSourcePath — 三 payload 命中,bundle 内与测试文件排除', () => {
  test('services/backend 源命中', () => {
    const r = m.isMirroredSourcePath('services/backend/src/services/x.js');
    assert.equal(r.mirrored, true);
    assert.equal(r.dst, 'services/backend');
    assert.equal(r.payloadRel, 'src/services/x.js');
  });
  test('docs 源命中', () => {
    const r = m.isMirroredSourcePath('docs/07_OPS/x.md');
    assert.equal(r.mirrored, true);
    assert.equal(r.dst, 'docs');
    assert.equal(r.payloadRel, '07_OPS/x.md');
  });
  test('kernel/alpine 源命中并映射到 alpine', () => {
    const r = m.isMirroredSourcePath('kernel/alpine/mkimg.sh');
    assert.equal(r.mirrored, true);
    assert.equal(r.dst, 'alpine');
    assert.equal(r.payloadRel, 'mkimg.sh');
  });
  test('前导 ./ 与反斜杠归一', () => {
    assert.equal(m.isMirroredSourcePath('./services\\backend\\src\\a.js').mirrored, true);
  });
  test('bundle 树内的文件不算源', () => {
    assert.equal(m.isMirroredSourcePath('platform/khy_os/bundled/services/backend/src/x.js').mirrored, false);
    assert.equal(m.isMirroredSourcePath('packaging/npm/bundled/services/backend/src/x.js').mirrored, false);
  });
  test('测试文件不进载荷 → 不算源', () => {
    assert.equal(m.isMirroredSourcePath('services/backend/src/x.test.js').mirrored, false);
    assert.equal(m.isMirroredSourcePath('services/backend/src/x.test.cjs').mirrored, false);
  });
  test('仓库根其它路径非镜像源', () => {
    assert.equal(m.isMirroredSourcePath('scripts/check-leaf-contract.js').mirrored, false);
    assert.equal(m.isMirroredSourcePath('pyproject.toml').mirrored, false);
    assert.equal(m.isMirroredSourcePath('').mirrored, false);
  });
});

describe('computeMirrorPaths — 映射到两 bundle 树', () => {
  test('services/backend 源', () => {
    assert.deepEqual(m.computeMirrorPaths('services/backend/src/services/x.js'), [
      'platform/khy_os/bundled/services/backend/src/services/x.js',
      'packaging/npm/bundled/services/backend/src/services/x.js',
    ]);
  });
  test('kernel/alpine 源 → alpine/', () => {
    assert.deepEqual(m.computeMirrorPaths('kernel/alpine/mkimg.sh'), [
      'platform/khy_os/bundled/alpine/mkimg.sh',
      'packaging/npm/bundled/alpine/mkimg.sh',
    ]);
  });
  test('非镜像源 → []', () => {
    assert.deepEqual(m.computeMirrorPaths('scripts/x.js'), []);
    assert.deepEqual(m.computeMirrorPaths('platform/khy_os/bundled/services/backend/src/x.js'), []);
  });
});

describe('detectPureLeaf — 标记 + 契约词同现于首块注释', () => {
  test('自声明纯叶子 → true', () => {
    assert.equal(m.detectPureLeaf('/**\n * foo — 纯叶子(零 IO、确定性)。\n */\nmodule.exports={};'), true);
  });
  test('pure leaf 英文变体 → true', () => {
    assert.equal(m.detectPureLeaf('/**\n * pure-leaf: deterministic 单一真源\n */'), true);
  });
  test('仅提到但无契约词 → false', () => {
    assert.equal(m.detectPureLeaf('/**\n * 这个文件描述了纯叶子的概念\n */'), false);
  });
  test('无块注释 → false', () => {
    assert.equal(m.detectPureLeaf('const x = 1;'), false);
    assert.equal(m.detectPureLeaf(''), false);
  });
});

describe('buildSelfEditAdvisory', () => {
  const rel = 'services/backend/src/services/x.js';

  test('已同步 + 非叶子 + 守卫全过', () => {
    const r = m.buildSelfEditAdvisory({
      repoRel: rel,
      isLeaf: false,
      mirrorState: { missing: [], drift: [] },
      guardResults: [{ name: 'leaf-contract', ok: true }, { name: 'model-hardcoding', ok: true }],
      guardsAvailable: true,
    }, {});
    assert.ok(r);
    assert.match(r.humanLine, /镜像已同步/);
    assert.match(r.humanLine, /✓ leaf-contract/);
    assert.doesNotMatch(r.humanLine, /纯叶子契约/); // 非叶子不加契约行
    assert.match(r.aiNote, /platform\/khy_os\/bundled\/services\/backend\/src\/services\/x\.js/);
    assert.match(r.aiNote, /packaging\/npm\/bundled\/services\/backend\/src\/services\/x\.js/);
    assert.match(r.aiNote, /已同步/);
  });

  test('漂移 + 叶子 + 守卫失败(内联 error 计数与样本)', () => {
    const r = m.buildSelfEditAdvisory({
      repoRel: rel,
      isLeaf: true,
      mirrorState: { missing: ['packaging/npm/bundled/services/backend/src/services/x.js'], drift: [] },
      guardResults: [{ name: 'model-hardcoding', ok: false, errorCount: 1, warnCount: 0, sample: "'claude-3'" }],
      guardsAvailable: true,
    }, {});
    assert.ok(r);
    assert.match(r.humanLine, /⚠ 需同步/);
    assert.match(r.humanLine, /纯叶子契约/);
    assert.match(r.humanLine, /✗ model-hardcoding\(1 error\)/);
    assert.match(r.aiNote, /当前缺失/);
    assert.match(r.aiNote, /model-hardcoding: 1 error/);
    assert.match(r.aiNote, /claude-3/);
    assert.match(r.aiNote, /纯叶子契约/);
  });

  test('安装态(守卫不可用)→ 降级为手动提示,不假装跑过', () => {
    const r = m.buildSelfEditAdvisory({
      repoRel: rel,
      isLeaf: false,
      mirrorState: { missing: [], drift: [] },
      guardResults: [],
      guardsAvailable: false,
    }, {});
    assert.ok(r);
    assert.match(r.humanLine, /安装态无 scripts/);
    assert.match(r.aiNote, /安装态/);
    assert.match(r.aiNote, /手动运行/);
  });

  test('非镜像源 → null', () => {
    assert.equal(m.buildSelfEditAdvisory({ repoRel: 'scripts/x.js' }, {}), null);
  });

  test('门控关 → null(逐字节回退)', () => {
    assert.equal(m.buildSelfEditAdvisory({ repoRel: rel }, { KHY_SELF_EDIT_ADVISORY: '0' }), null);
    // env 也可经 p.env 传入
    assert.equal(m.buildSelfEditAdvisory({ repoRel: rel, env: { KHY_SELF_EDIT_ADVISORY: 'off' } }), null);
  });

  test('坏输入不抛', () => {
    assert.doesNotThrow(() => m.buildSelfEditAdvisory(undefined, {}));
    assert.doesNotThrow(() => m.buildSelfEditAdvisory({ repoRel: null }, {}));
  });
});
