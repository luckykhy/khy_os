'use strict';

/**
 * Tests for scripts/archDebtScan.js（架构债静态分析器，DESIGN-ARCH-020）。
 *
 * 用合成 fixture 目录树验证三条规则的检出与基线对比，确保确定性、可离线、
 * 不依赖真实代码库状态。纯只读分析，零业务逻辑。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../../scripts/archDebtScan');

let ROOT;

function w(rel, content) {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'archdebt-'));
  // services 层
  w('services/good.js', "const x = require('./helper');\nmodule.exports = {};\n");
  w('services/helper.js', "module.exports = 1;\n");
  // R1 分层倒置：service 反向 require cli
  w('services/bad.js', "const ai = require('../cli/ai');\nmodule.exports = {};\n");
  w('services/deep/nested.js', "const r = require('../../cli/router');\nmodule.exports = {};\n");
  // cli 层（cli→services 合法，不算违规）
  w('cli/ai.js', "const s = require('../services/good');\nmodule.exports = {};\n");
  w('cli/router.js', "module.exports = {};\n");
  // R3 循环依赖：a ⇄ b
  w('services/cycA.js', "require('./cycB');\nmodule.exports = 'a';\n");
  w('services/cycB.js', "require('./cycA');\nmodule.exports = 'b';\n");
  // R2 巨石文件：超阈值
  w('services/giant.js', 'x\n'.repeat(60) + 'module.exports = {};\n');
});

after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('R1 分层倒置 scanLayering', () => {
  test('检出 services→cli 的反向依赖', () => {
    const v = A.scanLayering(ROOT);
    const targets = v.map((x) => x.target).sort();
    assert.deepStrictEqual(targets, ['../../cli/router', '../cli/ai']);
  });

  test('合法 cli→services 不被标记', () => {
    const v = A.scanLayering(ROOT);
    assert.ok(!v.some((x) => x.file.includes('cli/ai.js')));
  });

  test('每条违规带 file/line/target/rule', () => {
    const v = A.scanLayering(ROOT);
    for (const item of v) {
      assert.ok(item.file && typeof item.line === 'number' && item.target);
      assert.strictEqual(item.rule, 'R1-layering');
    }
  });
});

describe('R2 巨石文件 scanGodFiles', () => {
  test('超阈值文件被检出，未超的不被检出', () => {
    const g = A.scanGodFiles(ROOT, 50);
    const files = g.map((x) => x.file);
    assert.ok(files.some((f) => f.endsWith('giant.js')));
    assert.ok(!files.some((f) => f.endsWith('helper.js')));
  });

  test('按行数降序', () => {
    const g = A.scanGodFiles(ROOT, 1);
    for (let i = 1; i < g.length; i++) assert.ok(g[i - 1].loc >= g[i].loc);
  });
});

describe('R3 循环依赖 findCycles/scanCycles', () => {
  test('检出 a⇄b 二元环', () => {
    const cycles = A.scanCycles(ROOT);
    const hit = cycles.find((c) => c.members.some((m) => m.endsWith('cycA.js')));
    assert.ok(hit, '应检出含 cycA 的环');
    assert.ok(hit.members.some((m) => m.endsWith('cycB.js')));
    assert.strictEqual(hit.members.length, 2);
  });

  test('无环的图返回空', () => {
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'archdebt-nocyc-'));
    fs.writeFileSync(path.join(r2, 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(r2, 'b.js'), 'module.exports=1;\n');
    const cycles = A.findCycles(A.buildRequireGraph(r2));
    assert.strictEqual(cycles.length, 0);
    fs.rmSync(r2, { recursive: true, force: true });
  });
});

describe('extractRequires', () => {
  test('提取多种引号与行号', () => {
    const f = path.join(ROOT, 'services/bad.js');
    const reqs = A.extractRequires(f);
    assert.ok(reqs.some((r) => r.spec === '../cli/ai' && r.line === 1));
  });

  test('不存在的文件返回空数组（不抛）', () => {
    assert.deepStrictEqual(A.extractRequires(path.join(ROOT, 'nope.js')), []);
  });
});

describe('基线对比 diffNew/computeNew', () => {
  test('与基线一致 → 无新增', () => {
    const result = A.scanAll(ROOT);
    const baseline = { layering: result.layering, godFiles: result.godFiles, cycles: result.cycles };
    const neu = A.computeNew(result, baseline);
    assert.strictEqual(neu.layering.length, 0);
    assert.strictEqual(neu.godFiles.length, 0);
    assert.strictEqual(neu.cycles.length, 0);
  });

  test('空基线 → 全部视为新增', () => {
    const result = A.scanAll(ROOT);
    const neu = A.computeNew(result, { layering: [], godFiles: [], cycles: [] });
    assert.strictEqual(neu.layering.length, result.layering.length);
  });

  test('指纹忽略行号抖动（同 file+target 不算新增）', () => {
    const cur = [{ file: 'services/bad.js', line: 99, target: '../cli/ai' }];
    const base = { layering: [{ file: 'services/bad.js', line: 1, target: '../cli/ai' }] };
    assert.strictEqual(A.diffNew('layering', cur, base).length, 0);
  });

  test('真实基线文件存在且与当前代码库一致（CI 门禁绿）', () => {
    const result = A.scanAll(); // 真实 src
    const baseline = A.loadBaseline();
    const neu = A.computeNew(result, baseline);
    const total = neu.layering.length + neu.godFiles.length + neu.cycles.length;
    assert.strictEqual(total, 0, '当前代码库不应有超出基线的新增架构债');
  });
});

// ── R4 抽取漂移 scanDriftR4（DESIGN-ARCH-021）─────────────────────────────────
describe('R4 抽取漂移 scanDriftR4', () => {
  let R4;
  before(() => {
    R4 = fs.mkdtempSync(path.join(os.tmpdir(), 'archdebt-r4-'));
    const wr = (rel, c) => {
      const full = path.join(R4, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, c);
    };
    wr('helper.js', 'module.exports = { foo: 1, bar: 1, qux: 1, zap: 1 };\n');
    // 正例 1：三证据齐备，导出键与本地名完全相同（_foo）
    wr('pos_exact.js',
      "const helper = require('./helper');\n" +
      'function _foo(x) { return x; }\n' +
      'function run() { return _foo(1); }\n' +
      'module.exports = { _foo: helper.foo, run };\n');
    // 正例 2：导出键 bar，本地副本是带下划线变体 _bar（f / _f 候选）
    wr('pos_variant.js',
      "const helper = require('./helper');\n" +
      'function _bar(x) { return x; }\n' +
      'function run() { return _bar(2); }\n' +
      'module.exports = { bar: helper.bar, run };\n');
    // 反例 A：re-export 助手符号，但**无本地副本** → 健康，不报
    wr('neg_no_local.js',
      "const helper = require('./helper');\n" +
      'module.exports = { foo: helper.foo };\n');
    // 反例 B：有本地函数且被调用，但导出是**本地简写**（非 helper.member）→ 不报
    wr('neg_shorthand.js',
      "const helper = require('./helper');\n" +
      'function baz(x) { return x; }\n' +
      'function run() { return baz(3); }\n' +
      'module.exports = { baz, run };\n');
    // 反例 C：re-export + 本地副本存在，但本地从**未被内部调用** → 缺第三证据，不报
    wr('neg_not_called.js',
      "const helper = require('./helper');\n" +
      'function qux(x) { return x; }\n' +
      'module.exports = { qux: helper.qux };\n');
    // 反例 D：本地副本「调用」只出现在注释与字符串里 → 经 _blankNonCode 置空，不报
    wr('neg_call_in_string.js',
      "const helper = require('./helper');\n" +
      'function zap(x) { return x; }\n' +
      '// zap(99) inside a comment must not count\n' +
      'function run() { return "zap(1) inside a string"; }\n' +
      'module.exports = { zap: helper.zap, run };\n');
  });
  after(() => { try { fs.rmSync(R4, { recursive: true, force: true }); } catch { /* best effort */ } });

  const find = (drift, file) => drift.filter((d) => d.file.endsWith(file));

  test('三证据齐备：导出键与本地名相同 → 命中', () => {
    const drift = A.scanDriftR4(R4);
    const hits = find(drift, 'pos_exact.js');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].symbol, '_foo');
    assert.strictEqual(hits[0].localImpl, '_foo');
    assert.strictEqual(hits[0].callCount, 1);
    assert.strictEqual(hits[0].rule, 'R4-drift');
    assert.ok(hits[0].reExportVia.startsWith('helper.'));
  });

  test('导出键 f 但本地副本是 _f 变体 → 命中', () => {
    const drift = A.scanDriftR4(R4);
    const hits = find(drift, 'pos_variant.js');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].symbol, 'bar');
    assert.strictEqual(hits[0].localImpl, '_bar');
  });

  test('re-export 但无本地副本 → 不报', () => {
    assert.strictEqual(find(A.scanDriftR4(R4), 'neg_no_local.js').length, 0);
  });

  test('本地简写导出（非 helper.member）→ 不报', () => {
    assert.strictEqual(find(A.scanDriftR4(R4), 'neg_shorthand.js').length, 0);
  });

  test('本地副本从未被内部调用 → 缺第三证据，不报', () => {
    assert.strictEqual(find(A.scanDriftR4(R4), 'neg_not_called.js').length, 0);
  });

  test('调用仅在注释/字符串里 → 经 _blankNonCode 置空，不报', () => {
    assert.strictEqual(find(A.scanDriftR4(R4), 'neg_call_in_string.js').length, 0);
  });

  test('_blankNonCode：注释与字符串置空、代码保留、长度不变', () => {
    const src = 'const a = foo(1); // bar(2)\nconst s = "baz(3)";\n';
    const blanked = A._blankNonCode(src, { blankStrings: true });
    assert.strictEqual(blanked.length, src.length); // 偏移 1:1
    assert.ok(blanked.includes('foo(1)'));          // 真实代码保留
    assert.ok(!blanked.includes('bar(2)'));         // 注释置空
    assert.ok(!blanked.includes('baz(3)'));         // 字符串置空
    // strings:false 时字符串保留（供 require spec 抽取）
    const keep = A._blankNonCode("require('./x'); // c\n", { blankStrings: false });
    assert.ok(keep.includes('./x'));
  });
});

// ── 巨型环切点 analyzeGiantScc（DESIGN-ARCH-021）─────────────────────────────
describe('巨型环切点 analyzeGiantScc', () => {
  test('环内 services→cli 反向边的破环杠杆与贪心顺序', () => {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'archdebt-scc-'));
    const wr = (rel, c) => {
      const full = path.join(R, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, c);
    };
    // 三节点环 x→p→q→x，其中唯一 services→cli 反向边是 q→cli/x
    wr('cli/x.js', "require('../services/p');\nmodule.exports = {};\n");
    wr('services/p.js', "require('./q');\nmodule.exports = {};\n");
    wr('services/q.js', "require('../cli/x');\nmodule.exports = {};\n");

    const scc = A.analyzeGiantScc(R);
    assert.strictEqual(scc.giantSize, 3);
    assert.strictEqual(scc.edgeCount, 1, '仅一条 services→cli 反向边');
    assert.strictEqual(scc.edges[0].from, 'services/q.js');
    assert.strictEqual(scc.edges[0].to, 'cli/x.js');
    assert.strictEqual(scc.edges[0].leverage, 2, '3 节点环 → 移除后最大分量降到 1');
    assert.strictEqual(scc.greedy.length, 1);
    assert.strictEqual(scc.dissolvedAfter, 1, '移除 1 条边即瓦解');
    fs.rmSync(R, { recursive: true, force: true });
  });

  test('无环图 → giantSize<2，无候选边', () => {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'archdebt-scc2-'));
    fs.writeFileSync(path.join(R, 'a.js'), "require('./b');\nmodule.exports={};\n");
    fs.writeFileSync(path.join(R, 'b.js'), 'module.exports=1;\n');
    const scc = A.analyzeGiantScc(R);
    assert.ok(scc.giantSize < 2);
    assert.strictEqual(scc.edges.length, 0);
    assert.strictEqual(scc.greedy.length, 0);
    fs.rmSync(R, { recursive: true, force: true });
  });

  test('findCycles 行为零回归（_sccComponents 重构后仍只返回 size>1 簇）', () => {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'archdebt-scc3-'));
    fs.writeFileSync(path.join(R, 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(R, 'b.js'), "require('./a');\n");
    fs.writeFileSync(path.join(R, 'c.js'), 'module.exports=1;\n'); // 单点不应出现
    const cycles = A.findCycles(A.buildRequireGraph(R));
    assert.strictEqual(cycles.length, 1);
    assert.strictEqual(cycles[0].length, 2);
    // _sccComponents 含单点分量（c），findCycles 已过滤
    const comps = A._sccComponents(A.buildRequireGraph(R));
    assert.ok(comps.some((cmp) => cmp.length === 1), '_sccComponents 应含单点');
    fs.rmSync(R, { recursive: true, force: true });
  });
});
