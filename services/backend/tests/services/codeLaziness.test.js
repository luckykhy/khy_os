'use strict';

/**
 * codeLaziness.test.js — 懒人方法论纯叶子单测(node:test)。
 * 守护(goal 2026-06-27「让 Khyos 学习 ponytail 写代码方法论,尽量用代码实现」):
 *   1. env 门控默认开 / 关闭即字节回退
 *   2. detectCodingIntent 零假阳性(写代码触发;写诗/解释/翻译不触发)
 *   3. 指令含阶梯横档 + lazy: 标记约定 + 一个能跑的检查
 *   4. 强度 lite/full/ultra 文案
 *   5. harvestDebtMarkers 抽出上限/升级 + no-trigger 标记
 *   6. summarizeDebt 计数
 *   7. fail-soft
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const cl = require('../../src/services/codeLaziness');

describe('1. 门控', () => {
  test('默认开', () => {
    assert.equal(cl.isEnabled({}), true);
    assert.equal(cl.isEnabled({ KHY_CODE_LAZINESS: 'true' }), true);
  });
  test('仅显式 falsy 关闭', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(cl.isEnabled({ KHY_CODE_LAZINESS: v }), false);
    }
  });
  test('关闭后 routeCodeLaziness 返回空指令(字节回退)', () => {
    const r = cl.routeCodeLaziness({ text: '帮我写一个登录函数', env: { KHY_CODE_LAZINESS: 'off' } });
    assert.equal(r.directive, '');
  });
});

describe('2. detectCodingIntent 零假阳性', () => {
  test('写/改代码请求 → 触发', () => {
    for (const t of [
      '帮我写一个登录函数',
      '实现一个限流中间件',
      '重构这个组件',
      '修复这个 bug',
      'implement a debounce function',
      'add an endpoint for users',
      '给我写个脚本批量改名',
    ]) {
      assert.equal(cl.detectCodingIntent(t).coding, true, `应触发: ${t}`);
    }
  });
  test('非编码请求 → 不触发', () => {
    for (const t of [
      '写一首关于秋天的诗',
      '解释一下递归是什么',
      '翻译这段话成英文',
      '今天天气怎么样',
      '什么是闭包',
      '帮我算 3 + 5',
    ]) {
      assert.equal(cl.detectCodingIntent(t).coding, false, `不应触发: ${t}`);
    }
  });
  test('显式叫出 ponytail / 懒人模式 → 触发', () => {
    assert.equal(cl.detectCodingIntent('用 ponytail 方式做').explicit, true);
    assert.equal(cl.detectCodingIntent('开启懒人模式').coding, true);
  });
  test('空输入 fail-soft', () => {
    assert.equal(cl.detectCodingIntent('').coding, false);
    assert.equal(cl.detectCodingIntent(null).coding, false);
  });
});

describe('3. 指令内容', () => {
  const d = cl.routeCodeLaziness({ text: '帮我写一个登录函数' }).directive;
  test('命中编码意图即注入', () => {
    assert.ok(d.length > 0);
    assert.match(d, /\[SYSTEM:/);
  });
  test('含阶梯关键横档', () => {
    assert.match(d, /YAGNI/);
    assert.match(d, /复用/);
    assert.match(d, /标准库/);
    assert.match(d, /一行/);
  });
  test('含 lazy: 标记约定 + 一个能跑的检查 + 修根因', () => {
    assert.match(d, /lazy:/);
    assert.match(d, /一个能跑的检查/);
    assert.match(d, /根因/);
  });
  test('非编码意图 → 空指令(系统提示词字节不变)', () => {
    assert.equal(cl.routeCodeLaziness({ text: '写一首诗' }).directive, '');
  });
});

describe('4. 强度', () => {
  test('lite/full/ultra 各自文案', () => {
    const lite = cl.buildLazinessDirective({ coding: true }, 'lite');
    const full = cl.buildLazinessDirective({ coding: true }, 'full');
    const ultra = cl.buildLazinessDirective({ coding: true }, 'ultra');
    assert.match(lite, /lite/);
    assert.match(full, /full/);
    assert.match(ultra, /ultra|极端/);
  });
  test('resolveLevel 默认 full,非法值退默认', () => {
    assert.equal(cl.resolveLevel({}), 'full');
    assert.equal(cl.resolveLevel({ KHY_CODE_LAZINESS_LEVEL: 'ultra' }), 'ultra');
    assert.equal(cl.resolveLevel({ KHY_CODE_LAZINESS_LEVEL: 'bogus' }), 'full');
  });
});

describe('5. harvestDebtMarkers', () => {
  test('抽出上限/升级 + no-trigger 标记', () => {
    const files = [
      { path: 'a.js', content: 'const x = 1; // lazy: 全局锁, 吞吐成瓶颈再换每账户锁\nfoo();' },
      { path: 'b.py', content: '# lazy: O(n^2) 扫描\nbar()' },
      { path: 'c.js', content: '// ponytail: browser has one\n<input type="date">' },
      { path: 'd.js', content: 'const ok = true; // 普通注释,不是标记' },
    ];
    const rows = cl.harvestDebtMarkers(files);
    assert.equal(rows.length, 3);
    const a = rows.find((r) => r.file === 'a.js');
    assert.equal(a.line, 1);
    assert.match(a.ceiling, /全局锁/);
    assert.match(a.upgrade, /每账户锁/);
    assert.equal(a.hasTrigger, true);
    const b = rows.find((r) => r.file === 'b.py');
    assert.equal(b.hasTrigger, false); // 无升级路径 → 会烂掉
  });
  test('fail-soft:非数组返回空', () => {
    assert.deepEqual(cl.harvestDebtMarkers(null), []);
    assert.deepEqual(cl.harvestDebtMarkers(undefined), []);
  });
  test('反引号代码段内的提及不进台账(假阳性防护)', () => {
    const files = [
      { path: 'doc.js', content: ' * 故意的简化必须留 `// lazy: <上限>, <升级路径>` 注释\nfoo();' },
      { path: 'real.js', content: 'const x = 1; // lazy: 真标记, 真升级' },
    ];
    const rows = cl.harvestDebtMarkers(files);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file, 'real.js');
  });
});

describe('6. summarizeDebt', () => {
  test('计数 total / noTrigger / byFile', () => {
    const rows = [
      { file: 'a.js', hasTrigger: true },
      { file: 'a.js', hasTrigger: false },
      { file: 'b.js', hasTrigger: false },
    ];
    const s = cl.summarizeDebt(rows);
    assert.equal(s.total, 3);
    assert.equal(s.noTrigger, 2);
    assert.equal(s.byFile['a.js'], 2);
  });
});
