'use strict';

/**
 * glmVisionTextBudget.test.js — GLM 视觉模型超大文本预算截断叶子(纯字符串运算)契约锁。
 *
 * 根因回归(排障「为什么会出现剪贴板中转模式」/ 1210 第三形态):
 *   无图的大文本工具结果(磁盘扫描,实测约 25304 input token)撞 GLM 视觉端合并预算
 *   `inputs + max_new_tokens <= 16384` → 恒 400 code 1210 → 网关级联耗尽 → 落剪贴板兜底。
 *   前两个 1210 修(max_tokens 钳位 / 单图降采样)只管图,大文本它们都不触发。本叶子:命中
 *   GLM 视觉模型 + 门控开 + 估算超预算 → 中段截断最大文本块(保头保尾 + 标记),预算内 0 成本透传。
 *
 * 锁死:
 *   - 命中 GLM 视觉模型(含 provider 前缀)+ 超预算 → 截断且 afterTokens ≤ budget;
 *   - 只削最大块,小系统/用户提示原样保留;
 *   - 预算内(小文本)→ changed=false、内容逐字节不变;
 *   - 非视觉模型 → 原样不动;门控关(0/false/off/no)→ 逐字节回退;
 *   - 支持 string content 与 array text 块(OpenAI/Responses/Anthropic 同形);
 *   - 绝不抛(null messages / 非字符串 model / 怪异 env)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../../../src/services/gateway/glmVisionTextBudget');

const ON = {}; // 缺省 env → 默认开

// ~27000-token 纯 ASCII「磁盘扫描」文本(每段约 30 字符,重复 3200 次)。
function bigAscii() {
  return 'C:\\path\\file.tmp 12345 bytes; '.repeat(3200);
}

test('常量:合并预算 16384、默认输入预算 14000', () => {
  assert.strictEqual(L.COMBINED_TOKEN_BUDGET, 16384);
  assert.strictEqual(L.DEFAULT_INPUT_BUDGET, 14000);
});

test('estimateTextTokens:CJK 偏高估、ASCII 偏低;空串 0', () => {
  assert.strictEqual(L.estimateTextTokens(''), 0);
  assert.strictEqual(L.estimateTextTokens(null), 0);
  // CJK 1 char/token → 5 字 ≈ 5 token
  assert.strictEqual(L.estimateTextTokens('你好世界啊'), 5);
  // ASCII 3.5 char/token → 大文本远小于其字符数
  const big = bigAscii();
  assert.ok(L.estimateTextTokens(big) > 20000, 'big ascii 应估出两万+ token');
  assert.ok(L.estimateTextTokens(big) < big.length, 'token 估计应远小于字符数');
});

test('GLM 视觉模型 + 超预算(string content)→ 截断且落进预算,标记出现', () => {
  const big = bigAscii();
  const msgs = [
    { role: 'system', content: '你是一个有用的助手。' },
    { role: 'user', content: big },
  ];
  const r = L.clampTextBudgetInMessages('glm-4v-flash', msgs, { maxTokens: 1024 }, ON);
  assert.strictEqual(r.changed, true);
  assert.ok(r.beforeTokens > r.budget, 'before 应超预算');
  assert.ok(r.afterTokens <= r.budget, `after(${r.afterTokens}) 应 ≤ budget(${r.budget})`);
  assert.ok(/已截断约/.test(msgs[1].content), '大块应含截断标记');
  // 小系统提示原样保留(未被削)。
  assert.strictEqual(msgs[0].content, '你是一个有用的助手。');
});

test('带 provider 前缀亦命中(glm/glm-4.6v-flash)', () => {
  const msgs = [{ role: 'user', content: bigAscii() }];
  const r = L.clampTextBudgetInMessages('glm/glm-4.6v-flash', msgs, { maxTokens: 1024 }, ON);
  assert.strictEqual(r.changed, true);
  assert.ok(r.afterTokens <= r.budget);
});

test('array text 块(OpenAI/Responses/Anthropic 同形)→ 削最大块、小块保留', () => {
  const big = bigAscii();
  const msgs = [{
    role: 'user',
    content: [
      { type: 'text', text: big },
      { type: 'text', text: 'small tail note' },
    ],
  }];
  const r = L.clampTextBudgetInMessages('glm-4v-flash', msgs, { maxTokens: 1024 }, ON);
  assert.strictEqual(r.changed, true);
  assert.ok(r.afterTokens <= r.budget);
  assert.strictEqual(msgs[0].content[1].text, 'small tail note', '小块应原样保留');
  // input_text / output_text 变体亦识别
  const msgs2 = [{ role: 'user', content: [{ type: 'input_text', text: big }] }];
  const r2 = L.clampTextBudgetInMessages('glm-4v-flash', msgs2, { maxTokens: 1024 }, ON);
  assert.strictEqual(r2.changed, true);
  assert.ok(r2.afterTokens <= r2.budget);
});

test('图片块(image_url)不被当文本削,纯图消息 changed=false', () => {
  const msgs = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: '识别这张图' },
    ],
  }];
  const r = L.clampTextBudgetInMessages('glm-4v-flash', msgs, { maxTokens: 1024 }, ON);
  assert.strictEqual(r.changed, false, '小文本 + 图 → 不截断');
  assert.strictEqual(msgs[0].content[0].image_url.url, 'data:image/png;base64,AAAA', '图片 url 不动');
});

test('预算内(小文本)→ changed=false、内容逐字节不变', () => {
  const msgs = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '帮我看看这个错误' },
  ];
  const snapshot = JSON.stringify(msgs);
  const r = L.clampTextBudgetInMessages('glm-4v-flash', msgs, { maxTokens: 1024 }, ON);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.beforeTokens, r.afterTokens);
  assert.strictEqual(JSON.stringify(msgs), snapshot, '预算内应逐字节不变');
});

test('非视觉模型 → 原样不动', () => {
  for (const model of ['gpt-4o', 'glm-4.7-flash', 'deepseek-v3']) {
    const msgs = [{ role: 'user', content: bigAscii() }];
    const snapshot = msgs[0].content.length;
    const r = L.clampTextBudgetInMessages(model, msgs, { maxTokens: 1024 }, ON);
    assert.strictEqual(r.changed, false, `${model} 不应改动`);
    assert.strictEqual(msgs[0].content.length, snapshot, `${model} 内容不变`);
  }
});

test('门控关(0/false/off/no)→ 逐字节回退,不截断', () => {
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    const env = { KHY_GLM_VISION_TEXT_BUDGET: off };
    assert.strictEqual(L.textBudgetEnabled(env), false, `off=${off}`);
    const big = bigAscii();
    const msgs = [{ role: 'user', content: big }];
    const r = L.clampTextBudgetInMessages('glm-4v-flash', msgs, { maxTokens: 1024 }, env);
    assert.strictEqual(r.changed, false, `off=${off}`);
    assert.strictEqual(msgs[0].content, big, `off=${off} 内容不变`);
  }
});

test('门控开(缺省 / 其它值)→ 启用', () => {
  assert.strictEqual(L.textBudgetEnabled({}), true);
  assert.strictEqual(L.textBudgetEnabled({ KHY_GLM_VISION_TEXT_BUDGET: '1' }), true);
  assert.strictEqual(L.textBudgetEnabled({ KHY_GLM_VISION_TEXT_BUDGET: 'on' }), true);
});

test('inputBudget 显式覆盖 maxTokens 推算', () => {
  const big = bigAscii();
  const msgs = [{ role: 'user', content: big }];
  const r = L.clampTextBudgetInMessages('glm-4v-flash', msgs, { inputBudget: 500 }, ON);
  assert.strictEqual(r.budget, 500);
  assert.ok(r.afterTokens <= 500);
});

test('绝不抛:null messages / 非字符串 model / 怪异输入', () => {
  assert.doesNotThrow(() => L.clampTextBudgetInMessages('glm-4v-flash', null, {}, ON));
  assert.doesNotThrow(() => L.clampTextBudgetInMessages('glm-4v-flash', [], {}, ON));
  assert.doesNotThrow(() => L.clampTextBudgetInMessages(null, [{ role: 'user', content: 'x' }], {}, ON));
  assert.doesNotThrow(() => L.clampTextBudgetInMessages(12345, [{ role: 'user', content: 'x' }], {}, ON));
  // messages 含怪异条目不抛
  assert.doesNotThrow(() => L.clampTextBudgetInMessages('glm-4v-flash', [null, 1, { content: 42 }, { role: 'user' }], {}, ON));
  const r = L.clampTextBudgetInMessages(null, [{ role: 'user', content: bigAscii() }], {}, ON);
  assert.strictEqual(r.changed, false, '非字符串 model → 不动');
});

test('_middleTruncate:保头保尾,短串原样', () => {
  assert.strictEqual(L._middleTruncate('short', 100), 'short');
  const long = 'A'.repeat(1000) + 'B'.repeat(1000);
  const out = L._middleTruncate(long, 200);
  assert.ok(out.startsWith('A'), '保头');
  assert.ok(out.endsWith('B'), '保尾');
  assert.ok(/已截断约/.test(out), '含标记');
  assert.ok(out.length < long.length, '确有收缩');
});
