'use strict';

/**
 * channelLogGating.test.js — [EvoRequirement] 非活跃通道日志越权（症状级 acceptance）。
 *
 * 驱动 kiroAdapter 真实的「无 token + autoOpenLogin」路径（getAccessToken → maybeOpenKiroLogin），
 * 用 console.warn 间谍 + 桩化的 platformUtils 证明两件事，全程零真实网络/浏览器/IDE：
 *
 *   弃用通道（GATEWAY_PREFERRED_ADAPTER=api，kiro 被 setChannelActive(false)）：
 *     - 抛 "No Kiro token"（功能语义不变），但
 *     - 绝不向 UI 主控台输出 `[kiroAdapter] Kiro login required`（console.warn 零次）；
 *     - 绝不拉起 IDE/浏览器（openDefault/spawnGuiApp 零次）。  → 期望行为 #1 + #2
 *
 *   活跃通道（GATEWAY_PREFERRED_ADAPTER=kiro）：
 *     - 同样抛错，但 console.warn 照常输出「login required」，openDefault 照常拉起登录。
 *       → 硬性约束：不得误杀活跃通道的关键错误日志/必要副作用。
 *
 * 隔离手段：在 require kiroAdapter 之前，把 accountPool / platformUtils / os.homedir 全部桩掉，
 * 让本地与账号池都「无 token」，且任何拉起动作只落到内存间谍上。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ENV_KEY = 'GATEWAY_PREFERRED_ADAPTER';

// ── 1. 强制 auto-open 打开（否则 login 路径在 env 门控处提前返回，测不到对比） ──
process.env.KIRO_AUTO_OPEN_LOGIN = '1';
process.env.KIRO_LOGIN_COOLDOWN_MS = '1'; // 关掉冷却，活跃用例不被弃用用例的时间戳挡住

// ── 2. 把 homedir 指到一个空临时目录：~/.aws/sso/cache 必为空，readKiroToken → null ──
const _origHomedir = os.homedir;
const _emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-kiro-empty-'));
os.homedir = () => _emptyHome;

// ── 3. 桩掉 accountPool（账号池也无 token）与 platformUtils（拉起动作只记账） ──
const spawnCalls = [];
const openCalls = [];
const adaptersDir = path.resolve(__dirname, '../../../src/services/gateway/adapters');
const platformUtilsPath = require.resolve('../../../src/tools/platformUtils');
const accountPoolPath = require.resolve('../../../src/services/accountPool');
const ideDetectorPath = require.resolve('../../../src/services/gateway/adapters/ideDetector');

function fakeModule(p, exportsObj) {
  const m = new Module(p, module);
  m.filename = p;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[p] = m;
}

fakeModule(platformUtilsPath, {
  openDefault: (target) => { openCalls.push(target); },
  spawnGuiApp: (target) => { spawnCalls.push(target); },
});
fakeModule(accountPoolPath, {
  init: async () => {},
  getActiveToken: async () => null,
});
// findInstallation('kiro') → null 让 maybeOpenKiroLogin 走 openDefault(KIRO_LOGIN_URL) 分支。
fakeModule(ideDetectorPath, { findInstallation: () => null });

// 现在加载被测模块（吃到上面所有桩）。
const kiroPath = require.resolve('../../../src/services/gateway/adapters/kiroAdapter');
delete require.cache[kiroPath];
const kiro = require(kiroPath);

const _origPref = process.env[ENV_KEY];

test.after(() => {
  os.homedir = _origHomedir;
  if (_origPref === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = _origPref;
  try { fs.rmSync(_emptyHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

function withWarnSpy(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  spawnCalls.length = 0;
  openCalls.length = 0;
  return Promise.resolve()
    .then(fn)
    .then(
      () => { console.warn = orig; return warns; },
      (err) => { console.warn = orig; throw err; },
    );
}

test('弃用通道：getAccessToken 抛 No Kiro token，但零 WARN、零 IDE 拉起', async () => {
  kiro.destroy(); // 清掉登录冷却时间戳，隔离用例
  process.env[ENV_KEY] = 'api';
  kiro.setChannelActive(false);

  const warns = await withWarnSpy(async () => {
    await assert.rejects(
      () => kiro.getAccessToken({ autoOpenLogin: true }),
      /No Kiro token/,
      '功能语义不变：仍如实抛出无 token',
    );
  });

  const loginWarns = warns.filter((w) => /login required/i.test(w));
  assert.deepStrictEqual(loginWarns, [], '弃用通道绝不把 login required 冒泡到 UI 主控台');
  assert.deepStrictEqual(spawnCalls, [], '弃用通道绝不拉起 IDE');
  assert.deepStrictEqual(openCalls, [], '弃用通道绝不打开登录页');
});

test('活跃通道：同样抛错，但 WARN 与登录拉起照常（不误杀关键日志/副作用）', async () => {
  kiro.destroy(); // 清掉登录冷却时间戳，隔离用例
  process.env[ENV_KEY] = 'kiro';
  kiro.setChannelActive(true);

  const warns = await withWarnSpy(async () => {
    await assert.rejects(
      () => kiro.getAccessToken({ autoOpenLogin: true }),
      /No Kiro token/,
    );
  });

  const loginWarns = warns.filter((w) => /login required/i.test(w));
  assert.strictEqual(loginWarns.length, 1, '活跃通道必须照常向用户报「login required」');
  assert.strictEqual(openCalls.length, 1, '活跃通道照常拉起登录页（无安装时回退 openDefault）');
});

test('auto 模式（无偏好，非弃用）：deliberate login 照常拉起（防回归 autoLogin 契约）', async () => {
  // auto 模式不是「弃用」——显式 autoOpenLogin 请求必须仍打开登录入口，
  // 这正是历史 kiroAdapter.autoLogin 测试的契约；不得因僵尸治理误伤。
  kiro.destroy(); // 清掉登录冷却时间戳，隔离用例
  delete process.env[ENV_KEY];
  kiro.setChannelActive(true);

  const warns = await withWarnSpy(async () => {
    await assert.rejects(
      () => kiro.getAccessToken({ autoOpenLogin: true }),
      /No Kiro token/,
    );
  });

  const loginWarns = warns.filter((w) => /login required/i.test(w));
  assert.strictEqual(loginWarns.length, 1, 'auto 模式仍报「login required」（未被误杀）');
  assert.strictEqual(openCalls.length, 1, 'auto 模式仍拉起登录入口');
});
