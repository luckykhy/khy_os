// khy.visionProvider：多模态（看屏）能力接入层
// 三个内置 provider：
//   - dashscope (Qwen-VL)：OpenAI 兼容 chat/completions + image_url（Base64 / URL）
//   - openai (GPT-4o vision)：同上，OpenAI 官方
//   - custom：任何 OpenAI 兼容 /v1/chat/completions 的多模态端点
// 不引入 VLM 权重；纯调用方。

import { Preferences } from '@capacitor/preferences';

export const VLM_PROVIDERS = [
  { id: 'dashscope', label: '通义千问 Qwen-VL', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-vl-plus', 'qwen-vl-max'] },
  { id: 'openai',    label: 'OpenAI GPT-4o vision', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'custom',    label: '自定义（OpenAI 兼容）', baseUrl: '', models: ['gpt-4o'] },
];

const KEY_PREFIX = 'khy_vision_key_';
const SEL_KEY = 'khy_vision_selection_v1';
const browserKeyStore = new Map();

async function secureGet(key) {
  if (!window.Capacitor?.isNativePlatform?.()) return browserKeyStore.get(key) || null;
  const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
  try {
    const r = await SecureStoragePlugin.get({ key });
    return r.value || null;
  } catch { return null; }
}

async function secureSet(key, value) {
  if (!window.Capacitor?.isNativePlatform?.()) { browserKeyStore.set(key, value); return; }
  const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
  await SecureStoragePlugin.set({ key, value });
}

async function secureRemove(key) {
  if (!window.Capacitor?.isNativePlatform?.()) { browserKeyStore.delete(key); return; }
  const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
  try { await SecureStoragePlugin.remove({ key }); } catch { /* */ }
}

export function getVlmProviders() {
  return VLM_PROVIDERS.map((p) => ({ ...p }));
}

export async function getVlmSelection() {
  const { value } = await Preferences.get({ key: SEL_KEY });
  return value ? JSON.parse(value) : { provider: '', model: '' };
}

export async function setVlmSelection(sel) {
  await Preferences.set({ key: SEL_KEY, value: JSON.stringify(sel || {}) });
}

export async function getVlmApiKey(provider) {
  return secureGet(`${KEY_PREFIX}${provider}`);
}

export async function saveVlmApiKey(provider, value) {
  const trimmed = String(value || '').trim();
  if (trimmed) await secureSet(`${KEY_PREFIX}${provider}`, trimmed);
  else await secureRemove(`${KEY_PREFIX}${provider}`);
}

// 调多模态模型描述一张图
// image: { dataUrl: 'data:image/png;base64,...' } | { url: 'https://...' }
export async function visionDescribe({ provider, baseUrl, model, apiKey, image, prompt }) {
  if (!apiKey) throw new Error('Vision Provider 未配置 API Key');
  if (!image) throw new Error('缺图像输入');
  const url = (baseUrl || VLM_PROVIDERS.find((p) => p.id === provider)?.baseUrl || '').replace(/\/+$/, '');
  if (!url) throw new Error('Vision Provider 未配置 baseUrl');
  const body = {
    model: model || VLM_PROVIDERS.find((p) => p.id === provider)?.models?.[0],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || '请描述这张图。' },
        image.url
          ? { type: 'image_url', image_url: { url: image.url } }
          : { type: 'image_url', image_url: { url: image.dataUrl } },
      ],
    }],
    max_tokens: 1024,
  };
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`视觉模型 ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}
