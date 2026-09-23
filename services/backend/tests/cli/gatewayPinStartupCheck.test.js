'use strict';

/**
 * gatewayPinStartupCheck.test.js — [DESIGN-ARCH-136] §9.5 的验收用例。
 *
 * 背景实测：env-gateway-pin 的 error 判据早已在 baseSelfCheckService._checkGatewayPreferred，
 * 但 (a) 经典 REPL 里 runOnce 结果只写日志；(b) TUI 在 `await startInkApp` 早返回，
 * 经典模式的自检块从未到达。修复 = baseSelfCheckService 导出轻量单检
 * `checkGatewayPreferredOnce`（判据 100% 复用，零新增 env / 零新告警文案体系），
 * replSession 在 TUI 分叉之前与经典 REPL 自检块各注入一次**非阻断**预检。
 *
 * 三条核心断言（用户验收口径）：
 *   ① 启动时自检确实被触发（G-05，源码级：TUI 调用点位于 startInkApp 之前）
 *   ② api+true 组合报出钉选 error（G-02，行为级：真跑 checkGatewayPreferredOnce）
 *   ③ 解钉路径对用户可见（G-03 行为级 + G-07 源码级）
 *
 * ⚠️ 必须用 `require('node:test')`（同 cliFailureEnvelopeZeroAttempt.test.js 的理由：
 * jest.config.js 按标记自动忽略；`test:node` 全量 glob 会跑本文件 ⇒ 落地即须绿）。
 * ⚠️ 本文件**绝不**触发 autoRepair 的写盘分支：涉及「未注册」场景的用例一律显式传
 * `{ autoRepairPreferred: false }` —— 真实默认语义（含 autoRepair）由 G-02 的
 * unavailable 场景覆盖（该分支本身不写 env）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { checkGatewayPreferredOnce } = require('../../src/services/baseSelfCheckService');
const gateway = require('../../src/services/gateway/aiGateway');

const SRC = path.join(__dirname, '..', '..', 'src', 'cli', 'replSession.js');
const readReplSession = () => fs.readFileSync(SRC, 'utf8');

/** 打补丁：跳过 gateway.init（重），并把 getStatus 换成确定形状。用完必须调 dispose。 */
function stubGatewayStatus(statuses) {
  const origGet = gateway.getStatus;
  const origInit = gateway.isInitialized;
  gateway.isInitialized = () => true;
  gateway.getStatus = () => statuses;
  return () => {
    gateway.getStatus = origGet;
    gateway.isInitialized = origInit;
  };
}

function withEnv(adapter, strict, fn) {
  const prevA = process.env.GATEWAY_PREFERRED_ADAPTER;
  const prevS = process.env.GATEWAY_PREFERRED_STRICT;
  process.env.GATEWAY_PREFERRED_ADAPTER = adapter;
  if (strict === undefined) {
    delete process.env.GATEWAY_PREFERRED_STRICT;
  } else {
    process.env.GATEWAY_PREFERRED_STRICT = strict;
  }
  return Promise.resolve(fn()).finally(() => {
    if (prevA === undefined) {
      delete process.env.GATEWAY_PREFERRED_ADAPTER;
    } else {
      process.env.GATEWAY_PREFERRED_ADAPTER = prevA;
    }
    if (prevS === undefined) {
      delete process.env.GATEWAY_PREFERRED_STRICT;
    } else {
      process.env.GATEWAY_PREFERRED_STRICT = prevS;
    }
  });
}

const apiUnavailable = [
  { type: 'api', name: 'API 聚合通道', enabled: true, available: false, detail: 'probe detail' },
];

test('G-01 未注册通道 + 显式关 autoRepair → 报「配置无效」且绝不写盘（repairs 空）', async () => {
  const dispose = stubGatewayStatus(apiUnavailable);
  try {
    await withEnv('nope', 'true', async () => {
      const { issues, repairs } = await checkGatewayPreferredOnce({ autoRepairPreferred: false });
      const hit = issues.find((it) => it && it.source === 'gateway');
      assert.ok(hit, '必须产出 gateway issue');
      assert.strictEqual(hit.severity, 'high');
      assert.match(hit.message, /未注册或已禁用/);
      assert.strictEqual(repairs.length, 0, '显式关 autoRepair 时绝不能改写 env');
    });
  } finally {
    dispose();
  }
});

test('G-02 ★api + STRICT=true + 通道不可用 → 报出 error 级「strict 禁止回退」', async () => {
  const dispose = stubGatewayStatus(apiUnavailable);
  try {
    await withEnv('api', 'true', async () => {
      const { issues } = await checkGatewayPreferredOnce();
      const hit = issues.find((it) => it && it.source === 'gateway');
      assert.ok(hit, '钉选 + 不可用必须产出 issue');
      assert.strictEqual(hit.severity, 'error', 'strict 钉死不可用通道必须判 error（非 warning）');
      assert.match(hit.message, /strict 禁止回退/);
      assert.match(hit.message, /api/);
    });
  } finally {
    dispose();
  }
});

test('G-03 ★解钉路径对用户可见：message 给出 GATEWAY_PREFERRED_ADAPTER=auto', async () => {
  const dispose = stubGatewayStatus(apiUnavailable);
  try {
    await withEnv('api', 'true', async () => {
      const { issues } = await checkGatewayPreferredOnce();
      const hit = issues.find((it) => it && it.source === 'gateway');
      assert.ok(hit);
      assert.match(hit.message, /GATEWAY_PREFERRED_ADAPTER=auto/);
    });
  } finally {
    dispose();
  }
});

test('G-04 非 strict（STRICT=false）时降级为 warning —— 判级不被本次改动改变', async () => {
  const dispose = stubGatewayStatus(apiUnavailable);
  try {
    await withEnv('api', 'false', async () => {
      const { issues } = await checkGatewayPreferredOnce();
      const hit = issues.find((it) => it && it.source === 'gateway');
      assert.ok(hit);
      assert.strictEqual(hit.severity, 'warning');
    });
  } finally {
    dispose();
  }
});

test('G-05 ★启动时确实被触发：TUI 调用点位于 startInkApp 之前', () => {
  const src = readReplSession();
  const callIdx = src.indexOf('_kickoffGatewayPinStartupCheck({ toTui: true })');
  const forkIdx = src.indexOf("require('./tui/app.js')");
  assert.ok(callIdx > 0, 'TUI 模式的启动预检调用必须存在');
  assert.ok(forkIdx > callIdx, '预检必须在 TUI 分叉（startInkApp require）之前 —— 否则 TUI 永远走不到');
  const replCallIdx = src.indexOf('_kickoffGatewayPinStartupCheck({ toTui: false })');
  assert.ok(replCallIdx > callIdx, '经典 REPL 模式的调用也必须存在');
});

test('G-06 非阻断：预检是 fire-and-forget（不 await、带 catch 兜底）', () => {
  const src = readReplSession();
  const fnStart = src.indexOf('function _kickoffGatewayPinStartupCheck');
  const fnEnd = src.indexOf('async function startRepl');
  assert.ok(fnStart > 0 && fnEnd > fnStart, '预检函数必须存在且位于 startRepl 之前');
  const body = src.slice(fnStart, fnEnd);
  assert.doesNotMatch(body, /await\s+_kickoffGatewayPinStartupCheck/, '调用方绝不能 await 它');
  assert.match(body, /\.catch\(\(\) => \{\}\)/, 'Promise 链必须有 catch 兜底');
  assert.match(body, /checkGatewayPreferredOnce/, '判据必须复用 baseSelfCheckService，不得另立');
});

test('G-07 呈现通道：TUI 走通知端口且解钉指引可见', () => {
  const src = readReplSession();
  const fnStart = src.indexOf('function _kickoffGatewayPinStartupCheck');
  const body = src.slice(fnStart, src.indexOf('async function startRepl'));
  assert.match(body, /emitNotification/, 'TUI 侧必须走 notificationPort（挂载缓冲/回放）');
  assert.match(body, /khy doctor/, '解钉/自动修复指引必须对用户可见');
  assert.match(body, /GATEWAY_PREFERRED_ADAPTER/, '解钉动作必须写明');
});

test('G-08 不误报：通道健康时启动预检不产出任何 issue', async () => {
  const dispose = stubGatewayStatus([
    { type: 'api', name: 'API 聚合通道', enabled: true, available: true, detail: 'ok' },
  ]);
  try {
    await withEnv('api', 'true', async () => {
      const { issues } = await checkGatewayPreferredOnce();
      const hit = issues.find((it) => it && it.source === 'gateway');
      assert.strictEqual(hit, undefined, '健康通道绝不能告警（误报比不报更糟）');
    });
  } finally {
    dispose();
  }
});
