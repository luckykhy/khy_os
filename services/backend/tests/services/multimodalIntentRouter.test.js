'use strict';

/**
 * multimodalIntentRouter — 多模态意图路由(防混乱)的确定性测试(node:test)。
 *
 * 锁定:khyos 第 5 路输入零误触识别、提示词清晰度评估、分路 inventory、仅在「提示词不清
 * 且 ≥2 路异构输入」时注入消歧指令,且提示词清晰 / 单一模态 / 意图模式活跃 / env 关闭时
 * 一律不注入(系统提示词字节不变)。
 */

const test = require('node:test');
const assert = require('node:assert');

const r = require('../../src/services/multimodalIntentRouter');

test('detectKhyosReference: 命中明确 khyos 引用,零误触', () => {
  assert.strictEqual(r.detectKhyosReference('帮我看看 khyos'), true);
  assert.strictEqual(r.detectKhyosReference('用在 khy os 上'), true);
  assert.strictEqual(r.detectKhyosReference('构建 khy-os 内核'), true);
  assert.strictEqual(r.detectKhyosReference('khy 内核怎么启动'), true);
  assert.strictEqual(r.detectKhyosReference('khy 底座'), true);
  // 零假阳性:khyquant(应用,非底座)、macos、裸 os
  assert.strictEqual(r.detectKhyosReference('打开 khyquant 看行情'), false);
  assert.strictEqual(r.detectKhyosReference('我用的是 macos 系统'), false);
  assert.strictEqual(r.detectKhyosReference('this runs on the os layer'), false);
  assert.strictEqual(r.detectKhyosReference(''), false);
});

test('assessPromptClarity: 空文本配媒体→不清;纯模糊指代→不清;具体指令→清晰', () => {
  assert.strictEqual(r.assessPromptClarity('', { hasMedia: true }).clear, false);
  assert.strictEqual(r.assessPromptClarity('', { hasMedia: false }).clear, true);
  assert.strictEqual(r.assessPromptClarity('看看这些').clear, false);
  assert.strictEqual(r.assessPromptClarity('帮我处理一下').clear, false);
  assert.strictEqual(r.assessPromptClarity('把图片转成网页').clear, true);
  assert.strictEqual(r.assessPromptClarity('总结这段音频').clear, true);
  // 足够具体的句子默认放行(不误判为模糊)
  assert.strictEqual(r.assessPromptClarity('请基于这些资料给我一份周报草稿').clear, true);
});

test('buildInventory: 去重并按确定性优先级排序', () => {
  const inv = r.buildInventory({ mediaKinds: ['video', 'audio', 'image'], khyos: true, hasText: true });
  const channels = inv.map(c => c.channel);
  assert.deepStrictEqual(channels, ['khyos', 'text', 'image', 'audio', 'video']);
});

test('routeMultimodalIntent: 文本+图片+音频+视频+khyos 且提示词不清 → 注入消歧指令', () => {
  const out = r.routeMultimodalIntent({
    text: '看看这些 顺便用在 khyos 上',
    mediaKinds: ['image', 'audio', 'video'],
    modes: [],
  });
  assert.strictEqual(out.khyos, true);
  assert.strictEqual(out.ambiguousMultimodal, true);
  assert.ok(out.directive && out.directive.includes('不混乱'));
  assert.ok(out.directive.includes('khyos'));
  const channels = out.inventory.map(c => c.channel);
  for (const ch of ['khyos', 'image', 'audio', 'video']) assert.ok(channels.includes(ch), `缺通道 ${ch}`);
});

test('routeMultimodalIntent: 图片+文档+压缩包 且模糊 → archive 作为第 5 路通道入册并被消歧指令枚举', () => {
  const out = r.routeMultimodalIntent({
    text: '看看这些',
    mediaKinds: ['image', 'document', 'archive'],
    modes: [],
  });
  assert.strictEqual(out.ambiguousMultimodal, true);
  const channels = out.inventory.map(c => c.channel);
  // 确定性顺序:text → image → document → archive(archive 在 document 之后、audio 之前)
  assert.deepStrictEqual(channels, ['text', 'image', 'document', 'archive']);
  assert.ok(out.directive.includes('压缩包'), '消歧指令须显式提到压缩包');
});

test('routeMultimodalIntent: 单一模态 + 模糊 → 不触发(交给单图消歧)', () => {
  const out = r.routeMultimodalIntent({
    text: '看看这张图',
    mediaKinds: ['image'],
    modes: [],
  });
  assert.strictEqual(out.heterogeneousCount, 1);
  assert.strictEqual(out.ambiguousMultimodal, false);
  assert.strictEqual(out.directive, null);
});

test('routeMultimodalIntent: 提示词清晰 + 多模态 → 不过度触发', () => {
  const out = r.routeMultimodalIntent({
    text: '把这张图片转成网页,并总结这段音频',
    mediaKinds: ['image', 'audio'],
    modes: [],
  });
  assert.strictEqual(out.clarity.clear, true);
  assert.strictEqual(out.ambiguousMultimodal, false);
  assert.strictEqual(out.directive, null);
});

test('routeMultimodalIntent: 意图模式活跃(goal) + 多模态 + 模糊 → 让位不注入', () => {
  const out = r.routeMultimodalIntent({
    text: '看看这些',
    mediaKinds: ['image', 'audio', 'video'],
    modes: ['goal'],
  });
  assert.strictEqual(out.modeActive, true);
  assert.strictEqual(out.ambiguousMultimodal, false);
  assert.strictEqual(out.directive, null);
});

test('routeMultimodalIntent: 一路媒体 + khyos + 模糊 → 触发(异构≥2)', () => {
  const out = r.routeMultimodalIntent({
    text: '帮我搞定 用 khyos',
    mediaKinds: ['image'],
    modes: [],
  });
  assert.strictEqual(out.heterogeneousCount, 2);
  assert.strictEqual(out.ambiguousMultimodal, true);
  assert.ok(out.directive);
});

test('routeMultimodalIntent: env 关闭 → directive 为空(字节不变)', () => {
  const out = r.routeMultimodalIntent({
    text: '看看这些',
    mediaKinds: ['image', 'audio', 'video'],
    modes: [],
    options: { multimodalIntentRouter: 'off' },
  });
  assert.strictEqual(out.enabled, false);
  assert.strictEqual(out.ambiguousMultimodal, false);
  assert.strictEqual(out.directive, null);
});
