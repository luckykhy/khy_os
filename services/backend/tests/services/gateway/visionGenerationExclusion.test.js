'use strict';

/**
 * visionGenerationExclusion.test.js — 「生成型号不当视觉输入」纯叶子契约 SSoT。
 *
 * 真实 bug:VISION_NAME_HINTS 的裸 'image' 片段把图像生成模型(agnes-image-2.1-flash)
 * 误判为视觉输入 → 纯文本模型收到图被自动改选到生成端点 → model_not_found/404。
 * 本套件锁死:
 *   - 开门(default)→ image/video 生成命名规律命中 → isGenerationOnlyModel=true;
 *   - 真视觉输入型号绝不被误命中(gpt-4o / qwen-vl / glm-4v / claude-3 …);
 *   - 关门(0/false/off/no)→ 逐字节回退(恒 false / null);
 *   - 集成:visionCapability.isVisionCapableModel 开门时对生成型号返回 false、门关回退 true;
 *   - 绝不抛(junk env / null / 非字符串 model)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  GENERATION_PATTERNS,
  visionGenerationExclusionEnabled,
  isGenerationOnlyModel,
  matchedGenerationPattern,
} = require('../../../src/services/gateway/visionGenerationExclusion');
const { isVisionCapableModel } = require('../../../src/services/gateway/visionCapability');

test('gate default-on', () => {
  assert.strictEqual(visionGenerationExclusionEnabled({}), true);
  assert.strictEqual(visionGenerationExclusionEnabled({ KHY_VISION_GENERATION_EXCLUSION: '1' }), true);
  assert.strictEqual(visionGenerationExclusionEnabled({ KHY_VISION_GENERATION_EXCLUSION: 'on' }), true);
});

test('gate off (0/false/off/no, case/space-insensitive) → byte-revert to false/null', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    const env = { KHY_VISION_GENERATION_EXCLUSION: v };
    assert.strictEqual(visionGenerationExclusionEnabled(env), false, v);
    assert.strictEqual(isGenerationOnlyModel('agnes-image-2.1-flash', env), false, v);
    assert.strictEqual(matchedGenerationPattern('agnes-image-2.1-flash', env), null, v);
  }
});

test('image-generation models are flagged (gate on) — the demonstrated bug case', () => {
  const gens = [
    'agnes-image-2.1-flash',       // 触发本次 404 的自定义 provider 生成型号
    'sensenova-6.7-flash-image',
    'gpt-image-1',
    'qwen-image',
    'hunyuan-image',
    'dall-e-3', 'dalle3',
    'imagen-3.0', 'imagen-4',
    'stable-diffusion-3.5', 'sdxl-turbo', 'sd3-medium',
    'flux.1-schnell', 'flux-dev',
    'kolors-v2', 'seedream-3.0', 'seededit-v1', 'cogview-4',
    'wanx-v1', 'ideogram-v2', 'recraft-v3', 'kandinsky-3', 'hidream-i1',
    'ernie-irag-edit',
  ];
  for (const m of gens) {
    assert.strictEqual(isGenerationOnlyModel(m, {}), true, m);
    assert.ok(matchedGenerationPattern(m, {}), `matched name for ${m}`);
  }
});

test('video-generation models are flagged (gate on)', () => {
  for (const m of [
    'sora-2', 'veo-3', 'veo2', 'kling-v1.6', 'cogvideo-x',
    'hailuo-02', 'seedance-1.0-pro', 'ltx-video', 'wan-video-2.1',
    'runway-video-gen',
  ]) {
    assert.strictEqual(isGenerationOnlyModel(m, {}), true, m);
  }
});

test('genuine vision-INPUT models are NEVER flagged (no false exclusion)', () => {
  const visionInputs = [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1',
    'claude-3-5-sonnet', 'claude-opus-4-8',
    'gemini-1.5-pro', 'gemini-2.0-flash',
    'qwen-vl-max', 'qwen2.5-vl-72b', 'internvl2-8b',
    'glm-4v-plus', 'glm-4.5v', 'glm-4.6v-flash',
    'pixtral-12b', 'llava-1.6', 'step-1v-8k', 'yi-vision',
    'grok-2-vision', 'llama-4-scout', 'nova-lite',
    'minicpm-v-2.6', 'cogvlm2',
  ];
  for (const m of visionInputs) {
    assert.strictEqual(isGenerationOnlyModel(m, {}), false, m);
  }
});

test('plain text models are NOT flagged (no effect on them)', () => {
  for (const m of [
    'agnes-2.0-flash',            // 本次场景的纯文本模型本体
    'gpt-4.1-mini', 'deepseek-v4', 'deepseek-chat',
    'glm-4-flash', 'qwen-max', 'kimi-k2', 'moonshot-v1-8k',
    'text-embedding-3-large',    // 名字带 image? 无 → 不命中;embedding 不在范围也不误伤
  ]) {
    assert.strictEqual(isGenerationOnlyModel(m, {}), false, m);
  }
});

test("'imagen' does NOT match the bare image-segment rule but IS caught by its own rule", () => {
  // 'imagen' 的 image 后接字母 n → image-segment 段边界不命中;单列 imagen 规则兜住。
  assert.strictEqual(matchedGenerationPattern('imagen-3', {}), 'imagen');
  assert.strictEqual(matchedGenerationPattern('agnes-image-2.1-flash', {}), 'image-segment');
});

test('provider-prefixed forms are tolerated', () => {
  for (const m of ['api:agnes:agnes-image-2.1-flash', 'agnes/agnes-image-2.1-flash', ' AGNES-IMAGE-2.1-FLASH ']) {
    assert.strictEqual(isGenerationOnlyModel(m, {}), true, m);
  }
});

test('never throws on junk env / non-string model', () => {
  assert.doesNotThrow(() => visionGenerationExclusionEnabled(null));
  assert.doesNotThrow(() => visionGenerationExclusionEnabled(undefined));
  assert.doesNotThrow(() => isGenerationOnlyModel('x', { KHY_VISION_GENERATION_EXCLUSION: {} }));
  assert.doesNotThrow(() => isGenerationOnlyModel(12345, {}));
  assert.doesNotThrow(() => matchedGenerationPattern(null, {}));
  assert.strictEqual(isGenerationOnlyModel(12345, {}), false);
  assert.strictEqual(isGenerationOnlyModel(null, {}), false);
});

// ── 集成:visionCapability 消费本叶子 ─────────────────────────────────────────
test('integration: visionCapability rejects generation model (gate on) — no more false vision candidate', () => {
  // 门开:agnes-image-2.1-flash 不再被 'image' 片段误判为视觉 → 不会被选作视觉候选。
  assert.strictEqual(isVisionCapableModel('agnes-image-2.1-flash', { env: {} }), false);
  // 真视觉模型仍判 true。
  assert.strictEqual(isVisionCapableModel('gpt-4o', { env: {} }), true);
  assert.strictEqual(isVisionCapableModel('qwen-vl-max', { env: {} }), true);
});

test('integration: gate off → byte-revert (image-hint误判照旧,证明是本叶子在纠正)', () => {
  // 关门:回退到旧行为——'image' 片段仍把生成型号误判为视觉 true。
  const off = { env: { KHY_VISION_GENERATION_EXCLUSION: '0' } };
  assert.strictEqual(isVisionCapableModel('agnes-image-2.1-flash', off), true);
});

test('integration: user env KHY_VISION_MODELS still wins over exclusion', () => {
  // 用户显式声明视觉集优先级最高(在 visionCapability 更早处命中即 true),纠正不该覆盖它。
  const env = { KHY_VISION_MODELS: 'agnes-image-2.1-flash' };
  assert.strictEqual(isVisionCapableModel('agnes-image-2.1-flash', { env }), true);
});

test('GENERATION_PATTERNS is frozen and non-empty', () => {
  assert.ok(Object.isFrozen(GENERATION_PATTERNS));
  assert.ok(GENERATION_PATTERNS.length > 0);
});
