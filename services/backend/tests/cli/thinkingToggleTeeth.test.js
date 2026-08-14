// Unit tests for the /thinking toggle "teeth": the pure DeepSeek model resolver
// that swaps deepseek-chat (V3, no reasoning) <-> deepseek-reasoner (R1, reasoning)
// so toggling /thinking actually changes the request, not just the display.
//
// Pure + env-free, so no gateway or network is needed.

const ai = require('../../src/cli/ai');
const { _resolveDeepseekThinkingModel } = ai.__test__;

describe('/thinking teeth — DeepSeek reasoner/chat routing', () => {
  test('thinking ON routes chat-class variants to the reasoner', () => {
    expect(_resolveDeepseekThinkingModel('deepseek-chat', true)).toBe('deepseek-reasoner');
    expect(_resolveDeepseekThinkingModel('deepseek-v3', true)).toBe('deepseek-reasoner');
    expect(_resolveDeepseekThinkingModel('deepseek', true)).toBe('deepseek-reasoner');
    expect(_resolveDeepseekThinkingModel('DeepSeek-Chat', true)).toBe('deepseek-reasoner'); // case-insensitive
  });

  test('thinking OFF routes reasoner-class variants back to chat', () => {
    expect(_resolveDeepseekThinkingModel('deepseek-reasoner', false)).toBe('deepseek-chat');
    expect(_resolveDeepseekThinkingModel('deepseek-r1', false)).toBe('deepseek-chat');
  });

  test('no swap when the variant is already correct for the toggle', () => {
    expect(_resolveDeepseekThinkingModel('deepseek-reasoner', true)).toBeNull();
    expect(_resolveDeepseekThinkingModel('deepseek-chat', false)).toBeNull();
  });

  test('non-DeepSeek models are never touched', () => {
    expect(_resolveDeepseekThinkingModel('claude-opus-4-8', true)).toBeNull();
    expect(_resolveDeepseekThinkingModel('gpt-4o', false)).toBeNull();
    expect(_resolveDeepseekThinkingModel('qwen-plus', true)).toBeNull();
    expect(_resolveDeepseekThinkingModel('', true)).toBeNull();
    expect(_resolveDeepseekThinkingModel(null, false)).toBeNull();
    expect(_resolveDeepseekThinkingModel(undefined, true)).toBeNull();
  });
});
