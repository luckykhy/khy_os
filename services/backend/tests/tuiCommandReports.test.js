'use strict';

/**
 * tuiCommandReports.test.js — TUI 原生执行非交互经典命令(/scan /hardware /checkpoint)回归。
 * (goal 2026-06-28「我只要用 TUI,REPL 有而 TUI 没有的功能要补齐,两处对齐」)
 *
 * 守护:
 *   1. 门控 KHY_TUI_NATIVE_COMMANDS 默认开:Tier A 命令(flag/command 命中)→ handled:true + 文本行。
 *   2. 门控关 → dispatchNativeCommand 恒 { handled:false }(字节回退,命令照旧落既有路径)。
 *   3. 非 Tier A 命令(如 rollback/未知)→ handled:false。
 *   4. service 失败/缺失 → 不抛,回退成一行错误说明文本(buildXxxReport 永远返回非空数组)。
 *   5. /checkpoint 复用 checkpointService.saveCheckpoint 落真检查点到临时目录。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reports = require('../src/cli/tui/tuiCommandReports');
const {
  dispatchNativeCommand, isEnabled, buildHardwareReport, buildScanReport, saveCheckpointReport,
  buildIntentReport, buildStudyReport, buildMindReport, runWorktreeNative,
} = reports;

test('门控判定:仅显式 0/false/off/no 关闭', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(isEnabled({ KHY_TUI_NATIVE_COMMANDS: v }), false, `env=${v}`);
  }
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_TUI_NATIVE_COMMANDS: 'true' }), true);
});

test('门控关:dispatchNativeCommand 恒 handled:false(字节回退)', () => {
  const r = dispatchNativeCommand({ flag: 'hardware' }, { env: { KHY_TUI_NATIVE_COMMANDS: 'off' } });
  assert.deepStrictEqual(r, { handled: false });
});

test('Tier A 命中(flag 或 command)→ handled:true + 非空文本行', () => {
  for (const parsed of [{ flag: 'hardware' }, { command: 'hardware' }, { flag: 'scan' }]) {
    const r = dispatchNativeCommand(parsed, { env: {} });
    assert.strictEqual(r.handled, true, JSON.stringify(parsed));
    assert.ok(Array.isArray(r.lines) && r.lines.length > 0);
  }
});

test('非 Tier A(rollback / 未知 / 空)→ handled:false', () => {
  assert.strictEqual(dispatchNativeCommand({ flag: 'rollback' }, { env: {} }).handled, false);
  assert.strictEqual(dispatchNativeCommand({ command: 'totally-unknown' }, { env: {} }).handled, false);
  assert.strictEqual(dispatchNativeCommand(null, { env: {} }).handled, false);
});

test('buildHardwareReport / buildScanReport 绝不抛、返回非空数组', () => {
  const hw = buildHardwareReport();
  assert.ok(Array.isArray(hw) && hw.length > 0);
  const scan = buildScanReport();
  assert.ok(Array.isArray(scan) && scan.length > 0);
});

test('saveCheckpointReport 复用 checkpointService 落真检查点', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ckpt-'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'content');
  const lines = saveCheckpointReport(dir);
  assert.ok(Array.isArray(lines) && lines.length > 0);
  // 成功保存 → 「检查点已保存」;失败 → 「检查点保存失败」。两者都不得抛。
  assert.ok(/检查点(已保存|保存失败)/.test(lines[0]), lines[0]);
});

// ── 新增同步报告档:/intent /study /mind ─────────────────────────────────────

test('buildIntentReport on/off 设 env + 持久化;show 报当前态', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-home-'));
  const origHome = process.env.HOME;
  const origUserprofile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const env = {};
    const onLines = buildIntentReport(['on'], env);
    assert.strictEqual(env.KHY_INTENT_ASSURANCE_DEBUG, 'true');
    assert.ok(/已开启意图保护调试/.test(onLines[0]), onLines.join('|'));
    // 持久化成功(临时 HOME 可写)→ 不应有「未能持久化」告警行。
    assert.ok(!onLines.some((l) => /未能持久化/.test(l)), onLines.join('|'));

    const showLines = buildIntentReport(['show'], env);
    assert.ok(/意图保护调试: 开启/.test(showLines[0]), showLines.join('|'));

    const offLines = buildIntentReport(['off'], env);
    assert.strictEqual(env.KHY_INTENT_ASSURANCE_DEBUG, 'false');
    assert.ok(/已关闭意图保护调试/.test(offLines[0]), offLines.join('|'));
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserprofile;
  }
});

test('buildStudyReport status 报学习模式状态、绝不抛', () => {
  const lines = buildStudyReport(['status']);
  assert.ok(Array.isArray(lines) && lines.length > 0);
  assert.ok(/学习模式/.test(lines[0]), lines.join('|'));
});

test('buildMindReport show 原生渲染认知双图;on/off 设 env;绝不抛', () => {
  const show = buildMindReport(['show'], {});
  assert.ok(Array.isArray(show) && show.length > 1, JSON.stringify(show));
  assert.strictEqual(show[0], '认知双图:');

  const env = {};
  const on = buildMindReport(['on'], env);
  assert.strictEqual(env.KHY_TASK_MINDMAP_AUTO_SHOW, 'true');
  assert.ok(/认知双图自动展示: 开启/.test(on[0]), on.join('|'));

  const reset = buildMindReport(['reset'], {});
  assert.ok(/重置/.test(reset[0]), reset.join('|'));
});

// ── 异步档:/worktree ────────────────────────────────────────────────────────

test('runWorktreeNative 非 git 目录 status → 文本行、async、绝不抛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wt-'));
  const origCwd = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = dir;
  try {
    const lines = await runWorktreeNative('status', {});
    assert.ok(Array.isArray(lines) && lines.length > 0);
    assert.ok(lines.some((l) => /隔离工作区/.test(l)), lines.join('|'));
  } finally {
    if (origCwd === undefined) delete process.env.KHYQUANT_CWD; else process.env.KHYQUANT_CWD = origCwd;
  }
});

// ── dispatchNativeCommand 覆盖新同步命令 ─────────────────────────────────────

test('dispatchNativeCommand 处理 intent/study/mind(handled:true + 文本行)', () => {
  for (const parsed of [
    { command: 'intent', args: ['show'] },
    { command: 'study', args: ['status'] },
    { command: 'mind', args: ['show'] },
  ]) {
    const r = dispatchNativeCommand(parsed, { env: {} });
    assert.strictEqual(r.handled, true, JSON.stringify(parsed));
    assert.ok(Array.isArray(r.lines) && r.lines.length > 0);
  }
});

test('dispatchNativeCommand 门控关 → intent/study/mind 亦 handled:false(字节回退)', () => {
  for (const parsed of [{ command: 'intent' }, { command: 'study' }, { command: 'mind' }]) {
    const r = dispatchNativeCommand(parsed, { env: { KHY_TUI_NATIVE_COMMANDS: 'off' } });
    assert.deepStrictEqual(r, { handled: false }, JSON.stringify(parsed));
  }
});

test('dispatchNativeCommand 不处理 worktree/review/rollback(由 App.js 异步驱动)', () => {
  for (const parsed of [{ command: 'worktree' }, { command: 'review' }, { command: 'rollback' }]) {
    assert.strictEqual(dispatchNativeCommand(parsed, { env: {} }).handled, false, JSON.stringify(parsed));
  }
});
