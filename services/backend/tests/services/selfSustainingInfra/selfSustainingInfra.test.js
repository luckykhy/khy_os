'use strict';

/**
 * selfSustainingInfra.test.js — 自持基建子系统测试（[DESIGN-ARCH-042]）。
 *
 * 覆盖 §3.1 契约即文档、§3.2 正交隔离影响扫描、§3.3 行为守卫骨架、§3.4 基建缺失淬火，
 * 四条防呆铁律，以及 §4.4 简单模型维护场景（改内部→无下游→拉测试→放行，不理解全局）。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const TMP_HOME = path.join(os.tmpdir(), 'khy-infra-test-' + process.pid);
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const {
  SelfSustainingInfra,
  ContractDocGenerator,
  DependencyImpactScanner,
  AutoTestScaffolder,
  InfraGapQuencher,
  GAP_KIND,
} = require('../../../src/services/selfSustainingInfra');

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

let _b = 0;
function freshBranch() { return `infra_test_${process.pid}_${_b++}`; }

const DOCUMENTED_SRC = `'use strict';
/**
 * 把两数相加。
 * @param {number} a  左加数
 * @param {number} b  右加数
 * @returns {number} 和
 */
function add(a, b) { return a + b; }
module.exports = { add };
`;

const BARE_SRC = `'use strict';
function multiply(x, y) { return x * y; }
module.exports = { multiply };
`;

// ——————————————————————————————————————————————————————————————
// §3.1 契约即文档（ContractDocGenerator）
// ——————————————————————————————————————————————————————————————
test('§3.1 从 JSDoc 契约抽取签名/参数/返回', () => {
  const g = new ContractDocGenerator();
  const { contracts } = g.extractContracts(DOCUMENTED_SRC, 'math.js');
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0].name, 'add');
  assert.equal(contracts[0].params.length, 2);
  assert.equal(contracts[0].params[0].name, 'a');
  assert.equal(contracts[0].returns.type, 'number');
});

test('§3.1 渲染 Markdown 含参数表与返回', () => {
  const g = new ContractDocGenerator();
  const md = g.renderMarkdown([g.extractContracts(DOCUMENTED_SRC, 'math.js')]);
  assert.match(md, /## math\.js/);
  assert.match(md, /\| `a` \| `number` \|/);
  assert.match(md, /\*\*返回\*\* `number`/);
});

test('防呆①：文档生成器标注「请勿手工编辑」杜绝双源', () => {
  const md = new ContractDocGenerator().renderMarkdown([]);
  assert.match(md, /请勿手工编辑/);
  assert.match(md, /代码即唯一真相/);
});

// ——————————————————————————————————————————————————————————————
// §3.2 正交隔离影响扫描（DependencyImpactScanner）
// ——————————————————————————————————————————————————————————————
test('§3.2 反向依赖传递闭包正确', () => {
  const s = new DependencyImpactScanner();
  const fileMap = {
    'a.js': "module.exports = 1;",
    'b.js': "const a = require('./a'); module.exports = a;",
    'c.js': "const b = require('./b'); module.exports = b;",
    'd.js': "module.exports = 9;",
  };
  const graph = s.buildGraph(fileMap);
  const impact = s.impactedBy('a.js', graph);
  assert.equal(impact.hasDownstream, true);
  assert.deepEqual(impact.impacted.map((i) => i.file).sort(), ['b.js', 'c.js']);
  // 深度递增：b 直接(1)，c 间接(2)。
  assert.equal(impact.impacted.find((i) => i.file === 'b.js').depth, 1);
  assert.equal(impact.impacted.find((i) => i.file === 'c.js').depth, 2);
});

test('§3.2 无下游依赖的文件改动影响面为空', () => {
  const s = new DependencyImpactScanner();
  const graph = s.buildGraph({ 'a.js': "require('./b')", 'b.js': '1' });
  assert.equal(s.impactedBy('a.js', graph).hasDownstream, false);
});

// ——————————————————————————————————————————————————————————————
// §3.3 行为守卫骨架（AutoTestScaffolder）
// ——————————————————————————————————————————————————————————————
test('§3.3 解析签名 + 生成边界用例骨架', () => {
  const sc = new AutoTestScaffolder();
  const sigs = sc.parseSignatures(DOCUMENTED_SRC);
  assert.equal(sigs[0].name, 'add');
  const out = sc.scaffold(sigs, { requirePath: './math', moduleName: 'math.js' });
  assert.match(out, /require\('node:test'\)/);
  assert.match(out, /add — 行为快照基线/);
  assert.match(out, /add — 边界: a/);
});

test('§3.3 数值参数走极值边界集', () => {
  const sc = new AutoTestScaffolder();
  const out = sc.scaffold([{ name: 'paginate', params: ['count'] }], { requirePath: './p' });
  assert.match(out, /Number\.MAX_SAFE_INTEGER/);
});

test('§3.3 字符串参数走空串/emoji 边界', () => {
  const sc = new AutoTestScaffolder();
  const cases = sc.boundaryCasesFor('name');
  assert.ok(cases.includes("''"));
  assert.ok(cases.some((c) => c.includes('1F600')));
});

// ——————————————————————————————————————————————————————————————
// §3.4 基建缺失淬火（InfraGapQuencher）
// ——————————————————————————————————————————————————————————————
test('§3.4 裸奔公共函数→missing-contract 裸奔点', () => {
  const q = new InfraGapQuencher();
  const gaps = q.audit(BARE_SRC, 'bare.js');
  assert.ok(gaps.some((g) => g.kind === GAP_KIND.MISSING_CONTRACT && g.symbol === 'multiply'));
});

test('§3.4 已契约函数不报 missing-contract', () => {
  const q = new InfraGapQuencher();
  const gaps = q.audit(DOCUMENTED_SRC, 'math.js');
  assert.equal(gaps.filter((g) => g.kind === GAP_KIND.MISSING_CONTRACT).length, 0);
});

test('防呆②：{any}/{Object} 弱类型契约触发 untyped-any', () => {
  const q = new InfraGapQuencher();
  const src = `/**
 * @param {any} x 任意
 * @returns {Object} 啥
 */
function f(x) { return x; }
module.exports = { f };`;
  const gaps = q.audit(src, 'weak.js');
  assert.ok(gaps.some((g) => g.kind === GAP_KIND.UNTYPED_ANY));
});

test('§3.2 直读全局态触发 implicit-dependency', () => {
  const q = new InfraGapQuencher();
  const gaps = q.audit("const k = process.env.SECRET_KEY; module.exports = { k };", 'imp.js');
  assert.ok(gaps.some((g) => g.kind === GAP_KIND.IMPLICIT_DEPENDENCY));
});

test('§3.4 淬火出 L1 基建自愈需求（复用 evoRequirement，含 targetSymbol）', () => {
  const q = new InfraGapQuencher();
  const req = q.quench({ kind: GAP_KIND.MISSING_CONTRACT, symbol: 'multiply', detail: 'x', file: 'bare.js' });
  assert.equal(req.level, 'L1');
  assert.equal(req.infraGap, true);
  assert.equal(req.targetSymbol, 'multiply');
  assert.equal(req.attribution.surface, 'infra-gap');
});

// ——————————————————————————————————————————————————————————————
// §4 门面编排 + 防呆③/④
// ——————————————————————————————————————————————————————————————
test('门面 generateDocs 从 fileMap 坍缩文档', () => {
  const infra = new SelfSustainingInfra({ branch: freshBranch() });
  const md = infra.generateDocs({ 'math.js': DOCUMENTED_SRC });
  assert.match(md, /### `function add\(a, b\)`/);
});

test('防呆③：commitGate 检出裸奔→阻断提交+淬火落账本', () => {
  const branch = freshBranch();
  const infra = new SelfSustainingInfra({ branch });
  const gate = infra.commitGate({ 'bare.js': BARE_SRC }, { testedSymbols: [] });
  assert.equal(gate.blocked, true);
  assert.ok(gate.requirements.length > 0);
  const pool = infra.pool();
  assert.ok(pool.length > 0);
  assert.equal(pool[0].payload.source, 'self-sustaining-infra');
});

test('防呆③：完备模块（有契约+已测）放行提交', () => {
  const infra = new SelfSustainingInfra({ branch: freshBranch() });
  const gate = infra.commitGate({ 'math.js': DOCUMENTED_SRC }, { testedSymbols: ['add'] });
  assert.equal(gate.blocked, false);
});

test('防呆④：有下游且未评估影响面→禁止重构公共契约', () => {
  const infra = new SelfSustainingInfra({ branch: freshBranch() });
  const fileMap = {
    'core.js': 'module.exports = 1;',
    'user.js': "const c = require('./core'); module.exports = c;",
  };
  const g = infra.guardRefactor('core.js', fileMap, { reviewedImpact: false });
  assert.equal(g.allowed, false);
  assert.equal(g.impact.count, 1);
});

test('防呆④：评估影响面后放行重构', () => {
  const infra = new SelfSustainingInfra({ branch: freshBranch() });
  const fileMap = {
    'core.js': 'module.exports = 1;',
    'user.js': "const c = require('./core'); module.exports = c;",
  };
  assert.equal(infra.guardRefactor('core.js', fileMap, { reviewedImpact: true }).allowed, true);
});

// ——————————————————————————————————————————————————————————————
// §4.4 场景验证：简单模型改内部实现，无需理解全局
// ——————————————————————————————————————————————————————————————
test('场景：改无下游工具内部实现→影响面空→拉边界测试→放行（不理解全局）', () => {
  const infra = new SelfSustainingInfra({ branch: freshBranch() });
  // 一个叶子工具，无任何下游依赖。
  const TOOL = `'use strict';
/**
 * 反转字符串。
 * @param {string} text 输入文本
 * @returns {string} 反转结果
 */
function reverseText(text) { return String(text).split('').reverse().join(''); }
module.exports = { reverseText };`;
  const fileMap = { 'tools/reverse.js': TOOL, 'tools/other.js': 'module.exports = 0;' };

  // 1) 影响面评估：无下游，可安全盲改。
  const guard = infra.guardRefactor('tools/reverse.js', fileMap, { reviewedImpact: true });
  assert.equal(guard.allowed, true);
  assert.equal(guard.impact.hasDownstream, false);

  // 2) 自动拉起边界测试骨架。
  const scaffold = infra.scaffoldTests(TOOL, { requirePath: './reverse', moduleName: 'reverse.js' });
  assert.match(scaffold, /reverseText — 边界: text/);

  // 3) 已契约 + 视为已测 → 提交门禁放行。
  const gate = infra.commitGate(fileMap, { testedSymbols: ['reverseText'] });
  const reverseGaps = gate.gaps.filter((g) => g.file === 'tools/reverse.js'
    && (g.kind === GAP_KIND.MISSING_CONTRACT || g.kind === GAP_KIND.MISSING_TEST));
  assert.equal(reverseGaps.length, 0, '叶子工具契约完备+已测，不应有阻断裸奔');
});

test('账本哈希链完整可校验', () => {
  const branch = freshBranch();
  const infra = new SelfSustainingInfra({ branch });
  infra.commitGate({ 'bare.js': BARE_SRC }, { testedSymbols: [] });
  const v = infra.verifyPool();
  assert.equal(v.ok, true);
});
