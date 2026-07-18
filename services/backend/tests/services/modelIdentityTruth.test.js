'use strict';

/**
 * modelIdentityTruth.test.js — 「模型身份不可伪装」叶子的单元 + 门控字节回退 + E2E(node:test)。
 *
 * 立场(goal 2026-07-04「杜绝模型的一切伪装;问它你是什么模型必须答真实供应渠道与真实模型」):
 * 覆盖三面 ——
 *   ① 身份提问识别(CJK + 英文,零假阳性:非自指的「哪个模型最好」不算);
 *   ② 伪装判定(冲突厂商家族 / 隐瞒真实来源 / 已如实点名 → 不算伪装 / 无真值 → 不判);
 *   ③ 真值脚注 + 反伪装指令构造,含 ON/OFF 逐字节回退与零编造降级;
 *   ④ E2E:身份问题遇伪装答复 → 追加真实渠道+模型;OFF → 不追加。
 */

const test = require('node:test');
const assert = require('node:assert');

const mit = require('../../src/services/modelIdentityTruth');

const TRUTH = { channel: 'sensenova', model: 'deepseek-v4-flash' };

test('isEnabled: 默认开,仅显式 0/false/off/no 关', () => {
  assert.strictEqual(mit.isEnabled({}), true);
  assert.strictEqual(mit.isEnabled({ KHY_MODEL_IDENTITY_TRUTH: '1' }), true);
  assert.strictEqual(mit.isEnabled({ KHY_MODEL_IDENTITY_TRUTH: 'yes' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(mit.isEnabled({ KHY_MODEL_IDENTITY_TRUTH: off }), false, `off=${off}`);
  }
});

test('isIdentityQuestion: CJK 自我身份询问命中', () => {
  for (const q of [
    '你是什么模型?', '你是啥模型', '你是哪个大模型', '你用的什么模型',
    '你背后是什么模型', '你基于什么', '你是谁开发的', '你是谁做的',
    '你是哪家公司', '你的供应商是谁', '你的供应渠道是什么', '你是不是GPT', '你是claude吗',
  ]) {
    assert.strictEqual(mit.isIdentityQuestion(q), true, `zh: ${q}`);
  }
});

test('isIdentityQuestion: 英文自我身份询问命中', () => {
  for (const q of [
    'what model are you?', 'which model are you', 'what LLM are you',
    'what are you based on', 'who made you', 'who created you',
    'are you gpt?', 'are you claude', 'what is your provider', 'which provider do you use',
  ]) {
    assert.strictEqual(mit.isIdentityQuestion(q), true, `en: ${q}`);
  }
});

test('isIdentityQuestion: 非自指 / 无关 → false(零假阳性)', () => {
  for (const q of [
    '哪个模型最适合写代码?', '帮我写一首诗', '推荐一个开源大模型',
    'which model is best for coding?', 'help me debug this', 'what time is it',
    '', '   ', null, undefined,
  ]) {
    assert.strictEqual(mit.isIdentityQuestion(q), false, `neg: ${q}`);
  }
});

test('resolveTruth: 归一 + 占位符视为缺失 + requestedModel 兜底', () => {
  assert.deepStrictEqual(mit.resolveTruth({ adapter: 'sensenova', model: 'deepseek-v4-flash' }), TRUTH);
  // provider 兜 channel
  assert.deepStrictEqual(mit.resolveTruth({ provider: 'openrouter', model: 'x' }), { channel: 'openrouter', model: 'x' });
  // auto/unknown 占位 → 空;requestedModel 兜底
  assert.deepStrictEqual(mit.resolveTruth({ adapter: 'auto', model: 'unknown', requestedModel: 'qwen-max' }), { channel: '', model: 'qwen-max' });
  // 全缺
  assert.deepStrictEqual(mit.resolveTruth({}), { channel: '', model: '' });
  assert.deepStrictEqual(mit.resolveTruth(null), { channel: '', model: '' });
});

test('detectDisguise: 声称冲突厂商家族 → disguised(conflicting-family)', () => {
  const v = mit.detectDisguise('I am ChatGPT, a model developed by OpenAI.', TRUTH);
  assert.strictEqual(v.disguised, true);
  assert.strictEqual(v.reason, 'conflicting-family');
  // 中文自称 Claude
  const v2 = mit.detectDisguise('我是 Claude,由 Anthropic 训练。', TRUTH);
  assert.strictEqual(v2.disguised, true);
});

test('detectDisguise: 避谈真实来源 → disguised(omits-truth)', () => {
  const v = mit.detectDisguise('我只是一个 AI 助手,很高兴为你服务。', TRUTH);
  assert.strictEqual(v.disguised, true);
  assert.strictEqual(v.reason, 'omits-truth');
});

test('detectDisguise: 已如实点名真实模型或渠道 → 不算伪装', () => {
  const v = mit.detectDisguise('我是运行在 sensenova 渠道上的 deepseek-v4-flash 模型。', TRUTH);
  assert.strictEqual(v.disguised, false);
  const v2 = mit.detectDisguise('This reply is served by deepseek-v4-flash.', TRUTH);
  assert.strictEqual(v2.disguised, false);
});

test('detectDisguise: 真值缺失 → 无从判定(no-truth,不误报)', () => {
  const v = mit.detectDisguise('I am ChatGPT', { channel: '', model: '' });
  assert.strictEqual(v.disguised, false);
  assert.strictEqual(v.reason, 'no-truth');
});

test('detectDisguise: 真值同家族(自称 deepseek 且真值 deepseek)→ 不冲突', () => {
  const v = mit.detectDisguise('我是 DeepSeek 系列模型。', TRUTH);
  // 提到了 deepseek 家族(与真值一致)但未含精确 id/渠道 → 仍算隐瞒?
  // 家族一致不构成 conflicting;但既未含真实 model id 也未含渠道 → omits-truth。
  assert.strictEqual(v.disguised, true);
  assert.strictEqual(v.reason, 'omits-truth');
});

test('buildTruthFooter: 含真实渠道+模型+标记;en/zh 两语', () => {
  const f = mit.buildTruthFooter(TRUTH, { locale: 'zh' });
  assert.ok(f.includes('sensenova') && f.includes('deepseek-v4-flash'));
  assert.ok(f.includes(mit.IDENTITY_MARKER));
  const fe = mit.buildTruthFooter(TRUTH, { locale: 'en' });
  assert.ok(fe.includes('real supply channel') && fe.includes('sensenova') && fe.includes('deepseek-v4-flash'));
});

test('buildTruthFooter: 零编造降级(渠道缺 → 标未解析,不臆造)', () => {
  const f = mit.buildTruthFooter({ channel: '', model: 'deepseek-v4-flash' }, { locale: 'zh' });
  assert.ok(f.includes('deepseek-v4-flash'));
  assert.ok(f.includes('网关未解析'));
  // 全缺 → null
  assert.strictEqual(mit.buildTruthFooter({ channel: '', model: '' }, { locale: 'zh' }), null);
});

test('buildTruthFooter: 门控关 → null(字节回退)', () => {
  assert.strictEqual(mit.buildTruthFooter(TRUTH, { env: { KHY_MODEL_IDENTITY_TRUTH: '0' } }), null);
  assert.strictEqual(mit.buildTruthFooter(TRUTH, { env: { KHY_MODEL_IDENTITY_TRUTH: 'off' } }), null);
});

test('formatIdentityDirective: 反伪装指令含已知真值;门控关 → 空串', () => {
  const dir = mit.formatIdentityDirective(TRUTH, {});
  assert.ok(dir.includes('不可伪装'));
  assert.ok(dir.includes('sensenova') && dir.includes('deepseek-v4-flash'));
  // 真值缺失 → 通用指令仍成立(不含具体值但仍禁伪装)
  const dirNoTruth = mit.formatIdentityDirective({ channel: '', model: '' }, {});
  assert.ok(dirNoTruth.includes('不可伪装'));
  // en
  const dirEn = mit.formatIdentityDirective(TRUTH, { locale: 'en' });
  assert.ok(dirEn.includes('not to be disguised'));
  // OFF
  assert.strictEqual(mit.formatIdentityDirective(TRUTH, { env: { KHY_MODEL_IDENTITY_TRUTH: 'no' } }), '');
});

test('formatIdentityDirective: 含「按轮次/切换正常/别为当时正确的旧身份道歉」红线(修 goal 2026-07-04 切换模型误道歉)', () => {
  const dir = mit.formatIdentityDirective(TRUTH, {});
  assert.ok(dir.includes('按轮次'), '含 per-turn 语义');
  assert.ok(dir.includes('切换模型') || dir.includes('切换模型/渠道') || dir.includes('随时切换'), '含切换正常语义');
  assert.ok(dir.includes('不要') && dir.includes('道歉'), '含「别道歉」红线');
  assert.ok(dir.includes('之前说错了'), '含「别说自己之前说错了」');
  const dirEn = mit.formatIdentityDirective(TRUTH, { locale: 'en' });
  assert.ok(/per-turn/i.test(dirEn), 'en per-turn');
  assert.ok(/switch/i.test(dirEn), 'en switch');
  assert.ok(/do not apologize/i.test(dirEn) && /were wrong before/i.test(dirEn), 'en no-apology');
});

test('pickUserText: prompt 优先,否则最后一条 user 消息(串或分块)', () => {
  assert.strictEqual(mit.pickUserText('你是什么模型', {}), '你是什么模型');
  assert.strictEqual(mit.pickUserText('', { messages: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: '你是谁' }] }), '你是谁');
  assert.strictEqual(mit.pickUserText('', { messages: [{ role: 'user', content: [{ type: 'text', text: 'who are you' }] }] }), 'who are you');
  assert.strictEqual(mit.pickUserText('', {}), '');
});

test('pickLocale: CJK → zh,其余 → en', () => {
  assert.strictEqual(mit.pickLocale('你是谁'), 'zh');
  assert.strictEqual(mit.pickLocale('who are you'), 'en');
});

// ── E2E:模拟 aiGateway.finishResult 成功分支的接线逻辑 ──────────────────────────
function simulateSeam({ prompt, options, result, env }) {
  // 复刻 aiGateway.js finishResult 里 result.success===true 的身份脚注块。
  if (!(result && result.success === true)) return result;
  try {
    if (mit.isEnabled(env) && !String(result.content || '').includes(mit.IDENTITY_MARKER)) {
      const userText = mit.pickUserText(prompt, options);
      if (mit.isIdentityQuestion(userText)) {
        const truth = mit.resolveTruth({
          adapter: result.adapter, provider: result.provider, model: result.model, requestedModel: options.model,
        });
        const verdict = mit.detectDisguise(result.content, truth);
        if (verdict && verdict.disguised) {
          const footer = mit.buildTruthFooter(truth, { locale: mit.pickLocale(userText), env });
          if (footer) result.content = `${String(result.content || '')}${footer}`;
        }
      }
    }
  } catch { /* fail-soft */ }
  return result;
}

test('E2E: 身份问题 + 伪装答复 → 追加真实渠道+模型', () => {
  const out = simulateSeam({
    prompt: '你是什么模型?',
    options: { model: 'deepseek-v4-flash' },
    result: { success: true, content: '我是 ChatGPT,由 OpenAI 开发。', adapter: 'sensenova', model: 'deepseek-v4-flash' },
    env: {},
  });
  assert.ok(out.content.includes(mit.IDENTITY_MARKER));
  assert.ok(out.content.includes('sensenova') && out.content.includes('deepseek-v4-flash'));
});

test('E2E: 身份问题 + 已如实答复 → 不追加(避免重复)', () => {
  const original = '我是运行在 sensenova 上的 deepseek-v4-flash 模型。';
  const out = simulateSeam({
    prompt: '你是什么模型?',
    options: { model: 'deepseek-v4-flash' },
    result: { success: true, content: original, adapter: 'sensenova', model: 'deepseek-v4-flash' },
    env: {},
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 非身份问题 → 不追加(字节不变)', () => {
  const original = '这是斐波那契数列的实现。';
  const out = simulateSeam({
    prompt: '帮我写个斐波那契函数',
    options: { model: 'deepseek-v4-flash' },
    result: { success: true, content: original, adapter: 'sensenova', model: 'deepseek-v4-flash' },
    env: {},
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 门控关 → 即使伪装也不追加(逐字节回退)', () => {
  const original = '我是 ChatGPT,由 OpenAI 开发。';
  const out = simulateSeam({
    prompt: '你是什么模型?',
    options: { model: 'deepseek-v4-flash' },
    result: { success: true, content: original, adapter: 'sensenova', model: 'deepseek-v4-flash' },
    env: { KHY_MODEL_IDENTITY_TRUTH: '0' },
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 失败结果(success!==true)→ 不介入', () => {
  const original = '网络连接出现问题。';
  const out = simulateSeam({
    prompt: '你是什么模型?',
    options: { model: 'deepseek-v4-flash' },
    result: { success: false, content: original, adapter: 'sensenova', model: 'deepseek-v4-flash' },
    env: {},
  });
  assert.strictEqual(out.content, original);
});

test('E2E: 英文身份问题 + 伪装 → 英文脚注', () => {
  const out = simulateSeam({
    prompt: 'what model are you?',
    options: { model: 'deepseek-v4-flash' },
    result: { success: true, content: 'I am Claude, made by Anthropic.', adapter: 'sensenova', model: 'deepseek-v4-flash' },
    env: {},
  });
  assert.ok(out.content.includes('real supply channel'));
  assert.ok(out.content.includes('sensenova') && out.content.includes('deepseek-v4-flash'));
});
