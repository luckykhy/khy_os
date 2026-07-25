'use strict';

/**
 * envRepair — SAFE create-missing-only self-repair registry (node:test, 确定性).
 *
 * Locks the SAFETY CONTRACT, not absolute machine state: repairs are
 * create-missing-only, idempotent, fail-soft, and NON-DESTRUCTIVE on corruption
 * (a path of the wrong type is never deleted). Uses a synthetic HOME (temp dir +
 * os.homedir monkeypatch) so tests never touch the real ~/.khy.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const repair = require('../../src/services/envRepair');

// Run `fn` with os.homedir() pointing at a throwaway temp dir; always restores.
function withSyntheticHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyhome-'));
  const orig = os.homedir;
  os.homedir = () => tmp;
  try {
    return fn(tmp);
  } finally {
    os.homedir = orig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('runRepairs: 返回数组,每项形状 {key,label,ok,changed,detail}', () => {
  process.env.KHY_ENV_OPTIMIZE_REPAIR = 'true';
  const out = repair.runRepairs();
  assert.ok(Array.isArray(out));
  for (const r of out) {
    assert.strictEqual(typeof r.key, 'string');
    assert.strictEqual(typeof r.label, 'string');
    assert.strictEqual(typeof r.ok, 'boolean');
    assert.strictEqual(typeof r.changed, 'boolean');
    assert.strictEqual(typeof r.detail, 'string');
  }
});

test('runRepairs: 子门 KHY_ENV_OPTIMIZE_REPAIR=false → 恒空数组(检测-only)', () => {
  const prev = process.env.KHY_ENV_OPTIMIZE_REPAIR;
  try {
    process.env.KHY_ENV_OPTIMIZE_REPAIR = 'false';
    assert.deepStrictEqual(repair.runRepairs(), []);
  } finally {
    process.env.KHY_ENV_OPTIMIZE_REPAIR = prev;
  }
});

test('配置目录修复:缺失 → 创建(changed:true);再跑 → 幂等 null', () => {
  withSyntheticHome((home) => {
    const target = path.join(home, '.khy');
    assert.strictEqual(fs.existsSync(target), false);
    const r1 = repair._repairConfigHome();
    assert.ok(r1 && r1.ok === true && r1.changed === true);
    assert.match(r1.detail, /已创建缺失的配置目录/);
    assert.strictEqual(fs.existsSync(target) && fs.statSync(target).isDirectory(), true);
    // idempotent — already healthy → null, no churn
    const r2 = repair._repairConfigHome();
    assert.strictEqual(r2, null);
  });
});

test('配置目录修复:已存在健康目录 → null(不动)', () => {
  withSyntheticHome((home) => {
    fs.mkdirSync(path.join(home, '.khy'), { recursive: true });
    assert.strictEqual(repair._repairConfigHome(), null);
  });
});

test('配置目录修复:路径被文件占用(损坏)→ 拒绝删除,ok:false 交人工', () => {
  withSyntheticHome((home) => {
    const target = path.join(home, '.khy');
    fs.writeFileSync(target, 'i am a file, not a directory');
    const r = repair._repairConfigHome();
    assert.ok(r && r.ok === false && r.changed === false);
    assert.match(r.detail, /需人工处理/);
    // NON-DESTRUCTIVE: the user's file must still be there.
    assert.strictEqual(fs.existsSync(target), true);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'i am a file, not a directory');
  });
});

test('每个注册修复都不抛,且遵守 create-missing-only 契约(健康 → null)', () => {
  process.env.KHY_ENV_OPTIMIZE_REPAIR = 'true';
  for (const r of repair._REPAIRS) {
    assert.strictEqual(typeof r.key, 'string');
    assert.strictEqual(typeof r.run, 'function');
    assert.doesNotThrow(() => { r.run(); });
  }
});

test('_REPAIRS 是可扩展注册表:追加一条即被 runRepairs 纳入', () => {
  process.env.KHY_ENV_OPTIMIZE_REPAIR = 'true';
  const before = repair.runRepairs().length;
  repair._REPAIRS.push({ key: 'synthetic-repair', label: '测试项', run: () => ({ ok: true, changed: true, detail: '合成修复' }) });
  try {
    const after = repair.runRepairs();
    assert.strictEqual(after.length, before + 1);
    const injected = after.find((r) => r.key === 'synthetic-repair');
    assert.ok(injected);
    assert.strictEqual(injected.changed, true);
    assert.strictEqual(injected.detail, '合成修复');
  } finally {
    repair._REPAIRS.pop(); // 复原,避免污染后续测试
  }
});

test('聚合器隔离抛异常的修复,不中断整轮', () => {
  process.env.KHY_ENV_OPTIMIZE_REPAIR = 'true';
  repair._REPAIRS.push({ key: 'throwing', label: '抛异常项', run: () => { throw new Error('boom'); } });
  try {
    assert.doesNotThrow(() => repair.runRepairs());
    // the throwing repair contributes nothing, but does not abort the sweep
    const out = repair.runRepairs();
    assert.ok(Array.isArray(out));
    assert.strictEqual(out.find((r) => r.key === 'throwing'), undefined);
  } finally {
    repair._REPAIRS.pop();
  }
});

test('平台差异:config-home 修复排除沙盒系统(ios/harmonyos)', () => {
  // On sandboxed mobile-class platforms the app cannot freely create dotdirs in
  // HOME, so create-missing repairs are scoped away from ios/harmonyos.
  const cfg = repair._REPAIRS.find((r) => r.key === 'config-home');
  assert.ok(cfg, 'config-home 修复应存在');
  assert.ok(Array.isArray(cfg.platforms), 'config-home 应带 platforms 白名单');
  assert.ok(!cfg.platforms.includes('ios'), 'iOS(沙盒)不应在 config-home 白名单内');
  assert.ok(!cfg.platforms.includes('harmonyos'), 'HarmonyOS(沙盒)不应在 config-home 白名单内');
  assert.ok(cfg.platforms.includes('linux'), 'Linux 应在 config-home 白名单内');
});

test('平台差异:runRepairs 按 KHY_OS_PROFILE=ios 跳过 config-home', () => {
  process.env.KHY_ENV_OPTIMIZE_REPAIR = 'true';
  const prevPin = process.env.KHY_OS_PROFILE;
  process.env.KHY_OS_PROFILE = 'ios';
  const osProfileService = require('../../src/services/osProfileService');
  osProfileService.resetCache();
  try {
    withSyntheticHome(() => {
      const out = repair.runRepairs();
      assert.ok(!out.some((r) => r.key === 'config-home'), 'iOS 下不应执行 config-home 修复');
    });
  } finally {
    if (prevPin === undefined) delete process.env.KHY_OS_PROFILE;
    else process.env.KHY_OS_PROFILE = prevPin;
    osProfileService.resetCache();
  }
});
