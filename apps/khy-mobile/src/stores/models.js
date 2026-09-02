import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { getSetting, setSetting } from '@/api/localDb';
import { fetchModelCatalog } from '@/api/catalog';
import {
  fetchModels,
  getStandaloneApiKey,
  removeStandaloneApiKey,
  saveStandaloneApiKey,
  standaloneProviders,
} from '@/api/standalone';
import { operationStatus } from '@/api/status';

// Models store: provider + API key management and the active model list.
// Standalone providers (direct OpenAI-compatible endpoints) live on the phone;
// remote providers are pulled from the khy-os gateway catalog.

const SETTINGS = {
  defaultModel: 'settings_default_model',
  mode: 'settings_mode',
};

export const useModelsStore = defineStore('mobile-models', () => {
  const providers = ref([]);
  const selectedProvider = ref('openai');
  const customBaseUrl = ref('');
  const customModels = ref([]);
  const standaloneApiKeys = ref({});
  const remoteCatalog = ref(null);
  const remoteModels = ref([]);
  const status = ref(operationStatus('读取', '模型列表', '等待开始'));
  const error = ref('');
  const defaultModel = ref('');
  // 默认空串：触发 router 守卫的"首次启动 → /welcome"分支，用户明确选完才落地。
  const mode = ref('');

  // 找到第一个已配 key 的 provider。模式未设、用户只在 ModelsView 临时填过
  // key 还没正式选模式时，让 ChatView/其它视图知道该用哪家。
  const firstProviderWithKey = computed(() => {
    for (const p of providers.value) {
      if (p.id === 'custom') continue; // custom 需要 baseUrl，单独处理
      if (standaloneApiKeys.value[p.id]) return p.id;
    }
    if (standaloneApiKeys.value.custom && customBaseUrl.value) return 'custom';
    return null;
  });

  const effectiveStandaloneProvider = computed(() => {
    if (firstProviderWithKey.value) return firstProviderWithKey.value;
    return selectedProvider.value || 'openai';
  });

  const modelOptions = computed(() => {
    // 1) 独立模式（或未设模式但已配 standalone key）→ 用 provider 默认模型
    if (mode.value === 'standalone' || (mode.value === '' && firstProviderWithKey.value)) {
      const pid = effectiveStandaloneProvider.value;
      const provider = providers.value.find((item) => item.id === pid);
      if (!provider) return [];
      if (pid === 'custom') {
        return customModels.value.length ? customModels.value : provider.models;
      }
      return provider.models;
    }
    // 2) 远程模式
    if (mode.value === 'remote') {
      return remoteModels.value;
    }
    // 3) 模式未设 + 没有任何 key：fallback 到 openai 默认模型（让 ChatView 不显示空）
    const fallback = providers.value.find((p) => p.id === (selectedProvider.value || 'openai'));
    return fallback?.models || ['gpt-4o-mini'];
  });

  async function restore() {
    const [storedModel, storedMode] = await Promise.all([
      getSetting(SETTINGS.defaultModel),
      getSetting(SETTINGS.mode),
    ]);
    defaultModel.value = storedModel || '';
    mode.value = storedMode || '';
    providers.value = standaloneProviders();
  }

  async function setDefaultModel(model) {
    defaultModel.value = model;
    await setSetting(SETTINGS.defaultModel, model);
  }

  async function setMode(next) {
    mode.value = next;
    await setSetting(SETTINGS.mode, next);
  }

  async function loadStandaloneKeys() {
    const keys = {};
    for (const provider of providers.value) {
      const value = await getStandaloneApiKey(provider.id);
      if (value) keys[provider.id] = value;
    }
    standaloneApiKeys.value = keys;
  }

  async function setApiKey(provider, value) {
    await saveStandaloneApiKey(provider, value);
    standaloneApiKeys.value = { ...standaloneApiKeys.value, [provider]: value.trim() };
    // 「可单独调用」：保存完 key 后后台立刻拉一次模型列表，失败不阻塞。
    // 这样用户保存完直接进 /chat 也能用上拉到的真实模型名（不再是 DEFAULTS 兜底）。
    refreshStandaloneModels(
      provider,
      providers.value.find((p) => p.id === provider)?.baseUrl || '',
      value.trim()
    ).then((list) => {
      // 第一次配该 provider：把 defaultModel 设为列表第一个（让 ChatView 立即能用）
      if (list?.length && !defaultModel.value) {
        defaultModel.value = list[0];
        setSetting(SETTINGS.defaultModel, list[0]).catch(() => {});
      }
    }).catch(() => { /* 静默 — 用户可以手动点「拉取模型」 */ });
  }

  async function clearApiKey(provider) {
    await removeStandaloneApiKey(provider);
    standaloneApiKeys.value = { ...standaloneApiKeys.value, [provider]: '' };
    // 如果当前 defaultModel 是这个 provider 的模型，清掉避免「空 key + 残缺 model」
    const p = providers.value.find((item) => item.id === provider);
    if (p?.models?.includes(defaultModel.value)) {
      defaultModel.value = '';
      setSetting(SETTINGS.defaultModel, '').catch(() => {});
    }
  }

  async function refreshStandaloneModels(provider, baseUrl, apiKey) {
    status.value = operationStatus('拉取', `模型列表（${provider}）`, '进行中');
    error.value = '';
    try {
      const models = await fetchModels(provider, baseUrl, apiKey);
      const index = providers.value.findIndex((item) => item.id === provider);
      if (index >= 0) {
        providers.value[index] = { ...providers.value[index], models };
      }
      if (provider === 'custom') customModels.value = models;
      status.value = operationStatus('拉取', `模型列表（${provider}）`, '已更新', 'success');
      return models;
    } catch (cause) {
      error.value = cause.message || '模型列表拉取失败';
      status.value = operationStatus('拉取', `模型列表（${provider}）`, '失败', 'error');
      throw cause;
    }
  }

  async function refreshRemoteCatalog() {
    status.value = operationStatus('拉取', 'khy-os 模型目录', '进行中');
    error.value = '';
    try {
      const catalog = await fetchModelCatalog();
      remoteCatalog.value = catalog;
      remoteModels.value = catalog.models || [];
      if (!defaultModel.value && catalog.models.length) {
        defaultModel.value = catalog.models[0].id;
      }
      status.value = operationStatus('拉取', 'khy-os 模型目录', '已更新', 'success');
      return catalog;
    } catch (cause) {
      error.value = cause.message || '模型目录拉取失败';
      status.value = operationStatus('拉取', 'khy-os 模型目录', '失败', 'error');
      throw cause;
    }
  }

  async function ensureKeysLoaded() {
    if (!Object.keys(standaloneApiKeys.value).length) await loadStandaloneKeys();
  }

  return {
    providers,
    selectedProvider,
    customBaseUrl,
    customModels,
    standaloneApiKeys,
    remoteCatalog,
    remoteModels,
    status,
    error,
    defaultModel,
    mode,
    modelOptions,
    firstProviderWithKey,
    effectiveStandaloneProvider,
    restore,
    setDefaultModel,
    setMode,
    loadStandaloneKeys,
    setApiKey,
    clearApiKey,
    refreshStandaloneModels,
    refreshRemoteCatalog,
    ensureKeysLoaded,
  };
});
