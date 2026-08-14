'use strict';

/**
 * startupFailureExplain.test.js — 送别礼「错误真实原因 + 方法」角度的行为契约。
 *
 * 覆盖的真实缺口：他机 pip/npm 装完首启，backend 的 node_modules 半装/未 hydrate，
 * bin/khy.js 起来后深层 require 抛 MODULE_NOT_FOUND → _emitFatal 只吐一行裸 stack。
 * 本纯叶子把该崩溃归因为「真实原因 + 解决方法」，_emitFatal 追加呈现。
 *
 * 分层同 windowsSpawnHardening：纯核心零 IO 绝不抛，门 KHY_STARTUP_FAILURE_EXPLAIN
 * default-on，关 → 返回 null → _emitFatal 逐字节回退今日裸 stack。
 */

const test = require('node:test');
const assert = require('node:assert');

const sfe = require('../../src/bootstrap/startupFailureExplain');

// 与 hydrationHealth 同源的红线：修法文本绝不教危险动作。
const DANGER_TOKENS = [
  'git commit', 'git push', 'rm -rf /', 'rm -r /', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

function assertDangerFree(text) {
  const s = String(text || '').toLowerCase();
  for (const t of DANGER_TOKENS) {
    assert.ok(!s.includes(t.toLowerCase()), `修法文本不得含危险动作: ${t}`);
  }
}

function moduleNotFound(name = 'express') {
  const err = new Error(`Cannot find module '${name}'`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

// ── 门控（CANON 4 词，default-on）────────────────────────────────────────────
test('isEnabled: CANON gating default-on', () => {
  assert.strictEqual(sfe.isEnabled({}), true);
  assert.strictEqual(sfe.isEnabled({ KHY_STARTUP_FAILURE_EXPLAIN: 'off' }), false);
  assert.strictEqual(sfe.isEnabled({ KHY_STARTUP_FAILURE_EXPLAIN: '0' }), false);
  assert.strictEqual(sfe.isEnabled({ KHY_STARTUP_FAILURE_EXPLAIN: 'no' }), false);
  assert.strictEqual(sfe.isEnabled({ KHY_STARTUP_FAILURE_EXPLAIN: 'false' }), false);
  assert.strictEqual(sfe.isEnabled({ KHY_STARTUP_FAILURE_EXPLAIN: 'disable' }), true); // EXTENDED → 开
});

// ── 门关 → 逐字节回退（返回 null）───────────────────────────────────────────
test('gate off → null even for a classifiable error', () => {
  const out = sfe.explainStartupFailure(moduleNotFound(), 'linux', { KHY_STARTUP_FAILURE_EXPLAIN: 'off' });
  assert.strictEqual(out, null);
});

// ── 空/无效输入 → null，绝不抛 ─────────────────────────────────────────────
test('falsy / non-error input → null, never throws', () => {
  assert.strictEqual(sfe.explainStartupFailure(null, 'linux', {}), null);
  assert.strictEqual(sfe.explainStartupFailure(undefined, 'linux', {}), null);
  assert.strictEqual(sfe.explainStartupFailure('boom', 'linux', {}), null);
  assert.strictEqual(sfe.explainStartupFailure(42, 'linux', {}), null);
});

// ── MODULE_NOT_FOUND：真实原因 + 解决方法 ───────────────────────────────────
test('MODULE_NOT_FOUND → cause + fix block', () => {
  const out = sfe.explainStartupFailure(moduleNotFound('express'), 'linux', {});
  assert.ok(out && typeof out === 'string');
  assert.ok(out.includes('真实原因'), '须含真实原因');
  assert.ok(out.includes('解决方法'), '须含解决方法');
  assert.ok(out.includes('hydrate'), '须点到首启 hydrate');
  assertDangerFree(out);
});

test('MODULE_NOT_FOUND → surfaces the missing module name', () => {
  const out = sfe.explainStartupFailure(moduleNotFound('better-sqlite3'), 'linux', {});
  assert.ok(out.includes('better-sqlite3'), '须点名缺失模块');
});

test('classify by message even when err.code is absent', () => {
  const err = new Error("Cannot find module 'sequelize'");
  // no code set
  const out = sfe.explainStartupFailure(err, 'linux', {});
  assert.ok(out && out.includes('真实原因'));
  assert.ok(out.includes('sequelize'));
});

// ── 平台分支：win32 vs unix 的修法不同 ─────────────────────────────────────
test('platform branch: win32 mentions khy stop + pip reinstall', () => {
  const out = sfe.explainStartupFailure(moduleNotFound(), 'win32', {});
  assert.ok(out.includes('khy stop'), 'win32 须提示先 khy stop 释放占用');
  assert.ok(out.includes('pip install'), 'win32 须给 pip 重装路径');
  assertDangerFree(out);
});

test('platform branch: unix mentions npm install (no khy stop占用套路)', () => {
  const out = sfe.explainStartupFailure(moduleNotFound(), 'linux', {});
  assert.ok(out.includes('npm install'), 'unix 须给源码 npm install 路径');
  assertDangerFree(out);
});

// ── 原生模块 ABI 不匹配 ────────────────────────────────────────────────────
test('ERR_DLOPEN_FAILED → native ABI cause + rebuild fix', () => {
  const err = new Error('Error loading shared library');
  err.code = 'ERR_DLOPEN_FAILED';
  const out = sfe.explainStartupFailure(err, 'linux', {});
  assert.ok(out && out.includes('真实原因'));
  assert.ok(out.includes('ABI') || out.includes('原生'), '须归因原生模块 ABI');
  assert.ok(out.toLowerCase().includes('rebuild'), '须给 rebuild 修法');
  assertDangerFree(out);
});

// ── 未识别错误 → null（逐字节回退今日裸 stack）─────────────────────────────
test('unrecognized error → null (byte-revert to raw stack)', () => {
  const err = new Error('some unrelated runtime error');
  err.code = 'EACCES';
  assert.strictEqual(sfe.explainStartupFailure(err, 'linux', {}), null);
});

// ── 确定性 ─────────────────────────────────────────────────────────────────
test('deterministic: same input → identical output', () => {
  const a = sfe.explainStartupFailure(moduleNotFound('ws'), 'linux', {});
  const b = sfe.explainStartupFailure(moduleNotFound('ws'), 'linux', {});
  assert.strictEqual(a, b);
});

// ── 接线契约：_emitFatal 必须防御式引用并 gate-off 逐字节回退 ────────────────
test('wiring: bin/khy.js _emitFatal defensively requires the explainer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bin', 'khy.js'),
    'utf8',
  );
  // 引用了归因叶子
  assert.ok(
    src.includes("require('../src/bootstrap/startupFailureExplain')"),
    '_emitFatal 须引用 startupFailureExplain',
  );
  assert.ok(src.includes('explainStartupFailure('), '须调用 explainStartupFailure');
  // 仅在有归因时追加（gate-off / null → 不动 msg = 逐字节回退）
  assert.ok(src.includes('if (explain) msg += explain'), 'null 时不得改动 msg');
  // 引用被 try/catch 包裹（崩溃现场依赖可能缺，绝不加重致命路径）
  const idx = src.indexOf("require('../src/bootstrap/startupFailureExplain')");
  const before = src.lastIndexOf('try {', idx);
  const catchAfter = src.indexOf('catch', idx);
  assert.ok(before !== -1 && catchAfter !== -1 && before < idx && idx < catchAfter,
    '归因引用须包在 try/catch 内');
});

// ── 绝不抛：即使 err 是恶意 getter ─────────────────────────────────────────
test('never throws on hostile error object', () => {
  const evil = {};
  Object.defineProperty(evil, 'code', { get() { throw new Error('nope'); } });
  Object.defineProperty(evil, 'message', { get() { throw new Error('nope'); } });
  let out;
  assert.doesNotThrow(() => { out = sfe.explainStartupFailure(evil, 'linux', {}); });
  assert.ok(out === null || typeof out === 'string');
});
