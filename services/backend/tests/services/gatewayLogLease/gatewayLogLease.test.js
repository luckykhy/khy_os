'use strict';

/**
 * gatewayLogLease.test.js — 「网关日志租界隔离」验收测试（DESIGN-ARCH-031）。
 *
 * 全程零真实网络/进程；用一个捕获型 userSink 断言"用户流(L0)上到底出现了什么"。
 * 覆盖：
 *   - 净味翻译：底层错误→友好句；纯噪音→吞掉；脱敏抹 Token/URL/路径/适配器名。
 *   - 租界四象限：未用适配器零泄漏 / 在用适配器净味可见 / 查网关全量可见 / 沙箱重定向缓冲。
 *   - 端到端（核心验收）：用 A 执行任务时 B 后台报错 → 用户流零泄漏，B 错误下沉 L1。
 *   - 静默沙箱：Token 刷新内部输出绝不上 L0，落 buffer；沙箱内抛错不外泄。
 *   - 后台守卫：guardBackground 吞掉未选中适配器的 rejection，绝不冒泡，下沉 L1。
 *   - 防呆：拦截器 fail-safe 放行普通日志；emit 显式带源优先于嗅探。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const noiseFilter = require('../../../src/services/gatewayLogLease/noiseFilter');
const logLease = require('../../../src/services/gatewayLogLease/logLease');
const devLog = require('../../../src/services/gatewayLogLease/devLog');
const sandbox = require('../../../src/services/gatewayLogLease/sandbox');
const ctxMod = require('../../../src/services/gatewayLogLease/context');

// 捕获 L0 用户流的 sink。
function makeUserSink() {
  const lines = [];
  return { sink: (s) => { lines.push(String(s)); return true; }, lines, joined: () => lines.join('') };
}

let uninstall = null;
let user = null;
beforeEach(() => {
  devLog.clear();
  user = makeUserSink();
  uninstall = sandbox.install({ force: true, userSink: user.sink });
});
afterEach(() => {
  if (uninstall) uninstall();
  uninstall = null;
});

// ── 净味翻译 ──────────────────────────────────────────────────────────

describe('NoiseFilter — 净味翻译', () => {
  test('Token 刷新失败 → 模型服务正在切换', () => {
    assert.equal(noiseFilter.translate('[kiroAdapter] Token refresh failed, falling back...'), '模型服务正在切换…');
  });
  test('本地依赖不完整 → 正在尝试其他方式获取', () => {
    assert.equal(noiseFilter.translate('✗ news(...) 本地依赖不完整'), '正在尝试其他方式获取…');
  });
  test('API 400 → 当前模型响应异常，正在自动修复', () => {
    assert.equal(noiseFilter.translate('API Error: 400 Invalid Request'), '当前模型响应异常，正在自动修复…');
  });
  test('requires puppeteer → 正在降级到轻量模式', () => {
    assert.equal(noiseFilter.translate('this action requires puppeteer'), '正在降级到轻量模式…');
  });
  test('纯 debug 噪音 → 吞掉(null)', () => {
    assert.equal(noiseFilter.translate('[kiro:debug] probe heartbeat ok'), null);
  });
  test('未命中规则也绝不返回机器味原文', () => {
    const out = noiseFilter.translate('zxcv qwer asdf');
    assert.ok(out === null || out === '模型服务处理中…');
  });
  test('sanitize 抹除 Token/URL/路径/适配器名', () => {
    const s = noiseFilter.sanitize('[kiroAdapter] bearer abc123def456 at https://api.x.com/v1 /home/u/.aws/creds');
    assert.doesNotMatch(s, /kiro/i);
    assert.doesNotMatch(s, /bearer abc/i);
    assert.doesNotMatch(s, /https?:\/\//);
    assert.match(s, /\[token\]|\[url\]|\[path\]/);
  });
});

// ── 租界四象限决策 ────────────────────────────────────────────────────

describe('GatewayLogLease.decide — 四象限', () => {
  test('未用该适配器（task 中，源≠活跃）→ 不可见，落 L1', () => {
    ctxMod.runWith({ activeAdapter: 'deepseek', mode: ctxMod.MODES.TASK }, () => {
      const v = logLease.decide({ sourceAdapter: 'kiro', level: 'warn', text: 'Token refresh failed' });
      assert.equal(v.visible, false);
      assert.equal(v.channel, 'L1');
    });
  });
  test('在用该适配器 → 可见(净味后)L0', () => {
    ctxMod.runWith({ activeAdapter: 'kiro', mode: ctxMod.MODES.TASK }, () => {
      const v = logLease.decide({ sourceAdapter: 'kiro', level: 'warn', text: 'API Error: 400' });
      assert.equal(v.visible, true);
      assert.equal(v.channel, 'L0');
      assert.equal(v.output, '当前模型响应异常，正在自动修复…');
    });
  });
  test('查网关状态 → 全量可见，保留适配器名摘要', () => {
    ctxMod.runWith({ mode: ctxMod.MODES.STATUS_QUERY }, () => {
      const v = logLease.decide({ sourceAdapter: 'kiro', level: 'error', text: 'kiro Token 过期' });
      assert.equal(v.visible, true);
      assert.equal(v.channel, 'L0');
      assert.match(v.output, /Token 过期/);
    });
  });
  test('沙箱模式 → 不可见，重定向 BUFFER', () => {
    ctxMod.runWith({ activeAdapter: 'kiro', mode: ctxMod.MODES.SANDBOX, buffer: [] }, () => {
      const v = logLease.decide({ sourceAdapter: 'kiro', level: 'log', text: 'refreshing token' });
      assert.equal(v.visible, false);
      assert.equal(v.channel, 'BUFFER');
    });
  });
  test('无上下文（游离）→ 不可见，落 L1，绝不上主流', () => {
    const v = logLease.decide({ sourceAdapter: 'kiro', level: 'error', text: 'background boom' });
    assert.equal(v.visible, false);
    assert.equal(v.channel, 'L1');
  });
});

// ── 端到端：用 A 执行时 B 后台报错零泄漏 ──────────────────────────────

describe('端到端 — 跨适配器零泄漏', () => {
  test('用 deepseek 执行任务时 kiro 后台 console 报错 → 用户流零泄漏，下沉 L1', async () => {
    await sandbox.runForAdapter('deepseek', async () => {
      // 模拟 kiro 适配器后台在同一异步树里打日志（带源前缀）。
      console.warn('[kiroAdapter] Token refresh failed, falling back to alternate token source');
      console.error('[kiroAdapter] login required');
    });
    // 用户流（L0）绝不出现 kiro 的任何字样。
    assert.doesNotMatch(user.joined(), /kiro/i);
    assert.doesNotMatch(user.joined(), /token refresh/i);
    // 这些被下沉到 L1 开发日志。
    const l1 = devLog.tail().map((r) => r.message).join(' ');
    assert.match(l1, /token|login|切换|凭证|\[token\]/i);
  });

  test('用 kiro 执行任务时 kiro 自身报错 → 净味后可见 L0（不泄漏内幕）', async () => {
    await sandbox.runForAdapter('kiro', async () => {
      console.warn('[kiroAdapter] API Error: 400 Invalid Request');
    });
    assert.match(user.joined(), /响应异常|正在/);
    // 仍不泄漏适配器名/状态码原文。
    assert.doesNotMatch(user.joined(), /kiroAdapter/);
    assert.doesNotMatch(user.joined(), /400 Invalid/);
  });

  test('普通非适配器日志在租界外不被接管（最小爆破半径，原样放行）', () => {
    // _route 返回 false ⇒ 拦截器放手，交回原生 sink（不改写、不下沉、不吞）。
    assert.equal(sandbox._route(null, 'log', 'just a normal app log line'), false);
  });
});

// ── 静默沙箱 ──────────────────────────────────────────────────────────

describe('runSandboxed — Token 刷新静默', () => {
  test('沙箱内输出绝不上 L0，落 buffer', async () => {
    const { result, buffer } = await sandbox.runSandboxed('kiro', async () => {
      console.log('[kiroAdapter] refreshing token...');
      console.warn('[kiroAdapter] using existing token');
      return 'TOKEN_OK';
    });
    assert.equal(result, 'TOKEN_OK');
    assert.equal(user.joined(), '', '沙箱期间用户流必须一片寂静');
    assert.ok(buffer.length >= 2, '内部输出重定向到缓冲');
  });

  test('沙箱内抛错不外泄，返回结构化 error + 摘要下沉 L1', async () => {
    const { result, error } = await sandbox.runSandboxed('kiro', async () => {
      throw new Error('bearer abcdef0123456789abcdef0123456789 refresh exploded');
    });
    assert.equal(result, null);
    assert.ok(error instanceof Error);
    assert.equal(user.joined(), '');
    const l1 = devLog.tail().map((r) => r.message).join(' ');
    assert.doesNotMatch(l1, /abcdef0123456789/, 'L1 摘要也要脱敏 Token');
  });
});

// ── 后台守卫 ──────────────────────────────────────────────────────────

describe('guardBackground — 后台 rejection 不冒泡', () => {
  test('未选中适配器的后台 rejection 被吞，下沉 L1，永不 reject', async () => {
    const r = await sandbox.guardBackground('kiro', async () => {
      throw new Error('[kiroAdapter] Token refresh failed in background');
    });
    assert.equal(r, null);
    const l1 = devLog.tail().map((x) => x.kind);
    assert.ok(l1.includes('background-error'));
  });

  test('installProcessGuards 幂等且可还原（保守安全网）', () => {
    const before = process.listenerCount('unhandledRejection');
    const off1 = sandbox.installProcessGuards();
    const off2 = sandbox.installProcessGuards(); // 幂等：第二次为 no-op
    assert.equal(process.listenerCount('unhandledRejection'), before + 1);
    off2(); // no-op
    off1();
    assert.equal(process.listenerCount('unhandledRejection'), before);
  });

  test('_attributeAdapter：显式字段优先，其次文本嗅探，无关错误返回 null', () => {
    assert.equal(sandbox._attributeAdapter({ adapterId: 'KIRO' }), 'kiro');
    assert.equal(sandbox._attributeAdapter(new Error('[traeAdapter] x')), 'trae');
    assert.equal(sandbox._attributeAdapter(new Error('generic failure')), null);
  });
});

// ── emit 显式带源 ─────────────────────────────────────────────────────

describe('emit — 显式带源优先于嗅探', () => {
  test('在用适配器 emit → 净味 L0', async () => {
    await sandbox.runForAdapter('kiro', async () => {
      sandbox.emit('kiro', 'warn', 'Token refresh failed, falling back');
    });
    assert.match(user.joined(), /切换|正在/);
    assert.doesNotMatch(user.joined(), /token refresh/i);
  });
  test('非活跃适配器 emit → 不泄漏，落 L1', async () => {
    await sandbox.runForAdapter('deepseek', async () => {
      sandbox.emit('kiro', 'error', 'API Error: 500 upstream');
    });
    assert.doesNotMatch(user.joined(), /kiro|500|upstream/i);
    assert.ok(devLog.tail().some((r) => r.adapter === 'kiro'));
  });
});
