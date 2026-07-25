'use strict';

/**
 * commandSubstitutionContext — guard tests.
 *
 * 修「Windows 上 PowerShell `$()` 被当 bash 注入硬拒 → 已批准却显示禁止」。
 * `$(...)`/反引号是 PowerShell 原生语法,不应像 POSIX 命令替换那样**无审批通道地硬拒**。
 *
 * Invariants:
 *   ① gate KHY_SUBST_SHELL_AWARE default ON; 0/false/off/no → OFF
 *   ② baseExecutable 稳健解析首个可执行名(去引号 / 取 basename / 小写 / Windows+POSIX 分隔符)
 *   ③ isPosixCommandSubstitution:bash/POSIX → true(仍硬拒);PowerShell 家族 → false(走审批)
 *   ④ gate OFF → 恒 true(逐字节回退旧硬拒);fail-safe 偏保守;绝不抛
 *   ⑤ END-TO-END(ExecApprovalManager, ASK 档):
 *        - powershell `$()` → allowed:false **带 requestId**(审批通道),不是 substitution 硬拒
 *        - bash `$()`      → allowed:false **无 requestId** + substitution 理由(硬拒不变)
 *   ⑥ LIVE wiring:execApproval require 本叶子;flag 已注册
 *
 * node:test(jest via rtk proxy unavailable — Exec format error)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const csc = require('../../src/services/commandSubstitutionContext');
const { ExecApprovalManager, PERMISSION } = require('../../src/services/execApproval');
const BACKEND_ROOT = path.resolve(__dirname, '../../');

// ── ① gate ────────────────────────────────────────────────────────────────
test('KHY_SUBST_SHELL_AWARE defaults ON, reverts on falsy words', () => {
  assert.strictEqual(csc.isEnabled({}), true);
  assert.strictEqual(csc.isEnabled({ KHY_SUBST_SHELL_AWARE: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(csc.isEnabled({ KHY_SUBST_SHELL_AWARE: off }), false, `'${off}'`);
  }
  assert.strictEqual(csc.isEnabled({ KHY_SUBST_SHELL_AWARE: '1' }), true);
});

// ── ② baseExecutable parsing ──────────────────────────────────────────────
test('baseExecutable extracts a lowercased basename robustly', () => {
  assert.strictEqual(csc.baseExecutable('powershell -Command "$(x)"'), 'powershell');
  assert.strictEqual(csc.baseExecutable('POWERSHELL.EXE -NoProfile'), 'powershell.exe');
  assert.strictEqual(csc.baseExecutable('pwsh -c "echo hi"'), 'pwsh');
  assert.strictEqual(
    csc.baseExecutable('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command "$(x)"'),
    'powershell.exe');
  assert.strictEqual(csc.baseExecutable('"C:\\path with space\\pwsh.exe" -c x'), 'pwsh.exe');
  assert.strictEqual(csc.baseExecutable('/usr/bin/bash -c "echo $(id)"'), 'bash');
  assert.strictEqual(csc.baseExecutable('echo $(whoami)'), 'echo');
  // never throws on junk
  assert.strictEqual(csc.baseExecutable(''), '');
  assert.strictEqual(csc.baseExecutable(null), '');
  assert.strictEqual(csc.baseExecutable(42), '');
});

test('isNonPosixShellInvocation recognizes only the PowerShell family', () => {
  for (const c of [
    'powershell -Command "$(Get-Date)"',
    'pwsh -c "$(x)"',
    'C:\\...\\powershell.exe -NoProfile -Command "gci | %{ $($_.Name) }"',
  ]) assert.strictEqual(csc.isNonPosixShellInvocation(c), true, c);
  for (const c of [
    'bash -c "echo $(id)"',
    'echo $(whoami)',
    'cmd /c "echo $(x)"',        // cmd 不是 PowerShell,保守仍视 POSIX
    'sh -c "`id`"',
  ]) assert.strictEqual(csc.isNonPosixShellInvocation(c), false, c);
});

// ── ③④ core decision + gate revert + fail-safe ────────────────────────────
test('isPosixCommandSubstitution: POSIX true, PowerShell false, gate-off reverts', () => {
  // POSIX contexts → still hard-deny worthy (true)
  assert.strictEqual(csc.isPosixCommandSubstitution('echo $(rm -rf /)', {}), true);
  assert.strictEqual(csc.isPosixCommandSubstitution('bash -c "`evil`"', {}), true);
  // PowerShell → native syntax, not POSIX substitution (false → route to approval)
  assert.strictEqual(csc.isPosixCommandSubstitution('powershell -Command "$(Get-Date)"', {}), false);
  assert.strictEqual(csc.isPosixCommandSubstitution('pwsh -c "gci | %{ $($_.Name) }"', {}), false);
  // gate OFF → byte-revert: everything treated as POSIX substitution (hard-deny kept)
  const off = { KHY_SUBST_SHELL_AWARE: '0' };
  assert.strictEqual(csc.isPosixCommandSubstitution('powershell -Command "$(Get-Date)"', off), true);
  assert.strictEqual(csc.isPosixCommandSubstitution('echo $(x)', off), true);
});

test('never throws on bad input (fail-safe conservative)', () => {
  assert.doesNotThrow(() => csc.isPosixCommandSubstitution(null, null));
  assert.doesNotThrow(() => csc.isPosixCommandSubstitution(undefined, undefined));
  assert.strictEqual(csc.isPosixCommandSubstitution(null, {}), true, 'junk → conservative deny');
  assert.strictEqual(csc.isPosixCommandSubstitution(123, {}), true);
});

// ── ⑤ END-TO-END through ExecApprovalManager (ASK mode) ───────────────────
test('ASK mode: PowerShell $() gets an approval path (not a hard substitution deny)', () => {
  const mgr = new ExecApprovalManager({ permissionLevel: PERMISSION.ASK });
  const v = mgr.checkCommand('powershell -NoProfile -Command "Get-ChildItem | %{ $($_.Name) }"');
  assert.strictEqual(v.allowed, false, 'still requires approval');
  assert.ok(v.requestId, 'has a requestId → user CAN approve (the fix)');
  assert.ok(!/injection risk/.test(v.reason || ''), 'not the substitution hard-deny reason');
  assert.strictEqual(v.reason, 'Approval required');
});

test('ASK mode: bash $() is still hard-denied (no approval path) — bash unchanged', () => {
  const mgr = new ExecApprovalManager({ permissionLevel: PERMISSION.ASK });
  const v = mgr.checkCommand('echo $(rm -rf /tmp/x)');
  assert.strictEqual(v.allowed, false);
  assert.ok(!v.requestId, 'no requestId → hard deny, no approval path');
  assert.ok(/injection risk/.test(v.reason || ''), 'substitution hard-deny reason preserved');
});

test('ASK mode with gate OFF: PowerShell $() reverts to the old hard deny', () => {
  const orig = process.env.KHY_SUBST_SHELL_AWARE;
  process.env.KHY_SUBST_SHELL_AWARE = '0';
  try {
    const mgr = new ExecApprovalManager({ permissionLevel: PERMISSION.ASK });
    const v = mgr.checkCommand('powershell -Command "$(Get-Date)"');
    assert.strictEqual(v.allowed, false);
    assert.ok(!v.requestId, 'byte-revert: hard deny, no approval path');
    assert.ok(/injection risk/.test(v.reason || ''));
  } finally {
    if (orig === undefined) delete process.env.KHY_SUBST_SHELL_AWARE;
    else process.env.KHY_SUBST_SHELL_AWARE = orig;
  }
});

// ── ⑥ LIVE wiring ─────────────────────────────────────────────────────────
test('execApproval requires commandSubstitutionContext at the hard-deny site', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/services/execApproval.js'), 'utf8');
  assert.ok(/require\(['"]\.\/commandSubstitutionContext['"]\)/.test(src),
    'execApproval requires the leaf');
  assert.ok(/isPosixCommandSubstitution\(/.test(src), 'calls the decision fn');
});

test('flagRegistry registers KHY_SUBST_SHELL_AWARE default ON', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_SUBST_SHELL_AWARE', {}), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_SUBST_SHELL_AWARE', { KHY_SUBST_SHELL_AWARE: 'off' }), false);
});
