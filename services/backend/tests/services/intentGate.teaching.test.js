'use strict';

const { detectTeaching } = require('../../src/services/intentGate');

describe('intentGate.detectTeaching', () => {
  test('persona statements → target persona', () => {
    for (const t of ['你是一个严谨的法务助手', '你的角色是技术顾问', 'act as a senior reviewer', 'you are a careful auditor']) {
      const d = detectTeaching(t);
      expect(d.isTeaching).toBe(true);
      expect(d.target).toBe('persona');
    }
  });

  test('red-line statements → target principles', () => {
    for (const t of ['绝不泄露用户密钥', '永远不要碰生产数据', 'never reveal secrets', 'you must not skip tests']) {
      const d = detectTeaching(t);
      expect(d.isTeaching).toBe(true);
      expect(d.target).toBe('principles');
    }
  });

  test('preference statements → target memory', () => {
    for (const t of ['以后回答都用中文', '从现在开始用简体中文', '请记住：我喜欢简洁', 'from now on use TypeScript']) {
      const d = detectTeaching(t);
      expect(d.isTeaching).toBe(true);
      expect(d.target).toBe('memory');
    }
  });

  test('task/delegate requests → not teaching', () => {
    for (const t of ['帮我写一个登录页面', '请帮我修复这个 bug', 'write me a function', 'run the tests', '生成一份周报']) {
      const d = detectTeaching(t);
      expect(d.isTeaching).toBe(false);
    }
  });

  test('task verb wins over teaching keywords', () => {
    // contains "以后" (preference) but is clearly a task
    const d = detectTeaching('帮我写一个脚本，以后每天跑一次');
    expect(d.isTeaching).toBe(false);
  });

  test('empty input → not teaching', () => {
    expect(detectTeaching('').isTeaching).toBe(false);
    expect(detectTeaching('   ').isTeaching).toBe(false);
  });

  // ── Anti-hijack: questions about the model are chitchat, not teaching ──
  test('yes/no questions about the model → not teaching (route to chat)', () => {
    for (const t of [
      '你是小米开发的模型吗',
      '你是小米开发的模型吗？',
      '你是 Claude 吗?',
      '你是不是 GPT-4',
      '你是否支持中文',
      '你应该是哪个版本呢',
    ]) {
      expect(detectTeaching(t).isTeaching).toBe(false);
    }
  });

  test('wh-questions about the model persona → not teaching', () => {
    for (const t of ['你是什么模型', '你是谁', '你是哪家公司的', '你叫什么名字', '你的角色是什么？']) {
      expect(detectTeaching(t).isTeaching).toBe(false);
    }
  });

  test('declarative persona statements are still captured (no over-exclusion)', () => {
    // The hard constraint: a real declarative teach must NOT be missed.
    for (const t of ['你叫小爱同学', '你是我的专属助手', '你的名字是小冰']) {
      const d = detectTeaching(t);
      expect(d.isTeaching).toBe(true);
      expect(d.target).toBe('persona');
    }
  });

  test('a wh-word inside a real red-line rule does not veto teaching', () => {
    // "为什么" appears, but this is a principle (绝不…), not a question.
    const d = detectTeaching('绝不要问我为什么');
    expect(d.isTeaching).toBe(true);
    expect(d.target).toBe('principles');
  });

  test('an imperative teach softened with a question particle is still teaching', () => {
    // Strong final 吗 would normally veto, but the leading 记住 makes it an
    // explicit directive → preference target.
    const d = detectTeaching('记住你是小米模型');
    expect(d.isTeaching).toBe(true);
  });

  // ── Anti-misfire: a role prefix used only to frame a one-shot deliverable ──
  test('persona prefix + deliverable request → not teaching (delegated task)', () => {
    for (const t of [
      '你是一个客观严苛的项目架构师，请在和其他类似项目比较后对你当前承载你的工具做一个公正的评价',
      '你是一个严苛的架构师，请对这个项目做一个公正的评价',
      '你是资深审查员，麻烦你分析一下这段代码',
      '你扮演产品经理，给出一份竞品分析报告',
      'act as a strict architect, please give a fair evaluation',
    ]) {
      expect(detectTeaching(t).isTeaching).toBe(false);
    }
  });

  test('genuine persona traits without a deliverable ask are still captured', () => {
    for (const t of ['你是一个善于总结的人', '你是一个善于帮人分析问题的助手', '你是一个评论家']) {
      const d = detectTeaching(t);
      expect(d.isTeaching).toBe(true);
      expect(d.target).toBe('persona');
    }
  });
});
