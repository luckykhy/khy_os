'use strict';

/**
 * dependencyHealing.test.js — Agent 依赖自愈机制验收测试（DESIGN-ARCH-027）。
 *
 * 全程零网络、零真实进程、零真实文件系统：探针/安装器/交互通道全部注入纯内存桩。
 * 覆盖：
 *   - registry 单一真源（条目/平台覆盖/安装命令均来自表）
 *   - probe 三类探针（node-module / system-command / python-package）
 *   - detectFromError 回溯辨认（既有硬抛与软失败文本零侵入接管）+ 非依赖错误返回 null
 *   - MISSING_DEPENDENCY 错误码 + MissingDependencyError 形状
 *   - toolError 推断：install 文本→MISSING_DEPENDENCY，"File not found"→RESOURCE_NOT_FOUND（零回归）
 *   - 自愈循环四分支：确认→安装→重试成功 / 用户拒绝 / 安装失败 / 无交互通道降级
 *   - 防呆：会话级 attempted 去重防死循环；命令只来自 registry；编排异常 fail-safe
 *   - 安装器：execFile 形态、followUp 串联、manager 缺失如实回报
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../../../src/services/dependency/registry');
const resolver = require('../../../src/services/dependency/resolver');
const installRunner = require('../../../src/services/dependency/installRunner');
const healing = require('../../../src/services/dependency/healingLoop');
const { ToolError, ERROR_CODES } = require('../../../src/services/toolError');

// 纯内存探针环境工厂。
function envWith({ commands = {}, modules = {}, pyPkgs = {}, platform = 'linux' } = {}) {
  return {
    searchExecutable: (bin) => (commands[bin] ? `/usr/bin/${bin}` : null),
    resolveNodeModule: (m) => !!modules[m],
    checkPythonPackage: (p) => !!pyPkgs[p],
    platform,
  };
}

// ── registry 单一真源 ───────────────────────────────────────────────

describe('registry — 单一真源', () => {
  test('暴露已知依赖条目', () => {
    const ids = registry.listDependencyIds();
    assert.ok(ids.includes('puppeteer'));
    assert.ok(ids.includes('ffmpeg'));
    assert.ok(ids.includes('torch'));
    assert.ok(ids.length >= 10);
  });

  test('每条目都有 probe + install + matchers', () => {
    for (const dep of registry.listDependencies()) {
      assert.ok(dep.id, `${dep.id} 有 id`);
      assert.ok(dep.probe && dep.probe.type, `${dep.id} 有 probe.type`);
      assert.ok(dep.install && Array.isArray(dep.install.command), `${dep.id} 安装命令是 argv 数组`);
      assert.ok(Array.isArray(dep.matchers) && dep.matchers.length > 0, `${dep.id} 有 matchers`);
    }
  });

  test('未知依赖返回 null', () => {
    assert.equal(registry.getDependency('nope'), null);
  });
});

// ── probe 三类探针 ──────────────────────────────────────────────────

describe('resolver.probe — 三类探针', () => {
  test('node-module 探针', () => {
    assert.equal(resolver.probe('puppeteer', envWith({ modules: { puppeteer: true } })).present, true);
    assert.equal(resolver.probe('puppeteer', envWith({})).present, false);
  });
  test('system-command 探针', () => {
    assert.equal(resolver.probe('ffmpeg', envWith({ commands: { ffmpeg: true } })).present, true);
    assert.equal(resolver.probe('ffmpeg', envWith({})).present, false);
  });
  test('python-package 探针', () => {
    assert.equal(resolver.probe('torch', envWith({ pyPkgs: { torch: true } })).present, true);
    assert.equal(resolver.probe('torch', envWith({})).present, false);
  });
  test('未知依赖永不抛错，按未就绪处理', () => {
    const p = resolver.probe('does-not-exist', envWith({}));
    assert.equal(p.present, false);
  });
});

// ── detectFromError 回溯辨认 ────────────────────────────────────────

describe('resolver.detectFromError — 既有报错零侵入接管', () => {
  test('软失败 note 文本 → puppeteer', () => {
    const d = resolver.detectFromError({ success: false, note: 'WebBrowser requires puppeteer or playwright. Install with: npm i puppeteer' });
    assert.equal(d && d.depId, 'puppeteer');
  });
  test('硬抛 Error 文本 → ffmpeg', () => {
    const d = resolver.detectFromError(new Error('ffmpeg not found in PATH. Install ffmpeg to enable video analysis.'));
    assert.equal(d && d.depId, 'ffmpeg');
  });
  test('videoAnalyze 软失败结果形状（success:false + status + error 字符串）→ ffmpeg 自愈', () => {
    // 钉死视频分析工具缺 ffmpeg 时返回的真实结果形状能被自愈漏斗（toolCalling 软失败分支）接管。
    const videoResult = {
      success: false,
      status: 'ffmpeg_unavailable',
      error: 'ffmpeg not found in PATH. Install ffmpeg to enable video analysis.',
      meta: { ffmpegAvailable: false },
    };
    assert.equal(resolver.detectFromError(videoResult).depId, 'ffmpeg');
  });
  test('python 硬抛 → torch / python3', () => {
    assert.equal(resolver.detectFromError(new Error('PyTorch not found. Run: pip install torch')).depId, 'torch');
    assert.equal(resolver.detectFromError(new Error('Python3 not found. Install Python 3.10+')).depId, 'python3');
  });
  test('tar / 7z 系统命令硬抛', () => {
    assert.equal(resolver.detectFromError(new Error('tar not found — cannot extract .tar.gz runtime archive')).depId, 'tar');
    assert.equal(resolver.detectFromError(new Error('7z not found — install 7-Zip')).depId, '7zip');
  });
  test('ToolError 结构化结果（error 是对象）也能辨认', () => {
    const sr = { success: false, error: { code: 'EXECUTION_ERROR', message: 'install local OCR: pip install khy-os[doc]' } };
    assert.equal(resolver.detectFromError(sr).depId, 'khy-os-doc-ocr');
  });
  test('MissingDependencyError 直接取 depId（不靠文本）', () => {
    const e = new resolver.MissingDependencyError('playwright', { env: envWith({}) });
    assert.equal(resolver.detectFromError(e).depId, 'playwright');
  });
  test('结构化失败带 depId 标 → 直接取（cheerio）', () => {
    // webSearchService 在确认根因后给失败结果打 depId，detectFromError 应优先据此辨认。
    assert.equal(resolver.detectFromError({ success: false, error: '搜索失败', depId: 'cheerio' }).depId, 'cheerio');
    // 未收录的 depId 标不被盲信 → 回落文本匹配（此处无文本 → null）。
    assert.equal(resolver.detectFromError({ success: false, error: 'x', depId: 'no-such-dep' }), null);
  });
  test('cheerio 中文降级提示 → cheerio（零侵入接管 webSearchService 软失败）', () => {
    const d = resolver.detectFromError({ success: false, error: 'HTML 解析依赖 cheerio 未安装，无 key 搜索引擎已降级。' });
    assert.equal(d && d.depId, 'cheerio');
  });
  test('通用 MODULE_NOT_FOUND 兜底：已收录模块 → 自愈（playwright/cheerio）', () => {
    assert.equal(resolver.detectFromError(new Error("Cannot find module 'playwright'")).depId, 'playwright');
    assert.equal(resolver.detectFromError(new Error("Error: Cannot find module 'cheerio'\n  code: 'MODULE_NOT_FOUND'")).depId, 'cheerio');
    // 子路径归一到顶层包名。
    assert.equal(resolver.detectFromError(new Error("Cannot find module 'cheerio/lib/parse'")).depId, 'cheerio');
  });
  test('安全红线：未收录模块缺失 → null（绝不据报错文本自动安装）', () => {
    assert.equal(resolver.detectFromError(new Error("Cannot find module 'left-pad'")), null);
    assert.equal(resolver.detectFromError(new Error("Cannot find module '@evil/typosquat'")), null);
    // 相对/绝对路径不是包，永不误判为依赖缺失。
    assert.equal(resolver.detectFromError(new Error("Cannot find module '../models'")), null);
    assert.equal(resolver.detectFromError(new Error("Cannot find module '/abs/path'")), null);
  });
  test('_extractMissingModule 归一与拒绝规则', () => {
    const ex = resolver._internal._extractMissingModule;
    assert.equal(ex("Cannot find module 'cheerio'"), 'cheerio');
    assert.equal(ex("Cannot find package '@scope/pkg/sub'"), '@scope/pkg');
    assert.equal(ex("Cannot find module 'foo/bar/baz'"), 'foo');
    assert.equal(ex("Cannot find module '../rel'"), null);
    assert.equal(ex('no module mention here'), null);
  });
  test('非依赖错误 → null（零误伤）', () => {
    assert.equal(resolver.detectFromError(new Error('File not found')), null);
    assert.equal(resolver.detectFromError(new Error('Connection refused')), null);
    assert.equal(resolver.detectFromError(null), null);
  });
});

// ── buildInstallPlan ────────────────────────────────────────────────

describe('resolver.buildInstallPlan — 平台解析，命令只来自 registry', () => {
  test('默认命令', () => {
    const plan = resolver.buildInstallPlan('puppeteer', envWith({}));
    assert.deepEqual(plan.command, ['npm', 'install', 'puppeteer']);
    assert.equal(plan.scope, 'project');
  });
  test('平台覆盖（darwin → brew）', () => {
    assert.equal(resolver.buildInstallPlan('ffmpeg', envWith({ platform: 'darwin' })).displayCommand, 'brew install ffmpeg');
    assert.equal(resolver.buildInstallPlan('ffmpeg', envWith({ platform: 'win32' })).manager, 'os');
  });
  test('返回的是防御性拷贝（改写不污染 registry）', () => {
    const plan = resolver.buildInstallPlan('puppeteer', envWith({}));
    plan.command.push('--evil');
    assert.deepEqual(registry.getDependency('puppeteer').install.command, ['npm', 'install', 'puppeteer']);
  });
});

// ── 错误码 / MissingDependencyError ─────────────────────────────────

describe('MISSING_DEPENDENCY 错误码', () => {
  test('ERROR_CODES 暴露 MISSING_DEPENDENCY', () => {
    assert.equal(ERROR_CODES.MISSING_DEPENDENCY, 'MISSING_DEPENDENCY');
  });
  test('install 文本 → MISSING_DEPENDENCY', () => {
    assert.equal(ToolError.fromGenericError(new Error('Run: pip install torch')).code, 'MISSING_DEPENDENCY');
    assert.equal(ToolError.fromGenericError(new Error('Install with: npm i puppeteer')).code, 'MISSING_DEPENDENCY');
  });
  test('"File not found"(ENOENT) 仍是 RESOURCE_NOT_FOUND（零回归）', () => {
    const e = new Error('File not found'); e.code = 'ENOENT';
    assert.equal(ToolError.fromGenericError(e).code, 'RESOURCE_NOT_FOUND');
  });
  test('MissingDependencyError 形状与结构化结果', () => {
    const e = new resolver.MissingDependencyError('torch', { env: envWith({}) });
    assert.equal(e.name, 'MissingDependencyError');
    assert.equal(e.depId, 'torch');
    assert.equal(e.autoInstallable, true);
    const sr = e.toStructuredResult();
    assert.equal(sr.success, false);
    assert.equal(sr.error.code, 'MISSING_DEPENDENCY');
    assert.match(sr.error.hint, /pip install torch/);
  });
});

// ── 安装器 installRunner ────────────────────────────────────────────

describe('installRunner — 隔离执行（注入桩）', () => {
  test('成功执行主命令', async () => {
    const calls = [];
    const runner = async (argv) => { calls.push(argv); return { ok: true, code: 0, stdout: '', stderr: '' }; };
    const plan = resolver.buildInstallPlan('puppeteer', envWith({}));
    const res = await installRunner.runInstall(plan, { runner });
    assert.equal(res.ok, true);
    assert.deepEqual(calls[0], ['npm', 'install', 'puppeteer']);
  });
  test('followUp 串联（playwright → 装 chromium）', async () => {
    const calls = [];
    const runner = async (argv) => { calls.push(argv.join(' ')); return { ok: true, code: 0 }; };
    const plan = resolver.buildInstallPlan('playwright', envWith({}));
    const res = await installRunner.runInstall(plan, { runner });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /playwright install chromium/);
  });
  test('主命令失败即中止，如实回报', async () => {
    const runner = async () => ({ ok: false, code: 1, stderr: 'boom', error: 'exit-nonzero' });
    const plan = resolver.buildInstallPlan('puppeteer', envWith({}));
    const res = await installRunner.runInstall(plan, { runner });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'exit-nonzero');
  });
  test('无计划 → 不执行', async () => {
    const res = await installRunner.runInstall(null, { runner: async () => ({ ok: true }) });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'no-plan');
  });
});

// ── 自愈循环编排 healingLoop ────────────────────────────────────────

describe('healingLoop.heal — 四分支 + 防呆', () => {
  const failure = { success: false, note: 'requires puppeteer; npm i puppeteer' };

  // probeSeq: 多次 probe 的 present 取值序列（去伪→安装后校验）
  function deps({ probeSeq = [false, true], installOk = true } = {}) {
    let i = 0;
    return {
      resolver: {
        defaultEnv: () => ({}),
        detectFromError: (f) => (f && /puppeteer/i.test(JSON.stringify(f instanceof Error ? f.message : f)) ? { depId: 'puppeteer', dependency: {} } : null),
        probe: () => ({ id: 'puppeteer', present: probeSeq[Math.min(i++, probeSeq.length - 1)] }),
        buildInstallPlan: () => ({ depId: 'puppeteer', label: 'Puppeteer', displayCommand: 'npm install puppeteer', command: ['npm', 'install', 'puppeteer'], scope: 'project', risk: 'medium' }),
      },
      runInstall: async () => ({ ok: installOk, steps: [] }),
    };
  }

  beforeEach(() => {
    for (const s of ['s1', 's2', 's3', 's4', 's5', 's6']) healing.resetSession(s);
  });

  test('分支1：确认 → 安装成功 → 重试成功', async () => {
    const out = await healing.heal({
      toolName: 'WebBrowser', failure, sessionId: 's1',
      control: async () => true,
      retry: async () => ({ success: true, output: 'navigated' }),
      deps: deps({ probeSeq: [false, true] }),
    });
    assert.equal(out.healed, true);
    assert.equal(out.result.success, true);
    assert.equal(out.result.output, 'navigated');
  });

  test('分支2：用户拒绝 → 不安装，给结构化指引', async () => {
    let installCalled = false;
    const d = deps({ probeSeq: [false] });
    d.runInstall = async () => { installCalled = true; return { ok: true }; };
    const out = await healing.heal({
      toolName: 'WebBrowser', failure, sessionId: 's2',
      control: async () => false,
      retry: async () => ({ success: true }),
      deps: d,
    });
    assert.equal(out.healed, false);
    assert.equal(out.declined, true);
    assert.equal(installCalled, false, '拒绝后绝不安装');
    assert.equal(healing.summarizeForAgent(out).status, 'user-declined');
  });

  test('分支3：安装失败 → 干净回报，不重试', async () => {
    let retried = false;
    const out = await healing.heal({
      toolName: 'WebBrowser', failure, sessionId: 's3',
      control: async () => true,
      retry: async () => { retried = true; return { success: true }; },
      deps: deps({ probeSeq: [false, false], installOk: false }),
    });
    assert.equal(out.healed, false);
    assert.equal(out.installFailed, true);
    assert.equal(retried, false, '安装失败不应重试');
  });

  test('分支4：无交互通道 → 优雅降级为指引（绝不静默安装）', async () => {
    let installCalled = false;
    const d = deps({ probeSeq: [false] });
    d.runInstall = async () => { installCalled = true; return { ok: true }; };
    const out = await healing.heal({
      toolName: 'WebBrowser', failure, sessionId: 's4',
      control: null,
      retry: async () => ({ success: true }),
      deps: d,
    });
    assert.equal(out.healed, false);
    assert.equal(out.degraded, true);
    assert.equal(out.reason, 'no-control-channel');
    assert.equal(installCalled, false);
    assert.equal(healing.summarizeForAgent(out).status, 'manual-required');
  });

  test('分支5：用户选「一起讨论」→ 不安装、不标 attempted、交回对话', async () => {
    let installCalled = false;
    const d = deps({ probeSeq: [false] });
    d.runInstall = async () => { installCalled = true; return { ok: true }; };
    const base = {
      toolName: 'WebBrowser', failure, sessionId: 's4',
      control: async () => ({ behavior: 'discuss' }),
      retry: async () => ({ success: true }),
      deps: d,
    };
    const out = await healing.heal(base);
    assert.equal(out.healed, false);
    assert.equal(out.discuss, true);
    assert.equal(installCalled, false, '讨论期间绝不安装');
    assert.equal(healing.summarizeForAgent(out).status, 'discuss-requested');
    // 不标 attempted：讨论后同会话再询问仍可决定安装（不被「已尝试」拦死）
    const d2 = deps({ probeSeq: [false, true] });
    const again = await healing.heal({ ...base, control: async () => true, deps: d2 });
    assert.equal(again.healed, true, '讨论后再次确认应能正常安装并重试');
  });

  test('_decodeDecision 识别 discuss（多种形状）', () => {
    const dec = healing._internal._decodeDecision;
    assert.equal(dec('discuss'), 'discuss');
    assert.equal(dec({ behavior: 'discuss' }), 'discuss');
    assert.equal(dec({ response: { action: 'discuss' } }), 'discuss');
    assert.equal(dec(true), 'install');
    assert.equal(dec('allow-always'), 'always');
    assert.equal(dec(false), 'skip');
  });

  test('防呆：非依赖错误 → null（不接管，原错误透出）', async () => {
    const out = await healing.heal({
      toolName: 'X', failure: new Error('File not found'), sessionId: 's5',
      control: async () => true, retry: async () => ({ success: true }),
      deps: deps({}),
    });
    assert.equal(out, null);
  });

  test('防呆：去伪——再探发现其实已就绪 → null', async () => {
    const out = await healing.heal({
      toolName: 'WebBrowser', failure, sessionId: 's5',
      control: async () => true, retry: async () => ({ success: true }),
      deps: deps({ probeSeq: [true] }),
    });
    assert.equal(out, null);
  });

  test('防呆：会话级 attempted 去重，杜绝死循环', async () => {
    const base = {
      toolName: 'WebBrowser', failure, sessionId: 's6',
      control: async () => true, retry: async () => ({ success: true }),
    };
    await healing.heal({ ...base, deps: deps({ probeSeq: [false, true] }) });
    // 第二次同会话同依赖：仍缺失也不再安装
    const again = await healing.heal({ ...base, deps: deps({ probeSeq: [false, false] }) });
    assert.equal(again.healed, false);
    assert.equal(again.alreadyAttempted, true);
  });

  test('防呆：编排层异常 fail-safe → null（不放大故障）', async () => {
    const out = await healing.heal({
      toolName: 'WebBrowser', failure, sessionId: 's6',
      control: async () => true, retry: async () => ({ success: true }),
      deps: { resolver: { detectFromError: () => { throw new Error('boom'); }, defaultEnv: () => ({}) } },
    });
    assert.equal(out, null);
  });

  test('开关 KHY_DEP_HEALING=off → 不接管', async () => {
    const prev = process.env.KHY_DEP_HEALING;
    process.env.KHY_DEP_HEALING = 'off';
    try {
      const out = await healing.heal({ toolName: 'WebBrowser', failure, sessionId: 's1', control: async () => true, retry: async () => ({ success: true }), deps: deps({}) });
      assert.equal(out, null);
    } finally {
      if (prev === undefined) delete process.env.KHY_DEP_HEALING; else process.env.KHY_DEP_HEALING = prev;
    }
  });

  test('只读底座：env.cwd（重定位安装根）原样流向 runInstall', async () => {
    // 模拟 resolver.defaultEnv 在只读底座下返回的重定位 cwd —— heal 必须把它透传给
    // installRunner，使 npm 装入用户数据家而非只读 bundle（问题 #1 的根因修复）。
    const RELOCATED = '/home/u/.khy/deps';
    let seenCwd = null;
    const d = deps({ probeSeq: [false, true] });
    d.resolver = { ...d.resolver, defaultEnv: () => ({ cwd: RELOCATED, relocated: true, modulePaths: [`${RELOCATED}/node_modules`] }) };
    d.runInstall = async (_plan, opts) => { seenCwd = opts && opts.cwd; return { ok: true, steps: [] }; };
    const out = await healing.heal({
      toolName: 'WebBrowser', failure, sessionId: 's2',
      control: async () => true,
      retry: async () => ({ success: true, output: 'ok' }),
      deps: d,
    });
    assert.equal(out.healed, true);
    assert.equal(seenCwd, RELOCATED, '安装 cwd 必须是重定位后的可写目录');
  });
});
