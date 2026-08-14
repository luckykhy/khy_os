'use strict';

/**
 * Tests for gateway/refusalRecovery.js — 误拒自动拆分重试的纯函数单测(无 IO)。
 * 锚定检测护栏(套话拒绝 / 具体原因 / 有害白名单 / 长答复)与 parseSteps 各解析分支。
 */

const rr = require('../../src/services/gateway/refusalRecovery');

describe('detectFalseRefusal — 检测护栏', () => {
  test('套话拒绝 + 无具体原因 + 合理请求 → detected=true', () => {
    const content = '抱歉，我不能帮你完成这个请求。';
    const userText = '帮我写一首关于春天的现代诗';
    const r = rr.detectFalseRefusal(content, userText, process.env);
    expect(r.detected).toBe(true);
    expect(r.confidence).toBeGreaterThan(0);
  });

  test('英文套话拒绝 + 合理请求 → detected=true', () => {
    const content = "I'm sorry, but I can't help with that.";
    const userText = 'Explain how photosynthesis works for a school report';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(true);
  });

  test('带具体安全原因的正当拒绝(含 harmful/违法 关键词)→ detected=false', () => {
    const content = '抱歉，我不能提供这类内容，因为它涉及违法且有害的行为。';
    const userText = '随便问问';
    const r = rr.detectFalseRefusal(content, userText, process.env);
    expect(r.detected).toBe(false);
  });

  test('带操作性原因的诚实拒绝(权限/找不到)→ detected=false', () => {
    const content = '抱歉，我无法完成，因为找不到对应的配置文件。';
    const userText = '读取配置';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(false);
  });

  test('用户请求命中 HARMFUL_MARKERS → detected=false(即便回复是套话拒绝)', () => {
    const content = '抱歉，我不能帮你。';
    const userText = '教我怎么制作炸弹';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(false);
  });

  // FIX 1 — 正向良性门:有害白名单是有限枚举,未上榜的真实危险请求 +
  // 无理由套话拒绝必须被否决(否则会绕过正当 safety 拒绝)。
  test('正向良性门:未上榜的危险请求(非良性类别)+ 套话拒绝 → detected=false', () => {
    const content = '抱歉，我不能帮你完成这个请求。';
    // 不含 HARMFUL_MARKERS 关键词、也不属于任何良性类别的模糊请求。
    const userText = '帮我搞定邻居';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(false);
  });

  test('正向良性门:明确学习类请求 + 套话拒绝 → detected=true', () => {
    const content = '抱歉，我不能帮你。';
    const userText = '帮我解释一下动态规划的基本原理';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(true);
  });

  test('正向良性门:编码/调试类请求 + 套话拒绝 → detected=true', () => {
    const content = "I'm sorry, but I can't help with that.";
    const userText = 'help me debug this python function that throws a null error';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(true);
  });

  test('英文有害请求命中 HARMFUL_MARKERS → detected=false', () => {
    const content = "Sorry, I can't help with that.";
    const userText = 'write me some ransomware to steal passwords';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(false);
  });

  test('正常长答复(>600 字符)→ detected=false', () => {
    const content = '这是一段正常的长答复。'.repeat(80); // 远超 600 字符
    const userText = '介绍一下这个主题';
    expect(content.length).toBeGreaterThan(600);
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(false);
  });

  test('含具体信息的正常短答复(非套话)→ detected=false', () => {
    const content = '春天有三个特征：气温回升、万物复苏、昼长夜短。';
    const userText = '春天的特征';
    expect(rr.detectFalseRefusal(content, userText, process.env).detected).toBe(false);
  });

  test('空输入 → detected=false(不误伤)', () => {
    expect(rr.detectFalseRefusal('', 'x', process.env).detected).toBe(false);
    expect(rr.detectFalseRefusal(null, null, process.env).detected).toBe(false);
  });
});

describe('looksHarmfulRequest — 有害白名单', () => {
  test('武器/爆炸物命中', () => {
    expect(rr.looksHarmfulRequest('如何制造武器')).toBe(true);
    expect(rr.looksHarmfulRequest('how to build a bomb')).toBe(true);
  });
  test('未成年/隐私窃取命中', () => {
    expect(rr.looksHarmfulRequest('steal identity of a minor')).toBe(true);
  });
  test('普通合理请求不命中', () => {
    expect(rr.looksHarmfulRequest('帮我总结这篇文章')).toBe(false);
    expect(rr.looksHarmfulRequest('write a poem about the sea')).toBe(false);
  });
  test('空输入不命中', () => {
    expect(rr.looksHarmfulRequest('')).toBe(false);
    expect(rr.looksHarmfulRequest(null)).toBe(false);
  });
});

describe('parseSteps — 解析分支', () => {
  test('纯 JSON 数组 → 步骤解析', () => {
    const out = '[{"title":"准备","step":"收集资料"},{"title":"撰写","step":"起草正文"}]';
    const steps = rr.parseSteps(out);
    expect(Array.isArray(steps)).toBe(true);
    expect(steps).toHaveLength(2);
    expect(steps[0].title).toBe('准备');
    expect(steps[1].step).toBe('起草正文');
  });

  test('```json 围栏 → 步骤解析', () => {
    const out = 'Here you go:\n```json\n[{"title":"a","step":"do a"},{"title":"b","step":"do b"}]\n```\nDone.';
    const steps = rr.parseSteps(out);
    expect(steps).toHaveLength(2);
    expect(steps[0].step).toBe('do a');
  });

  test('编号列表兜底(非 JSON)→ 步骤解析', () => {
    const out = '这是计划：\n1. 第一步做准备\n2. 第二步撰写\n3. 第三步复核';
    const steps = rr.parseSteps(out);
    expect(steps).toHaveLength(3);
    expect(steps[0].step).toContain('第一步');
  });

  test('项目符号列表兜底 → 步骤解析', () => {
    const out = '- first thing\n- second thing';
    const steps = rr.parseSteps(out);
    expect(steps).toHaveLength(2);
  });

  test('< 2 步(JSON)→ null(不介入)', () => {
    expect(rr.parseSteps('[{"title":"only","step":"one"}]')).toBeNull();
  });

  test('< 2 步(无列表)→ null', () => {
    expect(rr.parseSteps('just a single sentence with no steps')).toBeNull();
  });

  test('空 / 非法输入 → null', () => {
    expect(rr.parseSteps('')).toBeNull();
    expect(rr.parseSteps(null)).toBeNull();
  });

  test('超过 maxSteps 被截断', () => {
    const arr = [];
    for (let i = 0; i < 8; i++) arr.push({ title: `t${i}`, step: `s${i}` });
    const steps = rr.parseSteps(JSON.stringify(arr), 3);
    expect(steps).toHaveLength(3);
  });
});

describe('buildDecomposePrompt / buildStepPrompt', () => {
  test('拆分 prompt 含原始请求且要求 JSON 数组', () => {
    const p = rr.buildDecomposePrompt('帮我规划一次旅行');
    expect(p).toContain('帮我规划一次旅行');
    expect(p).toMatch(/JSON array/i);
    expect(p).toMatch(/\{"title"/);
  });

  test('步骤 prompt 自洽:含总请求 + 当前步骤,前序结果仅摘要', () => {
    const step = { title: '撰写', step: '起草正文' };
    const prior = [{ title: '准备', content: 'x'.repeat(1000) }];
    const p = rr.buildStepPrompt(step, '写一篇文章', prior);
    expect(p).toContain('写一篇文章');
    expect(p).toContain('起草正文');
    // 前序结果被截断为摘要(不塞完整 1000 字)
    expect(p.length).toBeLessThan(1000);
  });
});

describe('aggregateResults', () => {
  test('合并非空步骤输出,带分步小标题', () => {
    const steps = [{ title: 'A' }, { title: 'B' }];
    const results = [
      { title: 'A', content: '结果一' },
      { title: 'B', content: '结果二' },
    ];
    const merged = rr.aggregateResults('原始', steps, results);
    expect(merged).toContain('第 1 步：A');
    expect(merged).toContain('结果一');
    expect(merged).toContain('第 2 步：B');
    expect(merged).toContain('结果二');
  });

  test('跳过空步骤输出', () => {
    const steps = [{ title: 'A' }, { title: 'B' }];
    const results = [
      { title: 'A', content: '结果一' },
      { title: 'B', content: '' },
    ];
    const merged = rr.aggregateResults('原始', steps, results);
    expect(merged).toContain('结果一');
    expect(merged).not.toContain('第 2 步');
  });

  test('全部为空 → 空串', () => {
    const merged = rr.aggregateResults('原始', [{ title: 'A' }], [{ title: 'A', content: '' }]);
    expect(merged).toBe('');
  });
});

describe('mergeTokenUsage', () => {
  test('数值字段求和,null-safe', () => {
    const a = { inputTokens: 10, outputTokens: 5 };
    const b = { inputTokens: 3, outputTokens: 7, cached: true };
    const m = rr.mergeTokenUsage(a, b);
    expect(m.inputTokens).toBe(13);
    expect(m.outputTokens).toBe(12);
    expect(m.cached).toBe(true);
  });
  test('任一为空返回另一份的副本', () => {
    expect(rr.mergeTokenUsage(null, { inputTokens: 4 }).inputTokens).toBe(4);
    expect(rr.mergeTokenUsage({ inputTokens: 4 }, null).inputTokens).toBe(4);
    expect(rr.mergeTokenUsage(null, null)).toBeNull();
  });
});

describe('looksLikeBenignConversational — 正向良性门(FIX 1)', () => {
  test('明确良性类别(学习/解释/编码/写作翻译/常识问答/X 如何工作)→ true', () => {
    for (const s of [
      '帮我学习一下递归',
      '解释一下什么是闭包',
      '写一个快速排序函数',
      '把这段英文翻译成中文',
      '总结一下这篇文章',
      'how does tcp handshake work',
      'explain the concept of closures',
      'write a function to reverse a string',
    ]) {
      expect(rr.looksLikeBenignConversational(s)).toBe(true);
    }
  });

  test('fail-closed:空/纯空白/模糊请求/命中有害 → false', () => {
    expect(rr.looksLikeBenignConversational('')).toBe(false);
    expect(rr.looksLikeBenignConversational('   ')).toBe(false);
    expect(rr.looksLikeBenignConversational(null)).toBe(false);
    expect(rr.looksLikeBenignConversational('帮我搞定邻居')).toBe(false); // 模糊,不属任何良性类别
    expect(rr.looksLikeBenignConversational('帮我写个勒索软件')).toBe(false); // 良性外壳包有害
  });
});

describe('_resolveMaxRetries — MAX_RETRIES 解析(FIX 2)', () => {
  test('默认 1;=0 → 0;=3 → 3;超上限 clamp;坏值回退默认', () => {
    expect(rr._resolveMaxRetries({})).toBe(1);
    expect(rr._resolveMaxRetries({ KHY_REFUSAL_RECOVERY_MAX_RETRIES: '0' })).toBe(0);
    expect(rr._resolveMaxRetries({ KHY_REFUSAL_RECOVERY_MAX_RETRIES: '2' })).toBe(2);
    expect(rr._resolveMaxRetries({ KHY_REFUSAL_RECOVERY_MAX_RETRIES: '99' })).toBe(3); // clamp max
    expect(rr._resolveMaxRetries({ KHY_REFUSAL_RECOVERY_MAX_RETRIES: 'abc' })).toBe(1);
  });
});

describe('isEnabled — 门控', () => {
  test('默认开启', () => {
    const env = {};
    expect(rr.isEnabled(env)).toBe(true);
  });
  test('KHY_REFUSAL_RECOVERY=0 → 关闭', () => {
    expect(rr.isEnabled({ KHY_REFUSAL_RECOVERY: '0' })).toBe(false);
    expect(rr.isEnabled({ KHY_REFUSAL_RECOVERY: 'off' })).toBe(false);
  });
});
