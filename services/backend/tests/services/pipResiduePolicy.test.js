'use strict';

/**
 * pipResiduePolicy.test.js — pip 半装残骸识别与受限清理计划纯叶子的单元测试(node:test)。
 *
 * 覆盖:parseInvalidDistResidue 解析 pip 告警、isPurgeableResidueName 只认 khy 家族 `~` 残骸、
 * buildResiduePurgePlan 门控 + 只删家族 + 去重 + 绝不误删他人残骸、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const p = require('../../src/services/pipResiduePolicy');

test('parseInvalidDistResidue: 解析单条 `~` 前缀残骸告警', () => {
  const out = p.parseInvalidDistResidue(
    'WARNING: Ignoring invalid distribution ~hy-os (C:\\Python\\Lib\\site-packages)'
  );
  assert.deepStrictEqual(out, [{ name: '~hy-os', location: 'C:\\Python\\Lib\\site-packages' }]);
});

test('parseInvalidDistResidue: 多条 + 去重', () => {
  const text =
    'WARNING: Ignoring invalid distribution ~hy-os (C:\\sp)\n' +
    'WARNING: Ignoring invalid distribution ~hy_os-0.1.188.dist-info (C:\\sp)\n' +
    'WARNING: Ignoring invalid distribution ~hy-os (C:\\sp)\n';
  const out = p.parseInvalidDistResidue(text);
  assert.strictEqual(out.length, 2);
});

test('parseInvalidDistResidue: 忽略非 `~` 前缀(真包名不误伤)', () => {
  const out = p.parseInvalidDistResidue('Ignoring invalid distribution khy-os (C:\\sp)');
  assert.deepStrictEqual(out, []);
});

test('parseInvalidDistResidue: 坏输入绝不抛', () => {
  assert.deepStrictEqual(p.parseInvalidDistResidue(null), []);
  assert.deepStrictEqual(p.parseInvalidDistResidue(undefined), []);
  assert.deepStrictEqual(p.parseInvalidDistResidue(12345), []);
});

test('isPurgeableResidueName: 认 khy 家族 `~` 残骸', () => {
  assert.strictEqual(p.isPurgeableResidueName('~hy-os'), true);
  assert.strictEqual(p.isPurgeableResidueName('~hy_os-0.1.188.dist-info'), true);
  assert.strictEqual(p.isPurgeableResidueName('~hy-quant'), true);
});

test('isPurgeableResidueName: 拒非 `~` 前缀 / 非家族 / 词干误伤', () => {
  assert.strictEqual(p.isPurgeableResidueName('khy-os'), false); // 真包
  assert.strictEqual(p.isPurgeableResidueName('~requests'), false); // 他人残骸绝不删
  assert.strictEqual(p.isPurgeableResidueName('~hy-oscar'), false); // 词干后非分隔符
  assert.strictEqual(p.isPurgeableResidueName(''), false);
  assert.strictEqual(p.isPurgeableResidueName(null), false);
});

test('buildResiduePurgePlan: 门关 → 空计划(逐字节回退)', () => {
  const plan = p.buildResiduePurgePlan({
    entries: [{ location: '/sp', name: '~hy-os' }],
    env: { KHY_PIP_RESIDUE_PURGE: 'off' },
  });
  assert.deepStrictEqual(plan, { shouldPurge: false, targets: [], message: '' });
});

test('buildResiduePurgePlan: 门开 → 仅家族 `~` 残骸入计划,他人残骸/真包被排除', () => {
  const plan = p.buildResiduePurgePlan({
    entries: [
      { location: '/sp', name: '~hy-os' },
      { location: '/sp', name: '~hy_os-0.1.188.dist-info' },
      { location: '/sp', name: '~requests' },   // 他人残骸,绝不删
      { location: '/sp', name: 'khy_os-0.1.188.dist-info' }, // 真包,绝不删
    ],
    pathSep: '/',
    env: {},
  });
  assert.strictEqual(plan.shouldPurge, true);
  assert.deepStrictEqual(plan.targets, ['/sp/~hy-os', '/sp/~hy_os-0.1.188.dist-info']);
});

test('buildResiduePurgePlan: 去重 + 尾分隔符归一', () => {
  const plan = p.buildResiduePurgePlan({
    entries: [
      { location: '/sp/', name: '~hy-os' },
      { location: '/sp', name: '~hy-os' },
    ],
    pathSep: '/',
    env: {},
  });
  assert.deepStrictEqual(plan.targets, ['/sp/~hy-os']);
});

test('buildResiduePurgePlan: 无残骸 → 空计划;坏输入绝不抛', () => {
  assert.strictEqual(p.buildResiduePurgePlan({ entries: [], env: {} }).shouldPurge, false);
  assert.strictEqual(p.buildResiduePurgePlan(null).shouldPurge, false);
  assert.strictEqual(p.buildResiduePurgePlan({ entries: 'bad' }).shouldPurge, false);
});
