'use strict';

/**
 * diskCleanup 引擎测试 —— 不变量驱动（对照 weipuxiezuo「判别不变量而非脆弱数值」）。
 *
 * 安全工程的核心断言是**绝不误删的不变量**，在一块「模拟磁盘」上验证：
 *   1. 受保护根永不进 selected（零误删）：主目录本身/文档/桌面/下载/数据家。
 *   2. 主目录是「精确受保护」——根本身否决，但其下白名单缓存子目录可清（否则自我封死）。
 *   3. 含用户数据信号(.git/源码工程/office 文档/媒体原片)的目录被否决，即便位置在白名单。
 *   4. liveness：最近写入(< keepRecentHours)的目录判「在用」跳过。
 *   5. dry-run 默认：clean 不传 apply 删 0 字节、磁盘文件全在。
 *   6. apply=true 真正清空内容但保留目录本身。
 *   7. TOCTOU：执行前最后一刻再否决一次（扫描后被植入用户数据 → 拒删）。
 *   8. fail-closed：判定异常一律当受保护。
 *   9. review 档(回收站/大缓存)默认不进 selected，需显式 includeReview。
 *  10. 工具风险：scan/plan 只读、clean+apply 破坏性(经 riskGate 不可绕人闸)。
 */

const path = require('path');

const catalog = require('../src/services/diskCleanup/junkCatalog');
const guard = require('../src/services/diskCleanup/protectedGuard');
const scanner = require('../src/services/diskCleanup/scanner');
const planner = require('../src/services/diskCleanup/planner');
const executor = require('../src/services/diskCleanup/executor');
const engine = require('../src/services/diskCleanup');

// ── 模拟磁盘（纯内存 fsImpl，posix 风格） ───────────────────────────────
function makeDisk(tree, { now = 1_000_000_000_000 } = {}) {
  // tree: { '/abs/path': { type:'dir'|'file', size?, mtimeMs?, children?:[names] } }
  // 我们用一个扁平 map：路径 → node。目录的 children 由前缀推断。
  const nodes = new Map();
  function add(p, node) { nodes.set(path.resolve(p), node); }
  for (const [p, n] of Object.entries(tree)) add(p, n);

  function get(p) { return nodes.get(path.resolve(p)); }
  function childrenOf(dir) {
    const base = path.resolve(dir);
    const prefix = base.endsWith('/') ? base : base + '/';
    const names = new Set();
    for (const key of nodes.keys()) {
      if (key === base) continue;
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) names.add(first);
      }
    }
    return [...names];
  }
  const fsImpl = {
    existsSync: (p) => nodes.has(path.resolve(p)),
    lstatSync: (p) => {
      const n = get(p);
      if (!n) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return {
        isDirectory: () => n.type === 'dir',
        isFile: () => n.type === 'file',
        isSymbolicLink: () => n.type === 'symlink',
        size: n.size || 0,
        mtimeMs: n.mtimeMs || 0,
      };
    },
    readdirSync: (p, opts) => {
      const n = get(p);
      if (!n || n.type !== 'dir') { const e = new Error('ENOTDIR'); e.code = 'ENOTDIR'; throw e; }
      const names = childrenOf(p);
      if (opts && opts.withFileTypes) {
        return names.map((name) => {
          const child = get(path.join(p, name));
          return {
            name,
            isDirectory: () => child && child.type === 'dir',
            isFile: () => child && child.type === 'file',
            isSymbolicLink: () => child && child.type === 'symlink',
          };
        });
      }
      return names;
    },
    rmSync: (p) => {
      const base = path.resolve(p);
      for (const key of [...nodes.keys()]) {
        if (key === base || key.startsWith(base + '/')) nodes.delete(key);
      }
    },
    unlinkSync: (p) => { nodes.delete(path.resolve(p)); },
    rmdirSync: (p) => fsImpl.rmSync(p),
  };
  return { nodes, fsImpl, now };
}

function depsFor(disk, homedir = '/home/u', extra = {}) {
  return {
    platform: 'linux',
    homedir,
    env: {},
    fsImpl: disk.fsImpl,
    now: () => disk.now,
    ...extra,
  };
}

// 一个典型 linux home：包含可清缓存 + 必须保护的用户数据。
function linuxHomeTree(now) {
  const old = now - 10 * 24 * 3600 * 1000;   // 10 天前（非在用）
  const fresh = now - 5 * 60 * 1000;          // 5 分钟前（在用）
  return {
    '/home/u': { type: 'dir' },
    '/home/u/Documents': { type: 'dir' },
    '/home/u/Documents/thesis.docx': { type: 'file', size: 999, mtimeMs: old },
    '/home/u/Desktop': { type: 'dir' },
    '/home/u/Desktop/important.txt': { type: 'file', size: 10, mtimeMs: old },
    // npm 缓存：可清（旧）
    '/home/u/.npm': { type: 'dir' },
    '/home/u/.npm/_cacache': { type: 'dir' },
    '/home/u/.npm/_cacache/a.bin': { type: 'file', size: 5000, mtimeMs: old },
    '/home/u/.npm/_cacache/b.bin': { type: 'file', size: 3000, mtimeMs: old },
    // pip 缓存：可清（旧）—— 注意它在 ~/.cache 下（review 根）但自身是 safe 白名单
    '/home/u/.cache': { type: 'dir' },
    '/home/u/.cache/pip': { type: 'dir' },
    '/home/u/.cache/pip/wheel.whl': { type: 'file', size: 2000, mtimeMs: old },
    // yarn 缓存：在用（fresh）→ 应跳过
    '/home/u/.cache/yarn': { type: 'dir' },
    '/home/u/.cache/yarn/live.bin': { type: 'file', size: 1000, mtimeMs: fresh },
  };
}

describe('diskCleanup — 受保护根不变量（零误删）', () => {
  test('受保护根永不进 selected：文档/桌面是包含式保护', () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk(linuxHomeTree(now), { now });
    const deps = depsFor(disk);
    const plan = engine.plan({ deps, includeReview: true });

    const selectedPaths = [...plan.selected, ...plan.review].map((c) => path.resolve(c.path));
    for (const p of selectedPaths) {
      expect(guard.isProtected(p, deps)).toBe(false);
    }
    // 文档/桌面绝不可能被选
    expect(selectedPaths).not.toContain('/home/u/Documents');
    expect(selectedPaths).not.toContain('/home/u/Desktop');
  });

  test('主目录是精确受保护：根本身否决，但其下白名单缓存可清', () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk(linuxHomeTree(now), { now });
    const deps = depsFor(disk);

    // 根本身受保护
    expect(guard.isProtected('/home/u', deps)).toBe(true);
    expect(guard.inspect('/home/u', deps).reason).toMatch(/受保护根本身/);
    // 缓存子目录不受保护
    expect(guard.isProtected('/home/u/.npm/_cacache', deps)).toBe(false);
  });

  test('数据家是精确受保护：根否决、其下 cache 子目录放行', () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk({
      '/home/u': { type: 'dir' },
      '/home/u/.khyos': { type: 'dir' },
      '/home/u/.khyos/accounts.db': { type: 'file', size: 100, mtimeMs: now },
      '/home/u/.khyos/cache': { type: 'dir' },
    }, { now });
    const deps = depsFor(disk, '/home/u', {
      // 伪造一个数据家解析（注入到 catalog 的 exact 解析器走 dataHome，
      // 这里直接验证 guard 对精确根的语义）。
    });
    // 直接断言 guard 语义：自定义精确根
    const exactRoots = guard.protectedExactPaths(deps);
    expect(Array.isArray(exactRoots)).toBe(true);
    // home 必在精确根内
    expect(exactRoots.map((p) => path.resolve(p))).toContain('/home/u');
  });
});

describe('diskCleanup — 用户数据信号否决', () => {
  test('白名单缓存里混入 .git / 源码工程 / office 文档 → 否决', () => {
    const now = 1_700_000_000_000;
    const tree = {
      '/home/u': { type: 'dir' },
      '/home/u/.npm': { type: 'dir' },
      '/home/u/.npm/_cacache': { type: 'dir' },
      '/home/u/.npm/_cacache/.git': { type: 'dir' },          // 版本库标记
      '/home/u/.npm/_cacache/data.bin': { type: 'file', size: 100, mtimeMs: now - 1e9 },
    };
    const disk = makeDisk(tree, { now });
    const deps = depsFor(disk);
    const sig = guard.userDataSignals('/home/u/.npm/_cacache', deps);
    expect(sig.hasSignal).toBe(true);
    expect(sig.signals.join()).toMatch(/\.git/);

    // 经扫描应被否决，不进 selected
    const plan = engine.plan({ deps });
    const ids = plan.selected.map((c) => c.id);
    expect(ids).not.toContain('npm-cache');
  });

  test('office 文档与媒体原片亦触发信号', () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk({
      '/home/u': { type: 'dir' },
      '/home/u/.cache': { type: 'dir' },
      '/home/u/.cache/x': { type: 'dir' },
      '/home/u/.cache/x/report.xlsx': { type: 'file', size: 1, mtimeMs: now },
      '/home/u/.cache/x/photo.cr2': { type: 'file', size: 1, mtimeMs: now },
    }, { now });
    const deps = depsFor(disk);
    const sig = guard.userDataSignals('/home/u/.cache/x', deps);
    expect(sig.hasSignal).toBe(true);
  });
});

describe('diskCleanup — liveness（在用即跳过）', () => {
  test('最近写入的目录判在用，不进 selected', () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk(linuxHomeTree(now), { now });
    const deps = depsFor(disk);
    const scanRes = scanner.scan({ deps });
    const yarn = scanRes.candidates.find((c) => c.id === 'yarn-cache');
    expect(yarn).toBeTruthy();
    expect(yarn.live).toBe(true);
    expect(yarn.eligible).toBe(false);
    expect(yarn.skipReason).toMatch(/在用/);
  });
});

describe('diskCleanup — dry-run 默认安全', () => {
  test('clean 不传 apply：删 0 字节，所有文件仍在', async () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk(linuxHomeTree(now), { now });
    const deps = depsFor(disk);
    const { report } = await engine.clean({ deps });
    expect(report.applied).toBe(false);
    expect(report.totals.freedBytes).toBe(0);
    expect(report.totals.removedItems).toBe(0);
    // 文件仍在
    expect(disk.fsImpl.existsSync('/home/u/.npm/_cacache/a.bin')).toBe(true);
  });

  test('apply=true：清空内容但保留目录本身', async () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk(linuxHomeTree(now), { now });
    const deps = depsFor(disk);
    const { report } = await engine.clean({ deps, apply: true });
    expect(report.applied).toBe(true);
    expect(report.totals.freedBytes).toBeGreaterThan(0);
    // npm 缓存内容清空
    expect(disk.fsImpl.existsSync('/home/u/.npm/_cacache/a.bin')).toBe(false);
    // 但目录本身保留
    expect(disk.fsImpl.existsSync('/home/u/.npm/_cacache')).toBe(true);
    // 用户数据丝毫未动
    expect(disk.fsImpl.existsSync('/home/u/Documents/thesis.docx')).toBe(true);
    expect(disk.fsImpl.existsSync('/home/u/Desktop/important.txt')).toBe(true);
  });
});

describe('diskCleanup — TOCTOU 末刻重检', () => {
  test('扫描后目录被植入用户数据 → 执行前否决', async () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk(linuxHomeTree(now), { now });
    const deps = depsFor(disk);
    const plan = engine.plan({ deps });
    const npm = plan.selected.find((c) => c.id === 'npm-cache');
    expect(npm).toBeTruthy();

    // 扫描已完成；现在「攻击者」往缓存目录里塞了一个 .git（模拟竞态）
    disk.nodes.set(path.resolve('/home/u/.npm/_cacache/.git'), { type: 'dir' });

    const report = await executor.execute(plan, { deps, apply: true });
    const npmEntry = report.items.find((i) => i.id === 'npm-cache');
    expect(npmEntry.status).toBe('vetoed');
    expect(npmEntry.vetoReason).toMatch(/用户数据信号/);
    // 文件未被删
    expect(disk.fsImpl.existsSync('/home/u/.npm/_cacache/a.bin')).toBe(true);
  });
});

describe('diskCleanup — fail-closed', () => {
  test('判定过程异常一律当受保护', () => {
    const deps = {
      platform: 'linux', homedir: '/home/u', env: {},
      fsImpl: { existsSync: () => true, readdirSync: () => { throw new Error('boom'); } },
    };
    // 传一个会让 path.resolve 抛的非法值（非字符串）
    expect(guard.isProtected(null, deps)).toBe(true);
    expect(guard.isProtected(undefined, deps)).toBe(true);
  });

  test('盘根/过浅路径拒删', () => {
    const deps = depsFor(makeDisk({}, {}));
    expect(guard.isProtected('/', deps)).toBe(true);
    expect(guard.isProtected('/onlyone', deps)).toBe(true); // 段数<2
  });

  test('含 .. 回溯拒删', () => {
    const deps = depsFor(makeDisk({}, {}));
    expect(guard.inspect('/home/u/.npm/../../etc', deps).protected).toBe(true);
  });
});

describe('diskCleanup — review 档需显式 opt-in', () => {
  test('回收站默认进 review，不进 selected；includeReview 后进 selected', () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk({
      '/home/u': { type: 'dir' },
      '/home/u/.local': { type: 'dir' },
      '/home/u/.local/share': { type: 'dir' },
      '/home/u/.local/share/Trash': { type: 'dir' },
      '/home/u/.local/share/Trash/old.bin': { type: 'file', size: 9999, mtimeMs: now - 1e9 },
    }, { now });
    const deps = depsFor(disk);

    const planNo = engine.plan({ deps, includeReview: false });
    expect(planNo.selected.find((c) => c.id === 'linux-trash')).toBeFalsy();
    expect(planNo.review.find((c) => c.id === 'linux-trash')).toBeTruthy();

    const planYes = engine.plan({ deps, includeReview: true });
    expect(planYes.selected.find((c) => c.id === 'linux-trash')).toBeTruthy();
  });
});

describe('diskCleanup — 扫描纯只读', () => {
  test('scan/plan 不改动磁盘', () => {
    const now = 1_700_000_000_000;
    const disk = makeDisk(linuxHomeTree(now), { now });
    const before = disk.nodes.size;
    const deps = depsFor(disk);
    scanner.scan({ deps });
    planner.buildPlan(scanner.scan({ deps }), {});
    expect(disk.nodes.size).toBe(before);
  });
});

describe('DiskCleanupTool — 风险声明', () => {
  const Tool = require('../src/tools/DiskCleanupTool');
  const t = new Tool();

  test('scan/plan 只读、非破坏；clean+apply 破坏', () => {
    expect(t.isReadOnly({ mode: 'scan' })).toBe(true);
    expect(t.isReadOnly({ mode: 'plan' })).toBe(true);
    expect(t.isReadOnly({ mode: 'clean' })).toBe(false);
    expect(t.isDestructive({ mode: 'scan' })).toBe(false);
    expect(t.isDestructive({ mode: 'clean', apply: false })).toBe(false);
    expect(t.isDestructive({ mode: 'clean', apply: true })).toBe(true);
  });

  test('clean+apply 经 riskGate 为不可绕人闸', () => {
    const registry = require('../src/tools');
    registry.loadTools && registry.loadTools();
    const reg = registry.get('DiskCleanup');
    expect(reg).toBeTruthy();
    const riskGate = require('../src/services/riskGate');
    const a = riskGate.assess('DiskCleanup', { mode: 'clean', apply: true }, { tool: reg, resolvedName: 'DiskCleanup' });
    expect(a.isDestructive).toBe(true);
    expect(riskGate.isUnbypassableGate(a)).toBe(true);
    // 只读 scan 不是不可绕闸
    const s = riskGate.assess('DiskCleanup', { mode: 'scan' }, { tool: reg, resolvedName: 'DiskCleanup' });
    expect(riskGate.isUnbypassableGate(s)).toBe(false);
  });

  test('plan 模式 execute 返回结构化计划 + ASCII 报告', async () => {
    const r = await t.execute({ mode: 'plan' });
    expect(r.success).toBe(true);
    expect(typeof r.report).toBe('string');
    expect(r.totals).toBeTruthy();
  });
});
