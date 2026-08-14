'use strict';

/**
 * duplicationGuard.test.js — scripts/lib/duplicationGuard.js 纯核心 in-process 单测。
 *
 * 自身不自触:本文件在 check-duplication 的 scope 外(scripts/tests/** 内建 self-ignore),
 * 且所有含重复的 fixture 都用**字符串拼接/循环**构造,源码里不出现 4 行字面重复块。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/duplicationGuard');

// ── fixture 构造器(拼接式,避免测试源码自身出现字面重复块) ─────────────────────────
// 5 行**相同有效行**的克隆体;wrapper 名不同(不参与匹配的第一行),内层 4+ 行相同。
function cloneBody() {
  return [
    "  const alpha = compute(input) + 1;",
    "  const beta = alpha * factor;",
    "  const gamma = beta - offset;",
    "  const label = 'row:' + gamma;",
    "  return { alpha, beta, gamma, label };",
  ].join('\n');
}
function fileWithClone(wrapperName, extraTailLines) {
  const tail = (extraTailLines || []).join('\n');
  return `'use strict';\nfunction ${wrapperName}(input, factor, offset) {\n${cloneBody()}\n}\n${tail}\n`;
}
// 仅 3 行相同(低于 MIN_BLOCK=4)——不应触发。三条 const 相同,return 行含 wrapperName 故不同,
// 且与 'use strict' 之间夹了不同的 function 行 → 无 4 行连续相同窗口。
function threeLineFile(wrapperName) {
  return `'use strict';\nfunction ${wrapperName}() {\n  const a = 1 + 1;\n  const b = a + 2;\n  const c = b + 3;\n  return '${wrapperName}' + c;\n}\n`;
}

describe('duplicationGuard.isEnabled — 主闸 KHY_DUPLICATION_GUARD', () => {
  test('默认(未设)开', () => {
    assert.equal(guard.isEnabled({}), true);
    assert.equal(guard.isEnabled({ KHY_OTHER: '1' }), true);
  });
  test('仅显式 0/false/off/no 关', () => {
    for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(guard.isEnabled({ KHY_DUPLICATION_GUARD: off }), false, `off-word ${off}`);
    }
    assert.equal(guard.isEnabled({ KHY_DUPLICATION_GUARD: '1' }), true);
    assert.equal(guard.isEnabled({ KHY_DUPLICATION_GUARD: 'on' }), true);
  });
});

describe('duplicationGuard.normalizeLine / isSignificant', () => {
  test('normalizeLine 折叠内部空白 + trim', () => {
    assert.equal(guard.normalizeLine('  const   x =\t1 ;  '), 'const x = 1 ;');
    assert.equal(guard.normalizeLine(''), '');
  });
  test('isSignificant 跳过空行 / 纯注释 / 纯结构标点', () => {
    assert.equal(guard.isSignificant(''), false);
    assert.equal(guard.isSignificant('// comment'), false);
    assert.equal(guard.isSignificant('# py comment'), false);
    assert.equal(guard.isSignificant('* jsdoc line'), false);
    assert.equal(guard.isSignificant('});'), false);
    assert.equal(guard.isSignificant('( ) [ ] ;'), false);
    assert.equal(guard.isSignificant('const x = 1;'), true);
  });
  test('significantLines 保留 1-based 原始行号', () => {
    const src = '\n// c\nconst a = 1;\n\nconst b = 2;\n';
    const sig = guard.significantLines(src);
    assert.deepEqual(sig.map((s) => s.lineNo), [3, 5]);
    assert.deepEqual(sig.map((s) => s.norm), ['const a = 1;', 'const b = 2;']);
  });
});

describe('duplicationGuard.assess — 集合级重复判定', () => {
  test('两文件共享 ≥4 有效行 → 每文件一条 finding(warn 模式全 warning)', () => {
    const files = [
      { relPath: 'a.js', source: fileWithClone('doAlpha') },
      { relPath: 'b.js', source: fileWithClone('doBeta') },
    ];
    const { findings, classes } = guard.assess({ files, mode: 'warn', env: {} });
    assert.equal(findings.length, 2, '两处克隆各一条');
    for (const f of findings) {
      assert.equal(f.severity, 'warning');
      assert.equal(f.rule, 'duplicate-block');
      assert.ok(Array.isArray(f.hashes) && f.hashes.length >= 1);
    }
    // a.js 的伙伴应含 b.js
    const fa = findings.find((f) => f.file === 'a.js');
    assert.match(fa.message, /b\.js/);
    assert.ok(classes.length >= 1, 'classes 至少一个克隆类');
    assert.equal(classes[0].lines, 4);
    assert.equal(classes[0].occurrences, 2);
  });

  test('仅 3 行相同(< MIN_BLOCK)→ 无 finding', () => {
    const files = [
      { relPath: 'a.js', source: threeLineFile('fnA') },
      { relPath: 'b.js', source: threeLineFile('fnB') },
    ];
    const { findings } = guard.assess({ files, mode: 'warn', env: {} });
    assert.equal(findings.length, 0);
  });

  test('gate 模式:hash ∈ baseline → warning;∉ baseline → error', () => {
    const files = [
      { relPath: 'a.js', source: fileWithClone('doAlpha') },
      { relPath: 'b.js', source: fileWithClone('doBeta') },
    ];
    // 先 warn 取 classes 的 hash 作基线。
    const warn = guard.assess({ files, mode: 'warn', env: {} });
    const knownHashes = warn.classes.map((c) => c.hash);

    // 空基线 → 全新重复 → error。
    const empty = guard.assess({ files, mode: 'gate', baseline: { entries: [] }, env: {} });
    assert.ok(empty.findings.every((f) => f.severity === 'error'), '空基线下全部 error');

    // 全 hash 入基线 → 既有 → warning。
    const known = guard.assess({ files, mode: 'gate', baseline: { entries: knownHashes.map((h) => ({ hash: h })) }, env: {} });
    assert.ok(known.findings.every((f) => f.severity === 'warning'), '入基线后降为 warning');

    // baseline 也接受 hash 数组 / Set 形态。
    const asArray = guard.assess({ files, mode: 'gate', baseline: knownHashes, env: {} });
    assert.ok(asArray.findings.every((f) => f.severity === 'warning'));
    const asSet = guard.assess({ files, mode: 'gate', baseline: new Set(knownHashes), env: {} });
    assert.ok(asSet.findings.every((f) => f.severity === 'warning'));
  });

  test('门关(KHY_DUPLICATION_GUARD=off)→ 空判定(逐字节回退)', () => {
    const files = [
      { relPath: 'a.js', source: fileWithClone('doAlpha') },
      { relPath: 'b.js', source: fileWithClone('doBeta') },
    ];
    const { findings, classes } = guard.assess({ files, mode: 'warn', env: { KHY_DUPLICATION_GUARD: 'off' } });
    assert.equal(findings.length, 0);
    assert.equal(classes.length, 0);
  });

  test('确定性:同输入两次 findings 完全一致', () => {
    const files = [
      { relPath: 'z.js', source: fileWithClone('zz') },
      { relPath: 'a.js', source: fileWithClone('aa') },
    ];
    const r1 = guard.assess({ files, mode: 'warn', env: {} });
    const r2 = guard.assess({ files, mode: 'warn', env: {} });
    assert.deepEqual(r1.findings, r2.findings);
    // 排序:findings 按 file 升序 → a.js 在 z.js 前。
    assert.equal(r1.findings[0].file, 'a.js');
  });

  test('minBlock 可覆盖:设 3 → 3 行相同也触发', () => {
    const files = [
      { relPath: 'a.js', source: threeLineFile('fnA') },
      { relPath: 'b.js', source: threeLineFile('fnB') },
    ];
    const { findings } = guard.assess({ files, mode: 'warn', minBlock: 3, env: {} });
    assert.ok(findings.length >= 1, 'minBlock=3 时 3 行相同应触发');
  });

  test('fail-soft:畸形入参绝不抛', () => {
    assert.doesNotThrow(() => guard.assess());
    assert.doesNotThrow(() => guard.assess({}));
    assert.doesNotThrow(() => guard.assess({ files: null, env: {} }));
    assert.doesNotThrow(() => guard.assess({ files: [null, { relPath: 5 }, { relPath: 'x.js', source: null }], env: {} }));
    const r = guard.assess({ files: [{ relPath: 'x.js', source: null }], env: {} });
    assert.deepEqual(r.findings, []);
  });
});
