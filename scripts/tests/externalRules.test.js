'use strict';

/**
 * scripts/ruleguard/lib/externalRules.js 的规则测试。
 *
 * 这个模块守的是「覆盖率分母只有登记表」这条盲区：一个检查器可以稳稳执行着
 * 登记表里根本不存在的规则，而 rules:coverage 对它完全看不见。测试刻意不只看
 * 真仓库——真仓库的外部 ID 会随登记表补登而减少，那种测试「一改就绿」，
 * 测不出规则逻辑。
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { scanExternalRules, CODE_FAMILIES } = require('../ruleguard/lib/externalRules');

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ext-'));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  return root;
}

const REGISTRY_IDS = new Set(['RUNTIME-001', 'SECURITY-002', 'LAYOUT-001']);

describe('externalRules: 登记表内外的切分', () => {
  test('只声明登记表内 ID 的检查器 → 外部 ID 为空', () => {
    const root = makeFixture({
      'scripts/ci/check-a.js': '/** enforces RUNTIME-001 */\n',
    });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.equal(r.externalIds.length, 0);
    assert.equal(r.checkers[0].checker, 'check-a.js');
    assert.deepEqual(r.checkers[0].registryIds, ['RUNTIME-001']);
  });

  test('登记表外 ID 被按 ID 聚合，并记住来自哪个检查器', () => {
    const root = makeFixture({
      'scripts/ci/check-sec.js': '/** SEC-001 gate */\n',
      'scripts/ci/check-up1.js': '/** UPLOAD-001 gate */\n',
      'scripts/ci/check-up2.js': '/** UPLOAD-001 复核 */\n',
    });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.equal(r.externalIds.length, 2);
    const upload = r.externalIds.find((x) => x.id === 'UPLOAD-001');
    assert.deepEqual(upload.checkers, ['check-up1.js', 'check-up2.js']);
    assert.deepEqual(r.externalIds.find((x) => x.id === 'SEC-001').checkers, ['check-sec.js']);
  });

  test('同形但不同源的 ID 不合并（不同检查器各记各的）', () => {
    const root = makeFixture({
      'scripts/ci/check-a.js': 'AUD-001\n',
      'scripts/ci/check-b.js': 'COM-001\n',
    });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.deepEqual(r.externalIds.map((x) => x.id), ['AUD-001', 'COM-001']);
  });

  test('同一文件里重复出现的 ID 只算一次', () => {
    const root = makeFixture({
      'scripts/ci/check-a.js': 'SEC-001 SEC-001 SEC-001\n',
    });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.equal(r.externalIds.length, 1);
    assert.equal(r.externalIds[0].checkers.length, 1);
  });
});

describe('externalRules: 内部编码族排除', () => {
  test('PTX- 族被排除出外部规则，并在 codeFamilies 里如实报告', () => {
    const root = makeFixture({
      'scripts/ci/check-tax.js': 'PTX-000 PTX-103 SEC-001\n',
    });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.deepEqual(r.externalIds.map((x) => x.id), ['SEC-001']);
    assert.deepEqual(r.codeFamilies, ['PTX-']);
    assert.ok(CODE_FAMILIES.has('PTX-'), '排除名单必须显式声明，不能靠正则侥幸');
  });

  test('编码族排除不影响真规则 ID 的收集', () => {
    const root = makeFixture({
      'scripts/ci/check-tax.js': 'PTX-001 PTX-099 NAM-001\n',
    });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.deepEqual(r.externalIds.map((x) => x.id), ['NAM-001']);
  });
});

describe('externalRules: 扫描范围与健壮性', () => {
  test('只扫 check-*.js，其它脚本不进报告', () => {
    const root = makeFixture({
      'scripts/ci/check-a.js': 'SEC-001\n',
      'scripts/ci/build-something.js': 'AUD-001\n',
      'scripts/ci/utils.js': 'COM-001\n',
    });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.equal(r.externalIds.length, 1);
    assert.equal(r.externalIds[0].id, 'SEC-001');
  });

  test('scripts/ci 目录不存在 → 空结果，不抛栈', () => {
    const root = makeFixture({ 'README.md': '# nothing\n' });
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.deepEqual(r, { checkers: [], externalIds: [], codeFamilies: [] });
  });

  test('无法读取的文件被跳过，不中断整次扫描', () => {
    const root = makeFixture({
      'scripts/ci/check-a.js': 'SEC-001\n',
    });
    // 占位一个名字合法但内容损坏的文件：用同一名字的目录挡住它。
    const dir = path.join(root, 'scripts', 'ci');
    const target = path.join(dir, 'check-b.js');
    fs.mkdirSync(target); // 目录而非文件 → readFileSync 抛 EISDIR
    const r = scanExternalRules(root, REGISTRY_IDS);
    assert.equal(r.externalIds.length, 1);
    assert.equal(r.checkers.length, 1);
  });
});

describe('externalRules: 真仓库冒烟', () => {
  // 防退化：这段报告是新加的，一旦被静默删掉，覆盖率的盲区就又看不见了。
  test('真仓库能扫出外部规则，且 --ci 不因它阻断', () => {
    const registry = require(path.join(ROOT, 'docs/10_规范/registry/RULES-REGISTRY.json'));
    const registryIds = new Set(registry.rules.map((x) => x.id));
    const r = scanExternalRules(ROOT, registryIds);
    assert.ok(r.externalIds.length >= 20, `期望扫出 ≥20 个登记表外规则，实测 ${r.externalIds.length}`);
    // 探针**不钉死具体编号** —— 这个位置已经栽过两次：
    //   ① 探 SEC-001，它在 2026-09-16 被正式登记 → 断言失效；
    //   ② 改探 ARCH-068，紧接着 check-repo-layout.js 的头部注释把设计文档引用
    //      从 [DESIGN-ARCH-068] 换成 [DESIGN-ARCH-117]/[LAY-005] → 再次失效。
    // 编号会随文档演进消失，但「ARCH-* = 检查器头部引用的设计文档编号，结构上
    // 不是登记表条目」这条性质是稳定的。故探**族**而非**号**。
    const archProbe = r.externalIds.find((x) => /^ARCH-\d{3}$/.test(x.id));
    assert.ok(
      archProbe,
      `期望外部规则里至少有一个 ARCH-* 编号，实测：${r.externalIds.map((x) => x.id).join(', ')}`
    );
    // 定义性不变量：外部 ⇔ 不在登记表内。用真登记表复核，防两侧口径漂移。
    assert.ok(
      r.externalIds.every((x) => !registryIds.has(x.id)),
      '外部规则清单不得包含已登记 ID'
    );
    assert.ok(!r.externalIds.some((x) => /^PTX-/.test(x.id)), 'PTX- 族不得混入规则清单');

    const result = cp.spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/ruleguard/index.js'), 'coverage', '--ci',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /覆盖率盲区/);
    // 与库结果**交叉核对**（而非钉死某个编号）：扫描函数与 CLI 是两条独立代码
    // 路径，二者报出的外部规则数必须一致。
    assert.match(
      result.stdout,
      new RegExp(`覆盖率盲区[\\s\\S]*?（${r.externalIds.length} 个 ID`),
      `CLI 盲区计数应与扫描函数一致（${r.externalIds.length}）`
    );
    assert.ok(result.stdout.includes(archProbe.id), `CLI 报告应含探针 ${archProbe.id}`);
  });
});
