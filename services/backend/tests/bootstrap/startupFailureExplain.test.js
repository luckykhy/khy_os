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

// ── BUG-38：ESM 方言（import() 抛 ERR_MODULE_NOT_FOUND / "Cannot find package '<路径>'"）──
// 现场来自 tui-ux-audit-20260919/AB：本机 pnpm store 内 ink 包体被清空 ⇒
// inkRuntime.loadInk() 的 `import('ink')` 崩溃。旧规则只认 CJS 的 MODULE_NOT_FOUND +
// "Cannot find module"，故 TUI 依赖崩溃落到「未识别 → 裸 stack」，用户看不到原因与修法。
function esmPackageNotFound(absHitPath) {
  const err = new Error(
    `Cannot find package '${absHitPath}' imported from ` +
      `${require('node:path').join(process.cwd(), 'src', 'inkRuntime.js')}\n` +
      'Did you mean to import "ink/build/index.js"?'
  );
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

test('ESM: ERR_MODULE_NOT_FOUND + "Cannot find package" 也被归因（不再回退裸 stack）', () => {
  // 用真实构造的路径（不硬编码绝对路径字面量，规则 RUNTIME-001）
  const hit = require('node:path').join(process.cwd(), 'node_modules', 'ink', 'index.js');
  const out = sfe.explainStartupFailure(esmPackageNotFound(hit), 'win32', {});
  assert.ok(out, 'ESM 方言必须归因出内容，不得为 null');
  // 2026-09-21：`node_modules/ink/index.js` 这种「按包根解析出的推断文件名」是
  // 空心包的指纹，归因升级为 hollow-package，措辞随之改变。
  assert.match(out, /真实原因：依赖 'ink' 是「空心」的/, '须给出真实原因');
  assert.ok(out.includes("'ink'"), `须点名包名 ink，实得：${out}`);
  assert.ok(!out.includes(hit), `归因句里不得把整条绝对路径甩给用户：${out}`);
  assertDangerFree(out);
});

test('ESM: win32 源码树用户也能拿到可照抄的修法', () => {
  const hit = require('node:path').join(process.cwd(), 'node_modules', 'ink', 'index.js');
  const out = sfe.explainStartupFailure(esmPackageNotFound(hit), 'win32', {});
  assert.match(out, /services.backend 下先 npm install/, 'Windows 源码用户须有可照抄的修法');
  const unixOut = sfe.explainStartupFailure(esmPackageNotFound(hit), 'linux', {});
  assert.match(unixOut, /services.backend 下先 npm install/);
});

test('ESM: 门关 → null（调用方逐字节回退今日裸 stack）', () => {
  const hit = require('node:path').join(process.cwd(), 'node_modules', 'ink', 'index.js');
  assert.strictEqual(
    sfe.explainStartupFailure(esmPackageNotFound(hit), 'win32', { KHY_STARTUP_FAILURE_EXPLAIN: 'off' }),
    null,
  );
});

// ── 包名归约（node 在 ESM 下打印的是**命中路径**，不是裸包名）────────────────
test('_packageNameFromSpec: 路径 → 包名（含 scoped / 反斜杠 / 嵌套 node_modules）', () => {
  const path = require('node:path');
  // 用 cwd 拼路径，避免在源码里写绝对路径字面量（RUNTIME-001）
  const underNm = (...segs) => path.join(process.cwd(), 'node_modules', ...segs);
  assert.strictEqual(sfe._packageNameFromSpec('ink'), 'ink');
  assert.strictEqual(sfe._packageNameFromSpec('@khy/shared'), '@khy/shared');
  assert.strictEqual(sfe._packageNameFromSpec(underNm('ink', 'build', 'index.js')), 'ink');
  assert.strictEqual(sfe._packageNameFromSpec(underNm('@babel', 'core', 'index.js')), '@babel/core');
  // 深层 store 形态：取**最后一个** node_modules 之后的段
  assert.strictEqual(
    sfe._packageNameFromSpec(
      path.join(underNm('.pnpm', 'x'), 'node_modules', 'react', 'index.js'),
    ),
    'react',
  );
  // 归约不出包名时回吐原串（绝不返回空，也绝不抛）
  assert.strictEqual(sfe._packageNameFromSpec(''), '');
});

test('_missingModuleName: 两种方言都能提出包名', () => {
  assert.strictEqual(sfe._missingModuleName("Cannot find module 'express'"), 'express');
  assert.strictEqual(
    sfe._missingModuleName(
      `Cannot find package '${require('node:path').join(process.cwd(), 'node_modules', 'react')}' imported from x.js`,
    ),
    'react',
  );
  assert.strictEqual(sfe._missingModuleName('boom'), '');
});

// ── 空心包 vs 真缺：2026-09-21 补 ───────────────────────────────────────────
// 同一个 MODULE_NOT_FOUND 家族里，「包目录在但内容是空的」与「包压根不在」是两种
// 病，修法不同（重装 vs 补装）。旧归因一律说「依赖未装齐…跑 npm install」——对空壳
// 无效，因为不存在性判据已全说好、marker 也写下了，重装会被短路。
// 判据（纯文本，无 IO）：ESM 命中路径 `node_modules` 之后没有任何真实目录层级。
const path = require('node:path');
const nmHit = (...segs) => path.join(process.cwd(), 'node_modules', ...segs);

test('_specPathTail: 取出 node_modules 之后的命中路径段', () => {
  assert.strictEqual(sfe._specPathTail(`Cannot find package '${nmHit('ink', 'index.js')}'`), 'ink\\index.js'.replace('\\', path.sep));
  assert.strictEqual(sfe._specPathTail("Cannot find module 'express'"), '');
  assert.strictEqual(sfe._specPathTail('boom'), '');
});

test('_looksHollow: 空壳形态判真（无真实目录层级）', () => {
  assert.strictEqual(sfe._looksHollow(`Cannot find package '${nmHit('ink', 'index.js')}'`), true);
  assert.strictEqual(sfe._looksHollow(`Cannot find package '${nmHit('ink')}'`), true);
  assert.strictEqual(sfe._looksHollow(`Cannot find package '${nmHit('@khy', 'shared', 'index.js')}'`), true);
});

test('_looksHollow: 非空壳判假（有真实目录层级 / 裸说明符）', () => {
  // 包体在、只是包内某个文件缺 → 不得误报空壳
  assert.strictEqual(sfe._looksHollow(`Cannot find package '${nmHit('ink', 'build', 'index.js')}'`), false);
  assert.strictEqual(sfe._looksHollow(`Cannot find package '${nmHit('ink', 'build', 'internal', 'x.js')}'`), false);
  // CJS 裸说明符 → 真缺，走 module-not-found
  assert.strictEqual(sfe._looksHollow("Cannot find module 'express'"), false);
  assert.strictEqual(sfe._looksHollow('boom'), false);
  assert.strictEqual(sfe._looksHollow(null), false);
});

test('空心形态 → hollow-package 归因，且给「删链接」这条真正有效的修法', () => {
  const out = sfe.explainStartupFailure(
    esmPackageNotFound(nmHit('ink', 'index.js')), 'win32', {},
  );
  assert.match(out, /「空心」/, '须说明是空心而非真缺');
  assert.match(out, /符号链接/, '须点出坏符号链接这一根因');
  assert.match(out, /node_modules 回退到上层|回退到上层完好的/, '须给「删链接即恢复」的无下载修法');
  assert.ok(!/依赖未装齐/.test(out), '空壳不得套用「未装齐」措辞（对空壳无效）');
  assertDangerFree(out);
});

test('反向验证：真缺包不得被判成空心（否则修法会指错方向）', () => {
  const out = sfe.explainStartupFailure(moduleNotFound('express'), 'linux', {});
  assert.match(out, /依赖未装齐/, '真缺仍须走原措辞');
  assert.ok(!/「空心」/.test(out), '真缺不得误报空心');
});

test('反向验证：包内文件真缺（有 build/ 层级）不得被判成空心', () => {
  const out = sfe.explainStartupFailure(
    esmPackageNotFound(nmHit('ink', 'build', 'index.js')), 'win32', {},
  );
  assert.ok(!/「空心」/.test(out), '有真实目录层级时不得误报空心');
});

test('hollow-package 必须排在 module-not-found 之前（更具体的先赢）', () => {
  const ids = sfe._CLASSIFIERS.map((c) => c.id);
  assert.ok(ids.includes('hollow-package'), 'hollow-package 须存在');
  assert.ok(ids.includes('module-not-found'), 'module-not-found 须存在');
  assert.ok(
    ids.indexOf('hollow-package') < ids.indexOf('module-not-found'),
    'hollow-package 必须在 module-not-found 之前，否则同批文案会被后者抢先匹配',
  );
});

test('反向验证：hollow-package 的 match 对真缺返回 false（防空转断言）', () => {
  const hollow = sfe._CLASSIFIERS.find((c) => c.id === 'hollow-package');
  assert.ok(hollow, 'hollow-package 分类器须存在');
  // 拿真缺的 ctx 喂它，它必须不接
  const ctxMissing = { code: 'MODULE_NOT_FOUND', message: "Cannot find module 'express'", platform: 'linux' };
  assert.strictEqual(hollow.match(ctxMissing), false, '真缺不应被 hollow 接走');
  // 拿空壳的 ctx 喂它，它必须接
  const ctxHollow = {
    code: 'ERR_MODULE_NOT_FOUND',
    message: `Cannot find package '${nmHit('ink', 'index.js')}'`,
    platform: 'linux',
  };
  assert.strictEqual(hollow.match(ctxHollow), true, '空壳须被 hollow 接走');
});

// ── BUG-38 接线契约：TUI 崩溃分支必须走同一颗归因叶子 ───────────────────────
// （该分支自成一套降级阶梯，不经过 bin/khy.js 的 _emitFatal；下面的源自愈只管
//  services/backend/src，node_modules 在其 _SKIP_DIRS 里 ⇒ 依赖崩溃无人归因。）
test('wiring: replSession 的 Ink TUI 崩溃分支防御式引用归因叶子', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', 'replSession.js'), 'utf8');
  const idx = src.indexOf('Ink TUI init failed');
  assert.ok(idx !== -1, 'TUI 崩溃分支须存在');
  const branch = src.slice(idx, idx + 2000);
  assert.ok(
    branch.includes("require('../bootstrap/startupFailureExplain')"),
    '崩溃分支须引用同一颗归因叶子（不能只靠 _emitFatal）',
  );
  assert.ok(branch.includes('explainStartupFailure('), '须调用 explainStartupFailure');
  assert.ok(branch.includes('if (explain)'), 'null 时不得改动输出（逐字节回退）');
  const reqIdx = branch.indexOf("require('../bootstrap/startupFailureExplain')");
  assert.ok(branch.lastIndexOf('try {', reqIdx) !== -1, '归因引用须包在 try/catch 内');
  assert.ok(branch.indexOf('catch', reqIdx) > reqIdx, '归因引用须有 catch 兜底');
});
