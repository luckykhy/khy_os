'use strict';

/**
 * upstreamStudyPlan 纯叶子测试 —— UpstreamStudy 的「怎么改」决策层:
 *   portabilityOf → 能改/不能改(forbidden/caution/safe)
 *   portWaveOf    → 先改/后改波次(0 读 → 1 契约/配置 → 2 实现 → 3 测试)
 *   buildStudyPlan→ 按波次分组 + forbidden 桶
 * 门控 KHY_UPSTREAM_STUDY_PLAN,关 ⇒ 逐字节回退(空档/null)。确定性、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const plan = require('../src/services/upstreamStudyPlan');

const ON = {};                                 // 默认 on
const OFF = { KHY_UPSTREAM_STUDY_PLAN: '0' };

// ── portabilityOf ─────────────────────────────────────────────────────
test('portabilityOf:许可证/法律文件 → forbidden(哪怕被归成 doc 精华)', () => {
  for (const p of ['proj/LICENSE.md', 'proj/COPYING', 'proj/NOTICE.txt', 'proj/AUTHORS']) {
    const v = plan.portabilityOf({ path: p, bucket: 'doc' }, ON);
    assert.strictEqual(v.verdict, 'forbidden', p);
    assert.ok(v.reason.includes('许可证') || v.reason.includes('法律'));
  }
});

test('portabilityOf:糟粕/非精华桶 → forbidden', () => {
  for (const bucket of ['vendored', 'lockfile', 'binary', 'secret', 'minified', '']) {
    const v = plan.portabilityOf({ path: 'proj/x', bucket }, ON);
    // 空 bucket 走 safe 兜底(无 bucket 信息时不武断禁止);其余非精华桶 forbidden
    if (bucket === '') assert.strictEqual(v.verdict, 'safe');
    else assert.strictEqual(v.verdict, 'forbidden', bucket);
  }
});

test('portabilityOf:config/changelog → caution', () => {
  assert.strictEqual(plan.portabilityOf({ path: 'proj/Cargo.toml', bucket: 'config' }, ON).verdict, 'caution');
  assert.strictEqual(plan.portabilityOf({ path: 'proj/CHANGELOG.md', bucket: 'changelog' }, ON).verdict, 'caution');
});

test('portabilityOf:源码/测试/一般文档 → safe', () => {
  assert.strictEqual(plan.portabilityOf({ path: 'proj/src/app.rs', bucket: 'source' }, ON).verdict, 'safe');
  assert.strictEqual(plan.portabilityOf({ path: 'proj/tests/t.rs', bucket: 'test' }, ON).verdict, 'safe');
  assert.strictEqual(plan.portabilityOf({ path: 'proj/docs/guide.md', bucket: 'doc' }, ON).verdict, 'safe');
});

test('portabilityOf:门关 ⇒ 空档(逐字节回退)', () => {
  const v = plan.portabilityOf({ path: 'proj/src/app.rs', bucket: 'source' }, OFF);
  assert.deepStrictEqual(v, { verdict: '', reason: '' });
});

test('portabilityOf:坏输入不抛(null/无 path)', () => {
  assert.strictEqual(plan.portabilityOf(null, ON).verdict, 'forbidden');
  assert.ok(plan.portabilityOf({}, ON).verdict);   // 无 bucket → safe 兜底,但不抛
});

// ── portWaveOf ────────────────────────────────────────────────────────
test('portWaveOf:W0 先读 —— changelog 桶 / migration|readme 类文档', () => {
  assert.strictEqual(plan.portWaveOf({ path: 'proj/CHANGELOG.md', bucket: 'changelog' }, ON).wave, 0);
  assert.strictEqual(plan.portWaveOf({ path: 'proj/MIGRATION.md', bucket: 'doc' }, ON).wave, 0);
  assert.strictEqual(plan.portWaveOf({ path: 'proj/README.md', bucket: 'doc' }, ON).wave, 0);
});

test('portWaveOf:W1 先改 —— 配置 / .d.ts / .proto / 名含 types|schema|api', () => {
  assert.strictEqual(plan.portWaveOf({ path: 'proj/Cargo.toml', bucket: 'config' }, ON).wave, 1);
  assert.strictEqual(plan.portWaveOf({ path: 'proj/src/types.d.ts', bucket: 'source' }, ON).wave, 1);
  assert.strictEqual(plan.portWaveOf({ path: 'proj/api.proto', bucket: 'source' }, ON).wave, 1);
  assert.strictEqual(plan.portWaveOf({ path: 'proj/src/schema.rs', bucket: 'source' }, ON).wave, 1);
  assert.strictEqual(plan.portWaveOf({ path: 'proj/src/api.ts', bucket: 'source' }, ON).wave, 1);
});

test('portWaveOf:W2 再改 —— 普通源码', () => {
  assert.strictEqual(plan.portWaveOf({ path: 'proj/src/app.rs', bucket: 'source' }, ON).wave, 2);
  assert.strictEqual(plan.portWaveOf({ path: 'proj/src/ui.rs', bucket: 'source' }, ON).wave, 2);
});

test('portWaveOf:W3 最后 —— 测试', () => {
  assert.strictEqual(plan.portWaveOf({ path: 'proj/tests/app_test.rs', bucket: 'test' }, ON).wave, 3);
});

test('portWaveOf:门关 ⇒ null / 坏输入不抛', () => {
  assert.strictEqual(plan.portWaveOf({ path: 'proj/src/app.rs', bucket: 'source' }, OFF), null);
  assert.strictEqual(plan.portWaveOf(null, ON), null);
});

// ── buildStudyPlan ────────────────────────────────────────────────────
test('buildStudyPlan:能改的按波次分组、不能改的进 forbidden', () => {
  const items = [
    { path: 'proj/CHANGELOG.md', bucket: 'changelog' },      // W0 caution
    { path: 'proj/LICENSE.md', bucket: 'doc' },              // forbidden
    { path: 'proj/Cargo.toml', bucket: 'config' },           // W1 caution
    { path: 'proj/src/types.d.ts', bucket: 'source' },       // W1 safe
    { path: 'proj/src/app.rs', bucket: 'source' },           // W2 safe
    { path: 'proj/tests/t.rs', bucket: 'test' },             // W3 safe
    { path: 'proj/node_modules/x.js', bucket: 'vendored' },  // forbidden
  ];
  const out = plan.buildStudyPlan(items, ON);
  assert.ok(out && Array.isArray(out.waves));
  const byWave = Object.fromEntries(out.waves.map((w) => [w.wave, w.items.map((i) => i.path)]));
  assert.deepStrictEqual(byWave[0], ['proj/CHANGELOG.md']);
  assert.deepStrictEqual(byWave[1].sort(), ['proj/Cargo.toml', 'proj/src/types.d.ts']);
  assert.deepStrictEqual(byWave[2], ['proj/src/app.rs']);
  assert.deepStrictEqual(byWave[3], ['proj/tests/t.rs']);
  // forbidden 两项
  assert.deepStrictEqual(out.forbidden.map((f) => f.path).sort(),
    ['proj/LICENSE.md', 'proj/node_modules/x.js']);
  // 每个精华项带 portability
  const toml = out.waves.find((w) => w.wave === 1).items.find((i) => i.path.endsWith('Cargo.toml'));
  assert.strictEqual(toml.portability, 'caution');
  assert.ok(out.note.includes('绝不整包合并'));
});

test('buildStudyPlan:空波次被过滤(只保留有条目的波)', () => {
  const out = plan.buildStudyPlan([{ path: 'proj/src/app.rs', bucket: 'source' }], ON);
  assert.strictEqual(out.waves.length, 1);
  assert.strictEqual(out.waves[0].wave, 2);
});

test('buildStudyPlan:门关 ⇒ null / 坏输入不抛', () => {
  assert.strictEqual(plan.buildStudyPlan([{ path: 'x', bucket: 'source' }], OFF), null);
  const out = plan.buildStudyPlan(null, ON);
  assert.ok(out && Array.isArray(out.waves) && out.waves.length === 0);
});

// ── 冻结不变式 ─────────────────────────────────────────────────────────
test('WAVES 冻结且四波齐全', () => {
  assert.strictEqual(plan.WAVES.length, 4);
  assert.ok(Object.isFrozen(plan.WAVES));
  assert.deepStrictEqual(plan.WAVES.map((w) => w.wave), [0, 1, 2, 3]);
});
