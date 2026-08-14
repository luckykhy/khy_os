'use strict';

/**
 * deterministicFacts.test.js — 「不只是计算:其他有确定答案的也用代码/权威知识库给真值」单测。
 *
 * 守护(goal 2026-06-26 续句:「但也不只是计算,我希望其他能算的有确定答案的也是,本地模式能用,
 * 但有模型模式公理与定理也优先使用,不要靠模型的猜测,批判性的参考 GLM5」):
 *   1. 单位换算精确(复用 groundTruth 有理数求值器,零浮点误差):温度仿射 / 长度 / 质量 / 时间 / 存储。
 *   2. 公认常数 / 公理:SI 定义常数(光速精确)与数学常数(π/e/√2),需求值意图共现。
 *   3. 定理 / 公式:按名取权威陈述(勾股 / 欧拉 / 费马…)。
 *   4. 零假阳性:日期 / 版本 / 范围 / 普通词(转身 / 打开 / transform)/ 跨量纲不触发。
 *   5. 指令:buildFactsDirective 列真值 + 命令直接采用 + 证据标注 + 知识边界(缺则说明)。
 *   6. env 门控 KHY_DETERMINISTIC_FACTS 默认开,显式 0/false/off/no 关 → 空指令。
 *   7. 本地模式 handler 契约 isFactIntent/detectFact/executeFact/formatFact。
 *   8. fail-soft:畸形输入绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const df = require('../../src/services/deterministicFacts');

const labels = (t) => df.detectDeterministicFacts(t).map((f) => f.label);
const map = (t) => df.detectDeterministicFacts(t).map((f) => `${f.label}=${f.value}`);

describe('1. 门控', () => {
  test('默认开 / 显式关', () => {
    assert.equal(df.isEnabled({}), true);
    assert.equal(df.isEnabled(undefined), true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(df.isEnabled({ KHY_DETERMINISTIC_FACTS: v }), false, v);
    }
  });
  test('关闭后 routeDeterministicFacts 返回空指令', () => {
    const r = df.routeDeterministicFacts({ text: '光速是多少', env: { KHY_DETERMINISTIC_FACTS: 'off' } });
    assert.deepEqual(r.facts, []);
    assert.equal(r.directive, '');
  });
});

describe('2. 单位换算(精确)', () => {
  test('温度仿射:摄氏/华氏/开尔文', () => {
    assert.deepEqual(map('100摄氏度转华氏度'), ['100 摄氏度 → 华氏度=212']);
    assert.deepEqual(map('32华氏度等于多少摄氏度'), ['32 华氏度 → 摄氏度=0']);
    assert.deepEqual(map('0摄氏度等于多少开尔文'), ['0 摄氏度 → 开尔文=273.15']);
    assert.deepEqual(map('37摄氏度是多少华氏度'), ['37 摄氏度 → 华氏度=98.6']);
  });
  test('长度:精确,含英制', () => {
    assert.deepEqual(map('5千米等于多少米'), ['5 千米 → 米=5000']);
    assert.deepEqual(map('1英里换算成米'), ['1 英里 → 米=1609.344']);
    assert.deepEqual(map('3.5英寸等于多少厘米'), ['3.5 英寸 → 厘米=8.89']);
  });
  test('质量 / 时间', () => {
    assert.deepEqual(map('5kg转克'), ['5 千克 → 克=5000']);
    assert.deepEqual(map('1斤等于多少克'), ['1 斤 → 克=500']);
    assert.deepEqual(map('2小时等于多少秒'), ['2 小时 → 秒=7200']);
  });
  test('存储:SI(1000)与二进制(1024)分明', () => {
    assert.deepEqual(map('1GiB是多少字节'), ['1 GiB → 字节=1073741824']);
    assert.deepEqual(map('1024MB等于多少GB'), ['1024 MB → GB=1.024']);
  });
  test('无限循环换算给近似 + 最简分数', () => {
    const r = df.detectDeterministicFacts('1厘米等于多少英寸');
    assert.equal(r.length, 1);
    assert.ok(r[0].value.includes('…'), r[0].value); // 1cm = 50/127 inch 非有限小数
    assert.ok(r[0].value.includes('/'), r[0].value);
  });
  test('跨量纲不可换 → 不触发(强零误报护栏)', () => {
    assert.deepEqual(labels('5米等于多少克'), []);
    assert.deepEqual(labels('100摄氏度等于多少米'), []);
  });
});

describe('3. 常数 / 公理(需求值意图)', () => {
  test('SI 定义常数精确', () => {
    assert.deepEqual(map('光速是多少'), ['真空光速 c=299792458 m/s']);
    assert.ok(map('普朗克常数等于多少')[0].includes('6.62607015'));
    assert.ok(map('阿伏伽德罗常数是多少')[0].includes('6.02214076'));
  });
  test('数学常数高精度', () => {
    assert.ok(map('圆周率π的精确值')[0].startsWith('圆周率 π=3.14159265358979323846'));
    assert.ok(map('自然常数e是多少')[0].includes('2.71828182845904523536'));
    assert.ok(map('根号2等于多少')[0].includes('1.41421356237309504880'));
  });
  test('实验测量常数标注不确定度(GLM5 证据边界)', () => {
    const r = df.detectDeterministicFacts('万有引力常数是多少');
    assert.equal(r.length, 1);
    assert.ok(r[0].source.includes('不确定度'), r[0].source);
  });
  test('无求值意图不触发(光速很快 ≠ 求值)', () => {
    assert.deepEqual(labels('光速很快但有限'), []);
    assert.deepEqual(labels('普朗克常数在量子力学里很重要'), []);
  });
});

describe('4. 定理 / 公式(按名)', () => {
  test('权威陈述', () => {
    assert.ok(map('勾股定理是什么')[0].includes('a² + b² = c²'));
    assert.deepEqual(map('欧拉恒等式'), ['欧拉恒等式=e^(iπ) + 1 = 0']);
    assert.ok(labels('费马小定理的内容').includes('费马小定理'));
    assert.ok(labels('三角形内角和是多少').includes('三角形内角和'));
  });
});

describe('5. 零假阳性', () => {
  test('日期 / 版本 / 范围 / 普通词不触发', () => {
    for (const t of [
      '2024-01-01 到 2024-03-05 之间', '升级到版本 1.2.3', '买 3-5 个',
      '我转身离开', 'transform this code', '他打开了门', 'page 1-2',
      'a/b/c 路径', '5 minutes in total', '5米的距离很长',
    ]) {
      assert.deepEqual(labels(t), [], t);
    }
  });
});

describe('6. 指令', () => {
  test('空 facts → 空串', () => {
    assert.equal(df.buildFactsDirective([]), '');
    assert.equal(df.buildFactsDirective(null), '');
  });
  test('列真值 + 命令直接采用 + 证据标注 + 知识边界', () => {
    const d = df.routeDeterministicFacts({ text: '光速是多少,顺便 5千米等于多少米' }).directive;
    assert.ok(d.includes('[SYSTEM:'));
    assert.ok(d.includes('禁止凭记忆改写'));
    assert.ok(d.includes('299792458 m/s'));
    assert.ok(d.includes('5 千米 → 米 = 5000'));
    assert.ok(d.includes('来源:')); // 证据标注
    assert.ok(d.includes('缺少可靠依据')); // 知识边界(GLM5)
  });
});

describe('7. 本地模式 handler 契约', () => {
  test('isFactIntent / detectFact / executeFact / formatFact', () => {
    assert.equal(df.isFactIntent('光速是多少'), true);
    assert.equal(df.isFactIntent('今天天气不错'), false);
    assert.equal(df.isFactIntent('光速是多少', undefined), true);
    const plan = df.detectFact('100摄氏度转华氏度');
    assert.equal(plan.type, 'deterministic_fact');
    assert.equal(plan.facts.length, 1);
    const res = df.executeFact(plan);
    assert.equal(res.success, true);
    const out = df.formatFact(res);
    assert.ok(out.includes('212'), out);
  });
  test('门控关 → isFactIntent false', () => {
    process.env.KHY_DETERMINISTIC_FACTS = 'off';
    try { assert.equal(df.isFactIntent('光速是多少'), false); }
    finally { delete process.env.KHY_DETERMINISTIC_FACTS; }
  });
  test('detectFact 无命中 → null', () => {
    assert.equal(df.detectFact('随便聊聊'), null);
  });
});

describe('8. fail-soft', () => {
  test('畸形输入绝不抛', () => {
    for (const t of [null, undefined, '', 123, {}, [], ' �', '转'.repeat(500), '5米转'.repeat(50)]) {
      assert.doesNotThrow(() => df.detectDeterministicFacts(t));
      assert.doesNotThrow(() => df.routeDeterministicFacts({ text: t }));
      assert.doesNotThrow(() => df.formatFact({ facts: t }));
    }
  });
  test('_convertUnit 畸形 → null,不抛', () => {
    const lk = df._UNIT_LOOKUP;
    assert.doesNotThrow(() => df._convertUnit('abc', lk['米'], lk['千米']));
  });
});
