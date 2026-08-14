'use strict';

/**
 * visionRoutingTruth — 视觉能力路由透明的单测(node:test)。
 *
 * 回归目标(khyos 自审 #6「无原生多模态 + 路由链路不透明·答不出哪个模型能看图」):
 * 验证「问视觉能力」被识别、footer 用 visionCapability SSOT 过滤真实注册表列出视觉模型 +
 * 回显实际路由模型、门控关字节回退 null、A 层指令注入/回退、fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/services/visionRoutingTruth');

// ── 门控 ────────────────────────────────────────────────────────────────────
test('isEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.isEnabled({}), true);
  assert.strictEqual(mod.isEnabled({ KHY_VISION_ROUTING_TRUTH: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.isEnabled({ KHY_VISION_ROUTING_TRUTH: off }), false, off);
  }
});

// ── 提问识别 ──────────────────────────────────────────────────────────────────
test('isVisionQuestion:命中视觉能力提问(CJK + 英文)', () => {
  const yes = [
    '哪些模型支持图像识别',
    '哪个模型能看图',
    '你能看图吗',
    '你可以识别图片吗',
    '你是不是多模态模型',
    '你是多模态吗',
    '支持视觉输入吗',
    'which models support vision',
    'what models can see images',
    'can you see images',
    'do you support vision',
    'are you multimodal',
  ];
  for (const q of yes) assert.strictEqual(mod.isVisionQuestion(q), true, q);
});

test('isVisionQuestion:不劫持识图命令 / 无关问句 / 空', () => {
  const no = [
    '识别这张图片里的文字',        // 命令,非提问 → 由 imageRecognitionIntent 处理
    '帮我把这张截图的文字提取出来',
    '今天天气怎么样',
    'what is the capital of France',
    '',
    null,
    undefined,
  ];
  for (const q of no) assert.strictEqual(mod.isVisionQuestion(q), false, String(q));
});

// ── classifyModels:用 SSOT 分组 ──────────────────────────────────────────────
test('classifyModels:用 visionCapability SSOT 分视觉/纯文本 + 去重', () => {
  const candidates = [
    { id: 'gpt-4o', provider: 'OpenAI' },          // hint 'gpt-4o' → vision
    { id: 'qwen-vl-max', provider: '通义千问' },     // '-vl' → vision
    { id: 'glm-4v-plus', provider: '智谱AI' },       // 'glm-4v' → vision
    { id: 'deepseek-v4-flash', provider: 'relay' },  // 无 hint → text-only
    { id: 'GPT-4O', provider: 'dup' },               // 大小写去重
    'lite',                                          // 纯文本
  ];
  const r = mod.classifyModels(candidates, { env: {} });
  const visIds = r.vision.map((e) => e.id.toLowerCase()).sort();
  assert.deepStrictEqual(visIds, ['glm-4v-plus', 'gpt-4o', 'qwen-vl-max']);
  const textIds = r.textOnly.map((e) => e.id.toLowerCase()).sort();
  assert.deepStrictEqual(textIds, ['deepseek-v4-flash', 'lite']);
});

test('classifyModels:env KHY_TEXT_ONLY_MODELS 强制纠正优先级最高', () => {
  const r = mod.classifyModels([{ id: 'gpt-4o' }], { env: { KHY_TEXT_ONLY_MODELS: 'gpt-4o' } });
  assert.strictEqual(r.vision.length, 0);
  assert.strictEqual(r.textOnly.length, 1);
});

test('classifyModels:非数组/空 → 空分组', () => {
  assert.deepStrictEqual(mod.classifyModels(null, {}), { vision: [], textOnly: [] });
  assert.deepStrictEqual(mod.classifyModels([], {}), { vision: [], textOnly: [] });
});

// ── buildVisionFooter ────────────────────────────────────────────────────────
test('buildVisionFooter:列出视觉模型 + 回显实际模型(纯文本)+ OCR 兜底', () => {
  const footer = mod.buildVisionFooter(
    {
      candidates: [{ id: 'qwen-vl-max', provider: '通义千问' }, { id: 'deepseek-v4', provider: 'relay' }],
      activeModel: 'deepseek-v4',
      activeSupportsVision: false,
    },
    { locale: 'zh', env: {} },
  );
  assert.ok(footer.includes(mod.VISION_MARKER), footer);
  assert.ok(/qwen-vl-max/.test(footer), '应列出视觉模型');
  assert.ok(/deepseek-v4/.test(footer), '应回显实际模型');
  assert.ok(/纯文本/.test(footer), '纯文本模型应标注');
  assert.ok(/OCR/i.test(footer), '纯文本应提 OCR 兜底');
});

test('buildVisionFooter:实际模型具备视觉 → 不提 OCR 兜底', () => {
  const footer = mod.buildVisionFooter(
    { candidates: [{ id: 'gpt-4o' }], activeModel: 'gpt-4o', activeSupportsVision: true },
    { locale: 'zh', env: {} },
  );
  assert.ok(/可直接接受图像输入/.test(footer), footer);
  assert.ok(!/OCR/i.test(footer), '视觉模型不应提 OCR 兜底: ' + footer);
});

test('buildVisionFooter:英文 locale', () => {
  const footer = mod.buildVisionFooter(
    { candidates: [{ id: 'qwen-vl-max' }], activeModel: 'deepseek-v4', activeSupportsVision: false },
    { locale: 'en', env: {} },
  );
  assert.ok(/vision routing/i.test(footer), footer);
  assert.ok(/text-only/i.test(footer), footer);
  assert.ok(/OCR/i.test(footer), footer);
});

test('buildVisionFooter:无视觉模型清单但有实际模型 → 仍陈述 + 标注无视觉模型', () => {
  const footer = mod.buildVisionFooter(
    { candidates: [{ id: 'lite' }], activeModel: 'lite', activeSupportsVision: false },
    { locale: 'zh', env: {} },
  );
  assert.ok(footer && footer.includes(mod.VISION_MARKER), footer);
  assert.ok(/没有可路由的视觉模型/.test(footer), footer);
});

test('buildVisionFooter:零编造 —— 无清单 + 实际模型未知 → null', () => {
  assert.strictEqual(
    mod.buildVisionFooter({ candidates: [], activeModel: 'auto', activeSupportsVision: false }, { env: {} }),
    null,
  );
  assert.strictEqual(mod.buildVisionFooter({}, { env: {} }), null);
});

test('buildVisionFooter:门控关 → null(字节回退)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      mod.buildVisionFooter(
        { candidates: [{ id: 'gpt-4o' }], activeModel: 'gpt-4o', activeSupportsVision: true },
        { env: { KHY_VISION_ROUTING_TRUTH: off } },
      ),
      null,
      off,
    );
  }
});

// ── A 层指令 ──────────────────────────────────────────────────────────────────
test('formatVisionDirective:默认开注入 / 门控关 → 空串(字节回退)', () => {
  const zh = mod.formatVisionDirective({ env: {}, locale: 'zh' });
  assert.ok(/视觉能力是「路由」而非原生/.test(zh), zh);
  const en = mod.formatVisionDirective({ env: {}, locale: 'en' });
  assert.ok(/Vision capability is routed/.test(en), en);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.formatVisionDirective({ env: { KHY_VISION_ROUTING_TRUTH: off } }), '', off);
  }
});

// ── pickUserText / pickLocale ────────────────────────────────────────────────
test('pickUserText:prompt 优先,否则取最后一条 user 消息', () => {
  assert.strictEqual(mod.pickUserText('你能看图吗', {}), '你能看图吗');
  assert.strictEqual(
    mod.pickUserText('', { messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: '哪些模型支持视觉' }] }),
    '哪些模型支持视觉',
  );
});

test('pickLocale:CJK → zh,否则 en', () => {
  assert.strictEqual(mod.pickLocale('你能看图吗'), 'zh');
  assert.strictEqual(mod.pickLocale('can you see images'), 'en');
});

// ── fail-soft ─────────────────────────────────────────────────────────────────
test('fail-soft:异常输入绝不抛', () => {
  assert.doesNotThrow(() => mod.isVisionQuestion(null));
  assert.doesNotThrow(() => mod.classifyModels(undefined, undefined));
  assert.doesNotThrow(() => mod.buildVisionFooter(null, null));
  assert.doesNotThrow(() => mod.formatVisionDirective(undefined));
  assert.doesNotThrow(() => mod.pickUserText(null, null));
});
