'use strict';

/**
 * mdEditorRegister 单测 —— 覆盖首次运行幂等注册的判决与「失败绝不永久跳过」的根因修复。
 *
 * 历史 bug:spawn 后无条件写「已完成」sentinel,一次静默失败即永久跳过,khyos 永远不进
 * 系统「打开方式」。本测锁定新语义:成功 sentinel 只在**权威检测到已注册**时写;失败只累加
 * attempts;有界重试;旧版(v1、无 success 字段)sentinel 不被信任,触发权威重估。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const mod = require('../../../src/services/mdEditorRegister');

// 每个用例一个临时 sentinel 路径(不碰真实 ~/.khy)。
let seq = 0;
function tmpSentinel() {
  seq += 1;
  return path.join(os.tmpdir(), `khy-md-reg-test-${process.pid}-${seq}.json`);
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function cleanup(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// spawn 记录器:记录被调用与否,返回带 unref 的假 child。
function makeSpawnRecorder() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { spawn, calls };
}

const BASE_ENV = { KHY_MD_EDITOR: '1', KHY_MD_AUTO_REGISTER: '1' };
const LINUX_DEPS_BASE = {
  platform: 'linux',
  resolveToolsDir: () => '/fake/tools',
  existsSync: () => true, // 脚本存在(且 linux desktop 检测默认 true,除非覆盖)
};

// ---- 门控 ----

test('gate off (KHY_MD_AUTO_REGISTER=0) → skip-gate, no spawn', () => {
  const target = tmpSentinel();
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    { KHY_MD_EDITOR: '1', KHY_MD_AUTO_REGISTER: '0' },
    Object.assign({}, LINUX_DEPS_BASE, { target, spawn }),
  );
  assert.strictEqual(r, 'skip-gate');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(fs.existsSync(target), false);
  cleanup(target);
});

test('parent gate off (KHY_MD_EDITOR=false) → skip-gate', () => {
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    { KHY_MD_EDITOR: 'false', KHY_MD_AUTO_REGISTER: '1' },
    Object.assign({}, LINUX_DEPS_BASE, { target: tmpSentinel(), spawn }),
  );
  assert.strictEqual(r, 'skip-gate');
  assert.strictEqual(calls.length, 0);
});

// ---- 平台 ----

test('unsupported platform (darwin) → skip-platform, no spawn', () => {
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, { platform: 'darwin', target: tmpSentinel(), spawn }),
  );
  assert.strictEqual(r, 'skip-platform');
  assert.strictEqual(calls.length, 0);
});

// ---- 成功 sentinel 快路径 ----

test('trusted success sentinel → skip-sentinel short-circuit, no spawn/detect', () => {
  const target = tmpSentinel();
  fs.writeFileSync(target, JSON.stringify({ version: '2.0.0', success: true }));
  const { spawn, calls } = makeSpawnRecorder();
  let detected = false;
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: () => { detected = true; return true; },
    }),
  );
  assert.strictEqual(r, 'skip-sentinel');
  assert.strictEqual(calls.length, 0, 'must not spawn when already succeeded');
  assert.strictEqual(detected, false, 'must not even probe when trusted success sentinel exists');
  cleanup(target);
});

// ---- 权威检测自愈 ----

test('authoritative isRegistered true → already + writes success sentinel (no spawn)', () => {
  const target = tmpSentinel();
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: (p) => String(p).endsWith('khyosMarkdown.desktop'), // 系统已注册
    }),
  );
  assert.strictEqual(r, 'already');
  assert.strictEqual(calls.length, 0, 'already registered → do not spawn again');
  const s = readJson(target);
  assert.strictEqual(s.success, true);
  assert.strictEqual(s.version, '2.0.0');
  cleanup(target);
});

test('stale v1 sentinel (no success) + system now registered → re-evaluated → already', () => {
  const target = tmpSentinel();
  // 旧版失败标记:只有 registeredAt/version 1.0.0,无 success 字段。
  fs.writeFileSync(target, JSON.stringify({ version: '1.0.0', registeredAt: '2025-01-01' }));
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: (p) => String(p).endsWith('khyosMarkdown.desktop'),
    }),
  );
  assert.strictEqual(r, 'already', 'stale v1 sentinel must not short-circuit; authoritative detect wins');
  assert.strictEqual(readJson(target).success, true);
  cleanup(target);
});

// ---- 未注册:有界重试,失败绝不写成功标记 ----

test('unregistered → spawn + attempts++ WITHOUT success sentinel (root-cause fix)', () => {
  const target = tmpSentinel();
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: (p) => {
        const s = String(p);
        if (s.endsWith('khyosMarkdown.desktop')) return false; // 系统未注册
        return true; // 脚本文件存在
      },
    }),
  );
  assert.strictEqual(r, 'spawned');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'bash');
  const s = readJson(target);
  assert.strictEqual(s.success, false, 'must NOT mark success on mere spawn — this was the bug');
  assert.strictEqual(s.attempts, 1);
  cleanup(target);
});

test('stale v1 sentinel + still unregistered → spawn, attempts start at 1', () => {
  const target = tmpSentinel();
  fs.writeFileSync(target, JSON.stringify({ version: '1.0.0', registeredAt: '2025-01-01' }));
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: (p) => !String(p).endsWith('khyosMarkdown.desktop'),
    }),
  );
  assert.strictEqual(r, 'spawned');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(readJson(target).attempts, 1);
  cleanup(target);
});

test('attempts accumulate: prev attempts=1 → next spawn sets attempts=2', () => {
  const target = tmpSentinel();
  fs.writeFileSync(target, JSON.stringify({ version: '2.0.0', success: false, attempts: 1 }));
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: (p) => !String(p).endsWith('khyosMarkdown.desktop'),
    }),
  );
  assert.strictEqual(r, 'spawned');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(readJson(target).attempts, 2);
  cleanup(target);
});

test('maxed attempts (>=MAX_ATTEMPTS) + unregistered → skip-maxed, no spawn', () => {
  const target = tmpSentinel();
  fs.writeFileSync(target, JSON.stringify({ version: '2.0.0', success: false, attempts: mod.MAX_ATTEMPTS }));
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: (p) => !String(p).endsWith('khyosMarkdown.desktop'),
    }),
  );
  assert.strictEqual(r, 'skip-maxed');
  assert.strictEqual(calls.length, 0, 'give up auto-register after budget exhausted');
  cleanup(target);
});

test('maxed attempts but system meanwhile registered → still self-heals to already', () => {
  const target = tmpSentinel();
  fs.writeFileSync(target, JSON.stringify({ version: '2.0.0', success: false, attempts: 99 }));
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      existsSync: (p) => String(p).endsWith('khyosMarkdown.desktop'),
    }),
  );
  // 权威检测在预算检查之前 → 已注册优先,补写成功标记。
  assert.strictEqual(r, 'already');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(readJson(target).success, true);
  cleanup(target);
});

// ---- 工具缺失 ----

test('resolveToolsDir null → skip-no-tools', () => {
  const target = tmpSentinel();
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      resolveToolsDir: () => null,
      existsSync: (p) => !String(p).endsWith('khyosMarkdown.desktop'),
    }),
  );
  assert.strictEqual(r, 'skip-no-tools');
  assert.strictEqual(calls.length, 0);
  cleanup(target);
});

test('register script file missing → skip-no-tools (no spawn)', () => {
  const target = tmpSentinel();
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    Object.assign({}, LINUX_DEPS_BASE, {
      target,
      spawn,
      // desktop 不存在(未注册)且脚本文件也不存在 → 一律 false
      existsSync: () => false,
    }),
  );
  assert.strictEqual(r, 'skip-no-tools');
  assert.strictEqual(calls.length, 0);
  cleanup(target);
});

// ---- win32 分支 spawn 形状 ----

test('win32 unregistered → spawns powershell register-windows.ps1, no success sentinel', () => {
  const target = tmpSentinel();
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    {
      platform: 'win32',
      target,
      spawn,
      resolveToolsDir: () => 'C:\\fake\\tools',
      existsSync: () => true, // 脚本存在
      spawnSync: () => ({ status: 1 }), // reg query 未命中 → 未注册
    },
  );
  assert.strictEqual(r, 'spawned');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'powershell');
  assert.ok(calls[0].args.some((a) => String(a).endsWith('register-windows.ps1')));
  assert.strictEqual(readJson(target).success, false);
  cleanup(target);
});

test('win32 reg query hit (status 0) → already, no spawn', () => {
  const target = tmpSentinel();
  const { spawn, calls } = makeSpawnRecorder();
  const r = mod.ensureMdRegistered(
    BASE_ENV,
    {
      platform: 'win32',
      target,
      spawn,
      resolveToolsDir: () => 'C:\\fake\\tools',
      existsSync: () => true,
      spawnSync: () => ({ status: 0 }), // ProgID 存在 → 已注册
    },
  );
  assert.strictEqual(r, 'already');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(readJson(target).success, true);
  cleanup(target);
});

// ---- 纯函数 ----

test('isSuccessSentinel: only success===true counts', () => {
  assert.strictEqual(mod.isSuccessSentinel({ success: true }), true);
  assert.strictEqual(mod.isSuccessSentinel({ success: false }), false);
  assert.strictEqual(mod.isSuccessSentinel({ registeredAt: 'x' }), false);
  assert.strictEqual(mod.isSuccessSentinel(null), false);
  assert.strictEqual(mod.isSuccessSentinel(undefined), false);
});

test('isRegistered linux: honors XDG_DATA_HOME override', () => {
  let probed = null;
  const ok = mod.isRegistered('linux', {
    env: { XDG_DATA_HOME: '/custom/xdg' },
    existsSync: (p) => { probed = String(p); return true; },
  });
  assert.strictEqual(ok, true);
  assert.ok(probed.startsWith('/custom/xdg/applications'));
  assert.ok(probed.endsWith('khyosMarkdown.desktop'));
});

test('isRegistered darwin → false (unsupported)', () => {
  assert.strictEqual(mod.isRegistered('darwin', { existsSync: () => true }), false);
});

test('constants exported', () => {
  assert.strictEqual(mod.SENTINEL_NAME, '.md-registered');
  assert.strictEqual(mod.SENTINEL_VERSION, '2.0.0');
  assert.strictEqual(typeof mod.MAX_ATTEMPTS, 'number');
  assert.ok(mod.MAX_ATTEMPTS >= 1);
});
