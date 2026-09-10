// 模型列表持久化功能测试
// 验证：保存 API Key 后拉取的模型列表会自动持久化到 localDb，
// 重启后从 localDb 恢复，defaultModel 自动更新。
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// 模拟 localDb
const localDbStore = new Map();
vi.mock('../src/api/localDb.js', () => ({
  getSetting: vi.fn(async (key) => localDbStore.get(key)),
  setSetting: vi.fn(async (key, value) => { localDbStore.set(key, value); }),
}));

// 模拟 standalone API
vi.mock('../src/api/standalone.js', () => ({
  standaloneProviders: vi.fn(() => [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'] },
    { id: 'custom', label: '自定义', baseUrl: '', models: ['gpt-4o'] },
  ]),
  fetchModels: vi.fn(async (provider) => {
    const modelMap = {
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
      deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      custom: ['custom-model-1', 'custom-model-2'],
    };
    return modelMap[provider] || ['gpt-4o'];
  }),
  saveStandaloneApiKey: vi.fn(async () => {}),
  getStandaloneApiKey: vi.fn(async () => 'fake-key'),
  removeStandaloneApiKey: vi.fn(async () => {}),
}));

beforeEach(() => {
  localDbStore.clear();
  setActivePinia(createPinia());
});

describe('模型列表持久化', () => {
  it('refreshStandaloneModels 拉取后应持久化到 localDb', async () => {
    const { useModelsStore } = await import('../src/stores/models.js');
    const store = useModelsStore();
    await store.restore(); // 初始化 providers

    // 拉取 openai 的模型
    await store.refreshStandaloneModels('openai', 'https://api.openai.com/v1', 'test-key');

    // 验证 in-memory 已更新
    const openai = store.providers.find((p) => p.id === 'openai');
    expect(openai).toBeTruthy();
    expect(openai.models).toContain('gpt-4.1');
    expect(openai.models).toContain('gpt-4.1-mini');

    // 验证已持久化到 localDb
    const persisted = localDbStore.get('settings_provider_models');
    expect(persisted).toBeTruthy();
    expect(persisted.openai).toContain('gpt-4.1');
  });

  it('restore 应从 localDb 恢复模型列表', async () => {
    const { useModelsStore } = await import('../src/stores/models.js');

    // 预先设置持久化的模型列表
    localDbStore.set('settings_provider_models', {
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-custom'],
      deepseek: ['deepseek-chat', 'deepseek-coder'],
    });
    localDbStore.set('settings_default_model', 'gpt-4.1-custom');
    localDbStore.set('settings_mode', 'standalone');

    const store = useModelsStore();
    await store.restore();

    // 验证模型列表已恢复
    const openai = store.providers.find((p) => p.id === 'openai');
    expect(openai.models).toContain('gpt-4.1-custom');

    const deepseek = store.providers.find((p) => p.id === 'deepseek');
    expect(deepseek.models).toContain('deepseek-coder');

    // 验证 defaultModel 已恢复
    expect(store.defaultModel).toBe('gpt-4.1-custom');

    // 验证 mode 已恢复
    expect(store.mode).toBe('standalone');
  });

  it('setApiKey 保存 Key 后应自动拉取模型并更新 defaultModel', async () => {
    const { useModelsStore } = await import('../src/stores/models.js');
    const store = useModelsStore();
    await store.restore();

    const initialDefault = store.defaultModel;

    // 保存 deepseek 的 key
    await store.setApiKey('deepseek', 'test-deepseek-key');

    // 等待异步拉取完成
    await new Promise((r) => setTimeout(r, 100));

    // 验证 defaultModel 已更新为拉取列表的第一个
    expect(store.defaultModel).toBe('deepseek-chat');

    // 验证 deepseek 的模型列表已更新
    const deepseek = store.providers.find((p) => p.id === 'deepseek');
    expect(deepseek.models).toContain('deepseek-reasoner');
  });

  it('persistProviderModels 应保存所有 provider 的当前模型列表', async () => {
    const { useModelsStore } = await import('../src/stores/models.js');
    const store = useModelsStore();
    await store.restore();

    // 手动更新某个 provider 的模型
    const idx = store.providers.findIndex((p) => p.id === 'openai');
    store.providers[idx] = { ...store.providers[idx], models: ['custom-model-a', 'custom-model-b'] };

    await store.persistProviderModels();

    const persisted = localDbStore.get('settings_provider_models');
    expect(persisted.openai).toEqual(['custom-model-a', 'custom-model-b']);
  });
});
