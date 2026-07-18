'use strict';

/**
 * evoEngine.test.js — 「需求内源发生器与闭环自愈引擎」验收测试。
 *
 * 覆盖闭环（阻力捕获→归因铸造→代码生成→沙箱验证→热融合）与六条硬边界：
 *   ① 绝不跳过沙箱直接注入宿主（无/伪造凭证一律拒绝）
 *   ② L2 必须出架构对比+爆炸半径，且强制降级 L0 + 3 步验证
 *   ③ 演进引擎绝不修改信任熔断机制与防呆规则（受保护不变量否决）
 *   ④ 连续 2 次沙箱失败 → 强制熔断引擎只读
 *   ⑤ 所有进化历史以不可变哈希链持久化，篡改即被 verify 抓出
 *   + §3.4 同一痛点连续 2 次失败 → 分支熔断 + 架构告警；已载补丁 3 次异常 → 回滚
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = path.join(os.tmpdir(), `khy-evo-test-${process.pid}`);
// evoLedger 经 getProjectDataDir 落盘，后者认 KHY_PROJECT_DATA_HOME（须在 require 前设置，
// 该解析器首调即缓存）——隔离到临时领地，杜绝污染真实 .khy 数据区。
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  SelfBootstrapEngine,
  OrganogenesisSandbox,
  HostPatcher,
  EvoTrustBreaker,
  evoRequirement,
  evoLevels,
  evoLedger,
} = require('../../../src/services/evoEngine');
const sandboxMod = require('../../../src/services/evoEngine/organogenesisSandbox');
const { PainPointScanner } = require('../../../src/services/evoEngine/painPointScanner');

after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

const { SIGNALS } = evoRequirement;

// —— 一个能解析「特殊格式」的健康器官：把 "k=v;k2=v2" 解析成对象。——
const HEALTHY_ORGAN = `
function organ(input) {
  var out = {};
  String(input).split(';').forEach(function (pair) {
    if (!pair) return;
    var i = pair.indexOf('=');
    if (i < 0) return;
    out[pair.slice(0, i)] = pair.slice(i + 1);
  });
  return out;
}`;
const HEALTHY_PROBES = [
  { input: 'a=1;b=2', expected: { a: '1', b: '2' } },
  { input: 'x=hello', expected: { x: 'hello' } },
];

function healthyGenerator() {
  return {
    target: 'parser:kv-semicolon',
    code: HEALTHY_ORGAN,
    entry: 'organ',
    probes: HEALTHY_PROBES,
  };
}

describe('evoLevels — 三级演进格 + L2 防呆②', () => {
  test('escalate 单调取严', () => {
    assert.equal(evoLevels.escalate('L0', 'L2'), 'L2');
    assert.equal(evoLevels.escalate('L1', 'L0'), 'L1');
    assert.equal(evoLevels.escalate('bogus', 'L0'), 'L2'); // 未知 fail-safe 最严
  });
  test('classify 把核心流转关键字判 L2，能力空洞判 L1', () => {
    assert.equal(evoLevels.classify({ why: '压缩算法丢核义' }), 'L2');
    assert.equal(evoLevels.classify({ why: '缺少解析器无法处理新格式', surface: 'new parser' }), 'L1');
    assert.equal(evoLevels.classify({ why: '边缘 case 未覆盖' }), 'L0');
  });
  test('防呆②：L2 缺架构对比/爆炸半径 → invalid；齐备 → 强制降级 L0 + 3 步', () => {
    const bad = evoLevels.planL2({});
    assert.equal(bad.valid, false);
    assert.ok(bad.missing.length >= 2);
    const good = evoLevels.planL2({ architectureDiff: '压缩管线 A→B 重构', blastRadius: '波及所有长链路任务' });
    assert.equal(good.valid, true);
    assert.equal(good.executionLevel, 'L0');       // 强制降级
    assert.equal(good.validationSteps, 3);
  });
});

describe('evoRequirement — 需求铸造', () => {
  test('缺归因 why → 抛（禁止头痛医头）', () => {
    assert.throws(() => evoRequirement.forge({ signal: SIGNALS.TOOL_FAILURE, attribution: {} }), /why/);
  });
  test('同一痛点签名稳定（数字归一）→ 同 ID，支撑熔断计数', () => {
    const a = evoRequirement.forge({ signal: SIGNALS.TOOL_FAILURE, surface: 'parser.js:10', attribution: { why: '缺解析器' } });
    const b = evoRequirement.forge({ signal: SIGNALS.TOOL_FAILURE, surface: 'parser.js:99', attribution: { why: '缺解析器' } });
    assert.equal(a.id, b.id); // 行号差异不分裂签名
  });
  test('L2 需求缺 l2Plan → validate 不合规', () => {
    const req = evoRequirement.forge({ signal: SIGNALS.TOOL_FAILURE, painPoint: '压缩网关缺陷', attribution: { why: '压缩算法系统性缺陷' } });
    assert.equal(req.level, 'L2');
    assert.equal(evoRequirement.validate(req).valid, false);
  });
});

describe('PainPointScanner — 阻力 → 归因 → 需求', () => {
  test('工具失败「无法处理格式」→ 归因缺工具(missing-tool)，级别 L1', () => {
    const scanner = new PainPointScanner();
    const req = scanner.scan({
      signal: SIGNALS.TOOL_FAILURE,
      error: new Error('parser cannot handle this format: unsupported'),
      surface: 'dataParser',
    });
    assert.equal(req.attribution.kind, 'missing-tool');
    assert.equal(req.level, 'L1');
    assert.ok(req.attribution.why.length > 0);
  });
  test('拦截器阻断 → 归因规则误杀(rule-misfire)', () => {
    const scanner = new PainPointScanner();
    const req = scanner.scan({ signal: SIGNALS.INTERCEPTOR_BLOCK, surface: 'guard:editBoundary' });
    assert.equal(req.attribution.kind, 'rule-misfire');
  });
});

describe('OrganogenesisSandbox — 影子执行 + 毒性 + 凭证', () => {
  test('健康器官 → passed + 签发可校验凭证', () => {
    const sb = new OrganogenesisSandbox();
    const v = sb.evaluate({ code: HEALTHY_ORGAN, entry: 'organ', probes: HEALTHY_PROBES });
    assert.equal(v.passed, true);
    assert.equal(v.solved, true);
    assert.ok(v.passToken);
    assert.equal(sandboxMod.verifyToken(v.passToken, HEALTHY_ORGAN, v.verdictDigest), true);
  });
  test('毒性器官（require/process/死循环）→ 静态判毒，无凭证', () => {
    const sb = new OrganogenesisSandbox();
    const toxic = `function organ(i){ var fs = require('fs'); return fs; }`;
    const v = sb.evaluate({ code: toxic, entry: 'organ', probes: [{ input: 'x', expected: 1 }] });
    assert.equal(v.toxic, true);
    assert.equal(v.passed, false);
    assert.equal(v.passToken, null);
    assert.ok(v.toxicity.length > 0);
  });
  test('未解决痛点 → passed=false 无凭证', () => {
    const sb = new OrganogenesisSandbox();
    const wrong = `function organ(i){ return {}; }`;
    const v = sb.evaluate({ code: wrong, entry: 'organ', probes: HEALTHY_PROBES });
    assert.equal(v.solved, false);
    assert.equal(v.passed, false);
    assert.equal(v.passToken, null);
  });
  test('差异校验：相对基线退化 → regressed', () => {
    const sb = new OrganogenesisSandbox();
    const wrong = `function organ(i){ return null; }`;
    const baseline = (i) => { const o = {}; String(i).split(';').forEach((p) => { const k = p.split('='); if (k[0]) o[k[0]] = k[1]; }); return o; };
    const v = sb.evaluate({ code: wrong, entry: 'organ', probes: HEALTHY_PROBES, baseline });
    assert.equal(v.regressed, true);
    assert.equal(v.passed, false);
  });
});

describe('HostPatcher — 三闸门', () => {
  test('防呆①：无凭证热载 → SandboxBypassError', () => {
    const hp = new HostPatcher();
    assert.throws(() => hp.applyPatch({ target: 'organ:x', code: HEALTHY_ORGAN, entry: 'organ', verdict: { passed: true, passToken: null } }), /sandbox|凭证|防呆①/i);
  });
  test('防呆①：伪造凭证 → 校验失败拒绝', () => {
    const hp = new HostPatcher();
    const verdict = { passed: true, passToken: 'deadbeef', codeHash: 'x'.repeat(64), verdictDigest: 'abc' };
    assert.throws(() => hp.applyPatch({ target: 'organ:x', code: HEALTHY_ORGAN, entry: 'organ', verdict }), /校验失败|伪造|防呆①/);
  });
  test('防呆③：热载触碰受保护不变量 → ConstitutionViolation', () => {
    const sb = new OrganogenesisSandbox();
    const v = sb.evaluate({ code: HEALTHY_ORGAN, entry: 'organ', probes: HEALTHY_PROBES });
    const hp = new HostPatcher();
    assert.throws(() => hp.applyPatch({ target: 'evoTrustBreaker:override', code: HEALTHY_ORGAN, entry: 'organ', verdict: v }), /受保护|宪法|防呆③/);
  });
  test('合法凭证 → 热载成功，resolve 可调用', () => {
    const sb = new OrganogenesisSandbox();
    const v = sb.evaluate({ code: HEALTHY_ORGAN, entry: 'organ', probes: HEALTHY_PROBES });
    const hp = new HostPatcher();
    const r = hp.applyPatch({ target: 'parser:kv', code: HEALTHY_ORGAN, entry: 'organ', verdict: v });
    assert.equal(r.ok, true);
    const fn = hp.resolve('parser:kv');
    // vm 上下文产出的对象原型属于沙箱 realm，deepStrictEqual 会因原型不同而误判 → 按值比较。
    assert.equal(JSON.stringify(fn('a=1')), JSON.stringify({ a: '1' }));
  });
  test('回滚卸载新器官', () => {
    const sb = new OrganogenesisSandbox();
    const v = sb.evaluate({ code: HEALTHY_ORGAN, entry: 'organ', probes: HEALTHY_PROBES });
    const hp = new HostPatcher();
    hp.applyPatch({ target: 'parser:roll', code: HEALTHY_ORGAN, entry: 'organ', verdict: v });
    hp.rollback('parser:roll');
    assert.equal(hp.resolve('parser:roll'), null);
  });
});

describe('EvoTrustBreaker — 熔断与回滚', () => {
  test('防呆④：跨痛点连续 2 次沙箱失败 → 引擎只读', () => {
    const br = new EvoTrustBreaker();
    br.recordSandboxResult('p1', false);
    assert.equal(br.isEngineReadOnly(), false);
    br.recordSandboxResult('p2', false);
    assert.equal(br.isEngineReadOnly(), true);
  });
  test('§3.4：同一痛点连续 2 次失败 → 分支熔断 + 架构告警', () => {
    const br = new EvoTrustBreaker();
    let r = br.recordSandboxResult('samePain', false);
    assert.equal(r.branchFused, false);
    r = br.recordSandboxResult('samePain', false);
    assert.equal(r.branchFused, true);
    assert.ok(r.alert && r.alert.kind === 'architectural-alert');
  });
  test('§3.4：已载补丁 3 次异常 → 回滚信号', () => {
    const br = new EvoTrustBreaker();
    assert.equal(br.recordPostLoadOutcome('patchA', true).rollback, false);
    assert.equal(br.recordPostLoadOutcome('patchA', true).rollback, false);
    assert.equal(br.recordPostLoadOutcome('patchA', true).rollback, true);
  });
  test('防呆③：受保护不变量识别', () => {
    assert.equal(EvoTrustBreaker.isProtectedTarget('evoLedger:x'), true);
    assert.equal(EvoTrustBreaker.isProtectedTarget('constraints'), true);
    assert.equal(EvoTrustBreaker.isProtectedTarget('parser:kv'), false);
  });
});

describe('evoLedger — 不可变哈希链（防呆⑤）', () => {
  test('append 链接 + verify 通过', () => {
    const branch = 'ledgertest1';
    evoLedger.append(evoLedger.KIND.REQUIREMENT, { a: 1 }, { branch });
    evoLedger.append(evoLedger.KIND.SANDBOX, { passed: true }, { branch });
    const v = evoLedger.verify({ branch });
    assert.equal(v.ok, true);
    assert.equal(v.length, 2);
  });
  test('防呆⑤：篡改盘上记录 → verify 当场抓出断链位置', () => {
    const branch = 'ledgertest2';
    evoLedger.append(evoLedger.KIND.REQUIREMENT, { a: 1 }, { branch });
    evoLedger.append(evoLedger.KIND.CODE, { b: 2 }, { branch });
    const file = evoLedger._file(branch);
    const chain = JSON.parse(fs.readFileSync(file, 'utf-8'));
    chain[0].payload = { a: 999 }; // 篡改黑历史
    fs.writeFileSync(file, JSON.stringify(chain));
    const v = evoLedger.verify({ branch });
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0);
  });
});

describe('SelfBootstrapEngine — 端到端 L1 演进流（场景验证）', () => {
  test('解析器无法处理特殊格式 → 自举推演→编码→沙箱→热载生效', () => {
    const engine = new SelfBootstrapEngine({ codeGenerator: healthyGenerator, branch: 'e2e-l1' });
    const out = engine.evolve({
      signal: SIGNALS.TOOL_FAILURE,
      error: new Error('parser cannot handle this format: unsupported kv-semicolon'),
      surface: 'dataParser',
    });
    assert.equal(out.status, 'evolved');
    assert.equal(out.requirement.level, 'L1');
    assert.equal(out.verdict.passed, true);
    assert.ok(out.patch.patchId);
    // 热载后器官在演进轨可调用（vm realm 对象按值比较）。
    assert.equal(JSON.stringify(engine.patcher.resolve('parser:kv-semicolon')('a=1;b=2')), JSON.stringify({ a: '1', b: '2' }));
    // 防呆⑤：全生命周期记入不可变日志且链完整。
    assert.equal(engine.verifyLedger().ok, true);
    const kinds = engine.history().map((e) => e.kind);
    assert.ok(kinds.includes('requirement') && kinds.includes('sandbox') && kinds.includes('hotload'));
  });

  test('毒性器官 → 引擎拒绝热载，痛点失败计数累积', () => {
    const toxicGen = () => ({ target: 'parser:bad', code: `function organ(i){ return require('fs'); }`, entry: 'organ', probes: HEALTHY_PROBES });
    const engine = new SelfBootstrapEngine({ codeGenerator: toxicGen, branch: 'e2e-toxic' });
    const out = engine.evolve({ signal: SIGNALS.TOOL_FAILURE, error: new Error('parser cannot handle format: unsupported'), surface: 'p' });
    assert.equal(out.status, 'sandbox-rejected');
    assert.equal(engine.patcher.resolve('parser:bad'), null);
  });

  test('防呆④端到端：同一引擎连续 2 次沙箱失败 → 第 3 次被只读锁拦下', () => {
    const wrongGen = () => ({ target: 'parser:w', code: `function organ(i){ return {}; }`, entry: 'organ', probes: HEALTHY_PROBES });
    const engine = new SelfBootstrapEngine({ codeGenerator: wrongGen, branch: 'e2e-readonly' });
    engine.evolve({ signal: SIGNALS.TOOL_FAILURE, error: new Error('parser unsupported format one'), surface: 'aaa' });
    engine.evolve({ signal: SIGNALS.TOOL_FAILURE, error: new Error('parser unsupported format two'), surface: 'bbb' });
    assert.equal(engine.breaker.isEngineReadOnly(), true);
    const third = engine.evolve({ signal: SIGNALS.TOOL_FAILURE, error: new Error('parser unsupported format three'), surface: 'ccc' });
    assert.equal(third.status, 'engine-readonly');
  });

  test('防呆②端到端：L2 需求缺架构对比 → 在需求闸门被拦死，绝不进入代码生成', () => {
    let generated = false;
    const gen = () => { generated = true; return healthyGenerator(); };
    const engine = new SelfBootstrapEngine({ codeGenerator: gen, branch: 'e2e-l2' });
    const out = engine.evolve({ signal: SIGNALS.TOOL_FAILURE, painPoint: '压缩算法系统性缺陷', error: new Error('压缩网关核心流转缺陷'), surface: 'compressor' });
    assert.equal(out.status, 'requirement-invalid');
    assert.equal(generated, false); // 没走到生成器
  });

  test('回滚端到端：已载补丁 3 次异常 → observePatch 触发卸载', () => {
    const engine = new SelfBootstrapEngine({ codeGenerator: healthyGenerator, branch: 'e2e-rollback' });
    const out = engine.evolve({ signal: SIGNALS.TOOL_FAILURE, error: new Error('parser cannot handle format: unsupported'), surface: 'dp' });
    assert.equal(out.status, 'evolved');
    const { patchId, target } = out.patch;
    engine.observePatch(patchId, target, true);
    engine.observePatch(patchId, target, true);
    const r = engine.observePatch(patchId, target, true);
    assert.equal(r.rollback, true);
    assert.equal(engine.patcher.resolve(target), null);
  });
});
