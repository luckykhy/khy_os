'use strict';

/**
 * projectCoherence.test.js — 项目整体意识 + 自驱收尾保障（[DESIGN-ARCH-050]）。
 *
 * 全程内存注入（readFile/knownFiles），不触碰真实磁盘；用一个不存在的伪项目根确保
 * 「磁盘回落」对未声明文件恒为 false，从而可确定性地构造「断链 / 已解析」两种局面。
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const importGraph = require('../../src/services/projectCoherence/importGraph');
const resolver = require('../../src/services/projectCoherence/resolver');
const analyzer = require('../../src/services/projectCoherence/coherenceAnalyzer');
const gate = require('../../src/services/projectCoherence/coherenceGate');
const closure = require('../../src/services/projectCoherence/deliverableClosure');
const facade = require('../../src/services/projectCoherence');

const ROOT = `/khyc_test_${process.pid}`;
const P = (rel) => path.join(ROOT, rel);

/** 构造内存 readFile + files 列表。 */
function mem(map) {
  const abs = {};
  for (const [rel, content] of Object.entries(map)) abs[P(rel)] = content;
  return {
    files: Object.keys(abs),
    readFile: (p) => (Object.prototype.hasOwnProperty.call(abs, p) ? abs[p] : null),
  };
}

// ── importGraph ─────────────────────────────────────────────────────
test('importGraph: ESM imports default/named/namespace + exports', () => {
  const src = `
    import foo from './a';
    import { b, c as d } from './b';
    import * as ns from './c';
    export const X = 1;
    export function doThing() {}
    export default X;
  `;
  const r = importGraph.parseFile('/x/mod.js', src);
  assert.equal(r.lang, 'js');
  const specs = r.imports.map((i) => i.spec).sort();
  assert.deepEqual(specs, ['./a', './b', './c']);
  const bImp = r.imports.find((i) => i.spec === './b');
  assert.ok(bImp.names.includes('b') && bImp.names.includes('c'));
  assert.ok(r.exports.names.has('X') && r.exports.names.has('doThing'));
  assert.equal(r.exports.hasDefault, true);
});

test('importGraph: CJS require + module.exports object', () => {
  const src = `
    const { alpha } = require('./util');
    const whole = require('./whole');
    module.exports = { run, stop };
  `;
  const r = importGraph.parseFile('/x/m.cjs', src);
  assert.ok(r.imports.some((i) => i.spec === './util' && i.names.includes('alpha')));
  assert.ok(r.imports.some((i) => i.spec === './whole' && i.names.includes('default')));
  assert.ok(r.exports.names.has('run') && r.exports.names.has('stop'));
});

test('importGraph: Object.assign export marks dynamic (no false missing-export)', () => {
  const r = importGraph.parseFile('/x/d.js', `Object.assign(module.exports, helpers);`);
  assert.equal(r.exports.dynamic, true);
});

test('importGraph: Python relative from-import parsed; py exports dynamic', () => {
  const r = importGraph.parseFile('/pkg/m.py', `from .util import a, b\nfrom ..core import C\ndef run():\n    pass\n`);
  assert.equal(r.lang, 'py');
  assert.ok(r.imports.some((i) => i.spec === '.util' && i.names.includes('a')));
  assert.ok(r.imports.some((i) => i.spec === '..core'));
  assert.equal(r.exports.dynamic, true);
});

test('importGraph: unknown extension → empty graph', () => {
  const r = importGraph.parseFile('/x/readme.md', `import x from './y'`);
  assert.equal(r.lang, null);
  assert.equal(r.imports.length, 0);
});

// ── resolver ────────────────────────────────────────────────────────
test('resolver: bare specifier is non-local', () => {
  const r = resolver.resolveImport('react', '/x/a.js', 'js', { exists: () => false, isDir: () => false });
  assert.equal(r.local, false);
});

test('resolver: relative resolves against known set (+ index)', () => {
  const io = resolver.makeIoFromSet([P('src/b.js'), P('src/dir/index.js')], false);
  const r1 = resolver.resolveImport('./b', P('src/a.js'), 'js', io);
  assert.equal(r1.local, true);
  assert.equal(r1.resolved, P('src/b.js'));
  const r2 = resolver.resolveImport('./dir', P('src/a.js'), 'js', io);
  assert.equal(r2.resolved, P('src/dir/index.js'));
});

test('resolver: unresolved relative → resolved null', () => {
  const io = resolver.makeIoFromSet([P('src/a.js')], false);
  const r = resolver.resolveImport('./missing', P('src/a.js'), 'js', io);
  assert.equal(r.local, true);
  assert.equal(r.resolved, null);
});

test('resolver: python relative to __init__', () => {
  const io = resolver.makeIoFromSet([P('pkg/util/__init__.py')], false);
  const r = resolver.resolveImport('.util', P('pkg/m.py'), 'py', io);
  assert.equal(r.resolved, P('pkg/util/__init__.py'));
});

// ── analyzer ────────────────────────────────────────────────────────
test('analyzer: unresolved local import → HIGH gap', () => {
  const m = mem({
    'src/index.js': `import { svc } from './service';\n`,
  });
  const res = analyzer.analyze({ cwd: ROOT, files: m.files, readFile: m.readFile, knownFiles: m.files });
  const g = res.gaps.find((x) => x.kind === 'unresolved_import');
  assert.ok(g, 'expected unresolved_import gap');
  assert.equal(g.severity, 'high');
  assert.equal(g.spec, './service');
});

test('analyzer: resolved import with matching export → no gap', () => {
  const m = mem({
    'src/index.js': `import { svc } from './service';\n`,
    'src/service.js': `export const svc = 1;\n`,
  });
  const res = analyzer.analyze({ cwd: ROOT, files: m.files, readFile: m.readFile, knownFiles: m.files });
  assert.equal(res.gaps.length, 0);
});

test('analyzer: resolved but missing named export → MEDIUM gap', () => {
  const m = mem({
    'src/index.js': `import { ghost } from './service';\n`,
    'src/service.js': `export const real = 1;\n`,
  });
  const res = analyzer.analyze({ cwd: ROOT, files: m.files, readFile: m.readFile, knownFiles: m.files });
  const g = res.gaps.find((x) => x.kind === 'missing_export');
  assert.ok(g, 'expected missing_export');
  assert.equal(g.severity, 'medium');
  assert.equal(g.name, 'ghost');
});

test('analyzer: dynamic target exports suppress missing-export false positive', () => {
  const m = mem({
    'src/index.js': `import { anything } from './dyn';\n`,
    'src/dyn.js': `Object.assign(module.exports, require('./gen'));\n`,
  });
  const res = analyzer.analyze({ cwd: ROOT, files: m.files, readFile: m.readFile, knownFiles: m.files });
  assert.equal(res.gaps.filter((x) => x.kind === 'missing_export').length, 0);
});

test('analyzer: broken package.json main → HIGH gap', () => {
  const m = mem({
    'package.json': JSON.stringify({ name: 'p', main: './dist/index.js' }),
  });
  const res = analyzer.analyze({ cwd: ROOT, files: m.files, readFile: m.readFile, knownFiles: m.files });
  const g = res.gaps.find((x) => x.kind === 'broken_manifest');
  assert.ok(g);
  assert.equal(g.field, 'main');
});

test('analyzer: package.json main present → no gap', () => {
  const m = mem({
    'package.json': JSON.stringify({ name: 'p', main: './index.js' }),
    'index.js': `module.exports = {};\n`,
  });
  const res = analyzer.analyze({ cwd: ROOT, files: m.files, readFile: m.readFile, knownFiles: m.files });
  assert.equal(res.gaps.filter((x) => x.kind === 'broken_manifest').length, 0);
});

// ── gate ────────────────────────────────────────────────────────────
test('gate: fewer than minFiles → no gate', () => {
  const d = gate.decide({ gaps: [{ severity: 'high' }], codeFileCount: 1 });
  assert.equal(d.shouldGate, false);
  assert.equal(d.reason, 'too_few_files');
});

test('gate: rounds exhausted → no gate', () => {
  const d = gate.decide({ gaps: [{ severity: 'high' }], codeFileCount: 3, rounds: 2, maxRounds: 2 });
  assert.equal(d.shouldGate, false);
  assert.equal(d.reason, 'rounds_exhausted');
});

test('gate: HIGH gap blocks; MEDIUM only with blockOnMedium', () => {
  const high = gate.decide({ gaps: [{ severity: 'high', detail: 'x' }], codeFileCount: 2 });
  assert.equal(high.shouldGate, true);
  const medOff = gate.decide({ gaps: [{ severity: 'medium', detail: 'y' }], codeFileCount: 2 });
  assert.equal(medOff.shouldGate, false);
  const medOn = gate.decide({ gaps: [{ severity: 'medium', detail: 'y' }], codeFileCount: 2, blockOnMedium: true });
  assert.equal(medOn.shouldGate, true);
});

test('gate: message lists blocking details + round', () => {
  const msg = gate.buildGateMessage([{ severity: 'high', detail: '断链A' }], 1, 2, []);
  assert.match(msg, /断链A/);
  assert.match(msg, /1\/2/);
});

// ── closure (problem 2) ─────────────────────────────────────────────
test('closure: progress-only reply detected', () => {
  assert.equal(closure.looksLikeProgressOnly('让我先查看一下文件结构。'), true);
  assert.equal(closure.looksLikeProgressOnly(''), true);
  assert.equal(closure.looksLikeProgressOnly('已完成：创建了 3 个文件并通过测试。'), false);
});

test('closure: bare acknowledgement is "no deliverable" (只有过程没有总结)', () => {
  // 工具跑完却只回一句纯客套 = 没做总结。
  assert.equal(closure.looksLikeProgressOnly('好的。'), true);
  assert.equal(closure.looksLikeProgressOnly('好的'), true);
  assert.equal(closure.looksLikeProgressOnly('嗯嗯'), true);
  assert.equal(closure.looksLikeProgressOnly('收到，'), true);
  assert.equal(closure.looksLikeProgressOnly('OK'), true);
  // 携带实质信息的简短交付绝不误伤（含结论词）。
  assert.equal(closure.looksLikeProgressOnly('好的，已启动: 夸克'), false);
  assert.equal(closure.looksLikeProgressOnly('桌面上主要有项目、毕业论文和旅游三类文件夹'), false);
});

test('closure: echoOfToolOutput forces closure even without a progress preface', () => {
  // 把工具原文回贴当结果（looksLikeProgressOnly 抓不到的实质内容）→ 仍强制收尾。
  assert.equal(closure.shouldForceClosure({
    reply: 'KHY-Documents\n项目\n毕业论文', totalToolCalls: 1, pendingToolCalls: 0, echoOfToolOutput: true,
  }), true);
  // 一次性同样生效。
  assert.equal(closure.shouldForceClosure({
    reply: 'KHY-Documents', totalToolCalls: 1, pendingToolCalls: 0, echoOfToolOutput: true, used: true,
  }), false);
});

test('closure: force only when work done + no deliverable, once', () => {
  assert.equal(closure.shouldForceClosure({ reply: '让我看看', totalToolCalls: 2, pendingToolCalls: 0 }), true);
  // 没干活 → 不强制
  assert.equal(closure.shouldForceClosure({ reply: '让我看看', totalToolCalls: 0, pendingToolCalls: 0 }), false);
  // 已用过 → 不再触发
  assert.equal(closure.shouldForceClosure({ reply: '让我看看', totalToolCalls: 2, pendingToolCalls: 0, used: true }), false);
  // 还有待执行工具 → 不是收尾时刻
  assert.equal(closure.shouldForceClosure({ reply: '让我看看', totalToolCalls: 2, pendingToolCalls: 1 }), false);
  // 实质结论 → 放过
  assert.equal(closure.shouldForceClosure({ reply: '已完成并验证，结果如下：...', totalToolCalls: 2, pendingToolCalls: 0 }), false);
});

// ── kickoff (problem 3: 计划前言却不开工) ─────────────────────────────
test('kickoff: force only when nothing started + planning preamble, once', () => {
  // 啥都没做（totalToolCalls:0）+ 只回计划前言 → 强制启动
  assert.equal(closure.shouldForceKickoff({ reply: '我先看看桌面有哪些文件', totalToolCalls: 0, pendingToolCalls: 0 }), true);
  // 已经开过工（totalToolCalls>0）→ 交给 closure 守卫，不抢
  assert.equal(closure.shouldForceKickoff({ reply: '我先看看桌面有哪些文件', totalToolCalls: 2, pendingToolCalls: 0 }), false);
  // 模型其实要调工具（pendingToolCalls>0）→ 不是干瞪眼
  assert.equal(closure.shouldForceKickoff({ reply: '我先看看桌面有哪些文件', totalToolCalls: 0, pendingToolCalls: 1 }), false);
  // 已用过 → 一次性
  assert.equal(closure.shouldForceKickoff({ reply: '我先看看桌面有哪些文件', totalToolCalls: 0, pendingToolCalls: 0, used: true }), false);
  // 带结论词（已经给了结果）→ 放过
  assert.equal(closure.shouldForceKickoff({ reply: '已完成：桌面上有 3 个文件。', totalToolCalls: 0, pendingToolCalls: 0 }), false);
});

test('kickoff: buildKickoffMessage includes the original request and demands action', () => {
  const msg = closure.buildKickoffMessage('整理一下我的桌面');
  assert.match(msg, /整理一下我的桌面/);
  assert.match(msg, /立即开始执行第一步|现在就/);
});

// ── 时态判别 (真根因: CONCLUSION_RE 把计划里的未来时「验证/完成/成功」误判为已交付) ──────
const PLAN_TEXT = [
  '好的，我来把 opencode-dev 这个项目做成可运行的软件。下面是完整的交付计划：',
  '1. 首先解压项目压缩包到工作目录，检查目录结构与 package.json 是否完整。',
  '2. 然后安装依赖：如果是 Node 项目就运行 npm install。',
  '3. 接着根据 README 确定构建命令，执行构建并处理编译错误。',
  '4. 之后运行项目自带的测试套件，确认核心功能通过。',
  '5. 再配置环境变量，尝试本地启动服务并做冒烟验证。',
  '6. 最后整理产物、输出运行说明，确保交付物真正可运行。',
].join('\n');

test('tense: 未来时多步计划(含「验证/完成/成功」)被判为 progress-only', () => {
  // 旧行为: CONCLUSION_RE 命中「验证/完成」→ false(误判已交付)。修后: 时态判别先判为未执行。
  assert.equal(closure._looksLikeUnexecutedPlan(PLAN_TEXT), true);
  assert.equal(closure.looksLikeProgressOnly(PLAN_TEXT), true);
  // 既有自驱 nudge 因此触发(allowAfterWork 覆盖「干了一半又回计划」)。
  assert.equal(closure.shouldForceKickoff({
    reply: PLAN_TEXT, totalToolCalls: 0, pendingToolCalls: 0, allowAfterWork: true,
  }), true);
});

test('tense: 零误伤真交付(完成标记 / 含编号的产物清单 / 短交付)', () => {
  // 有 perfective 完成标记 → 不当未执行计划。
  assert.equal(closure._looksLikeUnexecutedPlan('已完成交付。产物：\n1. dist/index.js\n2. README.md\n验证通过。'), false);
  assert.equal(closure.looksLikeProgressOnly('已完成交付。产物：\n1. dist/index.js\n2. README.md\n验证通过。'), false);
  // 枚举「结果报告」(测试通过/构建成功=完成标记)不误判为计划。
  assert.equal(closure.looksLikeProgressOnly('结果如下：\n1. 单测 42/42 通过\n2. 构建成功\n3. 冒烟验证无误'), false);
  // 短交付、裸完成句、单步陈述 —— 全部放过(非多步枚举计划)。
  assert.equal(closure.looksLikeProgressOnly('好的，已启动: 夸克'), false);
  assert.equal(closure.looksLikeProgressOnly('验证通过，服务已在 3000 端口运行。'), false);
  assert.equal(closure.looksLikeProgressOnly('任务完成。'), false);
});

test('tense: 门控 KHY_PLAN_KICKOFF_TENSE 关 → 字节回退今日行为', () => {
  const prev = process.env.KHY_PLAN_KICKOFF_TENSE;
  try {
    process.env.KHY_PLAN_KICKOFF_TENSE = 'off';
    // 关闭后: CONCLUSION_RE 命中计划里的「验证/完成」→ 回退为 false(今日的「误判已交付」行为)。
    assert.equal(closure._planKickoffTenseEnabled(), false);
    assert.equal(closure.looksLikeProgressOnly(PLAN_TEXT), false);
  } finally {
    if (prev === undefined) delete process.env.KHY_PLAN_KICKOFF_TENSE;
    else process.env.KHY_PLAN_KICKOFF_TENSE = prev;
  }
});

// ── 半截话 (用户原话「也不要总是半截话我推了动一下否则直接不动」) ─────────────
test('kickoff: embedded/trailing 半截话 preamble is detected, not just leading', () => {
  // 真实卡壳：计划小句嵌在句中、不从首字符起头 → 旧起锚匹配漏掉 → 卡死
  assert.equal(closure.looksLikeProgressOnly('文件已经在桌面上了，让我用图像识别功能查看内容'), true);
  // 尾部「接下来我来修复」收尾、全文无结论词 → 半截话
  assert.equal(closure.looksLikeProgressOnly('这是初步分析：A、B、C，接下来我来定位根因'), true);
  // 含结论词（已修复）→ 即便有「我来」也算已交付，放过
  assert.equal(closure.looksLikeProgressOnly('已修复并验证，最后我来补一句说明'), false);
});

test('kickoff: allowAfterWork covers the 干了一半又回前言 续作 gap', () => {
  // 默认（不传 allowAfterWork）：干过活就让位给 closure 守卫
  assert.equal(closure.shouldForceKickoff({ reply: '让我继续看看剩下的文件', totalToolCalls: 3, pendingToolCalls: 0 }), false);
  // allowAfterWork:true → 干了一半又回前言也续推（治反复手敲「继续」）
  assert.equal(closure.shouldForceKickoff({ reply: '让我继续看看剩下的文件', totalToolCalls: 3, pendingToolCalls: 0, allowAfterWork: true }), true);
  // allowAfterWork 不绕过其它让位：还有待执行工具 → 仍不介入
  assert.equal(closure.shouldForceKickoff({ reply: '让我继续看看剩下的文件', totalToolCalls: 3, pendingToolCalls: 2, allowAfterWork: true }), false);
  // allowAfterWork 不绕过结论判定：已交付 → 放过
  assert.equal(closure.shouldForceKickoff({ reply: '已完成：剩余文件已全部处理。', totalToolCalls: 3, pendingToolCalls: 0, allowAfterWork: true }), false);
});

// ── façade ──────────────────────────────────────────────────────────
test('façade: evaluateCoherenceGate end-to-end gates on unresolved import', () => {
  const m = mem({
    'src/a.js': `import './b';\n`,
    'src/c.js': `export const v = 1;\n`,
  });
  const r = facade.evaluateCoherenceGate({
    files: m.files, cwd: ROOT, readFile: m.readFile, knownFiles: m.files, rounds: 0, maxRounds: 2,
  });
  assert.equal(r.shouldGate, true);
  assert.match(r.message, /b/);
});

test('façade: coherent project does not gate', () => {
  const m = mem({
    'src/a.js': `import { v } from './b';\n`,
    'src/b.js': `export const v = 1;\n`,
  });
  const r = facade.evaluateCoherenceGate({
    files: m.files, cwd: ROOT, readFile: m.readFile, knownFiles: m.files,
  });
  assert.equal(r.shouldGate, false);
});

test('façade: evaluateClosure returns message when forcing', () => {
  const r = facade.evaluateClosure({ reply: '我先检查一下', totalToolCalls: 3, pendingToolCalls: 0, userMessage: '做个网站' });
  assert.equal(r.shouldForce, true);
  assert.match(r.message, /最终结果|结果/);
});

test('façade: evaluateKickoff returns message when nothing started', () => {
  const r = facade.evaluateKickoff({ reply: '我先看看桌面有什么', totalToolCalls: 0, pendingToolCalls: 0, userMessage: '打开我的桌面' });
  assert.equal(r.shouldForce, true);
  assert.match(r.message, /打开我的桌面/);
  // 已开工的场景不抢（交给 closure 守卫）
  const r2 = facade.evaluateKickoff({ reply: '我先看看桌面有什么', totalToolCalls: 2, pendingToolCalls: 0 });
  assert.equal(r2.shouldForce, false);
});

test('façade: analyze fail-safe never throws on garbage', () => {
  const r = facade.analyzeProjectCoherence({ files: [null, 123], cwd: ROOT, readFile: () => { throw new Error('boom'); } });
  assert.ok(Array.isArray(r.gaps));
});
