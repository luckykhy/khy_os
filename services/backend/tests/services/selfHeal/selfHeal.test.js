'use strict';

/**
 * tests/services/selfHeal/selfHeal.test.js — Agent 自愈微循环（DESIGN-ARCH-029）。
 *
 * 覆盖：诊断字典六行 + ErrorDiagnostician 归因 + 处方级死循环熔断 + 受控修复 +
 * MicroLoopExecutor（max_loop=1 / L0 自动 / L1 询问 / L2 跳过）+ FallbackTreeWithHeal
 * 全链（Puppeteer 缺失→尝试安装→失败→降级 WebFetch→403→强制兜底报告）+ 四道防呆。
 *
 * 零网络、零真实安装、零真实 FS：依赖安装器注入纯内存桩，工具 runner 注入假实现。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const selfHeal = require('../../../src/services/selfHeal');
const {
  FallbackTreeWithHeal, ErrorDiagnostician, MicroLoopExecutor,
  PrescriptionDeadLoopDetector, FixActions, diagnosisDictionary, MAX_LOOP, RISK,
} = selfHeal;
const { FixActions: FixActionsClass } = require('../../../src/services/selfHeal/fixActions');
const resilience = require('../../../src/services/resilience');

// ── 诊断字典：六行病因表 ────────────────────────────────────────────

test('字典：ModuleNotFoundError → 依赖缺失 / L1 / install-dependency，抽出包名', () => {
  const dx = diagnosisDictionary.diagnose("ModuleNotFoundError: No module named 'puppeteer'", 'MISSING_DEPENDENCY');
  assert.equal(dx.fixKind, 'install-dependency');
  assert.equal(dx.risk, 'L1');
  assert.equal(dx.needsConfirm, true);
  assert.equal(dx.capture.dep, 'puppeteer');
});

test('字典：ECONNREFUSED 127.0.0.1:9222 → 端口占用 / L1 / probe-port', () => {
  const dx = diagnosisDictionary.diagnose('connect ECONNREFUSED 127.0.0.1:9222', 'ECONNREFUSED');
  assert.equal(dx.fixKind, 'probe-port');
  assert.equal(dx.risk, 'L1');
  assert.equal(dx.capture.hostPort.port, '9222');
});

test('字典：Cannot read properties of null → 格式/参数缺失 / L0 / inject-defaults', () => {
  const dx = diagnosisDictionary.diagnose('TypeError: Cannot read properties of null (reading "x")', '');
  assert.equal(dx.fixKind, 'inject-defaults');
  assert.equal(dx.risk, 'L0');
  assert.equal(dx.needsConfirm, false);
});

test('字典：403 Forbidden → 权限/认证 / L0 / degrade-direct（自动降级）', () => {
  const dx = diagnosisDictionary.diagnose('Request failed: 403 Forbidden', 'HTTP_403');
  assert.equal(dx.fixKind, 'degrade-direct');
  assert.equal(dx.risk, 'L0');
});

test('字典：Command not found: python → 运行时缺失 / L1 / switch-runtime（固定候选）', () => {
  const dx = diagnosisDictionary.diagnose('Command not found: python', '');
  assert.equal(dx.fixKind, 'switch-runtime');
  assert.equal(dx.risk, 'L1');
  assert.deepEqual(dx.capture.candidates, ['python3', 'node']);
});

test('字典：EROFS → 写只读 / L0 / retarget-path', () => {
  const dx = diagnosisDictionary.diagnose('EROFS: read-only file system, open /data/out.txt', 'EROFS', { params: { path: '/data/out.txt' } });
  assert.equal(dx.fixKind, 'retarget-path');
  assert.equal(dx.risk, 'L0');
  assert.equal(dx.capture.path, '/data/out.txt');
});

test('字典防呆③：危险命令优先命中 L2 refuse（绝不被 L0/L1 抢先）', () => {
  const dx = diagnosisDictionary.diagnose('rm -rf / executed by tool', '');
  assert.equal(dx.risk, 'L2');
  assert.equal(dx.fixKind, 'refuse');
});

test('字典：未命中 → null（不臆造处方）', () => {
  assert.equal(diagnosisDictionary.diagnose('some totally unknown gibberish', ''), null);
});

// ── ErrorDiagnostician：三源合一 + fixable 判定 ──────────────────────

test('诊断器：依赖缺失校正为 E05 且 fixable=true', () => {
  const d = new ErrorDiagnostician();
  const dx = d.diagnose(new Error("Cannot find module 'puppeteer'"));
  assert.equal(dx.error_code, 'E05');
  assert.equal(dx.fixable, true);
  assert.equal(dx.missingDependency, 'puppeteer');
});

test('诊断器防呆③：L2 一律 fixable=false（禁止进微循环）', () => {
  const d = new ErrorDiagnostician();
  const dx = d.diagnose(new Error('rm -rf / boom'));
  assert.equal(dx.risk, 'L2');
  assert.equal(dx.fixable, false);
});

test('诊断器：403 → degrade-direct fixable=false（修复=降级本身）', () => {
  const d = new ErrorDiagnostician();
  const dx = d.diagnose({ message: '403 Forbidden', error: { code: 'HTTP_403' } });
  assert.equal(dx.fixable, false);
  assert.equal(dx.fixKind, 'degrade-direct');
});

// ── 处方级死循环熔断器 ──────────────────────────────────────────────

test('死循环：同一条处方第二次开具 → dead=true', () => {
  const det = new PrescriptionDeadLoopDetector();
  const diag = { fixKind: 'install-dependency', capture: { dep: 'puppeteer' } };
  assert.equal(det.check(diag).dead, false);
  det.record(diag);
  assert.equal(det.check(diag).dead, true);
  // 不同依赖 → 不同签名，不判死。
  assert.equal(det.check({ fixKind: 'install-dependency', capture: { dep: 'sharp' } }).dead, false);
});

test('死循环：签名与工具无关（换工具同处方仍熔断）', () => {
  const det = new PrescriptionDeadLoopDetector();
  const sigA = det.signature({ fixKind: 'install-dependency', capture: { dep: 'puppeteer' } });
  const sigB = det.signature({ fixKind: 'install-dependency', capture: { dep: 'puppeteer' } });
  assert.equal(sigA, sigB);
});

// ── 受控修复执行器（防注入：命令只来自字典/注册表/固定候选）──────────

test('FixActions：retarget-path 把写路径改到 /tmp（L0）', async () => {
  const fa = new FixActionsClass();
  const r = await fa.apply({ fixKind: 'retarget-path', capture: { path: '/data/out.txt' } }, { params: { path: '/data/out.txt', body: 'x' } });
  assert.equal(r.ok, true);
  assert.equal(r.params.path, '/tmp/out.txt');
  assert.equal(r.params.body, 'x');
});

test('FixActions：switch-runtime 在固定候选内切换 python→python3', async () => {
  const fa = new FixActionsClass();
  const r = await fa.apply({ fixKind: 'switch-runtime', capture: { command: 'python', candidates: ['python3', 'node'] } }, { params: { command: 'python script.py' } });
  assert.equal(r.ok, true);
  assert.equal(r.params.command, 'python3 script.py');
});

test('FixActions：probe-port 只读探测 → ok=false（不构成修复，转降级）', async () => {
  const fa = new FixActionsClass();
  const r = await fa.apply({ fixKind: 'probe-port', capture: { hostPort: { host: '127.0.0.1', port: '9222' } } }, { params: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'probe-only');
});

test('FixActions：install-dependency 委派注入的安装器（成功→打自愈标记触发有效重试）', async () => {
  const fa = new FixActionsClass({ installer: { async install() { return { ok: true, depId: 'puppeteer' }; } } });
  const r = await fa.apply({ fixKind: 'install-dependency', capture: { dep: 'puppeteer' } }, { params: { url: 'x' } });
  assert.equal(r.ok, true);
  assert.ok(r.params.__khy_self_heal__); // 入参确有变化，满足降级执行器的重试前置
});

// ── MicroLoopExecutor：硬上限 / 分级 / 熔断 ──────────────────────────

test('防呆①：MAX_LOOP 硬编码为 1', () => {
  assert.equal(MAX_LOOP, 1);
  assert.equal(new MicroLoopExecutor().MAX_LOOP, 1);
});

test('微循环：L0 自愈成功 → runOnce 重试通过（auto=true，零询问）', async () => {
  const micro = new MicroLoopExecutor();
  let calls = 0;
  const runTool = async (tool, params) => {
    calls += 1;
    return params.path && params.path.startsWith('/tmp') ? { success: true, wrote: params.path } : { success: false };
  };
  const out = await micro.runOnce({
    toolName: 'WriteFile',
    params: { path: '/data/x.txt' },
    failure: new Error('EROFS: read-only file system, open /data/x.txt'),
    context: { params: { path: '/data/x.txt' } },
    runTool,
  });
  assert.equal(out.ok, true);
  assert.equal(calls, 1); // 恰一次重试
  assert.equal(out.attempted_fixes[0].auto, true);
  assert.equal(out.attempted_fixes[0].result, 'fixed');
});

test('微循环：L1 未获批 → 不修复，降级（attempted 记 declined）', async () => {
  const micro = new MicroLoopExecutor({ confirm: async () => false });
  const out = await micro.runOnce({
    toolName: 'WebBrowser',
    params: { url: 'x' },
    failure: new Error("Cannot find module 'puppeteer'"),
    runTool: async () => ({ success: true }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.degrade, true);
  assert.match(out.attempted_fixes[0].result, /declined/);
});

test('防呆③：L2 错误根本不进微循环（无修复、直接降级、attempted 为空）', async () => {
  const micro = new MicroLoopExecutor({ confirm: async () => true });
  let ran = false;
  const out = await micro.runOnce({
    toolName: 'Bash',
    params: { cmd: 'rm -rf /' },
    failure: new Error('refusing rm -rf / dangerous'),
    runTool: async () => { ran = true; return { success: true }; },
  });
  assert.equal(out.ok, false);
  assert.equal(out.degrade, true);
  assert.equal(ran, false);                 // 没有重试
  assert.equal(out.attempted_fixes.length, 0); // 没有开任何处方
  assert.equal(out.diagnosis.risk, 'L2');
});

test('防呆④：同处方重复 → 第二次判死循环跳过', async () => {
  const det = new PrescriptionDeadLoopDetector();
  const micro = new MicroLoopExecutor({ deadLoop: det, confirm: async () => true,
    fixActions: new FixActionsClass({ installer: { async install() { return { ok: false, reason: 'network' }; } } }) });
  const failure = new Error("Cannot find module 'puppeteer'");
  const first = await micro.heal({ toolName: 'WebBrowser', params: { url: 'a' }, failure });
  assert.equal(first.fixed, false);                       // 安装失败
  assert.match(first.record.result, /failed/);
  const second = await micro.heal({ toolName: 'WebFetch', params: { url: 'a' }, failure });
  assert.equal(second.fixed, false);
  assert.match(second.record.result, /dead-loop/);        // 同处方被熔断
});

// ── FallbackTreeWithHeal：全链（Goal3 验收场景）──────────────────────

test('全链：Puppeteer 缺失→尝试安装→失败→降级 WebFetch→403→强制兜底报告', async () => {
  const seen = [];
  // 假工具 runner：WebBrowser 缺依赖 / WebFetch 403 / WebSearch 无结果。
  const runner = async (tool, params) => {
    seen.push(tool);
    if (tool === 'WebBrowser') return { success: false, error: "Cannot find module 'puppeteer'" };
    if (tool === 'WebFetch') return { success: false, error: '403 Forbidden', status: 403 };
    if (tool === 'WebSearch') return { success: false, error: 'no results' };
    return { success: false, error: 'unknown tool' };
  };
  // 注入"安装必失败"的微循环（确保走到降级与兜底）。
  const micro = new MicroLoopExecutor({
    confirm: async () => true, // 用户批准安装
    fixActions: new FixActionsClass({ installer: { async install() { return { ok: false, reason: 'network-unreachable' }; } } }),
  });
  const heal = new FallbackTreeWithHeal({ runner, microLoop: micro, confirm: async () => true });
  const out = await heal.run('fetch-web-content', { url: 'https://example.com', query: 'khy' });

  // —— Goal3 兜底报告形状（严格）——
  assert.equal(out.status, 'failed');
  assert.ok(out.intent);
  assert.ok(out.diagnosis && out.diagnosis.error_code);
  assert.equal(out.diagnosis.error_code, 'E05');            // 首因=依赖缺失
  assert.ok(Array.isArray(out.attempted_fixes));
  assert.ok('salvage_data' in out);
  assert.ok(out.next_action_suggestion);

  // 安装被尝试且失败被如实记录（先救后报）。
  const install = out.attempted_fixes.find((f) => /安装依赖/.test(f.action));
  assert.ok(install, 'attempted_fixes 必含安装尝试');
  assert.match(install.result, /failed/);
  assert.equal(install.auto, false); // L1 非自动

  // 三个 Plan 都被走过（降级树深度 3）。
  assert.deepEqual(seen, ['WebBrowser', 'WebFetch', 'WebSearch']);
});

test('全链：自愈成功（依赖装好）→ 原 Plan 重试通过，不降级', async () => {
  let installed = false;
  const runner = async (tool) => {
    if (tool === 'WebBrowser') return installed ? { success: true, content: 'hello' } : { success: false, error: "Cannot find module 'puppeteer'" };
    return { success: false, error: 'should-not-reach' };
  };
  const micro = new MicroLoopExecutor({
    confirm: async () => true,
    fixActions: new FixActionsClass({ installer: { async install() { installed = true; return { ok: true, depId: 'puppeteer' }; } } }),
  });
  const heal = new FallbackTreeWithHeal({ runner, microLoop: micro });
  const out = await heal.run('fetch-web-content', { url: 'https://example.com' });
  assert.equal(out.status, 'ok');
  assert.equal(out.plan, 'WebBrowser');
  assert.equal(out.result.content, 'hello');
  assert.equal(out.attempted_fixes[0].result, 'fixed');
});

test('防呆②：处方只来自字典——未知错误无处方，直接兜底不臆造命令', async () => {
  const runner = async () => ({ success: false, error: 'totally-unrecognized-failure-xyz' });
  const heal = new FallbackTreeWithHeal({ runner });
  const out = await heal.run('fetch-web-content', { url: 'x' });
  assert.equal(out.status, 'failed');
  // 无字典命中 → 没有任何"成功修复"记录被臆造。
  assert.ok(!out.attempted_fixes.some((f) => f.result === 'fixed'));
});

test('防呆（降级深度）：resilience 硬上限 3 层被复用（MAX_FALLBACK_DEPTH=3）', () => {
  assert.equal(resilience.MAX_FALLBACK_DEPTH, 3);
  assert.equal(resilience.MAX_RETRY_PER_PLAN, 1);
});
