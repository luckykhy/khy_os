'use strict';

/**
 * taskScaleDecomposeThreshold — 调低拆解阈值（goal 2026-08-07）：
 * 让中等复杂度任务（比较/多对象/复合查询）从 small 提升到 normal，从而触发
 * 计划拆解注入，而非被简单对话兜底吞掉。纯闲聊 / 简短指令仍保持 small。
 *
 * 相关修改：services/taskScale.js 新增 _COMPARE_MULTI_OBJECT 信号，
 * Rule 4/5 在命中该信号时排除 small。
 */

const assert = require('assert');

const PATH = require.resolve('../../src/services/taskScale');

function fresh() {
  delete require.cache[PATH];
  return require(PATH);
}

describe('taskScale — 调低拆解阈值（中复杂度 → normal）', () => {
  it('中复杂度比较问答从 small 提升到 normal', () => {
    const { resolveTaskScale } = fresh();
    assert.strictEqual(resolveTaskScale('对比一下SSRI类抗抑郁药、中成药和认知行为疗法对轻度抑郁症的优缺点'), 'normal');
  });

  it('多目标查询从 small 提升到 normal', () => {
    const { resolveTaskScale } = fresh();
    assert.strictEqual(resolveTaskScale('帮我查一下北京和上海明天分别的天气，顺便看看两地有哪些好玩的地方'), 'normal');
  });

  it('超短比较保持 small（防止过度拆解）', () => {
    const { resolveTaskScale } = fresh();
    // 一句话比较（< COMPARE_MIN_LEN）一眼可答，拆解是过度设计 → 保持 small。
    assert.strictEqual(resolveTaskScale('对比A和B的优缺点'), 'small');
    assert.strictEqual(resolveTaskScale('A和B有什么区别'), 'small');
  });

  it('中等长度比较提升到 normal（合理拆解）', () => {
    const { resolveTaskScale } = fresh();
    // 达到多步骤检索/对比所需长度的比较 → normal 走拆解。
    assert.strictEqual(resolveTaskScale('对比一下SSRI类抗抑郁药、中成药和认知行为疗法对轻度抑郁症的优缺点'), 'normal');
    assert.strictEqual(resolveTaskScale('帮我比较这几个方案各自的优缺点和适用场景，给出推荐'), 'normal');
  });

  it('纯闲聊保持 small（不污染简单对话）', () => {
    const { resolveTaskScale } = fresh();
    assert.strictEqual(resolveTaskScale('讲个笑话'), 'small');
    assert.strictEqual(resolveTaskScale('你好'), 'small');
  });

  it('简单状态查询保持 small', () => {
    const { resolveTaskScale } = fresh();
    assert.strictEqual(resolveTaskScale('看看服务器状态'), 'small');
  });

  it('简短无比较指令保持 small', () => {
    const { resolveTaskScale } = fresh();
    assert.strictEqual(resolveTaskScale('把文件发给我'), 'small');
  });

  it('编码任务不受影响仍为 normal/large', () => {
    const { resolveTaskScale } = fresh();
    assert.strictEqual(resolveTaskScale('帮我优化一下这个函数的性能'), 'normal');
    assert.strictEqual(resolveTaskScale('修复登录页的bug，然后添加一个退出登录的按钮'), 'normal');
  });

  it('_COMPARE_MULTI_OBJECT 导出可用且命中正确', () => {
    const { _COMPARE_MULTI_OBJECT } = fresh();
    assert.ok(_COMPARE_MULTI_OBJECT.test('对比A和B'));
    assert.ok(_COMPARE_MULTI_OBJECT.test('A和B有什么区别'));
    assert.ok(_COMPARE_MULTI_OBJECT.test('先做A再做B'));
    assert.ok(!_COMPARE_MULTI_OBJECT.test('你好'));
    assert.ok(!_COMPARE_MULTI_OBJECT.test('讲个笑话'));
  });

  it('COMPARE_MIN_LEN 导出且为正数（合理拆分门槛）', () => {
    const { COMPARE_MIN_LEN } = fresh();
    assert.ok(COMPARE_MIN_LEN > 0, 'minimum decompose length must be positive');
  });
});
