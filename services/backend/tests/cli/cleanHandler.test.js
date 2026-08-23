'use strict';

/**
 * cleanHandler.test.js — khy clean 的分级清理规划
 *
 * 这些测试盯的都是「删错了不可逆」的那几条边：会话历史不能进任何默认档、
 * 越界路径要被拒、每一项都必须带重建命令、预览与真删的账要对得上。
 * 用注入的 root/dataHome 建临时目录树,绝不碰真实仓库。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const clean = require('../../src/cli/handlers/clean');

/** 真仓库根：cli → tests → backend → services → root，共四层。按服务名解析要用真树。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** 造一棵一次性的假仓库树。返回 { root, dataHome, cleanup }。 */
function fixture(layout = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-clean-'));
  const dataHome = path.join(root, '.khy');
  const write = (rel, bytes) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes, 0x61));
  };
  for (const [rel, bytes] of Object.entries(layout)) {
    write(rel, bytes);
  }
  return { root, dataHome, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('buildCleanPlan — 档位划分', () => {
  test('--runtime 不碰会话存档，只把它报成「保留」', () => {
    const f = fixture({
      '.khy/logs/a.log': 4096,
      '.khy/checkpoints/session-1.json': 8192,
    });
    try {
      const plan = clean.buildCleanPlan({ tiers: ['runtime'], root: f.root, dataHome: f.dataHome });
      const rels = plan.items.map((i) => i.rel);
      expect(rels).toContain('.khy/logs');
      // 这是本命令最重要的一条约束:会话历史不进 --runtime。
      expect(rels).not.toContain('.khy/checkpoints');
      expect(plan.held.map((h) => h.rel)).toEqual(['.khy/checkpoints']);
      expect(plan.held[0].bytes).toBe(8192);
      // 保留的字节不许被算进「预计回收」,否则报出的数字是假的。
      expect(plan.totalBytes).toBe(4096);
    } finally {
      f.cleanup();
    }
  });

  test('显式 --checkpoints 才把会话存档纳入待删', () => {
    const f = fixture({ '.khy/checkpoints/session-1.json': 8192 });
    try {
      const plan = clean.buildCleanPlan({
        tiers: ['runtime'], root: f.root, dataHome: f.dataHome, checkpoints: true,
      });
      expect(plan.items.map((i) => i.rel)).toContain('.khy/checkpoints');
      expect(plan.held).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  test('运行时档是白名单：.khy 下的凭据与配置永远不在射程内', () => {
    const f = fixture({
      '.khy/logs/a.log': 1024,
      '.khy/api_keys.json': 512,
      '.khy/credentials/default-admin.json': 512,
      '.khy/memory/notes.json': 512,
      '.khy/sessions/s.json': 512,
      '.khy/receipts/r.json': 512,
    });
    try {
      const plan = clean.buildCleanPlan({ tiers: ['runtime'], root: f.root, dataHome: f.dataHome });
      const rels = plan.items.map((i) => i.rel);
      for (const keep of ['.khy/api_keys.json', '.khy/credentials', '.khy/memory', '.khy/sessions', '.khy/receipts']) {
        expect(rels).not.toContain(keep);
      }
      expect(rels).toEqual(['.khy/logs']);
    } finally {
      f.cleanup();
    }
  });

  test('--all 解出 build + deps，runtime 要单独点名', () => {
    expect(clean.resolveTiers({ all: true })).toEqual(['build', 'deps']);
    expect(clean.resolveTiers({ all: true, runtime: true })).toEqual(['build', 'deps', 'runtime']);
    expect(clean.resolveTiers({ runtime: true })).toEqual(['runtime']);
    expect(clean.resolveTiers({})).toEqual([]);
  });
});

describe('buildCleanPlan — 目标发现与安全边界', () => {
  test('依赖档靠遍历发现 node_modules 与 .venv，且不下钻嵌套树', () => {
    const f = fixture({
      'node_modules/a/index.js': 1024,
      'node_modules/a/node_modules/b/index.js': 1024,
      'apps/web/node_modules/c/index.js': 2048,
      'tools/x/.venv/pyvenv.cfg': 512,
      'src/keep.js': 100,
    });
    try {
      const plan = clean.buildCleanPlan({ tiers: ['deps'], root: f.root, dataHome: f.dataHome });
      const rels = plan.items.map((i) => i.rel).sort();
      expect(rels).toEqual(['apps/web/node_modules', 'node_modules', 'tools/x/.venv']);
      // 嵌套那棵的字节算在父树里,不能重复计入,否则「回收多少」会虚高。
      const top = plan.items.find((i) => i.rel === 'node_modules');
      expect(top.bytes).toBe(2048);
      expect(top.files).toBe(2);
      expect(plan.totalBytes).toBe(2048 + 2048 + 512);
    } finally {
      f.cleanup();
    }
  });

  test('构建档只收注册在册的产物路径，源码同级不受牵连', () => {
    const f = fixture({
      'packaging/npm/bundled/khy/bundle.mjs': 4096,
      'packaging/npm/package.json': 100,
      'packaging/npm/scripts/assemble.js': 100,
      'apps/ai-frontend/dist/index.js': 2048,
      'apps/ai-frontend/src/main.js': 100,
    });
    try {
      const plan = clean.buildCleanPlan({ tiers: ['build'], root: f.root, dataHome: f.dataHome });
      const rels = plan.items.map((i) => i.rel).sort();
      expect(rels).toEqual(['apps/ai-frontend/dist', 'packaging/npm/bundled']);
    } finally {
      f.cleanup();
    }
  });

  test('dist 下的 whl 与 tar.gz 单独收，同目录里的别的文件不动', () => {
    const f = fixture({
      'dist/khy_os-1.1.10.tar.gz': 4096,
      'dist/khy_os-1.1.10-py3-none-any.whl': 2048,
      'dist/README.txt': 100,
    });
    try {
      const plan = clean.buildCleanPlan({ tiers: ['build'], root: f.root, dataHome: f.dataHome });
      const rels = plan.items.map((i) => i.rel).sort();
      expect(rels).toEqual(['dist/khy_os-1.1.10-py3-none-any.whl', 'dist/khy_os-1.1.10.tar.gz']);
    } finally {
      f.cleanup();
    }
  });

  test('越界路径与仓库根本身都被 _withinRoots 拒掉', () => {
    const root = path.resolve(os.tmpdir(), 'khy-fake-root');
    expect(clean._withinRoots(path.join(root, 'dist'), [root])).toBe(true);
    expect(clean._withinRoots(root, [root])).toBe(false);
    expect(clean._withinRoots(path.resolve(root, '..', 'elsewhere'), [root])).toBe(false);
    // 同前缀但不是子路径:rm -rf 的经典误伤。
    expect(clean._withinRoots(root + '-backup', [root])).toBe(false);
  });

  test('符号链接不清：删链接还是删目标语义不清，就别动', () => {
    const f = fixture({ 'real/dist/x.js': 1024 });
    let linked = false;
    try {
      fs.symlinkSync(path.join(f.root, 'real', 'dist'), path.join(f.root, 'dist'), 'junction');
      linked = true;
    } catch {
      linked = false; // 无权限建链接时跳过断言,不让测试变脆
    }
    try {
      if (linked) {
        expect(clean._measure(path.join(f.root, 'dist'))).toBeNull();
      }
    } finally {
      f.cleanup();
    }
  });
});

describe('可逆性与账目', () => {
  test('每一项都带非空重建命令，一条都不能少', () => {
    const all = [
      ...clean.BUILD_TARGETS,
      ...clean._extensionBuildTargets(),
      ...clean.RUNTIME_TARGETS,
      ...clean.BUILD_GLOBS,
      clean.CHECKPOINT_TARGET,
    ];
    for (const t of all) {
      expect(typeof t.rebuild).toBe('string');
      expect(t.rebuild.trim().length).toBeGreaterThan(0);
    }
  });

  test('会话存档的重建命令如实写明不可恢复，不给虚假安全感', () => {
    expect(clean.CHECKPOINT_TARGET.rebuild).toMatch(/无法重建|永久丢失/);
  });

  test('两处嵌入式构建工具链的依赖树走自己的重建命令', () => {
    // 拓展那一处的路径由服务名解析出来，不在断言里写死拓展 id
    // （[DESIGN-ARCH-069] §1.3 第四条：核里不允许出现拓展 id 的分支）。
    const extRel = clean._markdownWorkbenchRel(REPO_ROOT);
    expect(extRel).toBeTruthy();
    expect(clean._depsRebuild(extRel + '/muya-embed/node_modules'))
      .toBe('node ' + extRel + '/muya-embed/ensure-vendor.mjs');
    expect(clean._depsRebuild('scripts/docs/mermaid-embed/node_modules')).toBe('npm run docs:mermaid');
    expect(clean._depsRebuild('node_modules')).toMatch(/pnpm install/);
    expect(clean._depsRebuild('tools/deepseek-eyes/.venv')).toMatch(/python -m venv/);
  });

  test('markdown 工作台的产物按服务名解析，拓展改名不需要改核代码', () => {
    // 解析结果必须落在 extensions/ 下且带 vendor/ 产物项；解析不到时返回空清单，
    // 而不是退回一个写死的路径 —— 写死的那条才是这条守卫要防的东西。
    const targets = clean._extensionBuildTargets(REPO_ROOT);
    expect(targets).toHaveLength(1);
    expect(targets[0].rel).toMatch(/^extensions\/.+\/vendor$/);
    expect(targets[0].rebuild).toBe('node ' + targets[0].rel.replace(/\/vendor$/, '') + '/muya-embed/ensure-vendor.mjs');
  });

  test('解析不到提供者时拓展清单为空，不伪造路径', () => {
    // 仓库外的 root 会让 path.relative 走出去，等价于「这份不在清理范围内」。
    expect(clean._markdownWorkbenchRel(path.join(REPO_ROOT, 'services'))).toBeNull();
    expect(clean._extensionBuildTargets(path.join(REPO_ROOT, 'services'))).toEqual([]);
    expect(clean._extensionDepsOverrides(path.join(REPO_ROOT, 'services'))).toEqual([]);
  });

  test('executeClean 回收的字节数与计划里报的一致，且真的删掉了', () => {
    const f = fixture({ 'apps/ai-frontend/dist/index.js': 4096, 'src/keep.js': 100 });
    try {
      const plan = clean.buildCleanPlan({ tiers: ['build'], root: f.root, dataHome: f.dataHome });
      expect(plan.totalBytes).toBe(4096);
      const res = clean.executeClean(plan);
      expect(res.ok).toBe(true);
      expect(res.reclaimedBytes).toBe(4096);
      expect(fs.existsSync(path.join(f.root, 'apps', 'ai-frontend', 'dist'))).toBe(false);
      expect(fs.existsSync(path.join(f.root, 'src', 'keep.js'))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test('删不掉的一项不拖垮其余各项，并被如实报为失败', () => {
    const f = fixture({ 'build/a.js': 1024, 'apps/ai-frontend/dist/b.js': 2048 });
    try {
      const plan = clean.buildCleanPlan({ tiers: ['build'], root: f.root, dataHome: f.dataHome });
      const fsImpl = {
        rmSync: (p, o) => {
          if (String(p).endsWith('build')) {
            throw new Error('EBUSY: 文件被占用');
          }
          return fs.rmSync(p, o);
        },
      };
      const res = clean.executeClean(plan, { fsImpl });
      expect(res.ok).toBe(false);
      expect(res.failed).toHaveLength(1);
      expect(res.failed[0].error).toMatch(/EBUSY/);
      expect(res.removed).toHaveLength(1);
      expect(res.reclaimedBytes).toBe(2048);
    } finally {
      f.cleanup();
    }
  });

  test('不存在的注册目标只记 missing，不产生空条目', () => {
    const f = fixture({});
    try {
      const plan = clean.buildCleanPlan({ tiers: ['build', 'runtime'], root: f.root, dataHome: f.dataHome });
      expect(plan.items).toEqual([]);
      expect(plan.missing).toBeGreaterThan(0);
      expect(plan.ok).toBe(false);
      expect(plan.totalBytes).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});

describe('命令注册', () => {
  test('clean 已进 ROUTER_COMMANDS，否则命令彻底不可达', () => {
    const schema = require('../../src/constants/commandSchema');
    expect(schema.getRouterCommandNames()).toContain('clean');
    expect(schema.getRouterSubCommands().clean).toContain('help');
  });
});
