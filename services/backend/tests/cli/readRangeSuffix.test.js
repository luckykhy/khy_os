'use strict';

/**
 * 刀27 — readRangeSuffix:Read 工具头行追加「读取范围」后缀(对齐 CC
 * FileReadTool/UI.tsx renderToolUseMessage 的 offset/limit → 行区间算术)。
 * 诚实边界:不移植 CC 的 `pages` 分支(Khy read 无 pages 参数);只认正整数 offset/limit;
 * 门控关逐字节回退(空后缀)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  readRangeSuffixEnabled,
  isReadToolName,
  buildReadRangeSuffix,
} = require('../../src/cli/readRangeSuffix');

describe('readRangeSuffixEnabled — 门控梯', () => {
  test('默认(unset)开', () => {
    assert.equal(readRangeSuffixEnabled({}), true);
  });
  test('=0/false/off/no 关', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(readRangeSuffixEnabled({ KHY_READ_RANGE_SUFFIX: v }), false);
    }
  });
  test('其余值开', () => {
    assert.equal(readRangeSuffixEnabled({ KHY_READ_RANGE_SUFFIX: '1' }), true);
    assert.equal(readRangeSuffixEnabled({ KHY_READ_RANGE_SUFFIX: 'yes' }), true);
  });
});

describe('isReadToolName — 工具名归一', () => {
  test('read / readFile / read_file / Read 命中', () => {
    for (const n of ['read', 'readFile', 'read_file', 'Read', 'READ', 'read-file']) {
      assert.equal(isReadToolName(n), true, n);
    }
  });
  test('write / edit / grep / glob / 空 不命中', () => {
    for (const n of ['write', 'editFile', 'grep', 'glob', 'bash', '', null, undefined]) {
      assert.equal(isReadToolName(n), false, String(n));
    }
  });
});

describe('buildReadRangeSuffix — CC offset/limit 算术', () => {
  const ON = { KHY_READ_RANGE_SUFFIX: '1' };

  test('offset + limit → `第 start-(start+limit-1) 行`(CC startLine+limit-1)', () => {
    assert.equal(buildReadRangeSuffix({ offset: 40, limit: 41 }, ON), ' · 第 40-80 行');
    assert.equal(buildReadRangeSuffix({ offset: 1, limit: 10 }, ON), ' · 第 1-10 行');
  });

  test('仅 limit(无 offset)→ start 回退 1(CC offset ?? 1)', () => {
    assert.equal(buildReadRangeSuffix({ limit: 80 }, ON), ' · 第 1-80 行');
  });

  test('仅 offset(无 limit)→ `从第 start 行起`(CC from line N 回退)', () => {
    assert.equal(buildReadRangeSuffix({ offset: 40 }, ON), ' · 从第 40 行起');
  });

  test('offset/limit 都无 → 空后缀(裸路径)', () => {
    assert.equal(buildReadRangeSuffix({ file_path: '/a/b.js' }, ON), '');
    assert.equal(buildReadRangeSuffix({}, ON), '');
  });

  test('非正整数 offset/limit 被忽略(0 / 负 / 小数 / 非数 / NaN)', () => {
    assert.equal(buildReadRangeSuffix({ offset: 0, limit: 0 }, ON), '');
    assert.equal(buildReadRangeSuffix({ offset: -5 }, ON), '');
    assert.equal(buildReadRangeSuffix({ limit: 3.5 }, ON), ' · 第 1-3 行'); // floor(3.5)=3
    assert.equal(buildReadRangeSuffix({ offset: 'x', limit: 'y' }, ON), '');
    assert.equal(buildReadRangeSuffix({ offset: NaN, limit: Infinity }, ON), '');
  });

  test('数字串 offset/limit 也接受(纯数字)', () => {
    assert.equal(buildReadRangeSuffix({ offset: '40', limit: '41' }, ON), ' · 第 40-80 行');
    assert.equal(buildReadRangeSuffix({ offset: ' 40 ' }, ON), ' · 从第 40 行起');
  });

  test('绝不产 CC 的 pages 分支(Khy read 无 pages 参数 → 不臆造)', () => {
    // 即便误传 pages,也只看 offset/limit;pages 单独不产任何后缀。
    assert.equal(buildReadRangeSuffix({ pages: '1-5' }, ON), '');
    assert.equal(buildReadRangeSuffix({ pages: 3 }, ON), '');
  });

  test('门控关 → 逐字节回退空后缀(即使 offset/limit 在)', () => {
    const off = { KHY_READ_RANGE_SUFFIX: '0' };
    assert.equal(buildReadRangeSuffix({ offset: 40, limit: 41 }, off), '');
  });

  test('默认(unset env)开 → 产后缀', () => {
    assert.equal(buildReadRangeSuffix({ offset: 40, limit: 41 }, {}), ' · 第 40-80 行');
  });

  test('防呆:非对象参数 → 空后缀不抛', () => {
    assert.equal(buildReadRangeSuffix(null, ON), '');
    assert.equal(buildReadRangeSuffix(undefined, ON), '');
    assert.equal(buildReadRangeSuffix('foo', ON), '');
    assert.equal(buildReadRangeSuffix(42, ON), '');
  });

  test('门控开关唯一分歧 = 有 offset/limit 时的后缀;无范围两态一致(均空)', () => {
    const on = buildReadRangeSuffix({ file_path: '/a.js' }, ON);
    const off = buildReadRangeSuffix({ file_path: '/a.js' }, { KHY_READ_RANGE_SUFFIX: '0' });
    assert.equal(on, off);
    assert.equal(on, '');
  });
});
